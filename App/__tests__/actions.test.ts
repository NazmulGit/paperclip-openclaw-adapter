import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { registerActions } from "../src/actions/handlers.js";
import { registerData } from "../src/data/handlers.js";
import {
  ACTION_RUN_SYNC,
  ACTION_TEST_CONNECTION,
  DATA_OPENCLAW_AGENTS,
  DATA_OPENCLAW_MODELS,
  DATA_SYNC_STATUS,
} from "../src/manifest.js";
import type { BridgeConfig, SyncStatusSnapshot } from "../src/types.js";

function makeCtxStub(overrides: Partial<PluginContext> = {}) {
  const dataHandlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
  const actionHandlers = new Map<
    string,
    (params: Record<string, unknown>) => Promise<unknown>
  >();
  const ctx = {
    data: { register: vi.fn((k: string, fn) => dataHandlers.set(k, fn)) },
    actions: { register: vi.fn((k: string, fn) => actionHandlers.set(k, fn)) },
    secrets: { resolve: vi.fn(async () => "this-is-a-valid-token-1234") },
    state: { get: vi.fn(async () => null), set: vi.fn(async () => {}) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    ...overrides,
  } as unknown as PluginContext;
  return { ctx, dataHandlers, actionHandlers };
}

const cfg: BridgeConfig = {
  openclawUrl: "ws://x",
  openclawToken: "this-is-a-real-token-123456",
  companyId: "c1",
  syncDirection: "bidirectional",
  conflictPolicy: "newest-wins",
  autoSyncCron: "*/5 * * * *",
  healthCheckCron: "*/1 * * * *",
};

describe("registerActions", () => {
  it("run-sync invokes AgentSync.fullSync and returns the result shape", async () => {
    const sync = {
      readBinding: vi.fn(async () => null),
      fullSync: vi.fn(async () => ({
        companyId: "c1",
        rows: [],
        actions: [],
        exportedToOpenClaw: ["x"],
        exportFailures: [],
        importedToPaperclip: [],
        importFailures: [],
      })),
    };
    const oc = { isOpen: () => true, ping: vi.fn(async () => ({ ok: true })) };
    const { ctx, actionHandlers } = makeCtxStub();
    registerActions({ ctx, openclaw: oc as never, sync: sync as never, config: () => cfg });

    const handler = actionHandlers.get(ACTION_RUN_SYNC);
    expect(handler).toBeDefined();
    // run-sync now takes an explicit companyId param (multi-company bindings).
    const result = (await handler!({ companyId: "c1" })) as {
      ok: boolean;
      rowCount: number;
      exported: string[];
    };
    expect(result.ok).toBe(true);
    expect(result.exported).toEqual(["x"]);
    expect(sync.fullSync).toHaveBeenCalledTimes(1);
  });

  it("run-sync surfaces an error when no companyId is provided and syncAll is off", async () => {
    const sync = { fullSync: vi.fn(), syncAllBound: vi.fn() };
    const oc = { isOpen: () => true, ping: vi.fn() };
    const { ctx, actionHandlers } = makeCtxStub();
    registerActions({
      ctx,
      openclaw: oc as never,
      sync: sync as never,
      config: () => ({ ...cfg, companyId: null }),
    });
    const result = (await actionHandlers.get(ACTION_RUN_SYNC)!({})) as { ok: boolean };
    expect(result.ok).toBe(false);
    expect(sync.fullSync).not.toHaveBeenCalled();
  });

  it("test-connection chains secret → websocket → rpc and reports the failing stage", async () => {
    const sync = { fullSync: vi.fn() };
    const oc = { isOpen: () => true, ping: vi.fn(async () => ({ ok: true })) };
    const { ctx, actionHandlers } = makeCtxStub();
    registerActions({ ctx, openclaw: oc as never, sync: sync as never, config: () => cfg });
    const happy = (await actionHandlers.get(ACTION_TEST_CONNECTION)!({})) as { ok: boolean };
    expect(happy.ok).toBe(true);

    // Now break the WS layer.
    const oc2 = { isOpen: () => false, ping: vi.fn() };
    const { ctx: ctx2, actionHandlers: ah2 } = makeCtxStub();
    registerActions({ ctx: ctx2, openclaw: oc2 as never, sync: sync as never, config: () => cfg });
    const wsBad = (await ah2.get(ACTION_TEST_CONNECTION)!({})) as { ok: boolean; stage?: string };
    expect(wsBad.ok).toBe(false);
    expect(wsBad.stage).toBe("websocket");
  });
});

describe("registerData", () => {
  it("sync-status returns empty snapshot when companyId missing", async () => {
    const oc = { isOpen: () => false, rpc: vi.fn() };
    const { ctx, dataHandlers } = makeCtxStub();
    registerData({ ctx, openclaw: oc as never, config: () => ({ ...cfg, companyId: null }) });
    const result = (await dataHandlers.get(DATA_SYNC_STATUS)!({})) as SyncStatusSnapshot;
    expect(result.rows).toEqual([]);
    expect(result.lastSyncAt).toBeNull();
  });

  it("openclaw-agents returns connected:false when ws is down", async () => {
    const oc = { isOpen: () => false, rpc: vi.fn(), ensureConnecting: vi.fn() };
    const { ctx, dataHandlers } = makeCtxStub();
    registerData({ ctx, openclaw: oc as never, config: () => cfg });
    const result = (await dataHandlers.get(DATA_OPENCLAW_AGENTS)!({})) as { connected: boolean };
    expect(result.connected).toBe(false);
    expect(oc.rpc).not.toHaveBeenCalled();
    // Down-state should also kick a non-blocking reconnect attempt.
    expect(oc.ensureConnecting).toHaveBeenCalled();
  });

  it("openclaw-agents proxies agents.list when ws is open", async () => {
    const oc = {
      isOpen: () => true,
      rpc: vi.fn(async () => [{ name: "scout" }]),
      ensureConnecting: vi.fn(),
    };
    const { ctx, dataHandlers } = makeCtxStub();
    registerData({ ctx, openclaw: oc as never, config: () => cfg });
    const result = (await dataHandlers.get(DATA_OPENCLAW_AGENTS)!({})) as {
      connected: boolean;
      agents: Array<{ name: string }>;
    };
    expect(result.connected).toBe(true);
    expect(result.agents).toEqual([{ name: "scout" }]);
  });

  it("openclaw-models returns the gateway's model catalog via listAvailableModels", async () => {
    const oc = {
      isOpen: () => true,
      ensureConnecting: vi.fn(),
      listAvailableModels: vi.fn(async () => [
        "anthropic:claude-opus-4-7",
        "anthropic:claude-sonnet-4-6",
      ]),
    };
    const { ctx, dataHandlers } = makeCtxStub();
    registerData({ ctx, openclaw: oc as never, config: () => cfg });
    const result = (await dataHandlers.get(DATA_OPENCLAW_MODELS)!({})) as {
      connected: boolean;
      models: string[];
    };
    expect(result.connected).toBe(true);
    expect(result.models).toEqual([
      "anthropic:claude-opus-4-7",
      "anthropic:claude-sonnet-4-6",
    ]);
    expect(oc.listAvailableModels).toHaveBeenCalled();
  });

  it("openclaw-models returns connected:false and kicks ensureConnecting when ws is down", async () => {
    const oc = {
      isOpen: () => false,
      ensureConnecting: vi.fn(),
      listAvailableModels: vi.fn(),
    };
    const { ctx, dataHandlers } = makeCtxStub();
    registerData({ ctx, openclaw: oc as never, config: () => cfg });
    const result = (await dataHandlers.get(DATA_OPENCLAW_MODELS)!({})) as {
      connected: boolean;
      models: string[];
    };
    expect(result.connected).toBe(false);
    expect(result.models).toEqual([]);
    expect(oc.ensureConnecting).toHaveBeenCalled();
    expect(oc.listAvailableModels).not.toHaveBeenCalled();
  });
});
