---
name: testing-octant-linux-ade
description: How to run and validate Octant's Linux ADE in Chrome on an Ubuntu desktop VM — server/renderer startup, scratch Code project setup via CLI, Codex provider login, Zen/dock terminal paths, and input-soak control technique.
---

# Testing Octant's Linux ADE in Chrome (Ubuntu desktop)

## Environment

- Server: `bun run packages/cli/src/bin.ts server run` → http://127.0.0.1:13773 (`/health` returns ok; `/` returns 503 "web client not built" — expected; use the Vite renderer).
- Renderer: `bun run packages/cli/src/bin.ts web --dev --no-open` → open `http://127.0.0.1:5173/?serverUrl=http%3A%2F%2F127.0.0.1%3A13773%2F` in Chrome. No launch token needed — loopback POSTs `/api/shell/local-session` automatically.
- Always `. ~/.config/octant-host/session.env` before CLI use; if stale, run `bash scripts/ade/start-secret-service-session.sh` and then re-source `. ~/.config/octant-host/session.env` (the script runs as a subprocess — its exports do not reach the calling shell).
- CLI: `bun run packages/cli/src/bin.ts <cmd>` from repo root.

## Devin Secrets Needed

- `OPENAI_API_KEY` — for `printf '%s' "$OPENAI_API_KEY" | codex login --with-api-key` (never print the key). Without it the Codex CLI provider instance registers but turns fail.

## Setup recipe

1. Scratch Code project: `git init /tmp/ade-demo && git -C /tmp/ade-demo commit --allow-empty -qm init` (Code binding inspects git — an empty dir fails; `--allow-empty` is required since nothing is staged), then from the Octant repo root `bun run packages/cli/src/bin.ts project add /tmp/ade-demo --type code --name ade-demo`.
2. `octant project access <name> full-access` sets `codeAccessPersistence: "project-default"` (the "Project remembers Full access" flag); `... approval-gated` resets to `current-session`.
3. Codex CLI instance auto-registers on first app load via discovery (no manual scan needed if `codex` is on PATH and logged in).
4. If a provider turn fails in the UI with "Provider execution failed." minutes after working, suspect a stale codex key: `~/.codex/auth.json` keeps the key from the last login, and a new session `OPENAI_API_KEY` makes the stored one return 401 `invalid_api_key`. Confirm with `codex exec --model <m> "Reply with exactly: PING-OK"` in a scratch repo, then re-login (`printenv OPENAI_API_KEY | codex login --with-api-key`) — `--with-api-key` reads stdin, it does not take the key as an argument.

## UI paths

- Zen: sidebar account button ("Set your name" / Account menu) → "Zen mode" → Navigator bar → Add → Terminal → "This Project" (requires the window's Code project context — click a project row in Projects directory first).
- Thread dock terminal: open the Code thread → Right Utility Dock → Workspace → "Terminal" (auto-starts).
- Thread access picker: "Next turn access" button in composer. Options below ceiling are direct radio items; above ceiling appear as "Raise thread · X" (disabled unless a native approval surface exists OR the project remembers Full access); "Lower thread · Ask for approvals" appears when ceiling > approval-gated.
- Composer access menu ("Access policy" button): picking "Full access" on Linux only succeeds if "Remember for this Project" is also ticked AND the project remembers — otherwise it surfaces an instructive error naming `octant project access <name> full-access`. There is no native approval dialog on Linux.
- First-run onboarding ("Welcome to Octant", 5 steps) may appear on a fresh profile — "Skip setup" is safe; provider discovery already ran.

## Terminal input-soak technique

To catch dropped/reordered keystrokes, type a brisk battery (`echo HEAD HEAD HEAD`, `echo THE-QUICK-BROWN-FOX-0123456789`, `printf '%s\n' ABCDEFGHIJKLMNOPQRSTUVWXYZ`, `echo AABBCCDDEEFFGGHH`) into the terminal, then type the SAME battery into a control surface to isolate the layer:

- Native terminal (install/run `konsole`) — isolates the synthetic-input harness.
- A plain textarea in the same page (e.g., the thread's follow-up composer) — isolates Chrome/DOM input vs the xterm.js→PTY path.
  Inspect results with the `zoom` action on the terminal region; default-scale screenshots can misrender "HEAD" as "HED".

**Do NOT trust `computer`-tool (`type` action) typing for character-level assertions.** It drives xdotool, which remaps spare keycodes to synthesize characters; Chrome sometimes resolves the keysym after xdotool restored the mapping, producing `keydown` events with `key="\u0000"`, `code="IntlRo"/"Lang5"/"F19"/""`. At brisk cadence ~15-20% of characters arrive as garbage — a bare `<textarea>` on `about:blank` drops them identically. xterm.js emits a `"\0"` data byte for those keys and Octant faithfully forwards it (readline discards NUL). For reliable terminal typing attach playwright-core over CDP at `http://localhost:29229` and use `page.keyboard.type()` / `page.keyboard.insertText()` — CDP injects characters directly, skipping the X11 keysym path, and produced zero drops in soak runs.

## Resolved investigations

- "Terminal typed input drops characters" (`HEAD`→`HED`, missing letters mid-string): traced end-to-end on main @ 7bde7a4c with an instrumented `CodeTerminalPane` — dropped chars arrived at `enqueueWrite` already as `"\u0000"`, and the same loss reproduced in a plain textarea with no Octant code involved. Root cause is the xdotool typing artifact above, NOT the keystroke-coalescing path or any Octant code. Real keyboards are unaffected. No product change made.
