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

- `event_journal` is COLUMN-based: `event_name` (e.g. `code.operation-event-recorded@1`, `image.job-status-changed@1`), `aggregate_type` (`image-job`, `provider-instance`, `code-operation`, `code-runtime`, …), `actor_kind`/`actor_id`, `occurred_at`, `payload_json`. There is NO `payload_json.kind` discriminator — filter on the columns. `provider_instance_projection` rows are `id|version|driverKind|enabled|<full instance JSON>`.
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

- `bun run build` takes ~9s warm (turbo cache); `bun scripts/package-desktop.ts` ~2-3min
  (benign swift keychain-helper deprecation warnings) → `<worktree>/out/Octant.app`.

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
- Discovery (`emulator -list-avds`) runs through `RepositoryTestProcessPort` under deny-default seatbelt.
  Post-#816 the confined listing works — the pane lists `octant_test` from `~/.android/avd` (verified on
  main 39dffcf9). If AVDs go missing again, suspect the seatbelt `privateHomeDenyReadRules` regression.
- SDK-absent path shows a named state: "Android emulator is unavailable — Install platform-tools and an
  emulator, then retry." (mv ~/Library/Android/sdk away to trigger; rename back to restore — discovery
  re-runs on pane mount/thread switch.)
- Emulator boot needs host nested virtualization; on VMs without it expect a bounded timeout outcome
  ("timed-out" + "emulator did not become ready"), not a hang. Verify the env claim outside Octant:
  `emulator -accel-check` may report Hypervisor.Framework support while `sysctl kern.hv_support` is 0 and
  a direct CLI boot fails `HVF error: HV_UNSUPPORTED` — the honest-timeout outcome is then environment-true.
- First Boot click shows a one-time approval card ("Allow Android boot?"); clicking Boot again while the
  first execute is still running latches silently with no new card — wait for the 180s bound to expire.
- Boot evidence lands as a file artifact at
  `~/Library/Application Support/Octant/android-runtime/artifacts/<threadId>/<checkoutId>/android-log-*`
  (contains e.g. "emulator did not become ready"). Device ops are NOT journaled as event_journal aggregates.

## iOS Simulator surface (Code-thread dock, "iOS Simulator")

- The dock menu item appears ONLY when the checkout root lists a `.xcodeproj`/`.xcworkspace`
  (`apps/web/src/apple/useAppleProjects.ts`). A fixture needs a REAL parseable pbxproj — a stub fails
  `xcodebuild -list -json`, and `appleToolchainService` treats ANY probe failure
  (xcode-select/xcodebuild/swift/showsdks/simctl/-list) as `category:"unavailable"` → whole pane dead.
- Live attach shows "Live · <device name>" with the rendered simulator frame; "Allow input to drive this
  Simulator" is a once-per-session grant (tap/type then work). The pane re-attaches automatically after an
  app restart (no re-approval needed for the frame itself).

## Provider credentials in Keychain

- Service `app.octant.provider-credentials`, account `<lowercase-instanceId>:<storeScope/hostId>`.
- Bundled helper `out/Octant.app/Contents/Resources/native/octant-keychain-helper` reads stdin JSON
  `{version:1,storeScope,operation:"set"|"has"|"resolve"|"delete",providerInstanceId,credential}`
  (`resolve` reads; there is no `get`, so a `get` probe always returns `failed`).
- Items live in the file-based login keychain, whose ACL + `partition_id` trust the creating binary's
  cdhash. The ad-hoc helper's cdhash changes whenever its Swift source changes (same source → same
  cdhash), and `security add-generic-password` items trust only `/usr/bin/security`. Such a foreign item
  shows `has: present` but `resolve: unavailable`; re-saving the key in the app makes the helper delete
  the foreign item by reference and re-add it under its own identity. Inspect ACLs with
  `security dump-keychain -a ~/Library/Keychains/login.keychain-db` (look for `partition_id`). Do not
  seed credentials with the `security` CLI — write them through the app.
- Symptom cluster meaning the provider-service plane is down on a build: provider cards show
  "Incompatible", `POST /api/providers/<id>/probe` → 503 "Octant Provider service is unavailable", and
  image jobs fail `image.job-status-changed` with `failure.category="unauthenticated"`,
  message "The provider credential is missing or unavailable" — even with a correct-format Keychain entry.

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

## Settings → Image generation — image providers (post-#840/#841 on 696647fb)

- Image-provider types do NOT appear in Providers & Models "Add provider manually" (list ends at
  "Ollama native HTTP") — they live only under Settings → Image generation → "Add image provider".
