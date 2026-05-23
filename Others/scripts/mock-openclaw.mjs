#!/usr/bin/env node
// Minimal OpenClaw Gateway mock — speaks just enough of protocol v3 for the
// openclaw-bridge plugin smoke test: handshake (hello), agents.list,
// agents.create, health, channels.status, send, memory.put.
//
// Usage:
//   node Others/scripts/mock-openclaw.mjs --port 18789
//
// Internally keeps an in-memory roster keyed by agent name so the smoke
// script can verify both "list" and "create" round-trips.

import { WebSocketServer } from "ws";
import { parseArgs } from "node:util";

const args = parseArgs({
  options: {
    port: { type: "string", default: "18789" },
    seed: { type: "string", default: "scout,researcher,hedger" },
  },
}).values;

const port = Number(args.port);
const seedNames = String(args.seed)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const agents = new Map(
  seedNames.map((name) => [
    name,
    { name, role: "general", model: "anthropic:claude-opus-4-7", updatedAt: new Date().toISOString() },
  ]),
);

const wss = new WebSocketServer({ port, host: "127.0.0.1" });
console.log(JSON.stringify({ at: "mock-openclaw", listening: `ws://127.0.0.1:${port}`, seeded: seedNames }));

wss.on("connection", (ws) => {
  setTimeout(
    () =>
      ws.send(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "mock-nonce", ts: Date.now() },
        }),
      ),
    5,
  );

  ws.on("message", (data) => {
    let frame;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (frame.type === "req") {
      const reply = (ok, payload, error) =>
        ws.send(JSON.stringify({ type: "res", id: frame.id, ok, payload, error }));

      switch (frame.method) {
        case "connect":
          reply(true, {
            protocol: 4,
            server: { version: "mock-1", platform: "node", instanceId: "mock" },
            snapshot: { uptimeMs: 1 },
          });
          break;
        case "health":
          reply(true, { ok: true });
          break;
        case "agents.list":
          reply(true, Array.from(agents.values()));
          break;
        case "agents.create": {
          const p = frame.params ?? {};
          if (!p.name) {
            reply(false, null, { code: "INVALID_REQUEST", message: "name required" });
            break;
          }
          if (agents.has(p.name)) {
            reply(false, null, { code: "ALREADY_EXISTS", message: `agent ${p.name} already exists` });
            break;
          }
          const created = {
            name: p.name,
            role: p.role ?? "general",
            model: p.model ?? "anthropic:claude-opus-4-7",
            updatedAt: new Date().toISOString(),
          };
          agents.set(created.name, created);
          reply(true, { ok: true, agent: created });
          break;
        }
        case "channels.status":
          reply(true, { channels: [{ id: "webchat", connected: true }] });
          break;
        case "send":
          console.log(JSON.stringify({ at: "send", params: frame.params }));
          reply(true, { ok: true });
          break;
        case "memory.put":
          console.log(JSON.stringify({ at: "memory.put", params: frame.params }));
          reply(true, { ok: true });
          break;
        default:
          reply(false, null, { code: "UNKNOWN_METHOD", message: `unknown method ${frame.method}` });
      }
      return;
    }
  });
});

process.on("SIGINT", () => wss.close(() => process.exit(0)));
process.on("SIGTERM", () => wss.close(() => process.exit(0)));
