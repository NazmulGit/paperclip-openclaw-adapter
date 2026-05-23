import type { PluginContext, PluginJobContext } from "@paperclipai/plugin-sdk";
import type { AgentSync } from "../sync/agent-sync.js";
import type { BridgeConfig } from "../types.js";

export interface SyncJobDeps {
  ctx: PluginContext;
  sync: AgentSync;
  config: () => BridgeConfig;
}

export function makeSyncJob(deps: SyncJobDeps): (job: PluginJobContext) => Promise<void> {
  return async (job: PluginJobContext) => {
    try {
      const result = await deps.sync.syncAllBound();
      deps.ctx.logger.info("openclaw-sync completed", {
        runId: job.runId,
        companies: result.companies.length,
        skipped: result.skipped.length,
        totalRows: result.companies.reduce((n, c) => n + c.rows.length, 0),
        totalExported: result.companies.reduce((n, c) => n + c.exportedToOpenClaw.length, 0),
        totalImported: result.companies.reduce((n, c) => n + c.importedToPaperclip.length, 0),
      });
    } catch (err) {
      deps.ctx.logger.error("openclaw-sync failed", {
        runId: job.runId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
