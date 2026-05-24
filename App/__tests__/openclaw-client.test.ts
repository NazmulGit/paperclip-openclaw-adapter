import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { OpenClawClient } from "../src/clients/openclaw-client.js";

interface ServerCtx {
  server: WebSocketServer;
  url: string;
  port: number;
}

function startMockGateway(scenario: {
  rejectAuth?: boolean;
  delayHelloMs?: number;
  onConnect?: (ws: WebSocket) => void;
}): Promise<ServerCtx> {
  return new Promise((resolve) => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    server.on("listening", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `ws://127.0.0.1:${port}`, port });
    });
    server.on("connection", (ws) => {
      scenario.onConnect?.(ws);

      // Real OpenClaw protocol: send connect.challenge immediately on open.
      if (scenario.rejectAuth) {
        // Skip challenge, close fast.
        setTimeout(() => ws.close(4001, "auth_rejected"), 10);
      } else {
        setTimeout(
          () =>
            ws.send(
              JSON.stringify({
                type: "event",
                event: "connect.challenge",
                payload: { nonce: "test-nonce", ts: Date.now() },
              }),
            ),
          5,
        );
      }

      ws.on("message", (data) => {
        const frame = JSON.parse(data.toString());
        if (frame.type !== "req") return;

        if (frame.method === "connect") {
          const sendHello = () =>
            ws.send(
              JSON.stringify({
                type: "res",
                id: frame.id,
                ok: true,
                payload: {
                  protocol: 4,
                  server: { version: "test", platform: "node", instanceId: "test" },
                  snapshot: { uptimeMs: 1 },
                },
              }),
            );
          if (scenario.delayHelloMs) setTimeout(sendHello, scenario.delayHelloMs);
          else sendHello();
          return;
        }
        if (frame.method === "health") {
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { ok: true } }));
          return;
        }
        if (frame.method === "agents.list") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: [{ name: "scout", role: "general", updatedAt: "2026-05-23T00:00:00Z" }],
            }),
          );
          return;
        }
        if (frame.method === "rpc.fail") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: false,
              error: { code: "BOOM", message: "boom" },
            }),
          );
          return;
        }
        if (frame.method === "rpc.never") return; // never reply
      });
    });
  });
}

describe("OpenClawClient", () => {
  let gateway: ServerCtx;
  let client: OpenClawClient | null = null;

  beforeAll(async () => {
    gateway = await startMockGateway({});
  });

  afterAll(async () => {
    client?.close();
    await new Promise<void>((resolve) => gateway.server.close(() => resolve()));
  });

  it("performs the connect handshake and reaches isOpen()", async () => {
    client = new OpenClawClient({ url: gateway.url, token: "abc123", reconnect: { enabled: false } });
    await client.connect();
    expect(client.isOpen()).toBe(true);
    const hello = client.helloSnapshot();
    expect(hello).not.toBeNull();
    const payload = hello?.payload as { protocol?: number } | undefined;
    expect(payload?.protocol).toBe(4);
    client.close();
    client = null;
  });

  it("correlates RPC responses by id", async () => {
    client = new OpenClawClient({ url: gateway.url, token: "abc123", reconnect: { enabled: false } });
    await client.connect();
    const agents = await client.rpc<Array<{ name: string }>>("agents.list", {});
    expect(agents).toHaveLength(1);
    expect(agents[0]!.name).toBe("scout");

    const ping = await client.ping();
    expect(ping.ok).toBe(true);
    client.close();
    client = null;
  });

  it("surfaces RPC errors with code + message", async () => {
    client = new OpenClawClient({ url: gateway.url, token: "abc123", reconnect: { enabled: false } });
    await client.connect();
    await expect(client.rpc("rpc.fail", {})).rejects.toThrowError(/boom/);
    client.close();
    client = null;
  });

  it("times out a never-replying RPC", async () => {
    client = new OpenClawClient({ url: gateway.url, token: "abc123", reconnect: { enabled: false } });
    await client.connect();
    await expect(client.rpc("rpc.never", {}, { timeoutMs: 200 })).rejects.toThrowError(/timeout/);
    client.close();
    client = null;
  });

  it("backoff increases exponentially up to the cap", () => {
    client = new OpenClawClient({
      url: gateway.url,
      token: "x",
      reconnect: { base: 1_000, cap: 30_000, enabled: false },
    });
    const a = client.computeBackoff(0);
    const b = client.computeBackoff(1);
    const c = client.computeBackoff(2);
    const big = client.computeBackoff(20);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThanOrEqual(1_000);
    expect(b).toBeGreaterThanOrEqual(1_500);
    expect(b).toBeLessThanOrEqual(2_000);
    expect(c).toBeGreaterThanOrEqual(3_000);
    expect(c).toBeLessThanOrEqual(4_000);
    expect(big).toBeLessThanOrEqual(30_000);
    client.close();
    client = null;
  });

  it("rejects connect when server closes immediately", async () => {
    const bad = await startMockGateway({ rejectAuth: true });
    const c = new OpenClawClient({ url: bad.url, token: "x", reconnect: { enabled: false } });
    await expect(c.connect()).rejects.toThrow();
    c.close();
    await new Promise<void>((resolve) => bad.server.close(() => resolve()));
  });

  it("listAvailableModels returns [] when ws is not open (no throw)", async () => {
    const c = new OpenClawClient({
      url: gateway.url,
      token: "x",
      reconnect: { enabled: false },
    });
    // Don't connect — should short-circuit.
    expect(c.isOpen()).toBe(false);
    expect(await c.listAvailableModels()).toEqual([]);
    c.close();
  });

  it("ensureConnecting is a no-op when already open", async () => {
    client = new OpenClawClient({ url: gateway.url, token: "x", reconnect: { enabled: false } });
    await client.connect();
    // Should not throw and should not start a duplicate connect.
    client.ensureConnecting();
    expect(client.isOpen()).toBe(true);
    client.close();
    client = null;
  });
});

describe("OpenClawClient.listAvailableModels — dedupe path", () => {
  it("dedupes models pulled from agents.list when models.list isn't implemented", async () => {
    // Custom mock: models.list returns error; agents.list returns 3 agents with
    // two distinct models. listAvailableModels should produce a sorted, deduped list.
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => server.on("listening", () => resolve()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    server.on("connection", (ws) => {
      setTimeout(
        () => ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: {} })),
        5,
      );
      ws.on("message", (data) => {
        const frame = JSON.parse(data.toString());
        if (frame.type !== "req") return;
        const send = (ok: boolean, payload?: unknown, error?: unknown) =>
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok, payload, error }));
        if (frame.method === "connect") return send(true, { protocol: 4 });
        if (frame.method === "models.list") return send(false, null, { code: "NOTSUP" });
        if (frame.method === "agents.list") {
          return send(true, [
            { name: "a", model: "anthropic:claude-opus-4-7" },
            { name: "b", model: "anthropic:claude-sonnet-4-6" },
            { name: "c", model: "anthropic:claude-opus-4-7" },
          ]);
        }
        send(false, null, { code: "X" });
      });
    });
    const c = new OpenClawClient({
      url: `ws://127.0.0.1:${port}`,
      token: "x",
      reconnect: { enabled: false },
    });
    await c.connect();
    const models = await c.listAvailableModels();
    expect(models).toEqual(["anthropic:claude-opus-4-7", "anthropic:claude-sonnet-4-6"]);
    c.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
