import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, PluginContext } from "@paperclipai/plugin-sdk";
import { AgentSync, pickPreferredModel } from "../src/sync/agent-sync.js";
import { StateKeys } from "../src/state-keys.js";
import type { BridgeConfig, OpenClawAgentRecord, SyncStatusSnapshot } from "../src/types.js";

// AgentSync.patchSlotAgentToOpenClaw uses global fetch to call PC's REST API
// after each materialize / export. Unit tests don't need to assert against
// it — just make sure it doesn't throw.
const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = vi.fn(
    async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
  ) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

type RecordedRpc = { method: string; params: unknown };

function makeOpenClaw(opts: {
  agents: OpenClawAgentRecord[];
  onCreate?: (params: unknown) => void;
  createShouldThrow?: boolean;
}) {
  const calls: RecordedRpc[] = [];
  return {
    calls,
    client: {
      rpc: vi.fn(async (method: string, params: unknown) => {
        calls.push({ method, params });
        if (method === "agents.list") return opts.agents;
        if (method === "agents.create") {
          if (opts.createShouldThrow) throw new Error("upstream create failed");
          opts.onCreate?.(params);
          return { ok: true };
        }
        throw new Error(`unexpected rpc ${method}`);
      }),
    },
  };
}

function makeCtx(opts: {
  paperclipAgents: Agent[];
  companies?: Array<{ id: string }>;
  managedReconcile?: (slotKey: string, companyId: string) => Promise<{ agentId: string | null }>;
}) {
  const state = new Map<string, unknown>();
  const ctx = {
    agents: {
      list: vi.fn(async () => opts.paperclipAgents),
      managed: {
        reconcile: vi.fn(opts.managedReconcile ?? (async (slotKey: string) => ({
          agentId: `agt_managed_${slotKey}`,
        }))),
      },
    },
    companies: { list: vi.fn(async () => opts.companies ?? []) },
    state: {
      get: vi.fn(async (key: { stateKey: string }) => state.get(JSON.stringify(key)) ?? null),
      set: vi.fn(async (key: { stateKey: string }, value: unknown) => {
        state.set(JSON.stringify(key), value);
      }),
      delete: vi.fn(async (key: { stateKey: string }) => {
        state.delete(JSON.stringify(key));
      }),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as PluginContext;
  return { ctx, state };
}

function pcAgent(name: string, role = "general", adapterType = "openclaw_gateway"): Agent {
  return { id: `agt_${name}`, name, role, adapterType } as unknown as Agent;
}

const baseConfig: BridgeConfig = {
  openclawUrl: "ws://x",
  openclawToken: "x",
  companyId: "c1",
  syncDirection: "bidirectional",
  conflictPolicy: "newest-wins",
  autoSyncCron: "*/5 * * * *",
  healthCheckCron: "*/1 * * * *",
};

describe("AgentSync.fullSync", () => {
  beforeEach(() => vi.useFakeTimers().setSystemTime(new Date("2026-05-23T12:00:00Z")));
  afterEach(() => vi.useRealTimers());

  it("calls agents.list + ctx.agents.list and writes the snapshot to state", async () => {
    const oc = makeOpenClaw({ agents: [{ name: "scout", role: "general" }] });
    const { ctx, state } = makeCtx({ paperclipAgents: [pcAgent("scout", "general")] });

    const sync = new AgentSync({ ctx, openclaw: oc.client as never, config: baseConfig });
    const result = await sync.fullSync("c1");

    expect(oc.calls.map((c) => c.method)).toContain("agents.list");
    expect((ctx.agents.list as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

    const summary = state.get(JSON.stringify(StateKeys.agentsSummary("c1"))) as SyncStatusSnapshot;
    expect(summary.rows).toHaveLength(1);
    expect(summary.rows[0]!.state).toBe("synced");
    expect(result.actions[0]!.kind).toBe("noop-synced");
  });

  it("exports paperclip-only agents to OpenClaw via agents.create", async () => {
    const created: Array<{ name: string; workspace: string; model: string }> = [];
    const oc = makeOpenClaw({
      agents: [],
      onCreate: (params) => created.push(params as { name: string; workspace: string; model: string }),
    });
    const { ctx } = makeCtx({ paperclipAgents: [pcAgent("hedger", "trader")] });

    const sync = new AgentSync({ ctx, openclaw: oc.client as never, config: baseConfig });
    const result = await sync.fullSync("c1");

    // agents.create now sends `workspace` (required by OC protocol v4) and
    // picks the most popular model from the existing OC roster (falls back to
    // a flagship Claude id when the roster is empty, as it is here).
    expect(created).toEqual([
      { name: "hedger", workspace: "default", model: "anthropic:claude-opus-4-7" },
    ]);
    expect(result.exportedToOpenClaw).toEqual(["hedger"]);
    expect(result.exportFailures).toEqual([]);
  });

  it("inherits the most popular model from existing OC agents when exporting", async () => {
    const created: Array<{ name: string; model: string }> = [];
    const oc = makeOpenClaw({
      agents: [
        { name: "alpha", model: "anthropic:claude-sonnet-4-6" },
        { name: "beta", model: "anthropic:claude-sonnet-4-6" },
        { name: "gamma", model: "anthropic:claude-opus-4-7" },
      ],
      onCreate: (params) => created.push(params as { name: string; model: string }),
    });
    const { ctx } = makeCtx({ paperclipAgents: [pcAgent("delta")] });
    const sync = new AgentSync({ ctx, openclaw: oc.client as never, config: baseConfig });
    await sync.fullSync("c1");
    expect(created[0]!.model).toBe("anthropic:claude-sonnet-4-6");
  });

  it("captures export failures but completes the rest of the sync", async () => {
    const oc = makeOpenClaw({ agents: [], createShouldThrow: true });
    const { ctx, state } = makeCtx({ paperclipAgents: [pcAgent("hedger")] });

    const sync = new AgentSync({ ctx, openclaw: oc.client as never, config: baseConfig });
    const result = await sync.fullSync("c1");

    expect(result.exportedToOpenClaw).toEqual([]);
    expect(result.exportFailures[0]!.name).toBe("hedger");
    const lastError = state.get(JSON.stringify(StateKeys.lastError("c1")));
    expect(lastError).not.toBeNull();
  });

  it("skips export when direction restricts to OC→PC", async () => {
    const oc = makeOpenClaw({ agents: [] });
    const { ctx } = makeCtx({ paperclipAgents: [pcAgent("hedger")] });

    const sync = new AgentSync({
      ctx,
      openclaw: oc.client as never,
      config: { ...baseConfig, syncDirection: "openclaw-to-paperclip" },
    });
    const result = await sync.fullSync("c1");

    expect(result.exportedToOpenClaw).toEqual([]);
    expect(oc.calls.find((c) => c.method === "agents.create")).toBeUndefined();
  });

  it("throws if companyId param is empty and never writes state", async () => {
    const oc = makeOpenClaw({ agents: [] });
    const { ctx } = makeCtx({ paperclipAgents: [] });
    const sync = new AgentSync({ ctx, openclaw: oc.client as never, config: baseConfig });
    // companyId moved from BridgeConfig to a per-call parameter; empty value
    // is the failure case to guard against.
    await expect(sync.fullSync("")).rejects.toThrow(/companyId/);
    expect((ctx.state.set as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("records error and rethrows when agents.list fails on OpenClaw side", async () => {
    const ocClient = {
      rpc: vi.fn(async () => {
        throw new Error("ws gone");
      }),
    };
    const { ctx, state } = makeCtx({ paperclipAgents: [] });
    const sync = new AgentSync({ ctx, openclaw: ocClient as never, config: baseConfig });
    await expect(sync.fullSync("c1")).rejects.toThrow(/ws gone/);
    const lastError = state.get(JSON.stringify(StateKeys.lastError("c1")));
    expect(lastError).toMatchObject({ message: "ws gone" });
  });

  it("pickPreferredModel picks the most-popular model or falls back to flagship Claude", () => {
    expect(pickPreferredModel([])).toBe("anthropic:claude-opus-4-7");
    expect(
      pickPreferredModel([
        { name: "a", model: "anthropic:claude-haiku-4-5-20251001" },
        { name: "b", model: "anthropic:claude-haiku-4-5-20251001" },
        { name: "c", model: "anthropic:claude-opus-4-7" },
      ]),
    ).toBe("anthropic:claude-haiku-4-5-20251001");
    // OC agents without a model should not skew the pick.
    expect(pickPreferredModel([{ name: "a" }, { name: "b" }])).toBe("anthropic:claude-opus-4-7");
  });

  it("filters paperclip side to openclaw_gateway adapter only", async () => {
    const oc = makeOpenClaw({ agents: [{ name: "internal" }] });
    const { ctx } = makeCtx({
      paperclipAgents: [
        pcAgent("internal", "general", "claude_local"),
        pcAgent("synced-one", "general", "openclaw_gateway"),
      ],
    });
    const sync = new AgentSync({ ctx, openclaw: oc.client as never, config: baseConfig });
    const result = await sync.fullSync("c1");
    const stateByName = Object.fromEntries(result.rows.map((r) => [r.name, r.state]));
    expect(stateByName.internal).toBe("openclaw-only");
    expect(stateByName["synced-one"]).toBe("paperclip-only");
  });
});
