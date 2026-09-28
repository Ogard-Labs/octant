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
  - `~/Library/Logs/Octant/service.log` — server lifecycle log (`server.ready` plus error-level
    `server.failure` entries from packaged-launch and migration failures; request-level failures
    like HTTP 4xx/5xx are NOT logged here)
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
- Code/Work threads journal differently from Chat: expect `runtime-work-updated` events (`$.work.state`) plus per-cursor stream events where the payload lives under `$.event` (e.g. `$.event.kind="tool-activity"`, `$.event.toolName="octant_browser"`), NOT flat `turn-updated` rows.
- Browser tool evidence: `tool-activity`/`tool-result` events with `octant_browser`, and `browser-observation` evidence events (recorded only on successful acts). Observation bodies are referenced by `contentReference` (`browser-observation-<uuid>`) but the body store is not in an obvious sqlite table or disk path — verify via the live Browser surface + assistant reply instead.

## Browser-surface and approval UI quirks

- Code/Work threads render an app-managed Browser surface in the right dock ("Shared live page" when the agent drives it; "Open a private Browser session" placeholder otherwise). Its address field truncates URLs — don't read the full URL from it.
- Work-mode approval banners ("Approval required for this action") can render an EMPTY side card with no Approve/Deny buttons. Clicking the thread tab or waiting for a re-render makes the buttons appear — retry before calling it broken.
- Browser origin approvals appear as an inline transcript card ("Allow Browser to open …?" / "isolated browser session") — approve via the inline Approve button.
- External localhost fixtures (python http.server) can die mid-session — `curl` the fixture URL before attributing "blank page"/"action failed" results to the app under test.

## Mode switching

- Sidebar header does not switch Chat/Work/Code; use Cmd+K command palette → "Switch to Chat" / "Switch to Code" / "Switch to Work".

## UI automation quirks (computer-use tool)

- The thread composer textarea sits BELOW the "Tip:" status line — click ~y=585 (at 1024×768), not on the tip row, or keystrokes land nowhere.
- The `@` mention popup contents are mode-dependent and version-dependent (e.g. one build offered Computer+Browser in Code but only Computer in Chat/Work). Always screenshot the popup per mode rather than assuming parity.
- The `@` mention popup appears in open threads AND in project-bound draft composers (verified: Work new-task draft under a project). If it doesn't appear, check that a project is selected in the draft. Typing `@` into a field that already contains `@` yields `@@` and no popup — Cmd+A then BackSpace first.
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

## Fresh/isolated data dir (first-run state without wiping the shared profile)

- `OCTANT_DATA_DIR=/path/to/dir <app>/Contents/MacOS/Octant` — the `open` command drops env vars, so launch the MacOS binary directly.
- The host validates the dir: it must be mode 0700 ("must not be accessible to other users"), or the app shows a validation dialog and quits. `mkdir -p` makes 755 → `chmod 700` it.
- Fresh dir = first-run wizard (About you → Workspace → Providers → Default model → Navigator → first thread). Codex CLI auto-detects Ready; pick GPT-5.6-Luna at the model step. Project picker: "Add a Code folder" → Create Project dialog → macOS picker, navigate with Cmd+Shift+G.
- CuaDriver versions are downloaded per data dir into `<dir>/computer-use/versions/`; the first session may run the bundled `Resources/native/cua-driver`, later ones a newer downloaded build.

## Computer-use (@Computer) testing

- The tool is bound per-turn by the @Computer mention chip. Follow-up turns WITHOUT a fresh chip fail instantly ("Tool failed" → agent reports "currently unavailable") — always re-add @Computer before concluding the capability broke.
- The SAME pending decision renders on two surfaces: the floating "Allow computer access?" PiP card (top-right of the thread pane) and the "Host-controlled computer use · Waiting for approval" dock aside (bottom-right, `.computer-use-activity`). The aside only shows sessions not currently represented by a visible PiP — open a covering surface (Inbox, Settings, a board) to surface it for the same in-flight decision.
- Journal evidence for a decision: `computer-use-observation` evidence rows with `$.evidence.detail` — "One-time approval is required" / "User approved this action once" / "User denied the proposed action" / "Visible host action completed". Approvals carry a real 5-minute TTL (post-#779) — an unanswered prompt expires and the turn can die with "Provider completed the turn while tool items were still active."
- The embedded cua-driver socket + HTTP broker can be probed directly: server pid env has `OCTANT_COMPUTER_USE_BROKER_URL`/`..._TOKEN` (`ps eww <server-pid>`); `cua-driver list-tools --socket <sock>` and `call ... check_permissions '{}'` / `get_accessibility_tree '{}'` answer whether a failure is driver-side or app-side.

## Android emulator surface (Code-thread dock, "Android emulator")

- Opened via the dock's `+`/`Add tool` menu or the surfaces rail; bound per thread+checkout.
- Discovery (`emulator -list-avds`) and all adb calls run through `RepositoryTestProcessPort` under
  deny-default seatbelt confinement. `privateHomeDenyReadRules` emits `(deny file-read* (subpath "$HOME/.android"))`
  — the default AVD store is unreadable, so the pane shows "No Android Virtual Devices were found" even with
  AVDs present (observed on main 836f8731; check whether a fix landed before assuming it still holds).
- `ANDROID_AVD_HOME`/`ANDROID_SDK_HOME` cannot work around it: `androidEnv` only forwards
  HOME/TMPDIR/TEMP/TMP/ANDROID_HOME/ANDROID_SDK_ROOT and `SAFE_INHERITED_ENVIRONMENT` omits them; relocating
  HOME also fails because the private-home deny follows `homedir()`.
- Reproduce/probe without UI: a bun script importing `apps/server/src/android/androidToolchainService` +
  `code/repositoryTestProcessPort` and calling `discover()`/`execute()` exercises the real confined path;
  `buildDenyDefaultSeatbeltProfile` emits the exact profile for manual `sandbox-exec -f` runs.
- SDK-absent path shows a named state: "Android emulator is unavailable — Install platform-tools and an
  emulator, then retry." (mv ~/Library/Android/sdk away to trigger; rename back to restore — discovery
  re-runs on pane mount/thread switch.)
