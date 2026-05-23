# Skill: paperclip

Lets you (an OpenClaw-driven agent) report progress or take action on Paperclip issues, via the `paperclip` tool installed by `openclaw-plugin-paperclip-bridge`.

## When to use this skill
- You are working on a task that originated as a Paperclip issue, and you want to leave a durable trail (comment + status change) instead of just chatting in the OpenClaw session.
- You want to open a new Paperclip issue for follow-up work that should be tracked.
- You want a quick reachability check before doing real Paperclip work.

## Tool operations

The `paperclip` tool takes one required field: `op`. Other fields depend on the op.

| op | required | notes |
|---|---|---|
| `ping` | — | Returns `/api/agents/me`. Confirms the API key works. |
| `commentIssue` | `issueId`, `body` | Posts a comment. The comment is attributed to the API key's agent. |
| `setIssueStatus` | `issueId`, `status` | `status` must be one of: `todo`, `in_progress`, `in_review`, `blocked`, `done`, `cancelled`. Optionally pass `comment` to post a comment in the same call. |
| `createIssue` | `title`; `companyId` if no default is configured | Opens a new `todo` issue. Optional: `description`, `priority` (`critical`/`high`/`medium`/`low`), `assigneeAgentId`. |

## Examples

Quick reachability check:
```json
{ "op": "ping" }
```

Post a comment:
```json
{ "op": "commentIssue", "issueId": "1f58576d-...", "body": "Picked this up, will report progress in 30 min." }
```

Close with a summary:
```json
{ "op": "setIssueStatus", "issueId": "1f58576d-...", "status": "done", "comment": "Shipped in PR #42." }
```

Open a follow-up:
```json
{ "op": "createIssue", "title": "Investigate flaky test in CI", "description": "Repro: ...", "priority": "high" }
```

## Common failure modes

- **HTTP 401/403**: The API key is missing, expired, or doesn't have permission. Ask the operator to re-run `Bootstrap PC credentials` from the Paperclip-side bridge settings.
- **HTTP 404 on `commentIssue` / `setIssueStatus`**: Wrong `issueId`. Use `createIssue` to start a new one.
- **`createIssue` without `companyId`**: The plugin needs a default in config (`defaultCompanyId`) or an explicit `companyId` in the call.
