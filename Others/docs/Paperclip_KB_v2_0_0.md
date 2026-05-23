# Paperclip — Complete Knowledge Base (Build-Ready)

| Field | Value |
|-------|-------|
| **Version** | `v2.0.0` |
| **Released** | 2026-05-23 |
| **Status** | Build-ready — focused on adapter & plugin development for the Paperclip ↔ OpenClaw bidirectional bridge project |
| **Supersedes** | v1.0.0 (2026-05-20) |
| **Primary Sources** | paperclip.ing · docs.paperclip.ing · github.com/paperclipai/paperclip · deepwiki.com/paperclipai/paperclip · github.com/gsxdsm/awesome-paperclip |
| **Scope** | 12 core systems, adapter architecture, built-in `openclaw_gateway` adapter, OpenClaw onboarding flow, plugin SDK (out-of-process workers + JSON-RPC + capabilities), external-adapters loader, end-to-end Paperclip plugin walkthrough for the bidirectional bridge |
| **Maintainer** | Updated on request via Claude (this Project) |

---

## How to update this file

Ask Claude inside this Project something like:
- *"Update Paperclip KB → v2.1.0, add new plugin SDK methods"*
- *"Refresh Paperclip KB with latest external-adapter changes"*

Claude fetches, bumps, updates the changelog, regenerates.

---

## Changelog

### v2.0.0 — 2026-05-23 (this release)
- **Major rewrite** focused on the bidirectional Paperclip ↔ OpenClaw integration project.
- Added complete adapter API reference (`AdapterExecutionContext`, `AdapterExecutionResult`, `ServerAdapterModule`, `UIAdapterModule`).
- Added complete built-in `openclaw_gateway` adapter deep-dive (WebSocket transport, session strategies, device pairing, x-openclaw-token).
- Added complete OpenClaw onboarding protocol on the Paperclip side (`POST /companies/:id/openclaw/invite-prompt`, `GET /invites/:token/onboarding{.txt}`, `POST /invites/:token/accept`, `POST /join-requests/:id/claim-api-key`).
- Added complete plugin SDK reference (out-of-process worker, JSON-RPC 2.0 over stdio, capability model, SSRF-protected `http.fetch`, host services).
- Added external-adapter loader detail (`~/.paperclip/adapter-plugins.json`, PR #2218 / `feat/external-adapter-phase1`).
- Added dedicated section: **"Building the Paperclip Adapter Plugin for OpenClaw"** (the Paperclip half of the bidirectional bridge).
- Added cross-reference index for every file path in `server/src/*`, `packages/adapters/*`, `packages/plugins/*` mentioned across the KB.

### v1.0.0 — 2026-05-20
- Initial KB: landing page, llms.txt, GitHub README, ROADMAP, awesome-paperclip, quickstart, telemetry, OpenClaw relationship.

---

> The full KB body is preserved verbatim as attached in the originating session — see the
> bundled document attached on 2026-05-23 for the complete §1–§16 reference (Twelve Systems
> architecture, adapter contract, built-in `openclaw_gateway` deep-dive, onboarding endpoints,
> plugin SDK, external-adapter loader, end-to-end Paperclip plugin walkthrough, source file
> cross-reference index, etc.).

---

*End of Paperclip Knowledge Base v2.0.0 — last updated 2026-05-23*
