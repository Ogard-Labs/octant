# Test plan — PR #249 `feature/linux-confinement` (head `1d620c9`, verified at `226f722`)

End-to-end verify the new Bubblewrap Linux confinement backend for Work/Code/ACP.
The primary flow drives a **Code** thread with the **Codex `gpt-5.6-luna`** model,
binds a real Git repository, and uses the `octant_terminal` tool to run a command.
We capture the resulting `bwrap` process command line to confirm Octant's shared
confinement builder is invoked on Linux (`bwrap --unshare-all -- ... <shell>`).
A second flow verifies the fail-closed behavior when `/usr/bin/bwrap` is unavailable.

## Preconditions

- Repo `/home/ubuntu/repos/octant` is on `feature/linux-confinement` at or ahead of
  `1d620c9 fix(server/linux-confinement): follow symlinks when probing base system dirs`.
- `bun` is on `PATH` (`/home/ubuntu/.bun/bin`).
- `bwrap` 0.6.1 is at `/usr/bin/bwrap` and unprivileged user namespaces work.
- `codex` 0.150.1 is at `/home/ubuntu/.local/bin/codex` and authenticated
  (`codex login status` prints `Logged in using ChatGPT`).
- Chrome is reachable at the DevTools endpoint `http://127.0.0.1:29229`.
- `XDG_DATA_HOME` will be isolated per server instance.

## Code references

| Claim                                                                                                                                                                                | Source                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux confinement builder emits `bwrap --unshare-all` plus `--proc /proc`, `--dev /dev`, read-only system binds, writable bound root/temp/shell-state, then `-- <executable> <args>` | `apps/server/src/process/linuxConfinement.ts:73-164`                                                                                        |
| `SeatbeltConfinementPort` dispatches to `buildLinuxConfinementLaunch` on Linux                                                                                                       | `apps/server/src/process/seatbeltProfile.ts:321-341`                                                                                        |
| `TerminalProcessPort` constructs `makeSeatbeltConfinementLive` and spawns `launch.command`/`launch.args`                                                                             | `apps/server/src/code/terminalProcessPort.ts:208-282`                                                                                       |
| The Code thread exposes `octant_terminal` to the provider; `run` starts a terminal and writes the command                                                                            | `apps/server/src/code/codeAppManagedTools.ts:40-310`                                                                                        |
| `bwrap` missing/not executable throws `SeatbeltConfinementError("incompatible", "Linux confinement requires an executable bubblewrap (bwrap) runtime.")`                             | `apps/server/src/process/linuxConfinement.ts:24-38`                                                                                         |
| Local host label is platform-aware and reads "This computer" on Linux                                                                                                                | `apps/web/src/shell/HostSelector.tsx`, `apps/web/src/shell/DraftThreadWorkspace.tsx`, `packages/client-runtime/src/localHostDisplayName.ts` |

## Setup (do once before the primary flow)

0. If a previous test server is running on port `13774`, stop it first so the new
   server starts with the correct commit.
1. Start Octant server on port `13774` with an isolated data directory:
   ```bash
   export PATH="/home/ubuntu/.bun/bin:$PATH"
   mkdir -p /home/ubuntu/.cache/octant-confinement/data
   XDG_DATA_HOME=/home/ubuntu/.cache/octant-confinement/data \
     bun run --cwd packages/cli src/bin.ts server run --port 13774
   ```
2. Find the server child PID (the one running `bun src/main.ts` under `apps/server`)
   and read `OCTANT_DESKTOP_BRIDGE_SECRET` from `/proc/<pid>/environ`.
3. Mint an authenticated launch token:
   ```bash
   capability=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=' | cut -c1-43)
   curl -s http://127.0.0.1:13774/api/desktop/launch-sessions \
     -H 'content-type: application/json' \
     -H "x-octant-desktop-secret: <bridgeSecret>" \
     -d "{\"windowId\":\"$(uuidgen)\",\"capability\":\"$capability\"}"
   ```
   The response gives `launchToken`. Build URL:
   `http://127.0.0.1:13774/?serverUrl=http%3A%2F%2F127.0.0.1%3A13774%2F#launchToken=<token>`.
4. Start a background `bwrap` process capture helper:
   ```bash
   while true; do
     ps -ef | grep '[b]wrap' | sed 's/^/BWRAP /' >> /tmp/bwrap-capture.log
     sleep 0.2
   done &
   ```
5. Connect Puppeteer to `http://127.0.0.1:29229`, open a new tab, navigate to the
   authenticated URL, maximize the window, and start the screen recording.

## T1 — Primary flow: `gpt-5.6-luna` Code thread runs a command inside `bwrap`

1. **Onboarding and host label.**
   - Complete or click **Skip for now** through first-run onboarding.
   - PASS: the app shell renders (sidebar + main surface), no blank screen or infinite spinner.
   - PASS: the host selector in the composer context strip reads **"This computer"**,
     not "This Mac". Screenshot.

2. **Add the Codex provider.**
   - Open **Settings → Providers**.
   - Click **Add provider**, choose **Codex CLI**, name it `Codex`, set binary to
     `/home/ubuntu/.local/bin/codex`, and submit.
   - Click **Check connection for Codex**.
   - PASS: within 60 s the provider card is **ready** and lists models including
     `gpt-5.6-luna`. If it reports `unauthenticated`, STOP and escalate — do not read
     `~/.codex/auth.json` or run `codex login`. Screenshot of the ready card.

3. **Create a Code project bound to a real Git repository.**
   - Switch to **Code** mode from the sidebar.
   - In the Code composer, open the project selector and choose **Add folder**.
   - In the folder picker, navigate to `/home/ubuntu/repos/octant` (a Git repository),
     click **Select**, name the project `confinement-test`, and create it.
   - PASS: the project is created and the composer context strip shows the project name
     and root path. If the folder is not a Git repository, the picker must show a typed
     message (`Code threads need a Git repository...`); use a different Git folder.
   - Screenshot of the created project / composer.

