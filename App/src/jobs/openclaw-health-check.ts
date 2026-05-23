import type { PluginContext, PluginJobContext } from "@paperclipai/plugin-sdk";
import type { OpenClawClient } from "../clients/openclaw-client.js";
import { StateKeys } from "../state-keys.js";
import type { BridgeConfig, SyncStatusSnapshot } from "../types.js";

export interface HealthJobDeps {
  ctx: PluginContext;
  openclaw: OpenClawClient;
  config: () => BridgeConfig;
  now?: () => number;
}

export function makeHealthJob(deps: HealthJobDeps): (job: PluginJobContext) => Promise<void> {
  const now = deps.now ?? Date.now;
  return async (_job: PluginJobContext) => {
    const cfg = deps.config();
    if (!cfg.companyId) return;
    const ping = await deps.openclaw.ping();
    await deps.ctx.state.set(StateKeys.openclawHealth(cfg.companyId), {
      ok: ping.ok,
      at: now(),
      error: ping.error ?? null,
    });
    // Best-effort: also flip the openclawHealthy bit on the snapshot so the
    // status widget reflects connectivity without waiting for the next sync.
    const summary = (await deps.ctx.state.get(StateKeys.agentsSummary(cfg.companyId))) as
      | SyncStatusSnapshot
      | null;
    if (summary) {
      const next: SyncStatusSnapshot = {
        ...summary,
        openclawHealthy: ping.ok,
        openclawHealthCheckedAt: now(),
      };
      await deps.ctx.state.set(StateKeys.agentsSummary(cfg.companyId), next);
    }
  };
}
