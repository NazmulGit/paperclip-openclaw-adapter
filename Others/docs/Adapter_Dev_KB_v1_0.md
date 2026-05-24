# Adapter Developer KB — Paperclip ↔ OpenClaw (v1.0)

Practical knowledge extracted from building `opencalw_adapter_for_paperclip` and `paperclip_adapter_for_opencalw` end-to-end. These are the real-world lessons, gotchas, and patterns that the upstream KBs don't cover. Use this alongside `Paperclip_KB_v2_0_0.md` and `OpenClaw_KB_v2_0_0.md`.

---

## 1. Mental Model

Think of a bridge adapter as three moving parts:

```
Paperclip Host (PC)              Bridge Plugin              OpenClaw (OC)
┌──────────────┐       JSON-RPC       ┌──────────────┐     WebSocket
│ Issues       │◀────worker.ts────────│ Sync Engine  │◀────────────▶ Gateway
│ Agents       │                      │ Event Bridge │               Agents
│ Companies    │                      │ Action Hdlrs │               Events
│ Plugin State │                      │ Data Hdlrs   │
└──────────────┘                      └──────────────┘
```

- **Worker** is your plugin's Node.js process. PC spawns it on demand and kills it when idle. Design stateless — any state you need across restarts goes in `ctx.state`.
- **Sync Engine** diffs two rosters (PC agents vs OC agents) and reconciles. Pure diff → pure reconcile → side-effectful materialize. Keep these layers separate.
- **Event Bridge** listens for OC gateway events tagged with Paperclip context (e.g., `paperclipIssueId`) and translates them into PC comments/status changes.

---

## 2. Paperclip Plugin SDK — Critical Gotchas

### 2.1 Every SDK call needs a capability declaration

If you call a method without declaring its capability, you get a silent permission error. Update `manifest.capabilities` every time you add an SDK call.

**Minimum capabilities for a bridge adapter:**
```ts
capabilities: [
  "plugin.state.read", "plugin.state.write",
  "events.subscribe",
  "jobs.schedule",
  "companies.read",
  "agents.read",
  "issues.read",
  "issue.comments.create",
  "agents.managed",
  "agent.tools.register",
  "instance.settings.register",
  "ui.dashboardWidget.register",
],
```

If you're minting per-agent API keys, also add the appropriate HTTP capability (the SDK uses `agents.keys.create` internally or you call `/api/agents/:id/keys` directly via the plugin's HTTP client).

---

### 2.2 Custom `settingsPage` hides the auto-config form

This is the **#1 surprise**: when your manifest declares a `settingsPage`, Paperclip hides the built-in "instance configuration" form. Fields like `openclawUrl` and `openclawToken` that you defined in `instanceConfig` schema will NOT be rendered by PC.

**You must implement your own Connection section in your React settings panel**, including:
- Displaying the current URL and a masked token (show length, not value)
- An Edit/Save flow that POSTs to `/api/plugins/:id/config` (the internal endpoint PC uses for instance config)
- Handling the "blank = keep existing" contract for the token field

```tsx
// Save connection — blank token means "keep existing"
async function saveConnection(url: string, token: string) {
  const body: Record<string, string> = { openclawUrl: url };
  if (token.trim()) body.openclawToken = token.trim();
  await fetch(`/api/plugins/${pluginId}/config`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
```

---

### 2.3 Build system: `tsc` alone breaks the UI bundle

`tsc` does NOT rewrite bare module specifiers (`react`, `@paperclipai/plugin-sdk/ui`). When you commit a tsc-only build and PC loads the UI file, it renders as a dashed placeholder box with the text "Plugin Name: Plugin Name".

**Always run both:**
```json
// package.json
"build": "tsc -p tsconfig.build.json && node esbuild.config.mjs"
```

`tsconfig.build.json` excludes the UI file from tsc (it just checks non-UI files). Then esbuild bundles the UI with its own React/SDK resolution. The resulting `dist/ui/index.js` should be ~30-60 KB depending on imports.

**Minimal esbuild config:**
```js
// esbuild.config.mjs
import { build } from "esbuild";
await build({
  entryPoints: ["src/ui/SettingsPanel.tsx"],
  bundle: true,
  format: "esm",
  outfile: "dist/ui/index.js",
  external: [],          // bundle everything — don't externalize react
  jsx: "automatic",
  target: "es2020",
  minify: false,         // keep readable for debugging
});
```

---

### 2.4 Managed agent slots

