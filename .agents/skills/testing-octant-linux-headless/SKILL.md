---
name: Testing Octant headless on Linux through Chrome
description: End-to-end browser testing for Octant running as a headless Linux station, including server launch, authenticated Chrome URLs, first-run onboarding, provider setup, and mode thread probing.
---

# Testing Octant headless on Linux through Chrome

## When to use this skill

You are driving Octant as a headless Linux host (no Electron desktop) and need to verify browser-only behavior: onboarding, provider settings, chat turns, and Work/Code mode handling. This complements the normal unit/integration test commands (`bun run test`, `bun run verify`) and is used when the acceptance criteria require a real browser and a real provider CLI.

## One-time setup per session

1. Make sure `bun` is available. The executable may be at `/home/ubuntu/.bun/bin/bun` and is not always on `PATH` in a fresh shell. The build/test scripts need `bun`, so either source an `envrc` that adds it or prepend it explicitly.
2. Confirm the GNOME Keyring / Secret Service session is active if you are testing the credential path:
   - `DBUS_SESSION_BUS_ADDRESS` must be exported.
   - `busctl --user status org.freedesktop.secrets` should succeed.
   - If the session is missing, `octant status` will report `Secret store: unavailable` and the credential broker will not start.
3. Confirm provider CLIs are installed where expected (e.g. `~/.local/bin/codex`, `~/.local/bin/devin`). `codex login status` should report a logged-in state before testing a real Codex turn.

## Launch the server under test

Start each server instance with a dedicated `XDG_DATA_HOME` so data dirs do not collide:

```bash
export PATH="/home/ubuntu/.bun/bin:$PATH"
# With Secret Service
DBUS_SESSION_BUS_ADDRESS="unix:abstract=/tmp/dbus-XXXXXX,guid=..." \
  XDG_DATA_HOME=/home/ubuntu/.cache/octant-review-server-data/data \
  bun run --cwd packages/cli src/bin.ts server run --port 13774

# Without Secret Service
env -u DBUS_SESSION_BUS_ADDRESS \
  XDG_DATA_HOME=/home/ubuntu/.cache/octant-nodbus/data \
  bun run --cwd packages/cli src/bin.ts server run --port 13775
```

The server child process receives `OCTANT_CREDENTIAL_BROKER_URL` and `OCTANT_CREDENTIAL_BROKER_TOKEN` only when Secret Service is reachable. Verify this by reading `/proc/<child-pid>/environ` for the child that runs `bun src/main.ts` (not the `bun run` wrapper).

## Check server health and secret-store status

```bash
OCTANT_INSTANCE_URL=http://127.0.0.1:13774/ bun run --cwd packages/cli src/bin.ts status --port 13774
```

- With the keyring `DBUS` env exported, expect `Octant host status: ready` and `Secret store: available`.
- With `-u DBUS_SESSION_BUS_ADDRESS`, expect `Secret store: unavailable` and the host still `ready`.

## Create an authenticated browser session

`octant web` may regenerate a desktop bridge secret that does not match the running server (`Project authority is unavailable`). The stable approach is to mint a launch token directly:

1. Read `OCTANT_DESKTOP_BRIDGE_SECRET` from the server child environ, or from the file written to the server data dir (`bridge.secret` or similar).
2. POST to `/api/desktop/launch-sessions`:

```bash
curl -s http://127.0.0.1:<port>/api/desktop/launch-sessions \
  -H 'content-type: application/json' \
  -H "x-octant-desktop-secret: <bridgeSecret>" \
  -d '{"windowId":"<uuid>","capability":"<43-char base64url token>"}'
```

The capability must match the regex `^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$`. The response URL is:

```
http://127.0.0.1:<port>/?serverUrl=http%3A%2F%2F127.0.0.1%3A<port>%2F#launchToken=<launchToken>
```

Launch tokens are single-use and expire in 5 minutes (`LAUNCH_SESSION_DEFAULT_TTL_MS`). Generate a fresh token for each tab load or reload.

## Drive Chrome with puppeteer-core

Connect to the Devin Chrome remote-debugging endpoint (`http://127.0.0.1:29229` in the current environment) and use `puppeteer-core`:

