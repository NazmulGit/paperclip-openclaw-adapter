import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { OpenClawClient } from "../clients/openclaw-client.js";
import type { AgentSync, MultiSyncResult, SyncRunResult } from "../sync/agent-sync.js";
import { normalizeOpenClawRoster } from "../sync/agent-sync.js";
import { StateKeys } from "../state-keys.js";
import {
  ACTION_BOOTSTRAP_TOKEN,
  ACTION_CHAT_HISTORY,
  ACTION_CHAT_SEND,
  ACTION_RUN_SYNC,
  ACTION_SAVE_BINDING,
  ACTION_SAVE_BULK,
  ACTION_TEST_CONNECTION,
  OPENCLAW_ADAPTER_TYPE,
} from "../manifest.js";
import type { BridgeConfig, CompanyBinding } from "../types.js";
import { EMPTY_BINDING } from "../types.js";

export interface ActionsDeps {
  ctx: PluginContext;
  openclaw: OpenClawClient;
  sync: AgentSync;
  config: () => BridgeConfig;
}

function readString(params: Record<string, unknown>, key: string): string | null {
  const v = params?.[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function readStringArray(params: Record<string, unknown>, key: string): string[] {
  const v = params?.[key];
  if (!Array.isArray(v)) return [];
  return v.filter((s): s is string => typeof s === "string" && s.length > 0);
}

function readBindingFromParams(params: Record<string, unknown>): CompanyBinding {
  return {
    enabled: Boolean(params?.enabled),
    agentNames: readStringArray(params, "agentNames"),
    workspaces: readStringArray(params, "workspaces"),
  };
}

export function registerActions(deps: ActionsDeps): void {
  const { ctx, openclaw, sync, config } = deps;

  ctx.actions.register(ACTION_RUN_SYNC, async (params) => {
    const companyId = readString(params ?? {}, "companyId");
    const syncAllWhenMissing = params?.syncAll === true;
    try {
      if (companyId) {
        // Sync just one company. Use its stored binding if any so the
        // workspace filter still applies.
        const binding = (await sync.readBinding(companyId)) ?? { ...EMPTY_BINDING, enabled: true };
        const result = await sync.fullSync(companyId, binding);
        return {
          ok: true,
          mode: "single",
          ...summariseSingle(result),
        };
      }
      if (syncAllWhenMissing) {
        const multi = await sync.syncAllBound();
        return {
          ok: true,
          mode: "multi",
          ...summariseMulti(multi),
        };
      }
      return { ok: false, error: "companyId required (or pass syncAll=true)" };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ctx.actions.register(ACTION_TEST_CONNECTION, async () => {
    const cfg = config();
    if (!cfg.openclawToken || cfg.openclawToken.length < 16) {
      return { ok: false, stage: "token", error: "gateway token missing or too short" };
    }
    // If the WS isn't open, try to (re)connect on the user's click instead
    // of asking the user to disable/enable the plugin.
    if (!openclaw.isOpen()) {
      try {
        await openclaw.connect();
      } catch (err) {
        return {
          ok: false,
          stage: "websocket",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
    const ping = await openclaw.ping();
    if (!ping.ok) {
      return { ok: false, stage: "rpc", error: ping.error ?? "ping failed" };
    }
    return { ok: true, message: "OpenClaw gateway reachable" };
  });

  ctx.actions.register(ACTION_CHAT_SEND, async (params) => {
    const agentName = readString(params ?? {}, "agentName");
    const message = readString(params ?? {}, "message");
    if (!agentName || !message) {
      return { ok: false, error: "agentName and message are required" };
    }
    if (!openclaw.isOpen()) {
      try {
        await openclaw.connect();
      } catch (err) {
        return { ok: false, stage: "websocket", error: err instanceof Error ? err.message : String(err) };
      }
    }
    try {
      // Use OpenClaw's `agents.list` to find the agent's id from its name,
      // then `sessions.create` to spin up a session and send the message.
      // We bypass the Paperclip-core openclaw_gateway adapter entirely
      // here — it speaks the v3 schema and breaks against OpenClaw 2026.5.x.
      const raw = await openclaw.rpc<unknown>("agents.list", {});
      // Look at the unnormalized list because OpenClaw 2026.5.x returns each
      // agent as `{ id, name?, workspace, ... }` — `id` is the addressable
      // key for `sessions.create`. Our normalizer flattens name<-id when
      // name is missing, which makes lookups by name lossy in this path.
      const envelope = raw as { agents?: Array<{ id?: string; name?: string }> };
      const target = (envelope.agents ?? []).find(
        (a) => a.name === agentName || a.id === agentName,
      );
      const targetId = target?.id ?? target?.name;
      if (!targetId) {
        return {
          ok: false,
          stage: "agents.list",
          error: `OpenClaw agent '${agentName}' not found`,
          availableAgents: normalizeOpenClawRoster(raw).agents.map((a) => a.name),
        };
      }
      // Labels must be unique per agent in OpenClaw. Include a short
      // random suffix so repeated test sends don't trip "label already in
      // use".
      const label = `paperclip-bridge-test-${Date.now().toString(36)}`;
      const session = await openclaw.rpc<{ key?: string; sessionId?: string; reply?: string }>(
        "sessions.create",
        {
          agentId: targetId,
          message,
          label,
        },
        { timeoutMs: 60_000 },
      );
      return {
        ok: true,
        agentName,
        agentId: targetId,
        sessionKey: session.key ?? null,
        sessionId: session.sessionId ?? null,
        reply: session.reply ?? null,
        raw: session,
      };
    } catch (err) {
      return { ok: false, stage: "openclaw", error: err instanceof Error ? err.message : String(err) };
    }
  });

  ctx.actions.register(ACTION_CHAT_HISTORY, async (params) => {
    const sessionKey = readString(params ?? {}, "sessionKey");
    if (!sessionKey) return { ok: false, error: "sessionKey required" };
    if (!openclaw.isOpen()) {
      try { await openclaw.connect(); } catch (err) {
        return { ok: false, stage: "websocket", error: err instanceof Error ? err.message : String(err) };
      }
    }
    try {
      const res = await openclaw.rpc<{ messages?: Array<Record<string, unknown>> }>(
        "chat.history",
        { sessionKey, limit: 50 },
        { timeoutMs: 15_000 },
      );
      return { ok: true, sessionKey, messages: res.messages ?? [] };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ctx.actions.register(ACTION_SAVE_BULK, async (params) => {
    const companyIds = readStringArray(params ?? {}, "companyIds");
    const agentNames = readStringArray(params ?? {}, "agentNames");
    if (companyIds.length === 0) return { ok: false, error: "Pick at least one Paperclip company." };
    if (agentNames.length === 0) return { ok: false, error: "Pick at least one OpenClaw agent." };
    const saved: Array<{ companyId: string; agentNames: string[] }> = [];
    const failures: Array<{ companyId: string; error: string }> = [];
    for (const cid of companyIds) {
      try {
        await sync.writeBinding(cid, { enabled: true, agentNames, workspaces: [] });
        saved.push({ companyId: cid, agentNames });
      } catch (err) {
        failures.push({ companyId: cid, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { ok: failures.length === 0, saved, failures };
  });

  ctx.actions.register(ACTION_SAVE_BINDING, async (params) => {
    const companyId = readString(params ?? {}, "companyId");
    if (!companyId) return { ok: false, error: "companyId required" };
    const binding = readBindingFromParams(params ?? {});
    try {
      await sync.writeBinding(companyId, binding);
      return { ok: true, companyId, binding };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // Auto-bootstrap PC API keys for every OC-bridged agent. Each PC agent gets
  // its OWN long-lived API key via `POST /api/agents/:id/keys` so the token
  // authenticates AS that agent (otherwise mutations like checkout/PATCH
  // return 403 — "bearer token identity doesn't match assignee"). The token
  // is then inlined into the agent's `adapterConfig.payloadTemplate.message`
  // so it travels with every wake event and the OC runtime never has to read
  // a credential file (container-friendly).
  //
  // We still write the first key to ~/.openclaw/workspace/paperclip-claimed-api-key.json
  // for backward compatibility with smoke tests / OC agents that prefer the
  // canonical file path.
  ctx.actions.register(ACTION_BOOTSTRAP_TOKEN, async (params) => {
    const companyId = readString(params ?? {}, "companyId");
    if (!companyId) return { ok: false, error: "companyId required" };
    const baseUrl = (config().paperclipApiUrl ?? "").trim() || "http://127.0.0.1:3100";

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const apiFetch = async (path: string, init: { method: string; body?: unknown } = { method: "GET" }) => {
      const res = await fetch(`${baseUrl}${path}`, {
        method: init.method,
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
      const text = await res.text();
      let json: unknown = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
      if (!res.ok) {
        throw new Error(`PC ${init.method} ${path} -> ${res.status}: ${text.slice(0, 240)}`);
      }
      return json as Record<string, unknown>;
    };

    try {
      // 1. Find every OC-bridged agent in this company.
      const allAgents = await ctx.agents.list({ companyId, limit: 200 });
      const ocAgents = allAgents.filter((a) => a.adapterType === OPENCLAW_ADAPTER_TYPE);
      if (ocAgents.length === 0) {
        return { ok: false, error: "no openclaw_gateway agents in this company; run sync first" };
      }

      // 2. Mint a per-agent API key for each. The key authenticates AS that
      //    agent, so when OC calls back to PC with that bearer token, PC's
      //    permission check sees the assignee's own identity and allows the
      //    mutation. PC's POST /agents/:id/keys returns { id, name, key }
      //    where `key` is the full secret (shown once).
      const keyName = `openclaw-bridge-${new Date().toISOString().slice(0, 10)}`;
      const perAgentResults: Array<{
        agentId: string;
        agentName: string;
        keyId: string | null;
        ok: boolean;
        error?: string;
      }> = [];
      let firstKey: string | null = null;

      for (const a of ocAgents) {
        try {
          const created = await apiFetch(`/api/agents/${encodeURIComponent(a.id)}/keys`, {
            method: "POST",
            body: { name: keyName },
          });
          const token =
            typeof created.key === "string"
              ? created.key
              : typeof created.token === "string"
                ? created.token
                : null;
          if (!token) throw new Error("create-key response missing key/token");
          if (!firstKey) firstKey = token;

          // Inline the token into adapterConfig.payloadTemplate.message so it
          // travels with every wake event. The built-in adapter passes
          // payloadTemplate.message straight through to OC; the wake text in
          // execute.js then concatenates after, and Claude picks up the
          // earlier "Set PAPERCLIP_API_KEY=..." line.
          const existing = (a.adapterConfig as Record<string, unknown> | null) ?? {};
          const existingTemplate = (existing.payloadTemplate as Record<string, unknown> | null) ?? {};
          const messageLine = `Set PAPERCLIP_API_KEY=${token} and PAPERCLIP_AGENT_ID=${a.id} in your run context before running Paperclip heartbeat steps.`;
          const nextTemplate = { ...existingTemplate, message: messageLine };
          const patchRes = await fetch(`${baseUrl}/api/agents/${encodeURIComponent(a.id)}`, {
            method: "PATCH",
            headers,
            body: JSON.stringify({
              adapterConfig: { ...existing, payloadTemplate: nextTemplate },
            }),
          });
          if (!patchRes.ok) {
            const txt = await patchRes.text().catch(() => "");
            throw new Error(`PATCH agent -> ${patchRes.status}: ${txt.slice(0, 240)}`);
          }
          perAgentResults.push({
            agentId: a.id,
            agentName: a.name,
            keyId: typeof created.id === "string" ? created.id : null,
            ok: true,
          });
        } catch (err) {
          perAgentResults.push({
            agentId: a.id,
            agentName: a.name,
            keyId: null,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // 3. Write the canonical file (first agent's key — used by OC deployments
      //    that still load from the well-known path). Match Paperclip smoke
      //    format: { token, apiKey } both same value.
      let filePath: string | null = null;
      if (firstKey) {
        filePath = join(homedir(), ".openclaw", "workspace", "paperclip-claimed-api-key.json");
        await fs.mkdir(dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, JSON.stringify({ token: firstKey, apiKey: firstKey }, null, 2), "utf8");
      }

      // 4. Persist bootstrap status so the UI can render it.
      const at = Date.now();
      const successCount = perAgentResults.filter((r) => r.ok).length;
      await ctx.state.set(StateKeys.bootstrap(companyId), {
        at,
        filePath,
        keyName,
        perAgent: perAgentResults,
        successCount,
      });

      return {
        ok: successCount > 0,
        filePath,
        keyName,
        successCount,
        totalAgents: perAgentResults.length,
        perAgent: perAgentResults,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

function summariseSingle(result: SyncRunResult) {
  return {
    companyId: result.companyId,
    rowCount: result.rows.length,
    exported: result.exportedToOpenClaw,
    exportFailures: result.exportFailures,
    imported: result.importedToPaperclip,
    importFailures: result.importFailures,
  };
}

function summariseMulti(multi: MultiSyncResult) {
  return {
    companies: multi.companies.map(summariseSingle),
    skipped: multi.skipped,
  };
}
