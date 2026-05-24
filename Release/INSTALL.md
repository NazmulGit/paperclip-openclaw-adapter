# Paperclip ↔ OpenClaw Bridge — Install

Two adapters. Install the Paperclip-side one (required) and, optionally, the OpenClaw-side scaffold.

| Side | Folder | What it does |
|---|---|---|
| Paperclip | `opencalw_adapter_for_paperclip/` | OpenClaw adapter installed **into Paperclip**. Discovers OC agents, mirrors them, runs sync, mints PC API keys for OC use. |
| OpenClaw | `paperclip_adapter_for_opencalw/` | Paperclip adapter installed **into OpenClaw**. Scaffolds a `paperclip.*` tool for OC agents (V2). |

## Prereqs

- Paperclip running locally (`paperclipai` on `http://127.0.0.1:3100`)
- OpenClaw Gateway running locally (default `ws://127.0.0.1:18789`)
- OC gateway token: `openclaw config get gateway.auth.token`
- Node 20+

## 1. Install the Paperclip-side adapter

```powershell
# From this Release/ folder
cd opencalw_adapter_for_paperclip

# Paperclip discovers plugins from ~/.paperclip/plugins. Copy or symlink there:
$dest = Join-Path $env:USERPROFILE ".paperclip\plugins\opencalw_adapter_for_paperclip"
New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
Copy-Item -Path "$PWD\*" -Destination $dest -Recurse -Force
```

Then in the Paperclip UI:
1. Open `http://127.0.0.1:3100/instance/settings/plugins`
2. Enable **OpenClaw Bridge** (it appears under "Installed Plugins").
3. Click **Configure** to open its settings.

## 2. Set gateway URL + token (now visible in the UI)

In the **Connection** section (new in v1.6):
1. Click **Edit**.
2. **Gateway URL**: `ws://127.0.0.1:18789`
3. **Gateway token**: paste the value from `openclaw config get gateway.auth.token`
4. Click **Save connection**.
5. Paperclip restarts the plugin worker; wait ~2 s.
6. Click **Test connection** — should report "OpenClaw gateway reachable".

## 3. Configure a company binding

In the **Configuration** section:
1. Left list — select one or more **Paperclip Companies**.
2. Right list — select one or more **OpenClaw Agents**.
3. Click **Save**.
4. Click **Sync now (all bindings)** to mirror them now.

## 4. Bootstrap PC credentials (one-time)

In the **Sync** section, click **Bootstrap PC credentials**. This mints a per-agent Paperclip API key for every bridged agent and inlines it into wake messages, so OpenClaw-side Claude can call back into Paperclip to comment, close issues, etc.

**Without this step, OC agents can process wake events but every issue mutation returns 403.**

## 5. Verify end-to-end (real UI flow, verified)

1. Go to `http://127.0.0.1:3100/TES/agents/all` (or your company prefix).
2. Click **New Agent** → **I want advanced configuration myself** → **OpenClaw Gateway** tile.
3. Fill **Agent name** (e.g. `ui-test-agent`) → click **Create agent**.
4. Back in the plugin settings, click **Sync now** then **Bootstrap PC credentials** (so the new agent gets its key).
5. Create a new issue in Paperclip, assign it to that agent. Description: *"reply with PONG and set status to done."*
6. Wait ~20 s. The issue should auto-close with PONG as the comment.

Confirmed working: TES-13 closed in 20 s with the marker comment.

## 6. (Optional) Install the OpenClaw-side scaffold

If you want OpenClaw agents to call Paperclip via a typed `paperclip` tool instead of raw fetch:

```powershell
cd ..\paperclip_adapter_for_opencalw
openclaw plugins install .\
openclaw plugins enable paperclip-bridge
openclaw plugins inspect paperclip-bridge --runtime
```

Set its runtime config:
- `baseUrl`: `http://127.0.0.1:3100`
- `apiKey`: a key from step 4 (one of the per-agent keys)
- `defaultCompanyId`: your Paperclip company ID (optional)

**Scaffold only** in V1 — manifest + tool + skill ready, install path not yet validated against a running OC. See `paperclip_adapter_for_opencalw/README.md`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "Gateway offline" badge | OC gateway not running or wrong URL/token | `openclaw config get gateway.auth.token` then re-Edit Connection |
| Settings page shows only "OpenClaw Bridge: OpenClaw Bridge" placeholder | Plugin was built with `tsc` only (no esbuild) | Rebuild source with `pnpm build` (now runs both tsc + esbuild) |
| Agent posts "Token file still absent" | OC agent has no PC credentials | Click **Bootstrap PC credentials** |
| 403 on `commentIssue` / `setIssueStatus` | Token is for a different agent | Re-bootstrap; per-agent keys are minted for each bridged agent |
| "Join request cannot be approved because this company has no active CEO" | PC requires `role=ceo` agent | Bootstrap auto-creates a `Bridge Bootstrap CEO`; verify it isn't terminated |

## Versions

- `opencalw_adapter_for_paperclip@1.1.0` (PC plugin, Paperclip SDK 2026.517.0)
- `paperclip_adapter_for_opencalw@0.1.0` (OC plugin scaffold, OpenClaw gateway protocol v4)
