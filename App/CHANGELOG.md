# Changelog

## 1.1.0 — 2026-05-24

Polishing pass after the v1.0.0 public release. Focused on closing the gap between the production code and its test suite, smarter defaults for cross-system fields, and surfacing the gateway's model catalog to the UI so operators don't have to memorize model ids.

### Added
- **`listAvailableModels()` on `OpenClawClient`** — tries `models.list` first; falls back to a sorted, deduped projection of the `model` fields on `agents.list`. Returns `[]` (not throw) when the WS isn't open so the UI can render "loading…" instead of an error toast.
- **`openclaw-models` data handler** — exposes the catalog to the SettingsPanel as `{ connected, models }`. Kicks `ensureConnecting()` when the socket is down.
- **`pickPreferredModel()` selector** — when exporting a Paperclip-only agent via `agents.create`, inherit the most-popular model already in the OC roster (falls back to `anthropic:claude-opus-4-7` on an empty roster). Replaces the previous hardcoded model.
- **`paperclipApiUrl` in `instanceConfigSchema`** — was already read by `AgentSync.patchSlotAgentToOpenClaw` and the bootstrap action; now surfaced in the host's config UI with a sensible default (`http://127.0.0.1:3100`) and a `^https?://` pattern guard.

### Tests
- **Suite expanded from 50/66 to 74/74 passing.** Test fixtures now mock the post-v1.0 production surface (`ctx.logger`, `ctx.companies`, `ctx.agents.managed.reconcile`, `openclaw.ensureConnecting`, `globalThis.fetch` for the PATCH path).
- New tests cover: `listAvailableModels` dedupe + WS-down short-circuit, `pickPreferredModel` selection rules, `openclaw-models` data handler (both connected and disconnected paths), `EventBridge` company-binding gating on inbound OC events.

### Changed
- `agents.create` now passes `workspace` (required by OC protocol v4) and uses the inherited/fallback model from `pickPreferredModel()` instead of a hardcoded string.

### Internal
- Bumped `PLUGIN_VERSION` and `package.json` version to `1.1.0`.

## 1.0.0 — 2026-05-23

Initial V1 release of `paperclip-plugin-openclaw-bridge`.

### Added
- **Manifest** (`PaperclipPluginManifestV1`, apiVersion 1) with capabilities, jobs, tools, instance config schema, settings page + dashboard widget UI slots.
- **OpenClawClient** — WebSocket client speaking Gateway protocol v3: handshake with `ConnectParams`, id-correlated RPC, event dispatch, exponential reconnect backoff (capped at 30 s, with jitter), fast-fail on socket close during handshake.
- **AgentSync** — full sync orchestrator. Reads `agents.list` from both sides, diffs (synced / drift / openclaw-only / paperclip-only), exports Paperclip-only agents to OpenClaw via `agents.create`, captures per-agent export failures without aborting the run.
- **Pure diff + reconcile** — `diffAgents()` + `planReconcile()` independent of host context; exhaustive policy coverage (`newest-wins`, `paperclip-wins`, `openclaw-wins`, `manual`).
- **EventBridge** — bidirectional ambient surfacing:
  - Paperclip → OpenClaw: `issue.created` notifies via `send` RPC; `issue.comment.created` mirrors via `memory.put`; `agent.run.finished`/`failed` writes run summary.
  - OpenClaw → Paperclip: `agent` events tagged with `paperclipIssueId` append comments via `ctx.issues.createComment`.
- **Config layer** — `normalizeConfig` + `validateConfigStructure` + secret resolution via `ctx.secrets.resolve(openclawTokenRef)`. Plugin never stores plaintext tokens.
- **Host UI bridge** — `ctx.data.register("sync-status")`, `ctx.data.register("openclaw-agents")`, `ctx.actions.register("run-sync")`, `ctx.actions.register("test-connection")`; `onValidateConfig` powers the host's "Test Connection" button.
- **UI components** — `SettingsPanel` (full operator panel), `StatusWidget` (dashboard widget), `AgentSyncTable` (drift breakdown).
- **Scheduled jobs** — `openclaw-sync` (every 5 min) and `openclaw-health-check` (every 1 min) registered via `ctx.jobs.register`.
- **Tool** — `list-openclaw-channels` agent-callable tool that proxies `channels.status` RPC.
- **End-to-end smoke** — vitest spins a real WebSocket server, runs OpenClawClient + AgentSync against it, asserts the round-trip.

### Known limitations (see CHECKLIST.md)
- V1 SDK has no `ctx.agents.create`; OpenClaw → Paperclip materialization is **discovery-only** (the Settings panel shows what's on OpenClaw; operator creates the matching Paperclip agent using the built-in `openclaw_gateway` adapter).
- WebSocket transport is `ws://` direct, not via `ctx.http`. Loopback OpenClaw works in dev; SSRF semantics for raw WS in production are TBD by the host.
- Bidirectional sync of *modifications* (e.g. role change) lands in V2; V1 detects drift and surfaces it for operator review.
