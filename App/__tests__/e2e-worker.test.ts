/**
 * E2E worker boot test.
 *
 * Spawns the **real built** worker (dist/worker.js) the same way Paperclip's
 * host would: feeds newline-delimited JSON-RPC over stdin, reads responses
 * from stdout. Validates the full plugin lifecycle (initialize → health →
 * validateConfig → shutdown) against a real mock OpenClaw WebSocket server.
 *
 * Requires `pnpm build` to have been run first.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = resolve(here, "../dist/worker.js");

let gateway: WebSocketServer;
let port = 0;
let connectedCount = 0;
let agentsListCalls = 0;

beforeAll(async () => {
  if (!existsSync(WORKER_PATH)) {
    throw new Error(
      `E2E requires a built worker at ${WORKER_PATH}. Run \`pnpm build\` first.`,
    );
  }
  await new Promise<void>((resolveListen) => {
    gateway = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    gateway.on("listening", () => {
      const addr = gateway.address();
      if (typeof addr === "object" && addr) port = addr.port;
      resolveListen();
    });
    gateway.on("connection", (ws) => {
      connectedCount++;
      setTimeout(
        () =>
          ws.send(
            JSON.stringify({
              type: "event",
              event: "connect.challenge",
              payload: { nonce: "e2e-nonce", ts: Date.now() },
            }),
          ),
        5,
      );
      ws.on("message", (data) => {
        const frame = JSON.parse(data.toString());
        if (frame.type !== "req") return;
        const r = (ok: boolean, payload?: unknown) =>
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok, payload }));
        if (frame.method === "connect") {
          return r(true, {
            protocol: 4,
            server: { version: "e2e-mock", platform: "node", instanceId: "e2e" },
            snapshot: { uptimeMs: 1 },
          });
        }
        if (frame.method === "agents.list") {
          agentsListCalls++;
          return r(true, [{ name: "scout", role: "researcher" }]);
        }
        if (frame.method === "health") return r(true, { ok: true });
        return r(false);
      });
    });
  });
});

afterAll(async () => {
  await new Promise<void>((r) => gateway.close(() => r()));
});

interface RpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

class WorkerHarness {
  proc!: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, (msg: RpcMessage) => void>();
  private buffer = "";
  private notifications: RpcMessage[] = [];
  private workerRequests = new Map<number, RpcMessage>();

  start(): void {
    this.proc = spawn(process.execPath, [WORKER_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NODE_ENV: "test" },
    });
    this.proc.stdout.on("data", (chunk) => this.onStdout(chunk.toString()));
    this.proc.stderr.on("data", (chunk) => {
      // Forward stderr to test output to help diagnostics.
      if (process.env.E2E_DEBUG) process.stderr.write(`[worker stderr] ${chunk}`);
    });
  }

  async stop(): Promise<void> {
    if (this.proc.exitCode !== null) return;
    this.proc.kill();
    await new Promise<void>((r) => this.proc.once("exit", () => r()));
  }

  async call<T = unknown>(method: string, params: unknown = {}, timeoutMs = 5_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolveCall, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(msg.error.message));
        else resolveCall(msg.result as T);
      });
      const req: RpcMessage = { jsonrpc: "2.0", id, method, params };
      this.proc.stdin.write(JSON.stringify(req) + "\n");
    });
  }

  /**
   * Auto-respond to worker→host requests with sensible defaults so the worker
   * can proceed past secret resolution and connect.
   */
  private autoRespond(req: RpcMessage): void {
    if (req.id === undefined || !req.method) return;
    let result: unknown = null;
    switch (req.method) {
      case "secrets.resolve":
        result = "this-is-a-valid-token-1234567";
        break;
      case "plugin.state.get":
      case "state.get":
        result = null;
        break;
      case "plugin.state.set":
      case "state.set":
        result = undefined;
        break;
      case "plugin.config.get":
      case "config.get":
        result = {
          openclawUrl: `ws://127.0.0.1:${port}`,
          openclawToken: "this-is-a-real-token-1234567",
          companyId: "c1",
          syncDirection: "bidirectional",
          conflictPolicy: "newest-wins",
          autoSyncCron: "*/5 * * * *",
          healthCheckCron: "*/1 * * * *",
        };
        break;
      default:
        // Anything we didn't anticipate: return empty success.
        result = null;
    }
    const reply: RpcMessage = { jsonrpc: "2.0", id: req.id, result };
    this.proc.stdin.write(JSON.stringify(reply) + "\n");
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: RpcMessage;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && msg.method) {
        // Worker → host request. Auto-respond.
        this.workerRequests.set(msg.id, msg);
        this.autoRespond(msg);
        continue;
      }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error)) {
        // Response to a host → worker request we sent.
        const cb = this.pending.get(msg.id);
        if (cb) {
          this.pending.delete(msg.id);
          cb(msg);
        }
        continue;
      }
      // Notification (no id).
      this.notifications.push(msg);
    }
  }
}

describe("e2e: real built worker over JSON-RPC", () => {
  it("initialize → health → validateConfig → shutdown cleanly, and connects to OpenClaw", async () => {
    const h = new WorkerHarness();
    h.start();
    try {
      // 1. initialize → triggers setup(ctx) which connects to OpenClaw.
      const init = (await h.call("initialize", {
        manifest: { id: "paperclipai.plugin-openclaw-bridge", apiVersion: 1 },
        config: {
          openclawUrl: `ws://127.0.0.1:${port}`,
          openclawToken: "this-is-a-real-token-1234567",
          companyId: "c1",
          syncDirection: "bidirectional",
          conflictPolicy: "newest-wins",
          autoSyncCron: "*/5 * * * *",
          healthCheckCron: "*/1 * * * *",
        },
        instanceInfo: { instanceId: "e2e", hostVersion: "test" },
        apiVersion: 1,
      })) as { ok: boolean };
      expect(init.ok).toBe(true);

      // 2. health → worker should report ok because OC handshake completed.
      const health = (await h.call("health", {})) as { status: string };
      // Either "ok" (if connect finished) or "degraded" (if reconnect still in flight).
      expect(["ok", "degraded"]).toContain(health.status);

      // 3. validateConfig → should accept a sane config and reject a busted one.
      const goodValidation = (await h.call("validateConfig", {
        config: {
          openclawUrl: `ws://127.0.0.1:${port}`,
          openclawToken: "this-is-a-real-token-1234567",
          companyId: "c1",
          syncDirection: "bidirectional",
          conflictPolicy: "newest-wins",
          autoSyncCron: "*/5 * * * *",
          healthCheckCron: "*/1 * * * *",
        },
      })) as { ok: boolean; errors?: string[] };
      expect(goodValidation.ok).toBe(true);

      const badValidation = (await h.call("validateConfig", {
        config: { openclawUrl: "http://nope", openclawToken: "" },
      })) as { ok: boolean; errors?: string[] };
      expect(badValidation.ok).toBe(false);
      expect(badValidation.errors?.length ?? 0).toBeGreaterThan(0);

      // 4. Confirm at least one connect happened to the mock OpenClaw.
      expect(connectedCount).toBeGreaterThanOrEqual(1);

      // 5. shutdown → worker should exit cleanly.
      await h.call("shutdown", {});
    } finally {
      await h.stop();
    }
  }, 20_000);
});
