---
name: testing-octant-desktop
description: How to test the packaged Octant macOS desktop app end-to-end — launch, first-run, providers, journal inspection, and UI quirks.
---

# Testing the packaged Octant desktop app (macOS)

## Launching the packaged build
- Build output: `out/Octant.app` (unsigned). Gatekeeper blocks first launch: run
  `xattr -dr com.apple.quarantine out/Octant.app` then `open out/Octant.app`.
- User data lands in `~/Library/Application Support/Octant/`:
  - `octant.sqlite3` — event journal + projections (authoritative state)
  - `providers/runtime-receipts/receipt-*.json` — tracked provider child processes
  - `~/Library/Logs/Octant/service.log` — server lifecycle log (only `server.ready` lines; errors are NOT logged here)
- Electron DevTools works in the packaged app: Cmd+Opt+I opens Elements/Console/Network — the only way to see renderer-side errors (e.g. `POST /api/chat/commands` status codes).

## Providers
- Codex CLI: authenticate once with `printf '%s' "$OPENAI_API_KEY" | codex login --with-api-key` (never print the key). Codex threads must use the `luna` model (team constraint).
- Mistral Vibe ACP: provider form has a password field for the API key. Copy it via
  `printenv MISTRAL_API_KEY | tr -d '\n' | pbcopy` then Cmd+V into the field.
- Devin Secrets needed: `OPENAI_API_KEY`, `MISTRAL_API_KEY`.

## Journal inspection (sqlite)
- `event_journal.payload_json` holds events; the type discriminator is `$.kind` (not `$.type`).
- `chat_turn_projection.turn_json` — turn rows incl. `$.extensionSelections` and `$.failure`.
- Attempt lifecycle: `attempt-updated` events carry `outcome` (`queued|completed|failed|interrupted|waiting`) and `failure.code`.
- `provider_catalog_projection.catalog_json` — discovered models only; runtime capabilities (e.g. appManagedTools) are NOT journaled there.

## UI automation quirks (computer-use tool)
- The thread composer textarea sits BELOW the "Tip:" status line — click ~y=585 (at 1024×768), not on the tip row, or keystrokes land nowhere.
- The `@` mention popup only appears in an OPEN thread's composer, never in the new-draft composer. Typing `@` into a field that already contains `@` yields `@@` and no popup — Cmd+A then BackSpace first.
- Draft-composer provider/model pickers can be flaky in open threads; select the model in a NEW draft composer instead (it works reliably there).
- A blocked composer send ("cannot accept native attachments") latches: remove selection chips via their `x`, clear text, and re-add to retry.

## Simulating a crashed host with a live orphan
- `pkill -9 -f Octant` lets provider app-servers exit cleanly on stdio EOF — they will NOT survive as orphans and will release thread locks.
- To create a true frozen orphan for restart-reconciliation testing: `kill -STOP <pid>` the app-server FIRST, then `pkill -9 -f Octant`. A stopped process cannot read EOF or run cleanup; startup reconcile must SIGKILL it.

## Testing a fix on a branch/worktree
- Rebuild the packaged app INSIDE the worktree, not the main checkout:
  `cd <worktree> && bun install && bun run build && bun scripts/package-desktop.ts` → `<worktree>/out/Octant.app`.
- Then `pkill -9 -f Octant`, `xattr -dr com.apple.quarantine <worktree>/out/Octant.app`, `open` it.
  User data (`~/Library/Application Support/Octant`) is shared across builds, so prior threads persist —
  reuse the same thread that showed the defect to prove the fix on the identical path.

## Useful evidence commands
- `pgrep -fl codex` / `pgrep -fl vibe-acp` — provider child processes.
- `ls ~/Library/Application\ Support/Octant/providers/runtime-receipts/` and
  `ls ~/.codex/thread-writer-locks/` — receipt + writer-lock state before/after restart.
