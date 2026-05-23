import { describe, expect, it, vi } from "vitest";
import type { PluginContext, PluginJobContext } from "@paperclipai/plugin-sdk";
import { makeSyncJob } from "../src/jobs/sync-openclaw.js";
import { makeHealthJob } from "../src/jobs/openclaw-health-check.js";
import { StateKeys } from "../src/state-keys.js";
import type { BridgeConfig } from "../src/types.js";

const cfg: BridgeConfig = {
  openclawUrl: "ws://x",
  openclawToken: "T",
  companyId: "c1",
  syncDirection: "bidirectional",
  conflictPolicy: "newest-wins",
  autoSyncCron: "*/5 * * * *",
  healthCheckCron: "*/1 * * * *",
};

const job: PluginJobContext = {
  jobKey: "openclaw-sync",
  runId: "run_x",
  trigger: "schedule",
  scheduledAt: "2026-05-23T12:00:00Z",
};

function makeCtx() {
  const state = new Map<string, unknown>();
  const ctx = {
    state: {
      get: vi.fn(async (k: { stateKey: string }) => state.get(JSON.stringify(k)) ?? null),
      set: vi.fn(async (k: { stateKey: string }, v: unknown) => {
        state.set(JSON.stringify(k), v);
      }),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as PluginContext;
  return { ctx, state };
}

describe("makeSyncJob", () => {
  it("runs fullSync and logs success counts", async () => {
    const { ctx } = makeCtx();
    const sync = {
      fullSync: vi.fn(async () => ({
        rows: [{}, {}],
        actions: [],
        exportedToOpenClaw: ["a"],
        exportFailures: [],
      })),
    };
    await makeSyncJob({ ctx, sync: sync as never, config: () => cfg })(job);
    expect(sync.fullSync).toHaveBeenCalled();
    expect((ctx.logger.info as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe(
      "openclaw-sync completed",
    );
  });

  it("skips fullSync when companyId is missing", async () => {
    const { ctx } = makeCtx();
    const sync = { fullSync: vi.fn() };
    await makeSyncJob({ ctx, sync: sync as never, config: () => ({ ...cfg, companyId: null }) })(job);
    expect(sync.fullSync).not.toHaveBeenCalled();
  });

  it("logs error but does not throw when fullSync rejects", async () => {
    const { ctx } = makeCtx();
    const sync = { fullSync: vi.fn(async () => { throw new Error("ws gone"); }) };
    await expect(
      makeSyncJob({ ctx, sync: sync as never, config: () => cfg })(job),
    ).resolves.toBeUndefined();
    expect(ctx.logger.error).toHaveBeenCalled();
  });
});

describe("makeHealthJob", () => {
  it("writes ping result + flips openclawHealthy on existing snapshot", async () => {
    const { ctx, state } = makeCtx();
    // Pre-seed an existing snapshot so the job can patch it.
    state.set(JSON.stringify(StateKeys.agentsSummary("c1")), {
      lastSyncAt: 1,
      lastError: null,
      rows: [],
      openclawHealthy: false,
      openclawHealthCheckedAt: null,
    });
    const oc = { ping: vi.fn(async () => ({ ok: true })) };
    await makeHealthJob({ ctx, openclaw: oc as never, config: () => cfg, now: () => 12345 })(job);

    const healthRow = state.get(JSON.stringify(StateKeys.openclawHealth("c1")));
    expect(healthRow).toMatchObject({ ok: true, at: 12345, error: null });

    const summary = state.get(JSON.stringify(StateKeys.agentsSummary("c1"))) as {
      openclawHealthy: boolean;
      openclawHealthCheckedAt: number;
    };
    expect(summary.openclawHealthy).toBe(true);
    expect(summary.openclawHealthCheckedAt).toBe(12345);
  });

  it("records ping failure with error", async () => {
    const { ctx, state } = makeCtx();
    const oc = { ping: vi.fn(async () => ({ ok: false, error: "not_connected" })) };
    await makeHealthJob({ ctx, openclaw: oc as never, config: () => cfg, now: () => 1 })(job);
    expect(state.get(JSON.stringify(StateKeys.openclawHealth("c1")))).toMatchObject({
      ok: false,
      error: "not_connected",
    });
  });
});