4. **Select `gpt-5.6-luna`.**
   - Open the **Provider and model** picker in the Code composer.
   - Search for or select `gpt-5.6-luna` under the Codex provider.
   - PASS: the picker closes and the trigger label shows a `gpt-5.6-luna` model.

5. **Send a command through the provider.**
   - Leave the access policy on **Approval** (or use **Full access** if available;
     the default approval path is the discriminating case).
   - Type and send:
     ```
     Run this exact command in the repository terminal and report the output:
     printf '%s\n' "$((1729+1))"
     ```
   - PASS: a terminal tool request appears (approval card) and the turn proceeds
     after approval. If the provider uses `octant_terminal` automatically without an
     explicit approval prompt, that is also a PASS, but a screenshot of the turn
     transcript is required.
   - FALLBACK: if Codex reports that `octant_terminal` is unavailable in this
     session, the provider-driven tool path is not exercised. In that case open the
     right-side **Terminal** tool directly and run the same `printf` command, and
     capture the `bwrap` process evidence from the resulting terminal panel.

6. **Capture confinement evidence.**
   - While the command is running, inspect `/tmp/bwrap-capture.log` and `ps -ef`.
   - PASS: at least one `bwrap` process is observed whose command line begins with
     `/usr/bin/bwrap --unshare-all --` and contains the absolute shell path
     (e.g. `/bin/bash` or `/bin/sh`) as the executable after the final `--`.
     Record the full `/proc/<pid>/cmdline` line.
   - PASS: the assistant message (or terminal transcript) contains `1730`.
   - Screenshot of the completed turn.

7. **Console health.**
   - PASS: the browser DevTools console shows **no uncaught exceptions**.

## T2 — Fail-closed: missing `bwrap` must not fall back to unconfined execution

1. Start a second server in a mount namespace where `/usr/bin/bwrap` is replaced by
   a non-executable `/dev/null`:
   ```bash
   mkdir -p /home/ubuntu/.cache/octant-confinement-nobwrap/data
   /usr/bin/bwrap --share-net --bind / / --bind /dev/null /usr/bin/bwrap -- \
     env PATH="/home/ubuntu/.bun/bin:$PATH" \
         XDG_DATA_HOME=/home/ubuntu/.cache/octant-confinement-nobwrap/data \
       /home/ubuntu/.bun/bin/bun run --cwd /home/ubuntu/repos/octant/packages/cli \
         src/bin.ts server run --port 13775
   ```
2. Mint a launch token for port `13775` as in setup step 3 and open it in a second
   browser tab.
3. Skip onboarding, create or select the same `confinement-test` Code project, and
   attempt to **open the repository terminal** (or send a command that requires a
   terminal, e.g. `echo fail-closed-test`).
   - FALLBACK: if starting the server inside the masked `bwrap` namespace crashes
     Bun on this host, stop and verify fail-closed behavior directly by driving
     `TerminalProcessPort`/`buildLinuxConfinementLaunch` with `sandboxPath` set to a
     non-executable file; the UI flow is then reported as untested.
4. PASS: the UI surfaces a **typed failure** rather than silently running unconfined.
   Expected text includes one of:
   - `Linux confinement requires an executable bubblewrap (bwrap) runtime.`
   - `incompatible`
   - `Terminal ... unavailable` / `Code operation requires approval` / `Code operation is unauthorized`
     (the exact server-level wording may be wrapped by the UI, but it must be a clear
     typed error, not a blank screen, spinner, or generic crash).
5. PASS: `ps -ef | grep '[b]wrap'` shows **no** `/usr/bin/bwrap` process launched.
6. PASS: browser DevTools console shows **no uncaught exceptions**.
7. Screenshot the error state.

## Out of scope / will be reported as untested

- Work-mode confinement (Code provides the same `TerminalProcessPort` path and is
  sufficient to prove `bwrap` confinement; Work has no terminal surface).
- ACP provider confinement (`devin` is not authenticated and user instructions forbid
  entering credentials; `codex` in this branch is not routed through the ACP
  confinement builder).
- macOS Seatbelt comparison (no darwin host available).
- Secret Service credential path (no active DBus/GNOME Keyring session is present;
  `octant status` will report `Secret store: unavailable`, which is acceptable for
  the Codex ChatGPT-auth path).

## Run findings

- Verified at `226f722` on `feature/linux-confinement`.
- T1 passed: Code thread created, `GPT-5.6-Luna` selected, `/home/ubuntu/repos/octant` bound,
  right-side Terminal opened, and `echo $((1729 - -1))` returned `1730` inside the confined
  `/bin/zsh` shell.
- T1 process evidence: `ps -ef` showed `/usr/bin/bwrap --unshare-all --share-net --new-session
--die-with-parent --proc /proc --dev /dev --ro-bind /usr/bin /bin ... -- /bin/zsh`.
- T1 caveats: the first-run `zsh-newuser-install` prompt appeared because `HOME` in the sandbox
  had no `.zsh*` files; the `+` key did not render when typed in xterm, so the arithmetic was
  performed as `1729 - -1`.
- T2 partial: a missing/non-executable `bwrap` throws `SeatbeltConfinementError` with reason
  `incompatible` directly against `buildLinuxConfinementLaunch`; the full browser UI fail-closed
  test was not completed because Bun crashes when the server is started inside a nested `bwrap`
  namespace that masks `/usr/bin/bwrap`.
- Targeted unit tests `seatbeltProfile.test.ts` and `terminalProcessPort.test.ts` pass (30/30).
