# Test plan — PR #248 `feature/linux-station-credential-store` (head `d39acd7`)

Portability check: drive Octant as a **headless Linux station through Chrome**. Prove what breaks,
not that it boots.

## Environment (already set up, not part of the plan)

- Repo `/home/ubuntu/repos/octant` at `d39acd7`.
- Bun `/home/ubuntu/.bun/bin/bun`.
- **Server A (Secret Service available)** — pre-existing, reused: pid 69754,
  `bun run --cwd packages/cli src/bin.ts server run --port 13774`, env
  `HOME=/home/ubuntu/.cache/octant-keyring-home`,
  `DBUS_SESSION_BUS_ADDRESS=unix:abstract=/tmp/dbus-CZQLlDFWD8,guid=fd95a7ac97214b6deb59d10c6a909263`,
  `XDG_DATA_HOME=/home/ubuntu/.cache/octant-review-server-data/data`.
- **Server B (Secret Service absent)** — started for T3: port 13775,
  `env -u DBUS_SESSION_BUS_ADDRESS`, separate `XDG_DATA_HOME=/home/ubuntu/.cache/octant-nodbus/data`.
- Authenticated browser URLs are minted per server with
  `bun run --cwd packages/cli src/bin.ts web --no-open --port <port>`.
- GNOME Keyring Secret Service session confirmed alive (pid 43674 owns `org.freedesktop.secrets`).
- Codex sign-in is being completed by the user (Henrik) in a Konsole `codex login` flow.

## Code evidence behind the plan

| Claim under test                                                                                                                  | Source                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Broker started only when Secret Service probes available; env injected into server child                                          | `packages/cli/src/serverRun.ts:39-54,75-80`                                                                                                                                                                                         |
| Server reads broker env                                                                                                           | `apps/server/src/serverConfig.ts:128-129`                                                                                                                                                                                           |
| `octant status` secret-store line                                                                                                 | `packages/cli/src/status.ts:36-47,52-59`                                                                                                                                                                                            |
| Linux secret-store probe = `busctl --user status org.freedesktop.secrets` + `/usr/bin/secret-tool` executable                     | `packages/host-runtime/src/platformCapabilities.ts` (`probesFor`)                                                                                                                                                                   |
| Secret Service store uses `secret-tool store/lookup/clear`, attrs `service=octant account=<uuid>`                                 | `packages/host-runtime/src/secretServiceCredentialStore.ts:73-166`                                                                                                                                                                  |
| Add-provider form: `aria-label="Provider type"` → `<option value="codex">Codex CLI</option>`, "Provider name", "Codex CLI binary" | `apps/web/src/providers/ProviderSettingsConfiguration.tsx:236,251-275`                                                                                                                                                              |
| Codex readiness `ready` vs `unauthenticated` + message "Authenticate Codex and make at least one usable model available."         | `apps/server/src/providers/codexDriver.ts:449-462`                                                                                                                                                                                  |
| Chat blocks with "Configure a default Chat provider and model before creating a conversation."                                    | `apps/server/src/chat/chatService.ts:2598`                                                                                                                                                                                          |
| Chat defaults auto-configured from first eligible picker group                                                                    | `apps/web/src/chat/autoConfigureChatDefaults.ts:35-51`                                                                                                                                                                              |
| Local host label: neutral constant + platform-aware server label                                                                  | `packages/contracts/src/host.ts`, `apps/server/src/localHostDisplayName.ts`, `apps/web/src/shell/HostSelector.tsx:58,117`, `apps/web/src/shell/DraftThreadWorkspace.tsx:227-230`, `apps/web/src/App.tsx:1957,2026`                  |
| **Suspected gap:** every web credential write goes through the Electron-only bridge                                               | `apps/web/src/App.tsx:1618` (`credentialManagementAvailable: hostBridge !== undefined`), `apps/web/src/shell/hostBridge.ts:220-235` (requires `window.octantHost`), `apps/web/src/providers/useProviderController.ts:355,405,461,…` |

---

## T0 — CLI/broker wiring (shell only, no recording)

Already partly captured during setup; re-run for the record.

1. `octant status --port 13774` **with** the keyring DBUS env.
   - PASS iff output contains `Secret store: available` and `Octant host status: ready`.
2. `octant status --port 13774` with `env -u DBUS_SESSION_BUS_ADDRESS`.
   - PASS iff same host reports `Secret store: unavailable`. (Same instance id in both →
     proves the line reflects the _probe_, not the host.)
3. Compare `/proc/<server-child>/environ` for both servers.
   - PASS iff Server A's child has non-empty `OCTANT_CREDENTIAL_BROKER_URL` on `127.0.0.1`
     **and** `OCTANT_CREDENTIAL_BROKER_TOKEN`, and Server B's child has **neither**.
   - This is the discriminating check: a broken fail-closed implementation would inject the
     broker (or crash) on the no-DBUS host.
