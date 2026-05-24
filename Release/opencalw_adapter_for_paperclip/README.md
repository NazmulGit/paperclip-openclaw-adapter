# paperclip-plugin-openclaw-bridge

Bidirectional sync between a Paperclip company and an OpenClaw Gateway.

The built-in Paperclip adapter `openclaw_gateway` already handles per-run
execution. This plugin owns the layers *above* runtime:

- **Discovery** — list OpenClaw agents in your Paperclip Settings panel.
- **Two-way sync** — push Paperclip-only agents to OpenClaw via `agents.create`; flag drift between rosters.
- **Event surfacing** — Paperclip issues notify OpenClaw operators; OpenClaw `agent` events post Paperclip task comments.
- **Wizard-style configuration** — host-rendered `instanceConfigSchema`, `onValidateConfig` powers "Test connection", custom Settings page exposes "Sync now" + discovery.

## Install

```bash
# 1. Build the plugin
cd App
pnpm install
pnpm build

# 2. Install it into your Paperclip instance (symlink during dev, or npm install when published)
# For local dev with a Paperclip checkout:
ln -s "$(pwd)" "/path/to/paperclip/plugins/openclaw-bridge"

# 3. From inside Paperclip, install via the plugins UI or:
paperclipai plugin install ./plugins/openclaw-bridge
```

## Configure

In Paperclip's plugin settings for `paperclipai.plugin-openclaw-bridge`:

| Field | What it is |
|---|---|
| `openclawUrl` | WebSocket endpoint, e.g. `ws://127.0.0.1:18789` |
| `openclawTokenRef` | Name of the host secret holding the OpenClaw gateway token (default: `OPENCLAW_GATEWAY_TOKEN`). **Set the actual value via Paperclip's host secrets UI / CLI** — never paste tokens into config. |
| `companyId` | Which Paperclip company this bridge syncs |
| `syncDirection` | `bidirectional` / `openclaw-to-paperclip` / `paperclip-to-openclaw` |
| `conflictPolicy` | `newest-wins` (default) / `paperclip-wins` / `openclaw-wins` / `manual` |
| `autoSyncCron` | Cron for the periodic sync job (default `*/5 * * * *`) |
| `healthCheckCron` | Cron for the OpenClaw health probe (default `*/1 * * * *`) |

Then open `Settings → OpenClaw Bridge` in Paperclip and click **Test connection** → **Sync now**.

## Develop

```bash
pnpm install         # install deps
pnpm typecheck       # tsc --noEmit
pnpm test            # vitest run (65 tests, ~1s)
pnpm build           # emits dist/
```

Run the end-to-end smoke against an in-process mock OpenClaw:

```bash
../Others/scripts/smoke.sh
```

## Architecture (one screen)

```
PaperclipPluginContext
  │
  ├─ events.on(issue.created / issue.comment.created / agent.run.*) ──► EventBridge ──┐
  ├─ agents.list / agents.get / issues.get                                            │
  ├─ issues.createComment ◄────────────────────────────────────────────────────────────┤
  ├─ jobs.register("openclaw-sync") ──► AgentSync.fullSync()                          │
  ├─ jobs.register("openclaw-health-check") ──► OpenClawClient.ping()                 │
  ├─ data.register("sync-status" / "openclaw-agents")  ◄── usePluginData (UI)         │
  ├─ actions.register("run-sync" / "test-connection")  ◄── usePluginAction (UI)       │
  ├─ tools.register("list-openclaw-channels")                                         │
  ├─ secrets.resolve(openclawTokenRef)                                                │
  └─ state.{get,set}(StateKeys.*) ── snapshots, lastSync, health                      │
                                                                                     ▼
                                                              ws://… OpenClaw Gateway
                                                              (rpc + events: agents.list,
                                                               agents.create, health, send,
                                                               memory.put, channels.status)
```

## License

MIT