- **Maximum 8 slots** per plugin instance.
- Slot IDs must be declared in the manifest (`openclaw-slot-1` … `openclaw-slot-8`). You cannot add slots dynamically.
- Display names are **static** — there is no `agents.update` API in SDK 2026.517.0. The slot shows the manifest `name` field, not the OC agent name. Work around this by including an OC-name ↔ slot mapping in your sync state table.
- `agents.managed.reset(slotId)` recreates (not deletes) a slot — orphan rows are the expected behavior when an OC agent is removed.
- `adapterType` must be set at slot declaration and cannot be changed. Use `"openclaw_gateway"` for OC-bridged slots.

```ts
// manifest.ts — managed slot declaration
managedAgents: Array.from({ length: 8 }, (_, i) => ({
  id: `openclaw-slot-${i + 1}`,
  name: `OpenClaw Agent ${i + 1}`,
  adapterType: "openclaw_gateway",
  adapterConfig: {},     // filled in by sync engine
})),
```

---

### 2.5 Per-agent API keys — NOT shared tokens

The most critical auth lesson: **a Paperclip API key minted for Agent A cannot act as Agent B**. PC checks the `sub` claim on the token. If OC agents all share one token, every issue mutation they attempt returns `403`.

**Wrong approach:** Use one PC admin token for all agents.

**Right approach:** Mint a per-agent key via `POST /api/agents/:id/keys`, then inject it into that agent's wake message via `adapterConfig.payloadTemplate.message`.

```ts
// Bootstrap: for each bridged agent
const { key } = await apiFetch(`/api/agents/${agentId}/keys`, {
  method: "POST",
  body: JSON.stringify({ name: "bridge-bootstrap-2026" }),
});

// Inject into wake message so OC agent gets it at runtime
await apiFetch(`/api/agents/${agentId}`, {
  method: "PATCH",
  body: JSON.stringify({
    adapterConfig: {
      payloadTemplate: {
        message: `Set PAPERCLIP_API_KEY=${key} and PAPERCLIP_AGENT_ID=${agentId} in your run context.`,
      },
    },
  }),
});
```

This sidesteps the join-request flow entirely — no CEO requirement, no approval gate.

---

### 2.6 CEO requirement — skip the join flow entirely

If you try to bootstrap via the join-request flow (`POST /api/companies/:id/join-requests`), PC rejects with `409 Join request cannot be approved because this company has no active CEO`. The plugin's own agent isn't a CEO, and auto-creating one adds friction.

**Skip the join flow.** Use `POST /api/agents/:id/keys` directly (see §2.5). The keys endpoint doesn't require CEO presence.

---

### 2.7 NewAgentDialog simplified form for `openclaw_gateway`

Paperclip's built-in New Agent dialog has a **hardcoded simplified path** for `openclaw_gateway` (and `http`) adapter types. It only renders a single "Gateway URL" input at create time. The full 12-field `OpenClawGatewayConfigFields` component only appears on the agent EDIT page after creation.

**Implications:**
- You cannot surface all gateway config fields during agent creation via the dialog — this is an upstream limitation, not a plugin bug.
- Your settings panel should include a note directing users to the agent's own dashboard to edit fields like `model`, `scopes`, `sessionKeyStrategy`, `timeout`, etc.
- If you need these fields pre-filled, do it on the next sync cycle via `PATCH /api/agents/:id` with `adapterConfig` values.

---

### 2.8 State scoping

Use scoped keys consistently. A flat key namespace causes collisions when a plugin manages multiple companies.

```ts
// state-keys.ts
export const KEYS = {
  sync:      (companyId: string) => `sync:${companyId}`,
  bootstrap: (companyId: string) => `bootstrap:${companyId}`,
  lastError: (companyId: string) => `error:${companyId}`,
  global:    (key: string)       => `global:${key}`,
};
```

Plugin state is instance-scoped (shared across all companies for that plugin install). Include companyId in every key.

---

### 2.9 Job design — one job, one purpose

Don't combine concerns in a single job. Split:
- `openclaw-sync` (every 5 min) — full diff + reconcile + materialize
- `openclaw-health-check` (every 1 min) — gateway ping only, updates status pill

Health check must be fast and independent. If sync fails, the health check should still pass (they probe different things).

---

### 2.10 Data handlers vs Action handlers

| Handler type | Use for | Triggered by |
|---|---|---|
| `data.*` | Read-only derived data (status, agent list, config) | UI polling, dashboard widgets |
| `action.*` | Mutations (sync, bootstrap, save config, chat send) | User button clicks |

Don't put mutation logic in data handlers — they may be called frequently and caching assumptions break.