- Post-#840 the create form carries REAL preset values → UI create works end-to-end and writes the
  credential through the real `setProviderCredential` path (Keychain entry appears at
  `app.octant.provider-credentials`, acct `<lowercase-instanceId>:<storeScope>` — verify via
  `security dump-keychain`). Manual `security add-generic-password` seeding produces a foreign item the
  helper cannot read (see "Provider credentials in Keychain"); write credentials through the app.
- Post-#841 image profiles are exempt from chat-runtime probing → honest badge is "Not checked"
  (not "Incompatible"). The `GET /api/providers/<id>/probe` 503 plane is no longer exercised.
- REAL GENERATION WORKS end-to-end on 696647fb: More → Image generator → "Create image…" → profile +
  gpt-image-2 → Generate → `image.job-queued@1 → status-changed(running) → status-changed(completed)`
  - `context.usage-reconciled`. Artifact bytes land at
    `~/Library/Application Support/Octant/generated-images/<scopeId>/<attachmentId>/finalized.bin`
    and serve via `GET /api/image/jobs/<jobId>/artifacts/<attachmentId>` + window capability header.
- Keychain persistence verified: provider row + enabled state survive `pkill -9` + relaunch; a
  post-restart generation completes WITHOUT re-entering the key.
- Probe without UI: `POST /api/providers/commands` with header `x-octant-window-capability` (extract from
  the renderer process args: `ps axww -o command= | grep octant-project-capability`; argv only — `ps eww`
  misses the headless renderer and dumps every process's environment, provider secrets included) — CLI
  creates return `{"kind":"provider-created"}`.

### Image-generator library list defect (696647fb — OPEN)

- The Image generator library NEVER renders completed jobs: `GET /api/image/jobs?threadKind=image-library`
  → 400 "Image job list requires a thread." because `parseThreadKind` in
  `apps/server/src/image/imageRoutes.ts` (~line 251) accepts only
  `chat-thread|work-thread|code-thread` and OMITS the `image-library` literal that
  `ImageJobThreadKind` (contracts) defines as a valid fourth kind. The enqueue POST uses the full
  schema (accepts image-library fine) and `GET /api/image/jobs/<jobId>` + artifact routes don't parse
  threadKind — so jobs create, complete, and serve PNGs but the list 400s → `GeneratedImageList` shows
  a blank surface (no cards, no empty state). Diagnosis recipe: compare the list endpoint (400
  "requires a thread") against `GET /api/image/jobs/<jobId>` (200 with artifacts) — the contrast
  isolates the parse-level miss rather than a store/refresh gap. Job listing uses in-memory
  `ImageJobProjection` (`holdsStateInMemory`, journal-replayed — no sqlite table).
- `ImageArtifactRef` wire shape is exactly `{attachmentId, hash, size, mime}` — the strict schema
  REJECTS extra fields (e.g. the `evidence` block the job detail returns); a curl revise enqueue must
  pass only those four keys or it 400s "Image generation request is invalid." A parent-linked revise
  job completes with `parentArtifactRef` journaled and produces a new artifact (red→blue circle
  verified visually).

## Usage-limit state injection (journal-level)

- `ProviderUsageLimit` facts ride ON the journaled stop rows, not a dedicated event: a Chat attempt
  persists `outcome:"waiting"` + `usageLimit:{kind,resetsAt?}`; Work turns and Code operations carry
  the same field beside their outcome. UPDATE `event_journal.payload_json` directly — the journal has
  no hash chain so payload edits are safe; restart after editing so in-memory projections re-read
  (persisted projections need the same edit in their own table).
- Code's snooze gate reads STANDALONE `provider-turn-state` frames — an `operation-result` frame
  carrying the field nested is seen by the renderer but honestly refused by the server.
- A waiting+limited Work turn cannot survive restart injection: `markInterruptedOnRestart` rewrites
  all non-terminal work turns to `interrupted`. Prove Work through the Chat path (shared machinery)
  and verify Work/Code at render level.
- Offer vs gate: the client offers "Snooze until reset" on any usageLimit-bearing resumable stop, but
  the server requires the latest stop to be `waiting` — a failed+limited stop shows a button that can
  only refuse.

## Form hazards and client-side failure signatures

- Placeholder-vs-value trap: on create forms, verify preset fields (model allowlist, default model)
  hold REAL values (regular text, editable) and not placeholder styling. A submit that leaves
  placeholder-preset fields untouched sends empty values → client-side command decode fails → a
  generic "could not be created" banner with no field-level hint. Submit untouched deliberately to
  catch it.
- Proving client-side refusal: DevTools → Network filtered to the command endpoint; **zero** requests
  after a failed submit means the failure never left the renderer (decode/validation), not a server
  refusal. Distinguishes `invalidCommand` from server 4xx/5xx without journal digging.
- DevTools-console secret hazard: typing a secret while DevTools is docked can refocus into the
  console during a window reflow and render the value in plaintext. Undock or close DevTools before
  entering credentials, and confirm the field shows masked dots before submitting. If a value lands
  in the console anyway: clear the console, delete contaminated recordings/screenshots, verify no
  submitted use, and flag rotation to the user.

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

## Codex provider turn-path defect (39dffcf9 — FIXED by #844 on 696647fb)

- Was: every Codex turn failed instantly "Codex returned an invalid protocol response." because
  codex-cli 0.157.x app-server emits `"error": null` in turn/start results and turn/completed
  notifications — `Schema.optional` accepted absent/undefined but not null, so healthy turns died
  in decode. #844 decodes null as absent for `turn.error`/`codexErrorInfo`. Verified: Chat turn
  with GPT-5.6-Luna completes in ~2s; journal shows `chat.turn-created → attempt-updated →
context.usage-reconciled` with no protocol-error payloads.
- If the signature returns on a future codex bump, suspect a new nullable field — reproduce via
  `codex app-server` stdio initialize + thread/turn calls and compare against `codexProtocol.ts`
  decoders.
- `codexDriver.ts` advertises `appManagedTools:"supported"` (Codex is the intended @Computer
  carrier); Vibe refuses @Computer at send-time, so on builds where Codex turns are broken no
  @Computer turn is possible.
- Send-time refusals (e.g. Vibe "cannot carry Octant's Computer tool") degrade after an app restart to the
  generic "Failed — The provider turn failed."; in-band provider errors persist verbatim.

## OpenCode binary naming (post-#851)

- Released OpenCode 2 installs `opencode`; `opencode2` is the earlier beta kept as fallback.
  Discovery prefers `opencode` labeled "OpenCode CLI"; the beta name shows "OpenCode 2 preview".
  `isOpenCode2BinaryPath` accepts both names → both route to the OpenCode 2 driver.
- `brew install opencode` works on this host (formula ships only the 1.x line — no real 2.x
  install exists on brew or npm `opencode-ai`). A 1.x binary under the new routing hits the
  OpenCode 2 catalog probe, which refuses `category:"incompatible"` +
  "OpenCode 2 binary did not report the beta runtime." — the UI shows badge "Incompatible" +
  "Provider configuration is incompatible" + Binary/Version detail; the raw message is NOT in
  the card (check "Connection details" → Process/Stopped, Version/Unavailable, Models/0).
  That incompatible state IS the e2e signature the refusal fired through the new path.
- Rescan = Settings → Providers & Models → "Check again"; a detected provider auto-registers
  on enable and the probe fires on toggle-on.

## Provider-type dropdown quirks (verified 696647fb)

- Settings → Providers & Models → "Add provider manually" Provider-type select contains ONLY
  coding-agent/custom-API kinds — its options end at "Ollama native HTTP" (press End inside the
  open select to confirm the last option). Image providers (OpenAI/Gemini/BFL/Ideogram) are NOT
  listed there; they live exclusively under Settings → Image generation → "Add image provider".
- Chat-mode composer DOES offer Codex CLI models: model picker → type "luna" in "Search models…"
  → "GPT-5.6-Luna — Codex CLI" selects it. Codex turns work in Chat, not just Code.

## Navigation/surface notes

- "More" sidebar menu holds Agents, Automations, Artifacts, Image generator, Plugins (shortcut to
  Settings → Skills & Extensions), Customize sidebar. Zen mode = sidebar profile menu → "Zen mode"
  (fullscreen Focus space). Image generator: More → Image generator → "Create image…" opens a properly
  stacked sheet — contrast with the cramped single-row provider create forms (Default model|Quality|Size|
  API key squeezed onto one row, API-key field ~100px — misses clicks, violates DESIGN.md stacked fields).

## Hidden/unreachable features

- `FIRST_PARTY_PLUGINS_EFFECTIVE` in `apps/web/src/shell/firstPartyPluginCatalog.ts` is a hardcoded
  client-side map — `linear-integration` is `false` ("bundled-off"), so no Linear Settings section,
  sidebar destination, or Create-from tab renders regardless of server state. Check this map before
  concluding a feature "isn't wired".
