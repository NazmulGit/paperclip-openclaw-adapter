# Community plugin: opencalw_adapter_for_paperclip — Paperclip ↔ OpenClaw bridge

(Draft of the issue I'll open on `paperclipai/paperclip` once the user okays the GitHub push.)

---

**Title:** Community plugin — opencalw_adapter_for_paperclip (Paperclip ↔ OpenClaw bridge)

**Body:**

Hi Paperclip team & community,

I've published a community plugin that bridges Paperclip with an OpenClaw Gateway end-to-end, so issues assigned in Paperclip flow into OpenClaw agents, get processed by Claude, and come back as comments + status changes.

**Repo:** https://github.com/NazmulGit/paperclip-openclaw-adapter

**License:** MIT

### What it does

- **Bidirectional agent sync** — OpenClaw agents mirror into Paperclip companies as managed agents (8 slots); Paperclip agents with `adapterType: openclaw_gateway` export to OpenClaw via `agents.create`.
- **Per-agent PC API key bootstrap** — one click in the settings panel mints a Paperclip API key per bridged agent and inlines it into wake messages, so OC agents can call back into Paperclip's API to comment, close issues, etc. Solves the 403 problem where shared tokens couldn't act as the assigned agent.
- **Polished settings UI** — collapsible sections with a status pills strip (Gateway / Token / Bindings); inline editor for `openclawUrl` + `openclawToken` (the auto-config form is hidden when a custom settingsPage exists, so we render it ourselves).
- **Continuous health/sync** — 25 s WS keepalive, exponential-backoff reconnect, `*/5 min` full sync, `*/1 min` health check.
- **Auto-fill `adapterConfig`** — agents created via Paperclip's New Agent → OpenClaw Gateway picker get the URL + token patched in on the next sync.

### Real-world verification

Heavy stress test (this repo's `Others/scripts/stress-tasks.json`):

10 parallel real-world tasks across 3 bridged agents — read company info via PC API, list open issues, compute Fibonacci(15), write Python code, list local files via shell, fetch example.com and extract `<title>`, prime check, explain SQL injection. **10/10 passed in 5 min wall-clock.** Not marker echo — actual cognitive work.

### Where it lives

- PC plugin (this repo): `opencalw_adapter_for_paperclip` — installed into `~/.paperclip/plugins/`
- OC plugin scaffold: `paperclip_adapter_for_opencalw` — adds a typed `paperclip.*` tool inside OpenClaw. V2 work.

### Known V1 limitations (documented in the repo)

- Managed-slot display names are static (no `agents.update` SDK in 2026.517.0); slots show as "OpenClaw Agent N". OC-name ↔ slot mapping is in the sync table.
- `tsc` alone isn't enough — `esbuild` is required to bundle the UI's bare specifiers.
- One PC company binds to one OC gateway at a time.
- When a company has no active `role=ceo` agent, the bridge auto-creates a "Bridge Bootstrap CEO" because PC's join approval gate requires one. Operators can rename or replace it.

### What I'd like feedback on

1. **`agents.update` SDK method** — would unlock per-instance display names for managed slots. Is this on the roadmap?
2. **Auto-config form when a custom settingsPage is present** — could the host render BOTH the auto-form (for instance config like URL/token) AND the custom panel? Right now custom panels have to re-implement config editing.
3. **Plugin showcase / community registry** — is there a place to list community plugins beyond the GitHub repo?

Happy to incorporate any conventions you'd like (capability tweaks, naming, etc.) before I cut a v1.0 release tag.

Thanks for shipping Paperclip — great primitives to build on.

— @NazmulGit