```typescript
import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:29229" });
const page = await browser.newPage();
await page.goto(authUrl, { waitUntil: "networkidle2" });
```

- If the installed `puppeteer-core` is older, `page.waitForTimeout` may not exist; use `await new Promise(r => setTimeout(r, ms))`.
- Use exact text matching for first-run footer buttons (`Continue`, `Skip for now`) and sidebar buttons; partial-text matching accidentally clicks `New chat` instead of `Set up a provider`/`Add provider manually`.
- The first-run onboarding dialog is modal and must be completed or skipped before you can reach Settings or open a thread.

## Important UI behavior

- **Host label:** the local host selector should read `This computer` on Linux (`aria-label` like `Host: This computer · Connected`). Watch for first-run onboarding copy that still says `this Mac` on Linux (`kept on this Mac`, `What this Mac can actually reach`); those strings are product-copy findings, not functional failures.
- **Credential fields in the browser:** API-key inputs for providers are disabled with a message such as `Manage credentials in the Octant host app. Credential changes are unavailable in this browser.` This is expected on a browser-only Linux station because there is no `window.octantHost` bridge. There is no plaintext fallback.
- **No-DBUS fail-closed behavior:** with Secret Service absent, the app shell still renders, the chat composer shows a typed `No provider ready` state, and provider forms disable the credential input. No uncaught exceptions or blank screens should occur.
- **Work and Code mode probing:**
  - The mode switcher in the sidebar offers Work and Code alongside Chat.
  - The folder picker is browser-based and can select local folders for Work Projects.
  - Code mode requires a Git repository; a non-git folder produces a typed refusal (`Code threads need a Git repository ...`).
  - On Linux, Seatbelt confinement may not be available; actual Work/Code turns may fail after project creation. Watch for typed error messages rather than crashes or silent hangs.

## Model gotchas

- Codex readiness is reported by the CLI. The exact ready model name may differ from what the test plan expects (e.g. `GPT-5.6-Sol` vs `gpt-5.6-luna`). Always verify the model ID shown in the provider card before sending a test message, and confirm from the server/provider responses whether the selected model was actually used.

## Cleanup

- Server instances are backgrounded with `nohup`; stop with `kill <pid>` or by killing the child `bun src/main.ts` process.
- Launch tokens are single-use and short-lived; no explicit cleanup needed.
- Screencasts and screenshots are written to `/home/ubuntu/screencasts/` and `/tmp/browser-driver/` by default.

## Devin secrets needed

None for the browser harness itself. If you ever need the real provider credentials (e.g. a ChatGPT/Codex session), those are user-supplied and must not be read from disk or typed by the agent. Use `codex login status` to check readiness and escalate to the user for interactive sign-in.

## Linux confinement (Bubblewrap) notes

- `server.ts` hardcodes the Code checkout shell to `/bin/zsh`; `zsh` must be installed on the Linux host.
- Right-side Terminal in a Code thread opens a `bwrap --unshare-all -- ... /bin/zsh` namespace. Capture the exact command with `ps -ef | grep '[b]wrap'`. The launch is built by `apps/server/src/process/linuxConfinement.ts`.
- The sandboxed `HOME` is the per-shell state directory. Octant pre-seeds a minimal `.zshrc` there so `zsh-newuser-install` is normally suppressed. If a prior `.zshrc` exists in that directory (e.g. from an older run), the wizard may still fire and must be dismissed (`q` or `0`) before commands execute normally.
- When driving the terminal from Puppeteer/`page.keyboard.type`, the `+` key can be swallowed by `zsh-newuser-install` or by xterm key translation, causing commands like `printf '%s\n' "$((1729+1))"` to be mangled. Use a `+`-free arithmetic form (e.g. `echo $((1729 - -1))`) to get `1730`.
- Fail-closed behavior (missing/non-executable `bwrap`) is easiest to verify against `buildLinuxConfinementLaunch` directly; it throws `SeatbeltConfinementError` with reason `incompatible`. Starting the server inside a `bwrap` namespace that masks `/usr/bin/bwrap` with `/dev/null` can crash Bun before the server boots, so do not rely on that path for UI fail-closed testing.
