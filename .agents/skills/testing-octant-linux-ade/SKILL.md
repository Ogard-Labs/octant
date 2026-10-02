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
5. If every provider turn fails within milliseconds with "Codex returned an invalid protocol response" (journal `failure.code:"protocol"`), suspect codex-cli wire drift, not auth: codex 0.157.x emits `"error": null` inside `turn/start` and `turn/started|completed` TurnReferences, and strict `Schema.optional` fields reject `null`. Diagnose by replaying the captured `turn/start` JSON-RPC result through `decodeTurnStartResult` in `apps/server/src/providers/codexProtocol.ts` — `{id,status}` decodes, `{id,status,error:null}` throws pre-fix. The decode-side fix shape is `Schema.optionalWith(X, { nullable: true })` (null → `undefined`), which keeps `?.` consumers safe; newly added unknown fields (e.g. `itemsView`, `startedAt`, `durationMs`) are already stripped.

## Packaged desktop

- `bun run build && bun run package:desktop` emits `out/Octant-*-linux-x64.AppImage` (native rebuilds need clang — installed by the repo blueprint; GCC ≤ 12 cannot parse Electron's V8 headers). Launch for UI testing: `DISPLAY=:0 APPIMAGE_EXTRACT_AND_RUN=1 ./out/Octant-*-linux-x64.AppImage` — it spawns its own bundled server on :13773, so stop any dev server/ Electron instance first (single-instance lock quits silently). The packaged app has a native "Allow full access" approval dialog the web surface lacks on Linux.

## Journal inspection

- No `sqlite3` CLI on this host — use python3's sqlite3 module against `~/.local/share/octant/octant.sqlite3`, table `event_journal`, columns `global_sequence`, `event_name`, `payload_json` (the payload wraps entities, e.g. `attempt.outcome`, `turn.capabilities` — inspect shape before filtering).
- Chat attempt verdicts: `chat.attempt-updated@1` → `attempt.outcome` = queued/streaming/completed/failed + `attempt.failure.code` (e.g. `"protocol"`).
- Work-turn confinement posture: `work.turn-updated@1` → `capabilities` = `{shell:"denied", git:"denied", worktree:"denied", pullRequest:"denied", code:"denied", confinement:"project-root-confined"}` on Work turns.

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

## GitHub / pull-request testing on this host (OCT-109 PR row)

- **GitHub-connected detection is strict**: `parseGithubRemote` requires the remote's literal hostname `github.com`. Clones made here keep the _rewritten_ `https://git-manager.devin.ai/proxy/github.com/...` URL (insteadOf baked at clone) → project shows "Not on GitHub". Fix repo-local only: `git remote set-url origin https://github.com/<owner>/<repo>.git` — pushes still transparently proxy via the global insteadOf rewrite.
- **gh auth for the packaged app**: the packaged server resolves gh once at launch via `resolveGhExecutableFromPath(trustedOnly)` — only `/usr/bin`, `/bin`, `/opt/homebrew/bin`, `/usr/local/bin` count; `/opt/.devin/package/custom_binaries` is untrusted. The real `/usr/bin/gh` needs hosts.yml auth, but the devin repo token rotates (~minutes) so a copied token goes stale fast. Durable fix: `sudo cp /opt/.devin/package/custom_binaries/{gh,gh-bin} /usr/local/bin/` — the wrapper exports a fresh GH_TOKEN per call and `/usr/local/bin` precedes `/usr/bin` in the app PATH. Requires an app restart (ghExecutable cached at launch).
- **`local/` delivery-target signature (fixed OCT-336)**: pre-fix, `ProjectService` lacked `observeCodeProjectRepository` → `connectedRepository` never populated → every composer-created thread got `deliveryTarget.proposedBaseRepository = "local/<project name>"` → `resolvePullRequestTarget` emitted `local/...` → `pull-request-review` returned `unavailable` forever and the create form (needs state `none`) was unreachable; linked-thread matching could never fire. Threads created before the fix keep `local/` immutably — only new threads verify the fix. Signature: PR board works but the Pull Request pane says "could not be observed" and the journal floods with `pull-request-review`/`unavailable` ops.
- Journal query: `event_journal` → `code.operation-event-recorded@1`, result kinds `pull-request-review` (states none/unavailable), `create-pull-request`, `pull-request-state`. Delivery target lives in `code.thread-created@1` payload `deliveryTarget`.
- PR board refresh icons are small/flaky — if a click doesn't update the list, zoom first and hit the circular-arrow glyph precisely, or use the header "Refresh all".
- **`pull-request-state` lying signature (fixed OCT-337)**: pre-fix, `ensure()` created via `gh pr create` then re-observed with `gh pr list --head "<owner>:<branch>"` — owner-prefixed `--head` does NOT match same-repo PRs (bare `--head <branch>` does). On a pre-fix build the pane says "creation is unavailable" and the journal shows `unavailable` while the PR exists — verify with `gh pr list --repo <slug> --head <branch> --state all`.
- **Linked threads need a fresh per-PROJECT snapshot**: `matchLinkedThreadsToPullRequest` requires the PR row to exist under the SAME project's snapshot rows (`thread.projectId === pr.projectId`). Two projects sharing one repo each maintain their own observed list; a PR created moments ago may only appear under the project whose refresh ran — hit that project's own section ⟳ (auto-refresh can lag even when toggled on) before concluding the link is broken.
- "Open linked thread" selects the thread (sidebar badge `#<n>` on the row/tab) but may not foreground the thread workspace from the full-surface board — check the sidebar highlight before calling the navigation broken.

## Agents / delegated AgentRun testing

- **Reach the run detail UI from a Code thread**: Chat threads have no right utility dock. Delegate via `octant_agents` in a Chat turn if you only need the run created, but to open Agents dock / run detail, delegate from a **Code** thread (right dock has Agents) or use Agents Center (sidebar "More" → Agents).
- **Unregistered settle-event signature (pre-existing since #842, seen on PR-882 testing)**: `agent.run-result-delivery-settled@1` is appended in `agentRunEventStore.ts` but its name was never registered in `createPhase1RuntimeRegistries` (`apps/server/src/persistence/runtimeRegistry.ts`) → `eventRegistry.#decode` throws `UnknownEventName` inside `agentResultDeliveryService.#settle` on EVERY completed subagent result → delivery never settles → **infinite redelivery loop**: the parent transcript accumulates duplicate "A subagent you delegated has finished" cards interleaved with "Failed / The provider turn failed", and the journal shows `provider-turn-state` ops flipping running→failed every ~4-5s indefinitely (real provider calls — kill the server to stop quota burn). Signature check: `grep UnknownEventName /tmp/octant-server-*.log` and count `code.operation-event-recorded@1` ops growing on the parent threadId.
- **Agents Center list semantics**: unacknowledged terminal runs show "Completed · Needs acknowledgement" and stay under All/History; acknowledging (run detail "Mark reviewed" → `agent.run-result-acknowledged@1`) removes the row from the list entirely — it does NOT move to History.
- **Optional-field decode check without devtools**: the `browser_console` tool only returns logs created by YOUR injected script — it cannot dump the page console buffer. For "no decode errors" assertions rely on (a) correct UI render of endpoint data and (b) the server log; `curl` on `/api/agent-runs/center` returns 401 (session-bound), so don't use it as a decode check.
- Typing caveat still applies: verify delegated prompts in the DOM after typing — xdotool drops chars.

## Code Environment "Pull requests" group (journaled snapshot, OCT-340)

- **Zero-PR "empty" freshness signature**: the server (`codeProjectPullRequestService`) marks a _successfully refreshed_ project with 0 rows as `status:"empty"` — same status as "never refreshed". `projectEmptyCopy` handles it (body "No open or draft pull requests.") but `freshnessCopy`/`pullRequestCountCopy` do not check `lastSuccessfulRefreshAt`, so a composed status line reads "Refresh to load pull requests… No GitHub snapshot yet" after a refresh that just succeeded. Check `~/.local/share/octant/code/pull-request-snapshot.json` `projectFreshness` entries: `{status:"empty", lastSuccessfulRefreshAt:<ts>}` = refreshed-empty.
- **Stale-state technique**: `echo "127.0.0.1 api.github.com" | sudo tee -a /etc/hosts` (passwordless sudo works) makes refreshes fail while the UI keeps working — stale copy + cached rows. Remove with `sudo sed -i '/127.0.0.1 api.github.com/d' /etc/hosts`. Also the fastest way to prove "no GitHub reads on open": open the panel with the block active — it populates fully from the journaled snapshot; confirm zero new `code.operation-event-recorded` ops in `event_journal` (only `workspace.layout-replaced`).
- **Dev server does not log gh spawns** — for "did it hit GitHub" evidence use the journal diff + hosts block, not `grep gh` on the log.
- **Group expander hitbox is finicky**: clicks at the text's visual y sometimes miss; click ~10-15px lower (the row's real center), or focus it and press Enter — same issue as the rail refresh icons.
- Snapshot is deliberately OUTSIDE the journal — `refresh-project`/`refresh-all` produce NO `code.operation-event-recorded` events. Per-project scope evidence lives in `pull-request-snapshot.json` `projectFreshness[<projectId>:<owner>/<repo>].lastSuccessfulRefreshAt`.
- `pgrep -f` / `pkill -f` inside an exec call self-matches the wrapper shell's own command line and can kill your shell mid-command (kill survives, chained `&&` steps silently don't run). Prefer killing by exact pid from `ps aux | grep`, or `pkill -f "node .*vite --host"`-style patterns that can't match the wrapper.

