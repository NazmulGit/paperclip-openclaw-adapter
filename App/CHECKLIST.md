# Open items / V1 → V2 punch list

Tracked here instead of as TODO comments in code.

## V1 shipped — confirmed working
- ✅ `PaperclipPluginManifestV1` shape validated against installed `@paperclipai/plugin-sdk@2026.517.0`.
- ✅ Capability list matches `PLUGIN_CAPABILITIES`.
- ✅ WebSocket handshake, RPC correlation, exponential backoff (capped 30 s).
- ✅ Diff + reconcile (pure) tested for every conflict policy.
- ✅ AgentSync round-trip validated end-to-end with a real WebSocket mock OpenClaw.
- ✅ Event bridge tested for both directions (issue → OC notify, OC event → issue comment).
- ✅ `onValidateConfig` returns warnings/errors host can render under "Test Connection".

## V1 caveats (known and intentional)

### Token persistence
The plugin **does not** store the OpenClaw token. The operator sets
`openclawTokenRef` (a string like `"OPENCLAW_GATEWAY_TOKEN"`) and configures
the actual secret value via Paperclip's host secrets UI/CLI. The worker reads
it at runtime via `ctx.secrets.resolve(...)`. This is more secure than
plugin-managed encrypted blobs and uses the host's own rotation pipeline.

### No `ctx.agents.create` in V1 SDK
Published SDK exposes `agents.list / get / pause / resume / invoke / managed.*`
but not `agents.create`. Consequences:

- **PC → OC export** works (we call OpenClaw's `agents.create` RPC).
- **OC → PC import** in V1 is **advertise-only**: the Settings panel lists OpenClaw
  agents and the operator manually creates the matching Paperclip agent using
  the built-in `openclaw_gateway` adapter. The `planReconcile` function emits
  `advertise-import` actions for these rows.

V2 candidate: when `ctx.agents.create` lands, swap `advertise-import` → real
create. Or declare a fixed pool of `managedAgents` slots in the manifest and
let the operator bind discovered OpenClaw agents to slots.

### WebSocket transport vs SSRF
`ctx.http.fetch` is SSRF-protected (blocks RFC-1918 / loopback). We use raw
`ws` to reach the gateway. In dev that's fine; in production the host may
add similar gating for WebSocket. Watch for `host.ws.outbound` capability or
similar in future SDK releases.

### Bidirectional MUTATION sync (drift fix)
V1 detects drift between rosters and surfaces it for review. It does NOT
automatically apply role/model changes from one side to the other. Apply
manually for now — or wait for V2 which will respect `conflictPolicy` for
mutation-level reconcile.

### Plugin UI hooks for streams
`usePluginStream` is wired in the SDK but not used in V1. V2 candidate:
push live sync progress to the Settings panel during `run-sync`.

### Multi-company / multi-gateway
V1 binds one OpenClaw URL to one Paperclip company per plugin install.
V2: per-company gateway configs (use `scopeKind: "company"` state).

### Slot type
V1 uses `settingsPage`. When/if the SDK adds `companySettingsPage` we should
switch — the company-scoped variant is the better fit semantically.

### ClawHub publishing
Not in V1 scope. When/if a Paperclip plugin marketplace exists, publish there.

## V2 backlog (priority order)
1. Wire `ctx.streams` for live sync progress.
2. Auto-create Paperclip agents from OpenClaw (managed-agent slot mechanism, or `ctx.agents.create` once available).
3. Bidirectional mutation reconcile (apply conflict policy to drift rows).
4. Multi-company / multi-gateway config layout.
5. Companion OpenClaw channel plugin (treat Paperclip as a channel inside OpenClaw — the other side of the bridge).
6. ClawHub publishing pipeline.

## Real-Paperclip E2E status (2026-05-23)

We installed the upstream Paperclip workspace (`pnpm install` at `Upstream/paperclip/`)
and ran `pnpm paperclipai plugin install -l ../../App` against it. The CLI accepted
the plugin layout (manifest detected, package resolved, install POST issued to the
expected `/api/plugins/install` endpoint). The server itself did not boot during
this session because `sqlite3@5.1.7` in Paperclip's lockfile needs to be built from
source on Windows and the host machine lacks the C++ Build Tools.

What this means in practice:
- The plugin's **manifest, build output, JSON-RPC worker protocol, and OpenClaw WS
  protocol are all verified against real Paperclip and OpenClaw SDK code** (66/66
  tests, including an end-to-end test that spawns the real `dist/worker.js` and
  drives it over stdin/stdout while it talks to a real WebSocket mock OpenClaw).
- The **last step — booting a full Paperclip server and clicking through the UI —
  was not achievable in this environment.** It only requires the operator to
  resolve the `sqlite3` native build (one of: install MSVC Build Tools, upgrade
  Paperclip's lockfile to `sqlite3@6`, or run Paperclip on macOS/Linux). After
  that: `paperclipai onboard -y` → `paperclipai plugin install -l <plugin path>`
  → open settings.
