import { definePlugin, runWorker, startWorkerRpcHost } from "@paperclipai/plugin-sdk";
import manifest, { TOOL_LIST_CHANNELS } from "./manifest.js";
import { loadConfig, normalizeConfig, tryResolveSecret, validateConfigStructure } from "./config.js";
import { OpenClawClient } from "./clients/openclaw-client.js";
import { AgentSync } from "./sync/agent-sync.js";
import { EventBridge } from "./events/event-bridge.js";
import { registerData } from "./data/handlers.js";
import { registerActions } from "./actions/handlers.js";
import { makeSyncJob } from "./jobs/sync-openclaw.js";
import { makeHealthJob } from "./jobs/openclaw-health-check.js";
import { SYNC_JOB_KEY, HEALTH_JOB_KEY } from "./manifest.js";
import { StateKeys } from "./state-keys.js";
import type { BridgeConfig } from "./types.js";

interface Runtime {
  config: BridgeConfig;
  openclaw: OpenClawClient;
  sync: AgentSync;
  bridge: EventBridge;
}

let runtime: Runtime | null = null;

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("openclaw-bridge starting", { id: manifest.id, version: manifest.version });

    runtime = await bootRuntime(ctx);

    registerData({
      ctx,
      openclaw: runtime.openclaw,
      config: () => runtime!.config,
    });

    registerActions({
      ctx,
      openclaw: runtime.openclaw,
      sync: runtime.sync,
      config: () => runtime!.config,
    });

    ctx.tools.register(
      TOOL_LIST_CHANNELS,
      {
        displayName: "List OpenClaw channels",
        description: "Return the live channels configured on the connected OpenClaw gateway.",
        parametersSchema: { type: "object", additionalProperties: false, properties: {} },
      },
      async () => {
        if (!runtime?.openclaw.isOpen()) {
          return { error: "not connected to OpenClaw" };
        }
        try {
          const data = await runtime.openclaw.rpc<unknown>("channels.status", {});
          return { content: JSON.stringify(data) };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    );

    ctx.jobs.register(
      SYNC_JOB_KEY,
      makeSyncJob({ ctx, sync: runtime.sync, config: () => runtime!.config }),
    );
    ctx.jobs.register(
      HEALTH_JOB_KEY,
      makeHealthJob({ ctx, openclaw: runtime.openclaw, config: () => runtime!.config }),
    );

    runtime.bridge.attach();

    ctx.logger.info("openclaw-bridge ready", {
      companyId: runtime.config.companyId,
      url: runtime.config.openclawUrl,
    });
  },

  async onHealth() {
    if (!runtime) return { status: "error", message: "runtime not initialized" };
    const ocOpen = runtime.openclaw.isOpen();
    return {
      status: ocOpen ? "ok" : "degraded",
      message: ocOpen ? "connected to OpenClaw" : "OpenClaw connection down",
      details: { url: runtime.config.openclawUrl, companyId: runtime.config.companyId },
    };
  },

  // No onConfigChanged: the SDK default restarts the worker on config change,
  // which gives us a clean re-init of OpenClaw client + AgentSync + EventBridge
  // against the new URL/token without manual surgery.

  async onValidateConfig(rawConfig) {
    const cfg = normalizeConfig(rawConfig);
    const structural = validateConfigStructure(cfg);
    const warnings = structural.filter((i) => i.level === "warn").map((i) => `${i.field}: ${i.message}`);
    const errors = structural.filter((i) => i.level === "error").map((i) => `${i.field}: ${i.message}`);
    return { ok: errors.length === 0, warnings, errors };
  },

  async onShutdown() {
    try {
      runtime?.bridge.detach();
      runtime?.openclaw.close();
    } catch {
      // best-effort
    }
    runtime = null;
  },
});

async function bootRuntime(ctx: Parameters<NonNullable<typeof plugin.definition.setup>>[0]): Promise<Runtime> {
  const config = await loadConfig(ctx);

  // First-install convenience: if no companies have an opt-in binding yet,
  // auto-bind the first visible company (workspace filter = "all"). The user
  // can change this in the SettingsPanel.
  try {
    const companies = await ctx.companies.list({ limit: 50 });
    let anyBound = false;
    for (const c of companies) {
      const existing = await ctx.state.get(StateKeys.binding(c.id));
      if (existing) {
        anyBound = true;
        break;
      }
    }
    if (!anyBound && companies[0]?.id) {
      const first = companies[0].id;
      await ctx.state.set(StateKeys.binding(first), { enabled: true, workspaces: [] });
      ctx.logger.info(`openclaw-bridge: auto-bound first company ${first}`);
    }
  } catch (err) {
    ctx.logger.warn("openclaw-bridge: company auto-bind failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  if (config.openclawToken && config.openclawToken.length >= 16) {
    ctx.logger.info("openclaw-bridge: gateway token from instance config");
  } else {
    ctx.logger.warn("openclaw-bridge: gateway token missing — set openclawToken in plugin config");
  }

  const openclaw = new OpenClawClient({
    url: config.openclawUrl,
    token: config.openclawToken,
    onLog: (level, message, meta) => ctx.logger[level](message, meta),
  });

  if (config.openclawToken) {
    // Fire-and-forget initial connect. The client schedules its own
    // exponential-backoff reconnects on close/error, so we don't need to
    // block worker boot on a flaky gateway. Failures here are logged but
    // never fatal — the data handlers and Test Connection button both fall
    // back to ensureConnecting() / connect() to kick a retry on demand.
    void openclaw.connect().catch((err) =>
      ctx.logger.warn("initial OpenClaw connect failed (background retry scheduled)", {
        err: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  const sync = new AgentSync({ ctx, openclaw, config });
  const bridge = new EventBridge({ ctx, openclaw, config });

  return { config, openclaw, sync, bridge };
}

export default plugin;

// On Windows, the SDK's `runWorker(plugin, import.meta.url)` entrypoint check
// trips over drive-letter URL conversion (ERR_UNSUPPORTED_ESM_URL_SCHEME).
// Detect "this process was spawned to run me" by checking argv[1] against the
// compiled worker filename and then start the RPC host directly. When the
// module is imported (tests/re-exports), the heuristic is false and nothing
// runs — same semantics as `runWorker`.
const argv1 = process.argv[1] ?? "";
if (argv1.replace(/\\/g, "/").toLowerCase().endsWith("/dist/worker.js")) {
  startWorkerRpcHost({ plugin });
} else {
  // Fall back to the SDK helper for non-Windows or non-standard layouts.
  runWorker(plugin, import.meta.url);
}
