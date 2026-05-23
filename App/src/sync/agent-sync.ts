import type { Agent, PluginContext } from "@paperclipai/plugin-sdk";
import type { OpenClawClient } from "../clients/openclaw-client.js";
import { diffAgents } from "./diff.js";
import { planReconcile, type ReconcileAction } from "./reconcile.js";
import { StateKeys } from "../state-keys.js";
import {
  OPENCLAW_ADAPTER_TYPE,
  OPENCLAW_AGENT_SLOT_COUNT,
  PLUGIN_ID,
  openclawSlotKey,
} from "../manifest.js";
import type {
  BridgeConfig,
  CompanyBinding,
  OpenClawAgentRecord,
  OpenClawAgentRoster,
  SyncStatusSnapshot,
} from "../types.js";
import { EMPTY_BINDING } from "../types.js";

export interface AgentSyncDeps {
  ctx: PluginContext;
  openclaw: OpenClawClient;
  config: BridgeConfig;
  now?: () => number;
}

export interface SyncRunResult {
  companyId: string;
  rows: SyncStatusSnapshot["rows"];
  actions: ReconcileAction[];
  exportedToOpenClaw: string[];
  exportFailures: Array<{ name: string; error: string }>;
  importedToPaperclip: Array<{ openclawName: string; slotKey: string; agentId: string | null }>;
  importFailures: Array<{ openclawName: string; error: string }>;
}

export interface MultiSyncResult {
  /** Companies that had a binding and were synced. */
  companies: SyncRunResult[];
  /** Companies skipped because no binding (or binding.enabled === false). */
  skipped: Array<{ companyId: string; reason: string }>;
}

export class AgentSync {
  private readonly ctx: PluginContext;
  private readonly oc: OpenClawClient;
  private readonly config: BridgeConfig;
  private readonly now: () => number;

  constructor(deps: AgentSyncDeps) {
    this.ctx = deps.ctx;
    this.oc = deps.openclaw;
    this.config = deps.config;
    this.now = deps.now ?? Date.now;
  }

  /**
   * Read a company's bridge binding. Absent => not bound.
   */
  async readBinding(companyId: string): Promise<CompanyBinding | null> {
    const raw = (await this.ctx.state.get(StateKeys.binding(companyId))) as
      | CompanyBinding
      | null
      | undefined;
    return raw ?? null;
  }

  /**
   * Write a company's bridge binding. Pass `null` to clear.
   */
  async writeBinding(companyId: string, binding: CompanyBinding | null): Promise<void> {
    if (binding === null) {
      await this.ctx.state.delete?.(StateKeys.binding(companyId));
      return;
    }
    await this.ctx.state.set(StateKeys.binding(companyId), binding);
  }

