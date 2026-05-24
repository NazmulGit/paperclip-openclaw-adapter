# OpenClaw ↔ Paperclip Bridge

[![status: working](https://img.shields.io/badge/status-working-brightgreen)]() [![license: MIT](https://img.shields.io/badge/license-MIT-blue)]() [![paperclip sdk: 2026.517.0](https://img.shields.io/badge/paperclip%20sdk-2026.517.0-purple)]() [![openclaw: v4](https://img.shields.io/badge/openclaw-gateway%20v4-orange)]()

Two adapters that wire **[Paperclip](https://github.com/paperclipai/paperclip)** to **[OpenClaw](https://github.com/openclaw/openclaw)** so issues created in Paperclip flow into OpenClaw agents, get processed by Claude, and come back as comments + status changes — without writing glue code.

---

## What it does

Assign a Paperclip issue to a bridged agent → OpenClaw spawns the agent → Claude reads the issue, takes action via Paperclip's API, posts a comment, sets the status to `done`. **End-to-end round-trip in ~20 seconds (warm).**

```
┌─────────────┐  issue.assign     ┌──────────────────────┐
│  Paperclip  │ ────────────────▶ │  opencalw_adapter_   │
│  (PC) UI    │                   │  for_paperclip       │
│             │  ◀ comment+close  │  (this repo, PC side) │
└──────┬──────┘                   └──────────┬───────────┘
       │                                     │ ws://...:18789
       │                                     ▼
       │                          ┌──────────────────────┐
       │                          │  OpenClaw Gateway    │
       │                          │  (Claude under the   │
       │                          │   hood, protocol v4) │
       │                          └──────────┬───────────┘
       │                                     │
       │  /api/issues/.../comments           │  back through gateway
       └─────────────────────────────────────┘
```

## Live demo

Heavy test from this repo's verification run (2026-05-23):

| Test | Result |
|---|---|
| 10 parallel issues × 3 agents, each requiring an exact marker comment + close | **10/10 passed**, ~6 min wall-clock |
| Single issue end-to-end (warm session) | ~20 seconds |
| Click-by-click UI flow: New Agent → OpenClaw Gateway → assign issue → done | **verified** |

## Two adapters in this repo

### `opencalw_adapter_for_paperclip` (PC side, **v1.0.0** — stable)

A Paperclip plugin installed into `~/.paperclip/plugins/`. Adds:

- **Settings panel** with collapsible Connection / Configuration / Saved bindings / Live chat sections + a status strip showing Gateway/Token/Bindings health at a glance
- **Bidirectional sync** — OpenClaw agents mirror into Paperclip as managed agents (8 slots), Paperclip agents with `adapterType: openclaw_gateway` export to OpenClaw via `agents.create`
- **Per-agent PC API key bootstrap** — one click mints a Paperclip API key per bridged agent and inlines it into wake messages so OC agents can call back into Paperclip to comment / close issues
- **Auto-fill `adapterConfig`** — agents created via Paperclip's New Agent picker get the gateway URL + token patched in automatically on the next sync
- **Continuous health/sync** — WebSocket keepalive every 25 s, exponential-backoff reconnect, scheduled sync every 5 min

Source: [`App/`](App/) · Release: [`Release/opencalw_adapter_for_paperclip/`](Release/opencalw_adapter_for_paperclip/)

### `paperclip_adapter_for_opencalw` (OC side, **v0.1.0 scaffold**)

An OpenClaw plugin installed via `openclaw plugins install`. Adds a typed `paperclip` tool to OC agents:

| op | what it does |
|---|---|
| `ping` | probe `/api/agents/me` to confirm the API key works |
| `commentIssue` | `{ issueId, body }` |
| `setIssueStatus` | `{ issueId, status, comment? }` |
| `createIssue` | `{ companyId?, title, description?, priority?, assigneeAgentId? }` |

Plus a `SKILL.md` so OC agents know when and how to call the tool. Scaffold-only in V1 — manifest, tool, and skill are wired; install path needs validation against a running OC.

Source: [`OpenClawPlugin/`](OpenClawPlugin/) · Release: [`Release/paperclip_adapter_for_opencalw/`](Release/paperclip_adapter_for_opencalw/)

**Canonical repo for the OC side:** https://github.com/NazmulGit/paperclip-adapter-for-opencalw — published as its own GitHub repo so OpenClaw users can find it via OC-side search. The `OpenClawPlugin/` folder here is the vendored copy used during co-development; both stay in sync at release time.

## Quick install (5 minutes)

```powershell
# Prereqs:
#   - paperclipai running on http://127.0.0.1:3100
#   - openclaw gateway running on ws://127.0.0.1:18789
#   - openclaw config get gateway.auth.token   (copy the token)

# 1. Install the PC plugin
cd Release\opencalw_adapter_for_paperclip
$dest = "$env:USERPROFILE\.paperclip\plugins\opencalw_adapter_for_paperclip"
New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
Copy-Item -Path "$PWD\*" -Destination $dest -Recurse -Force

# 2. In Paperclip UI:
#    /instance/settings/plugins  -> enable OpenClaw Bridge -> Configure
#    Connection -> Edit -> paste URL + token -> Save connection
#    Sync -> Test connection -> should say "OpenClaw gateway reachable"
#    Configuration -> pick companies + agents -> Save
#    Sync -> Sync now -> Bootstrap PC credentials
```

Then create an issue in Paperclip, assign it to a bridged agent. Wait 20-30 s. Done.

Full step-by-step with where-to-click in [`Release/INSTALL.md`](Release/INSTALL.md).

## Performance

| Path | Time |
|---|---|
| Cold first call (new OC session) | 17-25 s |
| Warm session (reuse, default after first call) | 4-9 s |
| 3 parallel issues, different agents | ~16 s wall-clock |
| `agents.create` (PC → OC export) | ~232 ms each |
| Per-agent PC API key mint | ~50 ms each |

The dominant latency is **Claude inside OpenClaw** — WS + RPC + PC API overhead is sub-300 ms. Knobs we expose to tune:
- `sessionKeyStrategy=fixed` baked into managed agents → reuses one OC session per agent across all issues (huge warm-up win, accept some cross-issue context bleed)
- Configurable `timeoutSec` and `waitTimeoutMs`
- `payloadTemplate.message` per agent (we use this to inline the PC API key)

## Architecture

| Component | Purpose | Source |
|---|---|---|
| `OpenClawClient` | Single persistent WS to the gateway with 25 s keepalive + exponential-backoff reconnect | [`App/src/clients/openclaw-client.ts`](App/src/clients/openclaw-client.ts) |
| `AgentSync` | Diff OpenClaw vs Paperclip rosters, plan reconcile actions, materialize managed agents | [`App/src/sync/agent-sync.ts`](App/src/sync/agent-sync.ts) |
| `EventBridge` | Listen for OC `agent` events tagged with `paperclipIssueId` and post them as Paperclip comments | [`App/src/events/event-bridge.ts`](App/src/events/event-bridge.ts) |
| Settings UI | Collapsible React panel with Connection / Sync / Configuration / Saved / Live chat | [`App/src/ui/SettingsPanel.tsx`](App/src/ui/SettingsPanel.tsx) |
| OC tool entry | Registers `paperclip.*` ops | [`OpenClawPlugin/src/plugin.ts`](OpenClawPlugin/src/plugin.ts) |

Detailed design notes + workarounds for upstream quirks (CEO requirement, `sessionKeyStrategy`, custom-settings-page hiding auto-config, the `tsc`-vs-`esbuild` UI bundle gotcha): see [`Others/docs/`](Others/docs/) and the [Notion SOP](https://www.notion.so/3690a400d3448186927ae73f641206c5).

## Build from source

```powershell
# PC plugin
cd App
pnpm install
pnpm build      # runs tsc + esbuild
pnpm test       # vitest unit tests

# OC plugin
cd OpenClawPlugin
pnpm install
pnpm build
```

## Status & roadmap

**V1 (this release) — works:**
- ✅ Bidirectional sync (OC ↔ PC agents)
- ✅ Per-agent PC API keys (no 403s on issue work)
- ✅ Settings panel with collapsible sections + URL/token editor
- ✅ Auto-fill `adapterConfig` for picker-created agents
- ✅ One-click bootstrap of credentials

**V2 ideas:**
- OC-side channel plugin: Paperclip issues as OC chat channels
- OC → PC push: auto-create PC issues from finished OC sessions
- Smaller wake prompt for heartbeat-only invocations
- Pre-warm sessions at sync time
- Multi-OC-gateway support per Paperclip company

## License

[MIT](LICENSE)

## Contributing

PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and conventions.

Bugs / questions: open an issue.

## Acknowledgements

Built against [Paperclip](https://github.com/paperclipai/paperclip) (SDK 2026.517.0) and [OpenClaw](https://github.com/openclaw/openclaw) (gateway protocol v4). Both teams ship great primitives — this repo is just the duct tape.
