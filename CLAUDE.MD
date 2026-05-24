# paperclip-openclaw-bridge

A Paperclip plugin that adds bidirectional sync with OpenClaw — beyond what the
built-in `openclaw_gateway` adapter provides. Renamed from `opencalw_adapter_for_paperclip`
in v2.0.0; plugin id is now `openclaw-bridge` (was `paperclipai.plugin-openclaw-bridge`).

## Repository layout (top-level)

```
.
├── App/         # The plugin itself — paperclip-openclaw-bridge (src, tests, build)
├── Upstream/    # Read-only clones of github.com/openclaw/openclaw and github.com/paperclipai/paperclip
├── Release/     # Built / packaged artifacts ready to publish (tarballs, dist bundles)
└── Others/
    ├── docs/    # Knowledge bases (Paperclip_KB_v2_0_0.md, OpenClaw_KB_v2_0_0.md)
    └── scripts/ # Smoke + dev scripts (smoke.sh, mock-openclaw.mjs)
```

## Why a new plugin

The built-in `openclaw_gateway` adapter only handles **runtime execution** of one
agent run. It does not:
- Sync the agent list between OpenClaw and Paperclip
- Surface ambient OpenClaw activity into Paperclip tasks
- Push Paperclip task notifications into OpenClaw's chat channels
- Provide a wizard-style configuration UX
- Persist sync state, conflict policy, last-sync timestamps

This plugin owns all of the above and **reuses the built-in adapter for the
runtime path** (don't duplicate it).

## Three V1 requirements (the user's brief)

1. **Bidirectional** — both-side event communication.
2. **Easy agent add or sync** — pull existing OpenClaw agents into Paperclip with
   `adapterType: openclaw_gateway`, and create new Paperclip agents back into
   OpenClaw via `agents.create` RPC.
3. **Easy configuration** — a settings panel + wizard, "Test connection",
   "Sync now", clear status.

## Critical references — READ BEFORE WRITING ANY CODE

- `Others/docs/Paperclip_KB_v2_0_0.md`
  - §6 — Adapter contract (for understanding how the built-in adapter we reuse works)
  - §7 — Built-in `openclaw_gateway` adapter deep-dive
  - §8 — OpenClaw onboarding flow (claim-secret, x-openclaw-token, device pairing)
  - §9 — Plugin SDK: out-of-process worker, JSON-RPC, capability model, SSRF rules
  - §11 — Full walkthrough for this exact plugin (file layout, manifest, worker, sync engine, event bridge, UI)
  - §15 — Community plugins to study: `paperclip-plugin-github-issues`, `paperclip-plugin-discord`
- `Others/docs/OpenClaw_KB_v2_0_0.md`
  - §4 — Gateway WebSocket Protocol v3 (frames, RPC methods, events, scopes)
  - §11 — The OpenClaw side, if/when we add a complementary channel plugin (V2)
- `Upstream/openclaw/` and `Upstream/paperclip/` — local mirrors of the source repos for grep/reference

## Stack

- TypeScript ESM, Node 20+
- esbuild for bundling
- vitest for unit tests
- ws library for the OpenClaw WebSocket client
- @paperclipai/plugin-sdk as a peer dependency

## Build / test / dev (run from App/)

- `pnpm build`        — bundle dist/
- `pnpm test`         — vitest unit tests
- `pnpm test:watch`   — vitest watch
- `pnpm dev`          — esbuild --watch
- `pnpm typecheck`    — tsc --noEmit

## Style and conventions

- Every method the plugin calls on the host SDK must be listed in `manifest.capabilities`. Adding a new SDK call without updating capabilities is a bug.
- Never put plaintext OpenClaw tokens in config files or commit them. Use `ctx.secrets.resolve(...)`.
- Use `ctx.state` (instance scope) for sync metadata: `lastSyncAt`, `lastError`, conflict resolutions.
- All Paperclip and OpenClaw API calls go through one of two client classes — never inline.
- One job = one purpose. `sync-openclaw` does the full diff; `openclaw-health-check` does only the ping.

## Out of scope for V1

- The OpenClaw-side channel plugin (Paperclip as a channel inside OpenClaw) — that's V2.
- An external adapter (a new `adapter_type` distinct from `openclaw_gateway`) — V2+ if needed.
- Multi-OpenClaw-gateway support — V1 binds to one gateway per Paperclip company.
- ClawHub publishing — V2.

## Testing strategy

- Unit: vitest + the TestHarness from `@paperclipai/plugin-sdk/testing`.
- Integration: `Others/scripts/smoke.sh` spins up a mocked OpenClaw WS server and walks the full sync.
- E2E (manual for now): point at a real local OpenClaw instance (see `Upstream/openclaw/`).

<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan
<!-- SPECKIT END -->