  /**
   * Sync every enabled-bound company against OpenClaw in one pass. A single
   * `agents.list` RPC is shared across all companies so we only hit the
   * gateway once per cycle.
   */
  async syncAllBound(): Promise<MultiSyncResult> {
    let companies: Array<{ id: string }> = [];
    try {
      companies = await this.ctx.companies.list({ limit: 200 });
    } catch (err) {
      this.ctx.logger.warn("syncAllBound: ctx.companies.list failed", {
        err: err instanceof Error ? err.message : String(err),
      });
      return { companies: [], skipped: [] };
    }

    // Pre-fetch the OpenClaw roster once.
    let roster: OpenClawAgentRoster;
    try {
      const raw = await this.oc.rpc<unknown>("agents.list", {});
      roster = normalizeOpenClawRoster(raw);
    } catch (err) {
      this.ctx.logger.warn("syncAllBound: agents.list failed", {
        err: err instanceof Error ? err.message : String(err),
      });
      return { companies: [], skipped: companies.map((c) => ({ companyId: c.id, reason: "gateway unreachable" })) };
    }

    const results: SyncRunResult[] = [];
    const skipped: Array<{ companyId: string; reason: string }> = [];
    for (const company of companies) {
      const binding = await this.readBinding(company.id);
      if (!binding || !binding.enabled) {
        skipped.push({ companyId: company.id, reason: binding ? "disabled" : "no binding" });
        continue;
      }
      try {
        results.push(await this.fullSync(company.id, binding, roster));
      } catch (err) {
        this.ctx.logger.warn("syncAllBound: company sync failed", {
          companyId: company.id,
          err: err instanceof Error ? err.message : String(err),
        });
        skipped.push({
          companyId: company.id,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { companies: results, skipped };
  }

  /**
   * Run a full sync against the given company using the given binding. The
   * OpenClaw roster can be passed in to avoid an extra RPC when the caller
   * already has it (e.g. multi-company sync).
   */
  async fullSync(
    companyId: string,
    binding: CompanyBinding = EMPTY_BINDING,
    rosterOverride?: OpenClawAgentRoster,
  ): Promise<SyncRunResult> {
    if (!companyId) {
      throw new Error("openclaw-bridge: companyId is required");
    }

    let openclawAgents: OpenClawAgentRecord[];
    let mainKey: string | null = null;
    try {
      const roster = rosterOverride ?? normalizeOpenClawRoster(await this.oc.rpc<unknown>("agents.list", {}));
      openclawAgents = roster.agents;
      mainKey = roster.mainKey;
    } catch (err) {
      await this.recordError(companyId, err);
      throw err;
    }

    // Apply this company's filters. AND-semantics: an OC agent is mirrored
    // into this company only if it passes BOTH the workspace filter (if any)
    // AND the agent-name allowlist (if any). Empty filters mean "no filter".
    const wsFilter = new Set(binding.workspaces ?? []);
    if (wsFilter.size > 0) {
      openclawAgents = openclawAgents.filter((a) =>
        typeof a.workspace === "string" && wsFilter.has(a.workspace),
      );
    }
    const agentFilter = new Set(binding.agentNames ?? []);
    if (agentFilter.size > 0) {
      openclawAgents = openclawAgents.filter((a) => agentFilter.has(a.name));
    }

    const paperclipAgents = await this.listPaperclipAgents(companyId);

    // Compute slot assignments BEFORE the diff so the very first sync still
    // pairs each OpenClaw agent with its managed-slot counterpart correctly.
    // We persist the same map after materialization for stable identity over
    // future syncs. OC agents that already pair with a same-named PC agent
    // are skipped here so we don't materialize duplicate slot rows.
    const ocNameToSlotKey = await this.computeSlotAssignments(
      companyId,
      openclawAgents,
      paperclipAgents,
    );
    const slotKeyToOcName: Record<string, string> = {};
    for (const [ocName, slotKey] of Object.entries(ocNameToSlotKey)) {
      slotKeyToOcName[slotKey] = ocName;
    }

    const rows = diffAgents({
      openclawAgents,
      paperclipAgents,
      paperclipAdapterType: OPENCLAW_ADAPTER_TYPE,
      pluginKey: PLUGIN_ID,
      slotKeyToOcName,
    });

    const actions = planReconcile({
      rows,
      syncDirection: this.config.syncDirection,
      conflictPolicy: this.config.conflictPolicy,
    });

    const exportedToOpenClaw: string[] = [];
    const exportFailures: Array<{ name: string; error: string }> = [];

    // OpenClaw's agents.create schema (protocol v4) requires `name` +
    // `workspace`, and rejects unknown properties. The "default workspace"
    // for the gateway is broadcast as `mainKey` in the agents.list result.
    // Fall back to "default" if the server didn't expose one (shouldn't
    // happen on modern OpenClaw but the fallback keeps us defensive).
    const workspace = mainKey ?? "default";
    for (const action of actions) {
      if (action.kind !== "export-to-openclaw") continue;
      try {
        await this.oc.rpc("agents.create", {
          name: action.paperclip.name,
          workspace,
          model: "anthropic:claude-opus-4-7",
        });
        exportedToOpenClaw.push(action.paperclip.name);
        markReconciled(rows, action.name, this.now());
        // The newly-created OpenClaw agent has no url/token on its Paperclip
        // counterpart unless someone seeded it. Patch the PC agent so the
        // built-in openclaw_gateway adapter can actually invoke it on the
        // next heartbeat.
        await this.patchSlotAgentToOpenClaw(action.paperclip.id, action.paperclip.name);
      } catch (err) {
        exportFailures.push({
          name: action.paperclip.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Defensive auto-fill: any PC agent of this company with
    // adapterType=openclaw_gateway and a missing/empty `adapterConfig.url`
    // gets the bridge's URL/token patched in. This covers the
    // "New Agent -> OpenClaw Gateway -> Create" flow where Paperclip
    // creates the agent with an empty adapterConfig and the bridge would
    // otherwise leave it unusable.
    for (const a of paperclipAgents) {
      if (a.adapterType !== OPENCLAW_ADAPTER_TYPE) continue;
      const cfg = (a.adapterConfig as Record<string, unknown> | null) ?? {};
      const url = typeof cfg.url === "string" ? cfg.url : "";
      if (url.length > 0) continue;
      try {
        await this.patchSlotAgentToOpenClaw(a.id, a.name);
      } catch (err) {
        this.ctx.logger.warn("auto-fill adapterConfig failed", {
          agentId: a.id,
          name: a.name,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Import OpenClaw-only agents into Paperclip as managed agents so they
    // appear on /<companyPrefix>/agents with the openclaw_gateway adapter.
    // Each OpenClaw agent name is assigned to a deterministic slot from the
    // manifest's static slot pool (sorted by name for stability across syncs).
    const importResult = await this.materializeManagedAgents(companyId, ocNameToSlotKey, rows);

    const snapshot: SyncStatusSnapshot = {
      lastSyncAt: this.now(),
      lastError: exportFailures.length
        ? { at: this.now(), message: `${exportFailures.length} export(s) failed` }
        : null,
      rows,
      openclawHealthy: true,
      openclawHealthCheckedAt: this.now(),
    };

    await this.ctx.state.set(StateKeys.agentsSummary(companyId), snapshot);
    await this.ctx.state.set(StateKeys.lastSyncAt(companyId), snapshot.lastSyncAt);
    if (snapshot.lastError) {
      await this.ctx.state.set(StateKeys.lastError(companyId), snapshot.lastError);
    } else {
      // Best-effort clear of any previous error.
      try {
        await this.ctx.state.delete?.(StateKeys.lastError(companyId));
      } catch {
        // .delete may not exist on older SDKs; safe to ignore.
      }
    }

    return {
      companyId,
      rows,
      actions,
      exportedToOpenClaw,
      exportFailures,
      importedToPaperclip: importResult.imported,
      importFailures: importResult.failures,
    };
  }

  /**
   * Compute a stable OpenClaw-name → slot-key assignment for the OC agents
   * that don't already have a same-named Paperclip agent. Names that pair by
   * `agent.name === openclaw.name` are PC-originated (or were renamed to
   * match) and stay materialized through that original Paperclip agent row;
   * cloning them into a managed slot would create a duplicate row on the
   * agents page.
   *
   * Existing slot assignments are preserved so per-OC-agent Paperclip agent
   * IDs stay stable across syncs. Called BEFORE diff so the row-pairing has
   * the mapping it needs on the first sync.
   */
  private async computeSlotAssignments(
    companyId: string,
    openclawAgents: OpenClawAgentRecord[],
    paperclipAgents: Agent[],
  ): Promise<Record<string, string>> {
    // Names of Paperclip agents that aren't plugin-managed slots themselves —
    // these are the agent rows that "win" pairing by raw name and shouldn't
    // get a duplicate slot row.
    const nonSlotPcNames = new Set<string>();
    for (const a of paperclipAgents) {
      const meta = a.metadata as Record<string, unknown> | null | undefined;
      const marker = meta?.paperclipManagedResource as Record<string, unknown> | undefined;
      const isOurSlot =
        marker?.pluginKey === PLUGIN_ID && marker.resourceKind === "agent";
      if (!isOurSlot) nonSlotPcNames.add(a.name);
    }

    const sortedNames = [...openclawAgents]
      .map((a) => a.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0)
      .filter((n) => !nonSlotPcNames.has(n))
      .sort();

    const existing =
      ((await this.ctx.state.get(StateKeys.slotAssignments(companyId))) as
        | Record<string, string>
        | null) ?? {};
    const assignments: Record<string, string> = {};
    const usedSlots = new Set<string>();

    for (const name of sortedNames) {
      const prior = existing[name];
      if (prior && !usedSlots.has(prior)) {
        assignments[name] = prior;
        usedSlots.add(prior);
      }
    }
    let cursor = 0;
    for (const name of sortedNames) {
      if (assignments[name]) continue;
      while (cursor < OPENCLAW_AGENT_SLOT_COUNT && usedSlots.has(openclawSlotKey(cursor))) {
        cursor++;
      }
      if (cursor >= OPENCLAW_AGENT_SLOT_COUNT) break;
      const slot = openclawSlotKey(cursor);
      assignments[name] = slot;
      usedSlots.add(slot);
      cursor++;
    }
    return assignments;
  }

  /**
   * Materialize one Paperclip managed-agent row per assigned OpenClaw agent
   * via `ctx.agents.managed.reconcile()`. Slot keys are taken from a
   * precomputed assignment map; this method is responsible only for the host
   * RPC and persisting the final assignment state.
   */
  private async materializeManagedAgents(
    companyId: string,
    assignments: Record<string, string>,
    rows: SyncStatusSnapshot["rows"],
  ): Promise<{
    imported: Array<{ openclawName: string; slotKey: string; agentId: string | null }>;
    failures: Array<{ openclawName: string; error: string }>;
  }> {
    if (this.config.syncDirection === "paperclip-to-openclaw") {
      return { imported: [], failures: [] };
    }
    if (!this.ctx.agents.managed?.reconcile) {
      return { imported: [], failures: [] };
    }

    const imported: Array<{ openclawName: string; slotKey: string; agentId: string | null }> = [];
    const failures: Array<{ openclawName: string; error: string }> = [];

    const sortedNames = Object.keys(assignments).sort();
    for (const name of sortedNames) {
      const slotKey = assignments[name];
      if (!slotKey) {
        failures.push({
          openclawName: name,
          error: `no free managed-agent slot (cap=${OPENCLAW_AGENT_SLOT_COUNT}); bump OPENCLAW_AGENT_SLOT_COUNT and rebuild`,
        });
        continue;
      }
      try {
        const resolution = await this.ctx.agents.managed.reconcile(slotKey, companyId);
        const agentId = resolution.agentId ?? null;
        imported.push({ openclawName: name, slotKey, agentId });
        // Right after reconcile, rename the materialized agent to the real
        // OpenClaw name and seed its adapterConfig with the gateway URL +
        // token. This is what makes the agent invokable at runtime (the
        // built-in `openclaw_gateway` adapter uses `agent.name` to address
        // the OpenClaw agent and reads url/password from `adapterConfig`).
        if (agentId) {
          await this.patchSlotAgentToOpenClaw(agentId, name);
        }
        // The diff ran before materialization, so it didn't see the slot
        // agent we just created. Flip the row to "synced" now so the
        // snapshot matches the live state instead of forever showing the OC
        // agent as "openclaw-only" until the next sync cycle.
        markSynced(rows, name, slotKey, agentId, this.now());
      } catch (err) {
        failures.push({
          openclawName: name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // NOTE: Plugin SDK 2026.517.0 has no `agents.managed.delete`; the only
    // mutator is `reset`, which materializes the slot to its declared
    // defaults (it does NOT remove the row). So we deliberately don't try to
    // clean up orphan slot rows from a prior sync. Operators can delete a
    // stale "OpenClaw Agent N" row manually from /<companyPrefix>/agents if
    // an OpenClaw agent name was retired.
    try {
      await this.ctx.state.set(StateKeys.slotAssignments(companyId), assignments);
    } catch {
      // non-fatal — next sync will recompute
    }

    return { imported, failures };
  }

  async loadSnapshot(companyId: string): Promise<SyncStatusSnapshot | null> {
    if (!companyId) return null;
    const raw = await this.ctx.state.get(StateKeys.agentsSummary(companyId));
    return (raw as SyncStatusSnapshot | null) ?? null;
  }

  private async listPaperclipAgents(companyId: string): Promise<Agent[]> {
    const out: Agent[] = [];
    let offset = 0;
    const batch = 100;
    while (true) {
      const page = await this.ctx.agents.list({ companyId, limit: batch, offset });
      out.push(...page);
      if (page.length < batch) break;
      offset += batch;
      if (offset > 10_000) break; // sanity guard
    }
    return out;
  }

  /**
   * After `agents.managed.reconcile()` materializes a slot, immediately:
   *
   *   1. **Rename** the Paperclip agent to the OpenClaw agent's real name.
   *      The built-in `openclaw_gateway` adapter passes `agent.name` straight
   *      through as the `agentName` param of the gateway's `agent` RPC, so
   *      without this step the adapter would try to invoke a non-existent
   *      OpenClaw agent called *"OpenClaw Agent N"*.
   *
   *   2. **Seed `adapterConfig`** with `{ url, password, scopes }` from this
   *      plugin's config. The built-in adapter reads these from
   *      `adapterConfig` (not from plugin config), so without it heartbeats
   *      fail with `openclaw_gateway_url_missing`.
   *
   * Both writes go through Paperclip's `PATCH /api/agents/:id` REST route
   * over loopback. Plugin workers don't have a typed `agents.update` SDK
   * method in 2026.517.0, but Paperclip's `local_trusted` deployment mode
   * accepts loopback calls without auth, so this is safe in the same
   * environment the bridge already targets.
   */
  private async patchSlotAgentToOpenClaw(agentId: string, openclawName: string): Promise<void> {
    const baseUrl = this.config.paperclipApiUrl?.trim() || "http://127.0.0.1:3100";
    const body: Record<string, unknown> = {
      name: openclawName,
      title: `OpenClaw agent: ${openclawName}`,
      adapterConfig: {
        url: this.config.openclawUrl,
        // The built-in adapter resolves auth in this order:
        // adapterConfig.authToken, adapterConfig.token, x-openclaw-token
        // header, then the Authorization header. We pass it as both
        // `authToken` (primary) and `token` (legacy fallback) so any version
        // of the adapter we run against finds it.
        authToken: this.config.openclawToken,
        token: this.config.openclawToken,
        scopes: ["operator.read", "operator.write", "operator.admin"],
        // Share one warm OC session per agent across ALL invokes (heartbeats
        // and issue work). Default "issue" gives every new issue a fresh
        // session, paying the ~10-15s cold-start penalty per issue. "fixed"
        // makes issue #2+ reuse the warm session. Trade-off is cross-issue
        // context bleed on OC's side — acceptable for the bridge use case.
        sessionKeyStrategy: "fixed",
      },
    };
    const res = await fetch(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      this.ctx.logger.warn("patchSlotAgent failed", {
        agentId,
        openclawName,
        status: res.status,
        body: text.slice(0, 240),
      });
    }
  }

  private async recordError(companyId: string, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await this.ctx.state.set(StateKeys.lastError(companyId), { at: this.now(), message });
    } catch {
      // state writes during error reporting should never throw
    }
  }
}

function markReconciled(rows: SyncStatusSnapshot["rows"], name: string, at: number): void {
  const r = rows.find((x) => x.name === name);
  if (r) r.lastReconciledAt = new Date(at).toISOString();
}

function markSynced(
  rows: SyncStatusSnapshot["rows"],
  name: string,
  slotKey: string,
  agentId: string | null,
  at: number,
): void {
  const r = rows.find((x) => x.name === name);
  if (!r) return;
  r.state = "synced";
  r.slotKey = slotKey;
  r.lastReconciledAt = new Date(at).toISOString();
  if (agentId && r.openclaw) {
    // After patchSlotAgentToOpenClaw, the PC row carries the OpenClaw name.
    r.paperclip = {
      id: agentId,
      name,
      role: "general",
      adapterType: OPENCLAW_ADAPTER_TYPE,
    };
  }
}

/**
 * OpenClaw's real `agents.list` returns either a bare array (older mocks) or
 * `{ agents: [...], defaultId, mainKey, scope }`. Each row may use `id` instead
 * of `name`, may omit `role`, and may carry `model.primary` instead of `model`.
 * Normalize all shapes here.
 *
 * Returns the **envelope** so callers that need `mainKey` (the workspace
 * required by `agents.create`) can use it.
 */
export function normalizeOpenClawRoster(raw: unknown): OpenClawAgentRoster {
  const envelope = raw as { agents?: unknown[]; mainKey?: unknown } | null;
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(envelope?.agents)
      ? (envelope!.agents as unknown[])
      : [];
  const mainKey =
    envelope && typeof envelope.mainKey === "string" && envelope.mainKey.length > 0
      ? envelope.mainKey
      : null;
  const out: OpenClawAgentRecord[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    const name =
      (typeof a.name === "string" && a.name) ||
      (typeof a.id === "string" && a.id) ||
      "";
    if (!name) continue;
    const model =
      typeof a.model === "string"
        ? a.model
        : typeof (a.model as { primary?: unknown } | undefined)?.primary === "string"
          ? ((a.model as { primary: string }).primary)
          : undefined;
    out.push({
      name,
      role: typeof a.role === "string" ? a.role : undefined,
      model,
      systemPrompt: typeof a.systemPrompt === "string" ? a.systemPrompt : undefined,
      updatedAt: typeof a.updatedAt === "string" ? a.updatedAt : undefined,
      workspace: typeof a.workspace === "string" ? a.workspace : undefined,
    });
  }
  return { agents: out, mainKey };
}

/** Back-compat wrapper for callers that only need the agents array. */
export function normalizeOpenClawAgents(raw: unknown): OpenClawAgentRecord[] {
  return normalizeOpenClawRoster(raw).agents;
}
