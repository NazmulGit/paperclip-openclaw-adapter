/**
 * End-to-end smoke: real WebSocket server (mock OpenClaw) + real OpenClawClient
 * + real AgentSync + mocked PluginContext. Validates that a Paperclip-only
 * agent is exported to OpenClaw via agents.create, and that the resulting
 * snapshot reflects the round-trip.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import type { Agent, PluginContext } from "@paperclipai/plugin-sdk";
import { OpenClawClient } from "../src/clients/openclaw-client.js";
import { AgentSync } from "../src/sync/agent-sync.js";
import { StateKeys } from "../src/state-keys.js";
import type { BridgeConfig, SyncStatusSnapshot } from "../src/types.js";

let server: WebSocketServer;
let port = 0;
const ocAgents = new Map<string, { name: string; role: string; updatedAt: string }>();

beforeAll(async () => {
  ocAgents.set("scout", { name: "scout", role: "researcher", updatedAt: "2026-05-23T00:00:00Z" });
  await new Promise<void>((resolve) => {
    server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    server.on("listening", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr) port = addr.port;
      resolve();
    });
    server.on("connection", (ws) => {
      setTimeout(
        () =>
          ws.send(
            JSON.stringify({
              type: "event",
              event: "connect.challenge",
              payload: { nonce: "smoke-nonce", ts: Date.now() },
            }),
          ),
        5,
      );
      ws.on("message", (data) => {
        const frame = JSON.parse(data.toString());
        if (frame.type !== "req") return;
        const r = (ok: boolean, payload?: unknown, error?: unknown) =>
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok, payload, error }));
        if (frame.method === "connect") {
          return r(true, {
            protocol: 4,
            server: { version: "smoke", platform: "node", instanceId: "smoke" },
            snapshot: { uptimeMs: 1 },
          });
        }
        if (frame.method === "agents.list") return r(true, Array.from(ocAgents.values()));
        if (frame.method === "agents.create") {
          const p = frame.params as { name: string; role?: string };
          ocAgents.set(p.name, {
            name: p.name,
            role: p.role ?? "general",
            updatedAt: new Date().toISOString(),
          });
          return r(true, { ok: true });
        }
        if (frame.method === "health") return r(true, { ok: true });
        return r(false, null, { code: "x", message: "unknown" });
      });
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function pcAgent(name: string, role = "general"): Agent {
  return {
    id: `agt_${name}`,
    name,
    role,
    adapterType: "openclaw_gateway",
  } as unknown as Agent;
}

function makeCtx(paperclipAgents: Agent[]): { ctx: PluginContext; state: Map<string, unknown> } {
  const state = new Map<string, unknown>();
  const ctx = {
    agents: {
      list: async () => paperclipAgents,
      managed: {
        // Smoke test runs against a mock OpenClaw and doesn't need a real
        // managed-agent host; reconcile just hands back a synthetic id so the
        // post-reconcile rename PATCH (which we stub via global fetch below)
        // has something to address.
        reconcile: async (slotKey: string) => ({ agentId: `agt_managed_${slotKey}` }),
      },
    },
    companies: { list: async () => [{ id: "c_smoke" }] },
    state: {
      get: async (k: { stateKey: string }) => state.get(JSON.stringify(k)) ?? null,
      set: async (k: { stateKey: string }, v: unknown) => {
        state.set(JSON.stringify(k), v);
      },
      delete: async (k: { stateKey: string }) => {
        state.delete(JSON.stringify(k));
      },
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as unknown as PluginContext;
  return { ctx, state };
}

const cfg = (): BridgeConfig => ({
  openclawUrl: `ws://127.0.0.1:${port}`,
  openclawToken: "X",
  companyId: "c_smoke",
  syncDirection: "bidirectional",
  conflictPolicy: "newest-wins",
  autoSyncCron: "*/5 * * * *",
  healthCheckCron: "*/1 * * * *",
});

describe("smoke: real WS + AgentSync round-trip", () => {
  it("discovers OpenClaw 'scout', exports Paperclip-only 'hedger' to OpenClaw, writes the snapshot", async () => {
    const oc = new OpenClawClient({
      url: `ws://127.0.0.1:${port}`,
      token: "smoke",
      reconnect: { enabled: false },
    });
    await oc.connect();
    expect(oc.isOpen()).toBe(true);

    const { ctx, state } = makeCtx([pcAgent("hedger", "trader"), pcAgent("scout", "researcher")]);
    const sync = new AgentSync({ ctx, openclaw: oc, config: cfg() });

    // AgentSync.patchSlotAgentToOpenClaw calls Paperclip's REST API; the
    // smoke server is OpenClaw, not Paperclip, so stub fetch to accept any
    // PATCH and let the sync round-trip proceed without HTTP errors.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    try {
      // companyId must match what the snapshot is keyed under; cfg().companyId
      // is "c_smoke" and the snapshot check below uses the same value.
      const result = await sync.fullSync("c_smoke");

      // 'hedger' exists only in PC → should be exported to OC.
      expect(result.exportedToOpenClaw).toContain("hedger");
      expect(ocAgents.has("hedger")).toBe(true);

      // 'scout' exists on both → synced.
      const scoutRow = result.rows.find((r) => r.name === "scout");
      expect(scoutRow?.state).toBe("synced");

      // Snapshot persisted to state.
      const snapshot = state.get(JSON.stringify(StateKeys.agentsSummary("c_smoke"))) as SyncStatusSnapshot;
      expect(snapshot.rows.length).toBeGreaterThanOrEqual(2);
      expect(snapshot.lastSyncAt).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
      oc.close();
    }
  });
});