## Canvas agent tool (octant_canvas) — how it actually reaches the model

- The tool is invoked as `tools.octant_canvas({operation:"create"|"revise"|"list"|"read"|"open"|"describe", ...})` inside Codex's `exec` JS bridge — NOT as a standalone tool call. In `~/.codex/sessions/<date>/rollout-*.jsonl` it appears inside `custom_tool_call`/`custom_tool_call_output` payloads for `name:"exec"`.
- A model that searches the exec VM's `ALL_TOOLS` catalog may report the tool "isn't available" — `ALL_TOOLS` only lists builtin tools (apply_patch, exec_command, etc.). Have the child call `tools.octant_canvas` directly instead of trusting a catalog listing. The same false-negative applies to `octant_shell`/`octant_agents`.
- Child AgentRun inner sessions land in the same `~/.codex/sessions/` dir; find the child's file by its `cwd` (the managed worktree path `~/.octant-worktrees/repo_<hash>/<childThreadId>`) and start timestamp.

## Delegation refusals

- `octant_agents` delegate returning `{"status":"refused","reason":"unavailable"}` maps to `agentRunChildWorktreePort` (worktree `planCreation`/`create`/`loadReceipt` refusal) for code-mode children. Observed: once a managed child completed with `agent.run-result-delivery-settled` "failed: The delivery was not admitted", every later delegate on that thread refused `unavailable` even after the run showed "Done"; the Agents-dock "Mark reviewed" click did not journal `agent.run-result-acknowledged`. If you need repeat delegations for a test, use a fresh thread or check whether an unacked/failed run is wedging the parent's delegation.

