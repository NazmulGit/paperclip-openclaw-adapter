# opencalw_adapter_for_paperclip

A Paperclip plugin that bridges Paperclip with an OpenClaw Gateway. Discover OpenClaw agents inside Paperclip, mirror them as managed agents, sync issue assignments through, and bootstrap the PC API credentials OC agents need to act on issues.

> See the [top-level README](../README.md) for the full project overview.

## Install

```powershell
$dest = "$env:USERPROFILE\.paperclip\plugins\opencalw_adapter_for_paperclip"
New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
Copy-Item -Path ".\dist" -Destination "$dest\dist" -Recurse -Force
Copy-Item -Path ".\package.json" -Destination "$dest\package.json"
```

Enable it in Paperclip at `/instance/settings/plugins`.

## Plugin Settings UI

| Section | Default | What it does |
|---|---|---|
| **Status strip** (top) | always visible | Pills: Gateway / Token / Bindings |
| **Connection** | open when token missing | Inline editor for URL + token |
| **Sync** | always visible | `Test connection` / `Sync now` / `Bootstrap PC credentials` |
| **Configuration** | open when no bindings | Multi-select: PC companies × OC agents + Save |
| **Saved bindings** | collapsed | Read-only table of active bindings |
| **Live chat test** | collapsed | One-off message → OC agent → reply |

Sections collapse on header click; status dots show "ok"/"warn"/"neutral".

## Architecture

```
src/
├── manifest.ts                 # Plugin id, capabilities, instance config schema, managed-agent slots
├── worker.ts                   # SDK entrypoint
├── config.ts                   # Normalize + validate
├── types.ts                    # BridgeConfig, OpenClawAgentRecord, CompanyBinding, …
├── state-keys.ts               # Scoped state keys
├── clients/openclaw-client.ts  # Persistent WS, 25s keepalive, exponential reconnect
├── sync/agent-sync.ts          # Diff + reconcile + materialize + auto-fill adapterConfig
├── sync/diff.ts                # Pure roster diff
├── sync/reconcile.ts           # Plan reconcile actions
├── events/event-bridge.ts      # OC agent events → PC comments
├── jobs/sync-openclaw.ts       # Cron */5 — full sync
├── jobs/openclaw-health-check.ts  # Cron */1 — gateway ping
├── data/handlers.ts            # sync-status, openclaw-agents, gateway-config, bootstrap-status, …
├── actions/handlers.ts         # test-connection, run-sync, save-bulk, bootstrap-token, chat-send, …
└── ui/SettingsPanel.tsx        # Collapsible settings UI
```

## Manifest declares

- **Capabilities:** `plugin.state.read/write`, `events.subscribe`, `jobs.schedule`, `companies.read`, `agents.read`, `issues.read`, `issue.comments.create`, `agents.managed`, `agent.tools.register`, `instance.settings.register`, `ui.dashboardWidget.register`
- **Instance config:** `openclawUrl`, `openclawToken`, `companyId`, `syncDirection`, `conflictPolicy`, `autoSyncCron`, `healthCheckCron`
- **Jobs:** `openclaw-sync` (*/5 min), `openclaw-health-check` (*/1 min)
- **UI slots:** `settingsPage`, `dashboardWidget`
- **Managed-agent slots:** 8 × `openclaw-slot-N` with `adapterType: openclaw_gateway`

## Build

```powershell
pnpm install
pnpm build      # tsc + esbuild
pnpm test       # vitest
pnpm typecheck
```

`tsc` alone is not enough — esbuild is required to bundle the UI's bare specifiers (`react`, `@paperclipai/plugin-sdk/ui`). The default `pnpm build` runs both.

## How bootstrap works

`ACTION_BOOTSTRAP_TOKEN`, for every bridged agent in every bound company:

1. `POST /api/agents/{id}/keys` — mint a per-agent PC API key
2. `PATCH /api/agents/{id}` setting `adapterConfig.payloadTemplate.message = "Set PAPERCLIP_API_KEY=<token>..."` — inlines the token into wake events
3. Writes `~/.openclaw/workspace/paperclip-claimed-api-key.json` for compat
4. Persists bootstrap state for the UI

Per-agent tokens are needed because a token minted for agent A can't act as agent B — PC's permission check would reject.

## Known V1 limitations

- Managed-slot display names are static (no `agents.update` in 2026.517.0). Slots show as "OpenClaw Agent N"; the OC-name → slot mapping is visible in the Sync table.
- Deleting an OC agent leaves an orphan PC slot row (the SDK's `agents.managed.reset` recreates rather than deletes).
- One PC company binds to one OC gateway.

## License

MIT — see [LICENSE](../LICENSE).
