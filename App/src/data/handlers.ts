import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { OpenClawClient } from "../clients/openclaw-client.js";
import { normalizeOpenClawRoster } from "../sync/agent-sync.js";
import { StateKeys } from "../state-keys.js";
import {
  DATA_ALL_BINDINGS,
  DATA_BOOTSTRAP_STATUS,
  DATA_COMPANIES,
  DATA_COMPANY_BINDING,
  DATA_GATEWAY_CONFIG,
  DATA_OPENCLAW_AGENTS,
  DATA_OPENCLAW_MODELS,
  DATA_OPENCLAW_WORKSPACES,
  DATA_SYNC_STATUS,
  PLUGIN_ID,
} from "../manifest.js";
import { EMPTY_BINDING } from "../types.js";
import type {
  BridgeConfig,
  CompanyBinding,
  OpenClawAgentRecord,
  SyncStatusSnapshot,
} from "../types.js";

export interface DataDeps {
  ctx: PluginContext;
  openclaw: OpenClawClient;
  config: () => BridgeConfig;
}

function readCompanyId(params: Record<string, unknown>): string | null {
  const v = params?.companyId;
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function registerData(deps: DataDeps): void {
  const { ctx, openclaw } = deps;

  ctx.data.register(DATA_SYNC_STATUS, async (params) => {
    const companyId = readCompanyId(params);
    if (!companyId) return emptySnapshot();
    const snapshot = (await ctx.state.get(StateKeys.agentsSummary(companyId))) as
      | SyncStatusSnapshot
      | null;
    return snapshot ?? emptySnapshot();
  });

  ctx.data.register(DATA_OPENCLAW_AGENTS, async () => {
    if (!openclaw.isOpen()) {
      openclaw.ensureConnecting();
      return { connected: false, agents: [] as OpenClawAgentRecord[] };
    }
    try {
      const raw = await openclaw.rpc<unknown>("agents.list", {});
      const roster = normalizeOpenClawRoster(raw);
      return { connected: true, agents: roster.agents, mainKey: roster.mainKey };
    } catch (err) {
      return {
        connected: false,
        agents: [] as OpenClawAgentRecord[],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ctx.data.register(DATA_OPENCLAW_MODELS, async () => {
    if (!openclaw.isOpen()) {
      openclaw.ensureConnecting();
      return { connected: false, models: [] as string[] };
    }
    const models = await openclaw.listAvailableModels();
    return { connected: true, models };
  });

  ctx.data.register(DATA_OPENCLAW_WORKSPACES, async () => {
    if (!openclaw.isOpen()) {
      openclaw.ensureConnecting();
      return { connected: false, workspaces: [] as string[] };
    }
    try {
      const raw = await openclaw.rpc<unknown>("agents.list", {});
      const roster = normalizeOpenClawRoster(raw);
      // Distinct workspaces across all agents, plus mainKey if the gateway
      // exposes one and it isn't already in the list. Sort for stable UI.
      const set = new Set<string>();
      for (const a of roster.agents) {
        if (typeof a.workspace === "string" && a.workspace.length > 0) set.add(a.workspace);
      }
      if (roster.mainKey) set.add(roster.mainKey);
      return {
        connected: true,
        workspaces: [...set].sort(),
        mainKey: roster.mainKey,
      };
    } catch (err) {
      return {
        connected: false,
        workspaces: [] as string[],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ctx.data.register(DATA_COMPANIES, async () => {
    try {
      const list = await ctx.companies.list({ limit: 200 });
      return {
        companies: list.map((c) => ({
          id: c.id,
          name: c.name,
          issuePrefix: c.issuePrefix,
        })),
      };
    } catch (err) {
      return {
        companies: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ctx.data.register(DATA_ALL_BINDINGS, async () => {
    try {
      const list = await ctx.companies.list({ limit: 200 });
      const bindings: Array<{
        companyId: string;
        companyName: string;
        issuePrefix: string;
        binding: CompanyBinding;
      }> = [];
      for (const c of list) {
        const stored = (await ctx.state.get(StateKeys.binding(c.id))) as
          | Partial<CompanyBinding>
          | null;
        // Older bindings (v1.3) didn't have `agentNames`. Normalize on read
        // so the UI never has to deal with undefined arrays.
        const binding: CompanyBinding = {
          enabled: Boolean(stored?.enabled),
          agentNames: Array.isArray(stored?.agentNames) ? stored!.agentNames!.filter((s): s is string => typeof s === "string") : [],
          workspaces: Array.isArray(stored?.workspaces) ? stored!.workspaces!.filter((s): s is string => typeof s === "string") : [],
        };
        bindings.push({
          companyId: c.id,
          companyName: c.name,
          issuePrefix: c.issuePrefix,
          binding,
        });
      }
      return { bindings };
    } catch (err) {
      return {
        bindings: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ctx.data.register(DATA_COMPANY_BINDING, async (params) => {
    const companyId = readCompanyId(params);
    if (!companyId) return { companyId: null, binding: EMPTY_BINDING };
    const binding = ((await ctx.state.get(StateKeys.binding(companyId))) as CompanyBinding | null) ??
      EMPTY_BINDING;
    return { companyId, binding };
  });

  ctx.data.register(DATA_BOOTSTRAP_STATUS, async (params) => {
    const companyId = readCompanyId(params);
    if (!companyId) return { bootstrapped: false };
    const status = await ctx.state.get(StateKeys.bootstrap(companyId));
    if (!status || typeof status !== "object") return { bootstrapped: false };
    return { bootstrapped: true, ...(status as Record<string, unknown>) };
  });

  // Expose the current gateway connection config so the SettingsPanel can
  // render it. Paperclip 2026.517.0 hides its auto-generated config form when
  // a plugin ships a custom settingsPage slot, so without this data source
  // operators have no UI to see/edit the URL + token.
  ctx.data.register(DATA_GATEWAY_CONFIG, async () => {
    const cfg = deps.config();
    const tokenLen = typeof cfg.openclawToken === "string" ? cfg.openclawToken.length : 0;
    return {
      pluginKey: PLUGIN_ID,
      openclawUrl: cfg.openclawUrl,
      // Never ship the raw token to the browser — only metadata. The user
      // sees "configured (48 chars)" / "missing" and re-enters when editing.
      tokenConfigured: tokenLen >= 16,
      tokenLen,
      syncDirection: cfg.syncDirection,
      conflictPolicy: cfg.conflictPolicy,
      autoSyncCron: cfg.autoSyncCron,
      healthCheckCron: cfg.healthCheckCron,
      paperclipApiUrl: cfg.paperclipApiUrl ?? "http://127.0.0.1:3100",
    };
  });
}

function emptySnapshot(): SyncStatusSnapshot {
  return {
    lastSyncAt: null,
    lastError: null,
    rows: [],
    openclawHealthy: null,
    openclawHealthCheckedAt: null,
  };
}