---

## 3. OpenClaw Gateway Protocol v4 — Critical Gotchas

### 3.1 WebSocket client requirements

Your WS client must:
- Send a **keepalive ping every 25 seconds** (OC gateway drops connections at 30 s idle)
- Implement **exponential backoff reconnect** (start at 1 s, cap at 60 s, jitter optional)
- Handle the `CONNECTED` frame and re-register subscriptions on reconnect
- Queue outbound RPCs during reconnect, drain on re-connect

```ts
// Minimal keepalive loop
private startKeepalive() {
  this.keepaliveTimer = setInterval(() => {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.ping();  // or send a {"type":"ping"} frame per protocol spec
    }
  }, 25_000);
}
```

---

### 3.2 Two separate agent namespaces

OpenClaw has two independent agent registries. Mixing them up wastes hours:

| Namespace | Created by | Listed by | Syncs into PC |
|---|---|---|---|
| **Gateway agents** | `agents.create` RPC via WS | `agents.list` RPC | ✅ Yes — this is what the bridge syncs |
| **Isolated agents** | `openclaw agents add` CLI | `openclaw agents list` CLI | ❌ No — different subsystem |

Your sync engine should call `agents.list` over the gateway WebSocket to get OC agents. Agents added via the OC CLI (`openclaw agents add`) are in the isolated-agent subsystem and will NOT appear in the gateway roster.

---

### 3.3 Event tagging for routing

OC events don't know about PC natively. Tag events at creation so the event bridge can route them:

```ts
// When creating an OC task from a PC issue
await ocClient.rpc("tasks.create", {
  agentId: slotAgentId,
  payload: {
    ...issuePayload,
    metadata: { paperclipIssueId: issue.id, paperclipCompanyId: company.id },
  },
});
```

Then in your event bridge, filter on `event.metadata?.paperclipIssueId` to know which PC issue to comment on.

---

### 3.4 `sessionKeyStrategy: "fixed"` for warm sessions

By default, OC creates a new session for every agent invocation (cold start = 17-25 s). Setting `sessionKeyStrategy: "fixed"` reuses the same session across invocations for that agent.

**Trade-off:** Faster (4-9 s warm), but the Claude session retains context from previous issues. For stateless tasks (write a comment + close) this is fine. For stateful tasks (multi-turn debugging) it can cause cross-issue confusion.

Set this in the agent's `adapterConfig` during sync materialization:

```ts
adapterConfig: {
  sessionKeyStrategy: "fixed",
  timeoutSec: 120,
  waitTimeoutMs: 30_000,
  gatewayUrl: this.config.openclawUrl,
  ...
}
```

---

### 3.5 `agents.create` RPC — Exporting PC agents to OC

When creating an OC agent from Paperclip (PC → OC direction):

```ts
await ocClient.rpc("agents.create", {
  name: agent.name,
  model: "claude-opus-4-7",  // or from adapterConfig
  description: `Bridged from Paperclip: ${agent.id}`,
  metadata: { paperclipAgentId: agent.id },
});
```

The returned `id` is the OC agent ID. Store the mapping in plugin state for future sync rounds.

---

## 4. Integration Patterns

### 4.1 Diff-based sync (not full overwrite)

Never delete and recreate everything on each sync. Always diff:

```
OC roster (from agents.list RPC)
     ↕ diff
PC managed slots (from agents.managed list)
     ↓
Reconcile plan: { toCreate[], toUpdate[], toOrphan[], toSkip[] }
     ↓
Materialize: apply plan with SDK calls
```

Benefits: idempotent (re-runnable safely), minimal churn, clear audit trail, fast.

**Pure diff function signature:**
```ts
function diffRosters(
  ocAgents: OpenClawAgent[],
  pcSlots: ManagedAgent[],
  syncTable: Map<string, string>  // ocId → slotId
): ReconcilePlan
```

---

### 4.2 Auto-fill `adapterConfig` on sync

When a user creates an agent via Paperclip's New Agent picker with `adapterType: openclaw_gateway`, the gateway URL/token fields are often empty (the dialog only shows one field). Your sync engine should detect this and patch them:

```ts
// In materialize step
if (!agent.adapterConfig?.gatewayUrl && config.openclawUrl) {
  await ctx.agents.update(agent.id, {
    adapterConfig: {
      ...agent.adapterConfig,
      gatewayUrl: config.openclawUrl,
      sessionKeyStrategy: "fixed",
    },
  });
}
```

---

### 4.3 Token injection pattern (wake message)