## Vite dev-server staleness after a mid-run branch switch

- `web --dev` caches dependency/package resolution in `node_modules/.vite/deps` (repo-root node_modules, plus the browser's loaded module graph). If the checkout switches branches while vite runs, NEW package-exports entries (e.g. a fresh `"./x": "./src/x.ts"` in a `@octant/*` package.json) silently fail to resolve: HMR keeps serving the old modules and the app looks "fine" while actually running pre-change code. Symptom: behavior under test is simply absent with no error.
- A page reload then shows a vite overlay like `"./x" is not exported under the conditions [...]` — misleading because the export IS on disk (workspace is a symlink); the cache is stale.
- Fix: kill the `web --dev` process, `rm -rf node_modules/.vite/deps`, restart `web --dev --no-open`, reload the page. Then re-test — any evidence captured on the stale bundle is invalid.
- Composer mention gate (OCT-285): every composer refuses an unattached `@computer`/`@browser` token — the thread composers check in `submitTurn`/their submit path, the first-message composers (ChatWelcome, WorkComposerAdapter, CodeComposerAdapter) check in their own submit. Both refusal wordings name the token; on ChatWelcome there is no suggestion list, so it says "start the thread and pick … there" instead.

## Journaled in-attempt Chat refusals

- **Deterministic in-attempt journaled refusal = Project spend ceiling** (the only UI-reachable one for chat threads): Sidebar → Projects → `+` → New Chat Project → row `…` → Open Project → Spend ceiling inspector (Manage) → integer token budget → Set. `1` guarantees refusal. Send a turn on that project's composer → `chat.turn-created@1` journals, then `spendCeiling.admit` inside `turnRunner.run` refuses → `chat.attempt-updated@1` `outcome:"interrupted"` + `failure:{code:"exhausted"}` → transcript "The spend ceiling for this scope is exhausted." + support correlation id (= attempt id) + Retry. Cleanup: Clear Project ceiling, Archive Project. Thread-scope ceilings exist but the right dock is disabled in chat mode — project ceiling only.
- **Pre-attempt only (verified — no journaled attempt)**: provider Disable or Remove → composer "No provider ready" block; Regenerate → "Chat service is unavailable." command refusal; zero `chat.attempt-*` events. Provider Remove also immediately auto-recreates a NEW **disabled** instance under a different id — bound threads keep the dead id. Safe protocol: `VACUUM INTO` sqlite backup while server runs, then Remove; restore = stop server, copy back, relaunch.
- **`@computer`/`@browser` not attachable on web**: mention typeahead needs `window.octantHost.getComputerUseStatus` (Electron-only); the token sends as plain text and the turn completes.
- **`failure.message` reachability**: a journaled `message` needs `ChatServiceError` inside `#runAttempt`'s try — only `#resolveExtensionContext` at `provider-handoff` throws there, and its conditions are phase-agnostic, so a bad selection refuses identically at send (pre-attempt). Producing one live needs a send→handoff state drift or the Electron `@Computer` path (macOS desktop); the stubbed-resolver test in `chatService.test.ts` is the authority on Linux.
- **Restart/replay check**: journaled in-attempt failures render the identical honest message after `server run` relaunch (verified including sqlite-restore relaunch) — compare the transcript sentence + support correlation id before/after.
