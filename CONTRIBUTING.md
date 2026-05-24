# Contributing

Thanks for thinking about contributing.

## Setup

```bash
# Clone
git clone <repo-url>
cd paperclip-openclaw-bridge

# PC plugin
cd App
pnpm install
pnpm build       # runs tsc + esbuild
pnpm test        # vitest

# OC plugin
cd ../OpenClawPlugin
pnpm install
pnpm build
```

You need Node 20+ and pnpm.

## Local dev loop

1. Start Paperclip locally (`npx paperclipai run` or your normal flow).
2. Start OpenClaw gateway (`openclaw gateway run`).
3. Symlink (or copy) `App/` into `~/.paperclip/plugins/paperclip-openclaw-bridge/`.
4. Edit code in `App/src/...`.
5. `pnpm build` to recompile. The plugin worker restarts automatically when Paperclip sees the new files (may require kill + respawn — see below).
6. For UI changes, hard-refresh the Paperclip settings page after a build (the bundled UI is cached).

### Worker reload trick

Paperclip caches the worker process. After a build:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match "paperclip-openclaw-bridge.*dist[\\\/]worker\.js" } |
  Stop-Process -Force
```

Next request to the plugin will respawn the worker with new code.

## Code style

- TypeScript ESM, strict mode.
- One method on the host SDK = one entry in `manifest.capabilities`. Adding an SDK call without listing the capability is a bug.
- Never commit plaintext OpenClaw tokens or API keys. Use `ctx.secrets.resolve()` or runtime config.
- Keep one job key per purpose. `sync-openclaw` does the full diff, `openclaw-health-check` only pings.

## Testing

- Unit: vitest + `@paperclipai/plugin-sdk/testing` TestHarness.
- Integration: `Others/scripts/smoke.sh` spins up a mocked OC gateway and walks the full sync.
- E2E manual: point at a real local OpenClaw (`Upstream/openclaw/`).

Before submitting a PR, run `pnpm test` and `pnpm typecheck` in `App/`.

## What's in scope vs out

In scope:
- Bug fixes in the bridge (sync, materialization, event routing).
- UI improvements to the SettingsPanel.
- Better diagnostics + error messages.
- Performance: session reuse, parallelism, smaller wake prompts.

Out of scope (or V2):
- Multi-OpenClaw-gateway per Paperclip company.
- A new `adapterType` distinct from `openclaw_gateway`.
- Full OC channel plugin (Paperclip as a channel inside OC).
- ClawHub publishing automation.

## PR checklist

- [ ] `pnpm build` succeeds in `App/` and `OpenClawPlugin/`.
- [ ] `pnpm test` passes.
- [ ] If touching the manifest, update `manifest.capabilities`.
- [ ] If touching the UI, click through the affected sections in a browser.
- [ ] If adding a new action/data handler, document it in the README + add it to the manifest constants.

## Reporting bugs

Open an issue with:
- Paperclip version (`paperclipai --version` or check `~/.paperclip/openclaw.json`).
- OpenClaw version (`openclaw --version`).
- Plugin version (in `App/package.json` or the Plugins page).
- Steps to reproduce.
- Relevant log excerpts (`~/.paperclip/logs/` and `openclaw plugins inspect <id>`).

## License

By contributing you agree your contributions are licensed under the MIT License (see [LICENSE](LICENSE)).
