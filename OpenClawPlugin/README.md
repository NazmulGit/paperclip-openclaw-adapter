# openclaw-plugin-paperclip-bridge

OpenClaw plugin that gives agents a `paperclip` tool for talking to Paperclip — commenting on issues, changing status, opening follow-ups, without writing raw fetch boilerplate.

Pairs with the Paperclip-side plugin `paperclip-plugin-openclaw-bridge` in `App/`.

## Status

**Scaffold.** Manifest, entry point, tool stub, and skill docs are in place. Not yet installed or tested against a running OpenClaw. Treat this as the foundation for V2.

## What it adds

A `paperclip` tool with four operations:

| op | description |
|---|---|
| `ping` | Probe Paperclip reachability (`GET /api/agents/me`) |
| `commentIssue` | Post a comment on an issue |
| `setIssueStatus` | Change status; optionally include a comment |
| `createIssue` | Open a new issue in a company |

Plus a skill (`skills/paperclip/SKILL.md`) that tells OC agents when and how to call it.

## Configuration

Set in OpenClaw's plugin config (`openclaw plugins inspect paperclip-bridge --runtime`):

| field | required | notes |
|---|---|---|
| `baseUrl` | yes | Paperclip API base. Default `http://127.0.0.1:3100` |
| `apiKey` | recommended | Bearer token. Get one from the Paperclip-side bridge's "Bootstrap PC credentials" button — that mints per-agent keys. Paste the value for the agent this OpenClaw instance represents. |
| `defaultCompanyId` | optional | Used by `createIssue` when no `companyId` is passed |
| `defaultAgentId` | optional | Used by `createIssue` when no `assigneeAgentId` is passed |

## Build

```bash
pnpm install
pnpm build      # tsc -> dist/index.js
```

## Install (once OC accepts it)

```bash
openclaw plugins install ./
openclaw plugins enable paperclip-bridge
openclaw plugins inspect paperclip-bridge --runtime    # verify config
```

## Why this exists vs. the existing bridge

The Paperclip-side plugin (`App/`) already makes the round-trip work: PC creates an issue → bridged OC agent processes it → posts a comment + closes via PC API. That works because the bridge inlines each agent's API key into the wake message, and the agent uses raw fetch.

This OC-side plugin is the cleaner alternative: instead of having every agent know the raw `/api/issues/.../comments` URL, it gets a typed `paperclip` tool the agent calls by name. Useful for:
- OpenClaw sessions that *aren't* PC-driven but still want to report into PC
- Agent code that's more maintainable than fetch boilerplate
- Future channel-plugin work (PC issues as OC channels)

## Files

```
OpenClawPlugin/
├── openclaw.plugin.json    # manifest: id, configSchema, contracts.tools
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts            # entry: re-exports register()
│   └── plugin.ts           # tool implementation
└── skills/
    └── paperclip/
        ├── SKILL.md        # agent-facing usage docs
        └── manifest.json
```

## V2 work

- Real install + test against a local OC instance
- Channel-plugin variant: surface PC issues as OC chat channels (`/paperclip <issueId>` to join)
- OC→PC push: hook session lifecycle to auto-create PC issues for long-running OC work