The cleanest way to give an OC agent its Paperclip API key without storing it in any config file:

```
PC bootstrap action
  → POST /api/agents/:id/keys  (mint per-agent key)
  → PATCH /api/agents/:id       (adapterConfig.payloadTemplate.message = "Set PAPERCLIP_API_KEY=...")
         ↓
  OC gateway wake event received by agent
  → Agent reads key from event message
  → Agent uses key for PC API calls (comment, close, etc.)
```

The token travels through the PC API (encrypted in transit + at rest in PC's own DB). It never appears in plugin state, a file on disk, or a commit.

---

### 4.4 Status pill pattern for settings UI

Users need instant visibility into what's working. A status strip at the top of the settings panel with three pills (Gateway / Token / Bindings) is the minimal viable status surface:

```tsx
type PillStatus = "ok" | "warn" | "err" | "neutral";

function StatusPill({ label, status }: { label: string; status: PillStatus }) {
  const colors = {
    ok:      "bg-green-500/20 text-green-300 border-green-500/30",
    warn:    "bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
    err:     "bg-red-500/20 text-red-300 border-red-500/30",
    neutral: "bg-zinc-700/40 text-zinc-400 border-zinc-600/30",
  };
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs border ${colors[status]}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}
```

Drive pill status from your health-check data handler — not from the settings panel's own fetch.

---

### 4.5 Collapsible section pattern

Every settings panel section should be collapsible. Start expanded if there's a problem, collapsed if healthy:

```tsx
function CollapsibleSection({
  title, defaultOpen = false, badgeStatus, children
}: {
  title: string;
  defaultOpen?: boolean;
  badgeStatus?: PillStatus;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <div className="border border-zinc-700 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium bg-zinc-800/60 hover:bg-zinc-700/60 transition-colors"
      >
        <span>{title}</span>
        <Chevron open={open} />
      </button>
      {open && <div className="px-4 py-4 bg-zinc-900/40">{children}</div>}
    </div>
  );
}
```

---

## 5. Common Failure Modes → Solutions

| Symptom | Root Cause | Fix |
|---|---|---|
| Settings panel renders as dashed placeholder box with plugin name repeated | `tsc`-only build — bare specifiers not rewritten | Run `tsc + esbuild`. Never commit tsc-only UI dist. |
| `403` on issue mutations (comment, close) from OC agent | Shared token can't act as the assigned agent | Mint per-agent keys via `POST /api/agents/:id/keys` |
| `409` "company has no active CEO" when bootstrapping | Attempted join-request flow | Skip join flow. Use per-agent keys endpoint directly. |
| Connection section not visible in settings panel | Custom settingsPage hides PC's auto-config form | Implement your own Connection section (§2.2) |
| Sync shows OC agents but CLI-added agents are missing | CLI adds to isolated-agent namespace, not gateway | Gateway sync uses `agents.list` RPC only; CLI agents are a different system |
| New Agent picker shows one field, not 12 gateway fields | PC hardcodes simplified form for `openclaw_gateway` | Document post-creation config; auto-fill via PATCH on sync |
| Gateway drops WS connection silently | No keepalive — gateway times out at 30 s | Send ping every 25 s |
| Cold agent response takes 17-25 s | New OC session per invocation | Set `sessionKeyStrategy: "fixed"` in adapterConfig |
| Managed slot shows "OpenClaw Agent 1" not OC agent name | No `agents.update` in SDK 2026.517.0 | Show OC-name ↔ slot mapping table in UI; upstream feature request |
| `git push` fails after PAT rotation | `gh auth setup-git` credential helper has stale token | Run `gh auth login --with-token < new-pat && gh auth setup-git` |

---

## 6. Build & Tooling Cheat Sheet

### Plugin build (PC side)
```powershell
cd App
pnpm install
pnpm build        # tsc -p tsconfig.build.json && node esbuild.config.mjs
pnpm typecheck    # tsc --noEmit (includes UI)
pnpm test         # vitest
```

### Install into local PC (development)
```powershell
$dest = "$env:USERPROFILE\.paperclip\plugins\opencalw_adapter_for_paperclip"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item -Path ".\App\dist"         -Destination "$dest\dist"         -Recurse -Force
Copy-Item -Path ".\App\package.json" -Destination "$dest\package.json" -Force
```

### Reload plugin without restart
Kill the worker process. PC will respawn it on the next plugin interaction (no full PC restart needed).

### Check plugin logs
Look in PC's worker process log stream. Plugin stdout/stderr is captured there. Add a unique prefix (`[OC-BRIDGE]`) to all your log lines for filtering.

### Package for distribution
```powershell
# From Release/ folder
Compress-Archive -Path ".\opencalw_adapter_for_paperclip\*" `
  -DestinationPath ".\opencalw_adapter_for_paperclip-1.0.0.zip" -Force
```

Include: `dist/`, `package.json`. Exclude: `node_modules/`, `src/`, `*.tsbuildinfo`.

---

## 7. GitHub Publishing Cheat Sheet

### One-time auth setup (classic PAT — do this once per machine)
```bash
# Generate at: github.com/settings/tokens/new
# Scopes: repo, workflow, admin:public_key, delete_repo, gist, user
echo "ghp_..." | gh auth login --with-token
gh auth setup-git   # configures git credential.helper
gh auth status      # verify
```

### Create repo + push
```bash
gh repo create my-adapter --public --source=. --remote=origin \
  --description "Brief description" --push
```

### Cut a release with assets
```bash
gh release create v1.0.0 dist/*.zip \
  --title "v1.0.0 — Initial release" \
  --notes-file RELEASE_NOTES.md
```

### Open a community announcement issue
```bash
gh issue create --repo paperclipai/paperclip \
  --title "Community plugin: my-adapter (Brief description)" \
  --body-file ANNOUNCE.md
```

**Fine-grained PATs cannot create repos** (need Administration:write at account level). Use classic PATs for automation that creates repos.

---

## 8. Latency Benchmarks (reference values)

From the real-world verification run (2026-05-23, 3 bridged agents, claude-opus-4-7):

| Operation | Time |
|---|---|
| Cold agent invocation (new OC session) | 17–25 s |
| Warm invocation (sessionKeyStrategy=fixed) | 4–9 s |
| 3 parallel issues, different agents | ~16 s wall-clock |
| 10 parallel real-world tasks (Fibonacci, web fetch, shell, SQL explain, etc.) | 10/10 in ~6 min |
| `agents.create` RPC (PC → OC export) | ~232 ms |
| Per-agent PC API key mint | ~50 ms |
| WS round-trip (ping → pong) | < 20 ms local |
| PC comment + status close via API | ~80–150 ms |

**~95% of total latency is the Claude model call inside OpenClaw**, not bridge overhead. The WS + RPC + PC API path is sub-300 ms total.

---

## 9. V2 Ideas (not yet built)

These patterns were identified during V1 but deferred:

| Feature | Approach | Blocker |
|---|---|---|
| Per-slot display names | `agents.update` SDK call | Not in SDK 2026.517.0 |
| Full 12-field OC config at agent create time | PC NewAgentDialog hook or upstream patch | Hardcoded simplified form in PC UI |
| OC → PC push (session finish → PC issue) | OC-side channel plugin v2 | `paperclip_adapter_for_opencalw` scaffold ready |
| Multi-gateway per PC company | Multiple WS clients, disambiguated state keys | V1 intentionally one-to-one |
| Pre-warm sessions at sync time | Send a no-op message to each agent slot at sync | Side effect: uses OC credits |
| Smaller wake prompt for heartbeat-only tasks | Separate slim `payloadTemplate` per task type | Requires issue-type metadata at assign time |

---

## 10. Checklist: Starting a New Adapter

Use this when beginning a new PC↔external-system adapter:

- [ ] Read `Paperclip_KB_v2_0_0.md` §9 (Plugin SDK) and §11 (plugin walkthrough) before writing any code
- [ ] Declare all capabilities upfront in `manifest.ts` — don't add them reactively
- [ ] Set up `esbuild.config.mjs` before writing any UI code
- [ ] Implement your own Connection/config section in the settings panel (PC hides the auto-config form)
- [ ] Use per-agent API keys, NOT shared tokens
- [ ] Skip the join-request flow — go direct to `POST /api/agents/:id/keys`
- [ ] Use scoped state keys (include companyId, never flat keys)
- [ ] One job = one purpose (sync job, health job)
- [ ] Keep sync logic in three pure layers: diff → reconcile plan → materialize
- [ ] Set `sessionKeyStrategy: "fixed"` in managed agent `adapterConfig` for warm sessions
- [ ] Send WS keepalive every 25 s (OC gateway drops at 30 s)
- [ ] Add status pills strip to settings UI (Gateway / Token / Bindings)
- [ ] Build verification: run a stress test with 5+ parallel real-world tasks before calling V1 done
- [ ] Document V1 limitations clearly in README before publishing
- [ ] Publish PC-side and OC-side plugins as separate GitHub repos (different discovery audiences)
