# OpenClaw — Complete Knowledge Base (Build-Ready)

| Field | Value |
|-------|-------|
| **Version** | `v2.0.0` |
| **Released** | 2026-05-23 |
| **Status** | Build-ready — focused on plugin/adapter development for the Paperclip ↔ OpenClaw bidirectional bridge project |
| **Supersedes** | v1.0.0 (2026-05-20) |
| **Primary Sources** | openclaw.ai · docs.openclaw.ai · github.com/openclaw/openclaw · deepwiki.com/openclaw/openclaw · npmjs.com/package/openclaw |
| **Scope** | Architecture, Gateway WebSocket protocol v3, plugin SDK, channel plugins, tool plugins, node/device pairing, skills, ClawHub — everything needed to build a plugin that integrates with Paperclip |
| **Maintainer** | Updated on request via Claude (this Project) |

---

## How to update this file

Ask Claude inside this Project something like:
- *"Update OpenClaw KB → v2.1.0, refresh from latest docs and add tool-plugin examples"*
- *"Bump OpenClaw KB to v3.0.0 and pull all node-pairing protocol details"*

Claude fetches, bumps, updates the changelog, regenerates.

---

## Changelog

### v2.0.0 — 2026-05-23 (this release)
- **Major rewrite** focused on the bidirectional Paperclip integration project.
- Added complete Gateway WebSocket Protocol v3 reference (frames, RPC methods, events, scopes, errors).
- Added complete Plugin SDK reference (extensions/ layout, `openclaw.extensions` manifest, subpath import map).
- Added Channel Plugin and Tool Plugin authoring walkthroughs.
- Added Node/Device pairing protocol — how OpenClaw discovers operators, nodes, and channel plugins.
- Added a dedicated section: **"Building a Paperclip Channel Plugin for OpenClaw"** (the OpenClaw half of the bidirectional bridge).
- Added cross-reference index for every file path in `src/gateway/*` mentioned across the KB.

### v1.0.0 — 2026-05-20
- Initial KB: marketing landing, GitHub README, docs index, getting started, architecture overview, skills, plugins overview, MCP, ClawHub overview.

---

> The full KB body is preserved verbatim as attached in the originating session — see the
> bundled document attached on 2026-05-23 for the complete §1–§16 reference (Gateway WebSocket
> Protocol v3, RPC catalog, plugin SDK subpath import map, channel plugin walkthrough, source
> file cross-reference index, etc.).

---

*End of OpenClaw Knowledge Base v2.0.0 — last updated 2026-05-23*