- Emulator boot needs host nested virtualization; on VMs without it expect a bounded timeout outcome
  ("timed-out" + "emulator did not become ready"), not a hang.

## Useful evidence commands

- `pgrep -fl codex` / `pgrep -fl vibe-acp` — provider child processes.
- `ls ~/Library/Application\ Support/Octant/providers/runtime-receipts/` and
  `ls ~/.codex/thread-writer-locks/` — receipt + writer-lock state before/after restart.

## Mistral Vibe provider setup (API key — REQUIRED)

- `vibe-acp --setup` is a fullscreen TUI (welcome → theme → "Use an API key" → paste field). Run it in a
  real Terminal.app window and type the key via `${MISTRAL_API_KEY}` substitution — write_to_process and
  piped stdin can't deliver it. It stores the key in macOS Keychain (`ai.mistral.vibe`).
- That keychain entry is USELESS to Octant: Vibe's confined spawn sets `VIBE_TEST_DISABLE_KEYRING=1` and
  lacks `allowProviderCredentialLookup` — "Sign in required" persists. The working path is Settings →
  Providers → Mistral Vibe ACP → Configure → "Mistral API key (leave blank to preserve)" → Save
  ("Stored in Keychain") → Check connection → Ready.
- Provider-card Save buttons can be unresponsive; pressing Enter inside the API-key field submits reliably
  (even while the row still shows "Checking"). Remove leaves a "Provider removal failed" banner even on
  successful removal.
- The composer's provider/model picker only lists providers whose catalog has models — a freshly-created
  provider stays hidden until its first probe populates `provider_catalog_projection`.
- Vibe does NOT carry Octant's app-managed Browser tool: Code refuses at send-time
  ("This provider cannot carry Octant's Browser tool…"); Work dispatches then fails in-band with
  failure.category="unsupported". Plain turns work in both modes.

## Settings → Providers — image-generation providers (DEFECT on builds ≤441df283)

- All four image creates (`create-openai-image-provider`, `create-gemini-native-image-provider`,
  `create-bfl-image-provider`, `create-ideogram-image-provider`) return **503 "Octant Provider service is
  unavailable."** while non-image creates succeed — root cause: `provider_instance_projection.driver_kind`
  CHECK constraint in `migrations.ts` lacks the image kinds → `ProjectionApplicationFailed` inside the
  append transaction → rollback (zero journal rows) → generic 503.
- The UI fails SILENTLY: the credential field clears (`withTransientCredential` finally) and
  `ImageGenerationSettingsView` does not render `controller.message` — a cleared field = the failure
  signature, not a success.
- Probe without UI: `POST /api/providers/commands` with header `x-octant-window-capability` (extract from
  the renderer process args: `ps axww -o command= | grep octant-project-capability`; argv only — `ps eww`
  misses the headless renderer and dumps every process's environment, provider secrets included) — CLI
  creates return `{"kind":"provider-created"}`, image ones 503.
- In-process repro: real `Journal` + `createPhase1RuntimeRegistries` + `migrateStoreWithBackup` on a
  scratch `OCTANT_DATA_DIR`, then `journal.append` the `provider.instance-created@1` event — surfaces the
  true `CHECK constraint failed` error that the HTTP layer masks. Enumerating `projections.all()` and
  applying the envelope to each names the throwing projection.

## GitHub integration (OCT-152 credential gotcha)

- Settings → GitHub state derives from `gh auth status --json hosts` via `decodeStatusAccount`, which
  requires exact keys `["login","active","scopes","tokenSource","gitProtocol"]` — **fine-grained PATs
  (`github_pat_*`) never emit `scopes`** (gh derives it from the API's `X-OAuth-Scopes` header), so a
  working fine-grained PAT classifies as "Unavailable" forever. Classic PATs and OAuth tokens do emit it.
- An error-state gh account that still carries `tokenSource` also fails the exact-keys check →
  "Unavailable" rather than "unauthorized"; the "Set up GitHub" button only renders in the true
  unauthorized/not-connected state (empty `hosts:` map).
- "Set up GitHub" runs a real GitHub device flow: shows a one-time code to enter at
  github.com/login/device — completing it needs a github.com browser session (user side).
- There is NO token-paste field by design; provisioning with the token on stdin — `printf '%s'
"$GH_TOKEN" | gh auth login --hostname github.com --with-token` — works for gh but not past the
  `scopes` decode.

## Hidden/unreachable features

- `FIRST_PARTY_PLUGINS_EFFECTIVE` in `apps/web/src/shell/firstPartyPluginCatalog.ts` is a hardcoded
  client-side map — `linear-integration` is `false` ("bundled-off"), so no Linear Settings section,
  sidebar destination, or Create-from tab renders regardless of server state. Check this map before
  concluding a feature "isn't wired".