4. Server B liveness: `curl` → HTTP 200.
   - PASS iff 200. A fail-open/fail-hard implementation would refuse to start.

## T1 — Golden path in Chrome (recorded)

1. Open Server A's authenticated `octant web` URL in maximized Chrome.
   - PASS iff the app shell renders (sidebar + mode surface), not a blank page or a spinner
     that never resolves. Screenshot.
2. Open DevTools console once, read errors, close it.
   - PASS iff **zero uncaught exceptions**. Record any that appear verbatim.
3. Reach Chat and attempt to create a thread **before** a Codex provider is ready.
   - Expected (old dead-end): the typed message
     "The chat thread could not be created. Configure a default Chat provider and model before
     creating a conversation."
   - PASS iff the refusal is that legible typed message (not a crash/hang). Screenshot.
   - If a provider is already configured and a thread creates immediately, record that instead
     and note the pre-existing state.

## T2 — Codex configured through the UI, real turn (recorded) — primary objective

Precondition: `codex login status` prints a logged-in state (user-completed).

1. Settings → Providers → add-provider form: set "Provider type" = **Codex CLI**,
   "Provider name" = `Codex`, "Codex CLI binary" = `/home/ubuntu/.local/bin/codex`. Submit.
   - PASS iff a provider card named `Codex` appears. Screenshot.
2. Click "Check connection for Codex".
   - PASS iff the card resolves to a **ready** state with at least one model listed, within a
     bounded wait (≤60 s), and **not** the `unauthenticated` guidance
     "Authenticate Codex and make at least one usable model available."
   - If it stays unauthenticated, that is a FAIL for T2 and I capture the typed state as the
     T4 fail-closed evidence instead.
3. Return to Chat, create a new thread, type `Reply with exactly: octant-linux-ok` and send.
   - PASS iff (a) the thread is created — the T1.3 message is **gone** — and (b) an assistant
     message streams in containing real model output. Screenshot of the turn.
   - Discriminating: a broken Linux provider path would either keep the T1.3 refusal, hang with
     no assistant message, or surface a provider error.

## T3 — Fail-closed honesty in the UI (recorded)

Uses **Server B** (no `DBUS_SESSION_BUS_ADDRESS`).

1. Open Server B's authenticated `octant web` URL in Chrome.
   - PASS iff the app shell renders. FAIL on blank screen / infinite spinner / error boundary.
     Screenshot.
2. Open DevTools console, read all output, close it.
   - PASS iff no uncaught exception. Screenshot of console.
3. Settings → Providers: inspect an API-key-backed provider type (e.g. "Anthropic-compatible
   HTTP" / Claude "Anthropic API key").
   - PASS iff the credential field is **disabled** with typed guidance (expected copy:
     "Manage credentials in the Octant host app…" / "…can only be created in the Octant host
     app"), i.e. a legible refusal — and **no plaintext-credential fallback** is offered.
   - Screenshot. Note explicitly whether this same restriction also applies on Server A
     (where the broker IS running) — per code reading it will, which is a finding: the Linux
     credential store has no browser-reachable write path.
4. Chat thread creation on Server B.
   - PASS iff it refuses with a typed message rather than hanging.

## T4 — "This Mac" must not appear anywhere (recorded)

1. On Server A's UI, open the host selector; inspect the draft-thread workspace and any host
   chips.
   - PASS iff the local host reads **"This computer"** and the string "This Mac" appears
     **nowhere** on screen. Screenshot of the host selector showing the label.
2. Corroborate with an in-page text search for "This Mac" across the shell surfaces visited.
   - PASS iff zero matches.

## T5 — macOS-only affordances refuse honestly (recorded)

1. Switch to **Work** mode and attempt to create/open a Work thread.
2. Switch to **Code** mode and attempt to create/open a Code thread.
   - Expected per ADR 0009: both **refuse** on Linux (no Seatbelt confinement backend).
   - PASS iff each refusal is a **legible typed message on screen** within a bounded wait.
   - FAIL iff: blank surface, unhandled exception in the console, spinner that never resolves,
     or a silent no-op with no explanation.
   - Screenshot each. Also try a Devin ACP provider action if reachable, same criteria.
3. Note any visibly broken native/Electron-only chrome (traffic-light insets, tray, Quick Look
   affordances) encountered along the way.

## Out of scope / will be reported as untested

- Real Devin/omp turns (ACP refuses on Linux by design).
- Any credential value entry — no API keys exist in this session and I will not guess any.
- macOS comparison behaviour (no darwin host available).
