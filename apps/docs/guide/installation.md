---
description: Install Octant on Apple Silicon macOS or x64 Linux and configure the local development environment.
---

# Installation

Octant ships an Apple Silicon technical preview for macOS (Developer ID signed
and notarized) and an unsigned x64 Linux AppImage for Ubuntu dogfood. Both run
the local server through Electron's Node process. No cloud service or external
relay is included in this preview.

## System requirements

### Apple Silicon (macOS)

- Apple Silicon Mac (M1 or later)
- macOS Sequoia or later
- Bun 1.4.4 (required for development and local iteration)
- Node 26 only when running the Node SQLite portability smoke

### Linux x64 (Ubuntu dogfood)

- x64 Linux host (Ubuntu is the dogfood target)
- Bun 1.4.4 (required for development and local iteration)
- Bubblewrap for Work and Code, `lsof` so Running services can find local servers, and a live Secret Service session to store provider credentials ([Linux Host](./linux-host))
- Node 26 only when running the Node SQLite portability smoke

## Install from source

Clone the repository and install dependencies:

```sh
bun install --frozen-lockfile
```

Verify the workspace:

```sh
bun run verify
```

## Package the desktop app

### Apple Silicon (macOS)

Build and package the Apple Silicon app:

```sh
bun run build
bun run package:desktop
```

The command produces `out/Octant.app` for `darwin-arm64`. The packaged app runs without Bun; it bundles its own rebuilt SQLite native module.

Packaging locally produces an **unsigned** app and says so, because signing needs an Apple Developer ID that only the maintainer holds. An unsigned build works, but it cannot update itself: the updater replaces the app only when the replacement satisfies the running app's code signature, and an unsigned app has none. To produce a release build, set `OCTANT_SIGNING_IDENTITY`, `OCTANT_NOTARY_PROFILE`, and `OCTANT_SIGNING_TEAM_ID`, and declare it with `OCTANT_RELEASE_BUILD=1` — a declared release refuses to finish unsigned rather than emitting something that looks shippable.

### Linux AppImage (Ubuntu dogfood)

On an x64 Linux host (for example Ubuntu), the same packaging entry point emits an AppImage. Darwin Keychain/code-file helpers are skipped; credentials use Secret Service via host-runtime.

```sh
bun run build
bun run package:desktop
# or explicitly:
OCTANT_PACKAGE_TARGET=linux-x64 bun run package:desktop
```

Produces:

- `out/Octant-<version>-linux-x64.AppImage` — portable dogfood artifact
- `out/Octant-linux-x64/` — electron-packager directory kept beside it for inspection

The AppImage is a peer Machine: Electron owns the local server lifecycle the same way the macOS app does. The image file is not code-signed the way the Apple Silicon app is. When you launch that image, Octant checks the same signed `<ring>/linux-x64.json` feed, downloads the new image, and verifies the signature and the hash before it writes anything. It then writes the new image beside the one you started, flushes it to disk, renames it into place, and relaunches. The new build starts after the old one has finished stopping, so the two never run side by side. If relaunch fails, the previous image is restored.

It will not update a package or an unpacked archive, and it will not update an image it cannot write. The reason appears in **Settings → General → Updates**. It also will not relaunch while an agent is still working or while Octant cannot confirm what is running — the same rule as on macOS. A provider that is not installed or not signed in, or one you switched off, does not hold the update back, because stopping Octant interrupts nothing for it. A launch that is not the portable image does not contact the update service.

Launch:

```sh
chmod +x out/Octant-*-linux-x64.AppImage
./out/Octant-*-linux-x64.AppImage
```

If your host cannot mount nested AppImages, run with `APPIMAGE_EXTRACT_AND_RUN=1`. Work/Code still need Bubblewrap and a live Secret Service session on the host (see below).

AppRun preserves Chromium's sandbox and lets Chromium refuse when it cannot establish one. It never adds `--no-sandbox`. A separate `unshare` command is not a reliable prerequisite probe because it has a different AppArmor identity. See [Desktop sandbox prerequisites](./linux-host#desktop-sandbox-prerequisites) for a tested isolated installation and the boundary for administrator-reviewed host profiles.

## Nightly development foundation

On macOS, both packaged desktop apps use a sealed bundled entry and refuse arbitrary
script paths, runtime loader options and remote-debugging flags. Their terminal
Browser command, `octant mcp`, accepts only its existing MCP/help commands.
Stable runs its fixed scoped CLI script through a separately identified bundled
Node runtime, preserving Code confinement without GUI-service permissions.
Octant's host and approved executable tools use that same separate runtime. This does not yet provide the full
`octant-nightly` command or a functional Nightly desktop bridge.

Nightly's separate application identity and packaging foundation are available
for development. It is not yet a usable second app. On macOS, ordinary Nightly
startup first authenticates a status check with a compatible signed Octant in
the same login session. Development/ad-hoc builds refuse this connection; a
missing response can mean Octant is closed or too old. If it is closed, Nightly
can start the installed compatible signed Octant without opening an Octant
window, then authenticate it again. An older installation that lacks this launch
capability refuses. Nightly reports a missing installation and, on Octant's
data, never starts its own host. A successful status check
is followed by separate authenticated window registration. A compatible host
issues only that window's short-lived capability; Nightly loads its own screens
without owning host data or credentials. If renewal fails, its old renderer
closes and Nightly tries fresh authenticated registration for up to 30 seconds.
Quitting cancels recovery; failure explains why Nightly closed. A recovered window
keeps its normal bounds, but does not transfer unsaved layout or drafts to its
new window identity. A connected Browser can display Stable-owned page images and
forward ordinary pointer, text and keyboard input inside the Nightly window.
Control-Escape leaves the page; Tab moves among its controls. Nightly’s own
dropdown, context and local text-editing menus use native macOS menus. These
local menus act on Nightly itself. An already focused standard text field in the
Stable-owned page also supports a native editing menu through pointer right-click
or Shift+F10.
Its source and lease remain checked while the menu is open; source retirement
dismisses the menu. Pointer invocation, Select All and Undo have native evidence.
Keyboard invocation preserves the current field and selection, and menu
retirement releases held page keys. Live clipboard acceptance remains pending. Standard text
inputs and textareas support native composition with a caret anchored to the
Stable-owned field. Password, custom editors, embedded frames and full IME
reconversion are not supported by that path. Page accessibility, remaining native popup types,
other native brokers and full lifecycle acceptance remain
unfinished, so this is not a usable Nightly release. Installation and
publication remain pending.

### Separate test data in Nightly

For development and testing on macOS, Nightly can run a host of its own on data
that is never Octant's. In Nightly, open **Settings › Updates** and set **Data**
to **Separate test data**, then choose **Relaunch Octant Nightly**. The choice
takes effect on that relaunch.

- Nightly's test data lives in
  `~/Library/Application Support/Octant Nightly/Test Data`, its host listens on
  port `13774`, and its log is in `~/Library/Logs/Octant Nightly`. It never
  reads or changes Octant's data, never connects to Octant's host, and Octant
  and Nightly can both run.
- Keys and secrets Octant keeps in the Keychain are kept apart: you enter them
  again for test data, and they are stored under Nightly's own Keychain names.
  Provider command-line tools keep their own sign-ins in your home folder
  (such as `~/.claude` and `~/.codex`), and those are shared with Octant.
- Work and Code without a Project use `~/Octant Nightly` instead of `~/Octant`.
- The window shows a **Test data** label beside the Nightly label.
- To go back, set **Data** to **Octant's data** and relaunch. While Nightly uses
  Octant's data, **Remove test data** moves the test data folder to the Trash.
- Separate test data is not offered on Linux yet.

An in-app Quit command in Octant closes its workspace windows while a current
Nightly window still uses its host. The host remains in the background, and
opening Octant again brings its screens back. When the final Nightly client
leaves, the host uses its normal active-work confirmation before stopping.
Cancelling keeps the host running. Signals, logout and update restart keep their
existing shutdown behavior. A headless launch waits up to 30 seconds after
host-ready for its first Nightly window, then follows that same guarded quit.
An already retained current Nightly client receives bounded recovery grace during
an app-managed host restart. This does not yet prove full signed coexistence or
reconnect acceptance.

Nightly's update controls follow only the Nightly channel and show no channel
switch. Its automatic-check choice is saved separately from Octant, and
changing it does not change Octant's channel. An update relaunch waits while host work is active
or cannot be confirmed, and closes Nightly's own window resources before asking
the platform updater to apply it. Failed cleanup or apply leaves a fresh Nightly
window available; an unconfirmed cleanup requires quitting and reopening Nightly
before retrying. This client wiring does not establish signed installed-update
or rollback acceptance.

A local desktop package defaults to Octant. An explicitly selected
`OCTANT_PACKAGE_FLAVOR=nightly` requires a matching dated preview
`OCTANT_RELEASE_VERSION` for the repository's existing base version; Octant
accepts a stable version or a dated candidate one. Packaging
stamps the flavor, product name, bundle id and link scheme, and selects the
inverted Nightly icon on macOS and for the Linux desktop launcher. Stable keeps
its original icon. Nightly keeps its
window storage under `Octant Nightly`, separate from Octant's shared host data.
It cannot start or migrate that host data.

Packaged Octant follows the stable ring or, when you choose Preview, the
candidate ring, and refuses a feed signed for preview. The Nightly identity
follows only preview and refuses stable and candidate feeds. Development runs
keep their existing behavior. The stable-host connection, full Nightly command
and coexistence remain required before Nightly can be offered as a usable
download.

While packaged Octant on macOS follows Preview, Settings › Updates shows an
Octant Nightly row below the release ring. Octant downloads Nightly only when
you choose Install Octant Nightly. Before placing it beside Octant as
`Octant Nightly.app`, it checks the Nightly feed's signature, the download's
hash, and that the app is Octant Nightly signed by Octant's own developer. If
a check fails, the row says which one and nothing is installed. Octant never
replaces another app with that name. Once Nightly is installed, the row offers
Open Octant Nightly and Remove Octant Nightly. Remove moves the app to the
Trash and leaves your data alone. Installing a newer Nightly over an installed
one moves the old copy to the Trash. Quit Octant Nightly before you replace or
remove it; the row asks you to if it is still open. After you switch back to Stable, the row
stays while Nightly is installed. Octant on Linux does not install Nightly;
download it from octant.sh instead. The release workflow's scheduled Nightly run
has an explicit preflight stop until that functional client is implemented and
verified. Its dispatched run builds Octant on the candidate ring and is not
held by that stop; stable releases and local packaging have no such stop
either.

Nightly identifies its local window with a neutral "Nightly" label beside
"Octant" below the sidebar's native controls. Collapsing the sidebar moves the
label into the title bar; Settings keeps the same identity visible. The label
is a local display cue, not permission to access a host or shared data.

## Desktop host shutdown

Closing the last window keeps the desktop-owned host available. Quitting
Octant uses the existing active-work confirmation; cancelling it keeps the
host running. Once quit is accepted, queued starts and restarts cannot reopen
the host. Startup failure and shutdown both attempt all acquired native
services even if one cleanup step fails, including closing the Computer and
managed-device listeners after their service cleanup fails. A host started
independently is left running.

If graceful shutdown stalls, the existing quit deadline still attempts to
terminate Octant's owned server and tracked managed tools before ending the
app. Completion of service cleanup alone does not confirm every managed-tool
process has exited.

## Data directory

### macOS

Octant stores local data at:

```text
~/Library/Application Support/Octant/
```

The authoritative SQLite store is `octant.sqlite3`. Native window state lives in `octant-window-state.json`. New windows default to 1440 × 900 logical pixels, limited to the display’s usable area; a saved window size and position are restored. Set `OCTANT_DATA_DIR` to an absolute path to override the default location.

### Linux

Without `OCTANT_DATA_DIR`, Linux uses the XDG layout:

```text
~/.local/share/octant/
```

Config, state, and runtime roots follow the matching XDG variables when set. Set `OCTANT_DATA_DIR` to an absolute path to override the data root.

To run the same local host without Electron during development:

```sh
bun --cwd packages/cli src/bin.ts server run
```

The foreground command drains on SIGINT/SIGTERM and reports an existing owner instead of opening a second store.

### Headless Linux for ADE testing

Prefer the Linux AppImage dogfood path above when you want the Electron Machine on Ubuntu. A Linux host can also run the same server and browser client without Electron to exercise Chat, Work, and Code. Install Bun 1.4.4 or later first (same requirement as the system requirements above), then:

```sh
bash scripts/ade/install-linux-host-deps.sh
bash scripts/ade/start-secret-service-session.sh
# Load the bus address into this shell; new login shells also pick it up via bashrc.
. "${HOME}/.config/octant-host/session.env"
curl -fsSL https://chatgpt.com/codex/install.sh | sh
bun --cwd packages/cli src/bin.ts server run
bun --cwd packages/cli src/bin.ts web
```

`install-linux-host-deps.sh` installs `bubblewrap`, `lsof`, `libsecret-tools`, `gnome-keyring`, `dbus-x11`, and `dbus-user-session` when missing, ensures Git 2.36 or newer (installed from the git-core PPA when the distro's is older), and wires a shell hook that loads the live session bus address from `~/.config/octant-host/session.env`. `start-secret-service-session.sh` must run on every host boot: it probes a live D-Bus (and rejects a snapshotted socket path), starts `gnome-keyring-daemon` for the secrets component when needed, points the Secret Service `default` alias at the unlocked session collection so `secret-tool` does not block on a GUI prompt, writes `session.env`, and proves a store/lookup round-trip. Running the start script as a subprocess cannot export into the parent shell, so source `session.env` before `server run` in the same shell (or open a new login shell after install has wired bashrc).

The start script is the intended Cloud Agent environment `start` boot hook. Until a Saved environment persists and executes `start` on each agent boot, run `scripts/ade/start-secret-service-session.sh` manually after install (then source `session.env` as above). When configuring a Saved environment that does run `start`, keep install and start separate:

```text
install:
  bash scripts/ade/install-linux-host-deps.sh
  bun install --frozen-lockfile

start:
  bash scripts/ade/start-secret-service-session.sh
```

If that Saved environment runs `start` in a separate process from `server run`, start-script exports do not cross the subprocess boundary. Operators (or the server-launch shell) must source `${HOME}/.config/octant-host/session.env` in the same shell immediately before `server run` so the host inherits `DBUS_SESSION_BUS_ADDRESS`. A login shell that already ran the install bashrc hook also loads a live address from that file.

`bwrap` is the confinement runtime. On a graphical login the session bus and keyring are usually already present; the start script is then a no-op once Secret Service answers. Provider CLIs are ordinary host binaries. Keep `~/.local/bin` on `PATH`, install a CLI there (this host used the official Codex installer), and point the provider instance at that absolute path. Octant reuses the provider's native login profile; a missing `bwrap` reports `incompatible` rather than falling back to an unconfined provider.

### Install a headless artifact

A headless artifact runs the host without a repository checkout. It contains the CLI, the server, the web app, and every runtime dependency, including the native `node-pty` and `better-sqlite3` modules. Bun 1.4.4 or later must be on `PATH`. On Linux the host also needs `bubblewrap` and `lsof`, which a stock Ubuntu install lacks: `sudo apt-get install -y bubblewrap lsof`. Without Bubblewrap, Work and Code terminals fail to start; without `lsof`, Running services cannot check for local servers. `octant server install`, `start`, `restart`, and `enable` print what is missing on Linux but never install it. Build the artifact on the platform and architecture it is for, because the native modules come from that machine's install:

```sh
bun install --frozen-lockfile
bun run build
bun scripts/package-headless.ts
# out/headless/octant-<version>-<platform>-<arch>.tar.gz
```

Copy the tarball to the host, unpack it, and install it with its own CLI:

```sh
tar -xzf octant-<version>-linux-x64.tar.gz
./octant-<version>-linux-x64/bin/octant server install --artifact "$PWD/octant-<version>-linux-x64"
```

On Linux the install root defaults to `~/.local/state/octant/install` (`state/install` under `OCTANT_DATA_DIR` when that is set; `--install-root` or `OCTANT_INSTALL_ROOT` overrides it). It holds one directory per version plus a `current` link. Run the installed CLI from there:

```sh
~/.local/state/octant/install/current/bin/octant server start
~/.local/state/octant/install/current/bin/octant server status
~/.local/state/octant/install/current/bin/octant server stop
```

`server start` writes and starts the per-user service (`octant.service` under systemd, `app.octant.server` under launchd).

To check a build end to end, `bun run smoke:headless-install` unpacks the newest artifact for this machine into an empty temporary prefix with no `node_modules` above it, installs it, and runs `server start`, `server status`, and `server stop` with a private data directory and port. Pass `--tarball <path>` and `--prefix <empty directory>` to choose them. It refuses to run if a per-user Octant service is already installed, and removes the service file it wrote when it finishes.

Do not remove or corrupt the default directory. Removing the native window-state file changes the window ID, while removing the SQLite file discards all local journal and shell data.

## Iterate with the browser client

Use `octant web` to open the authenticated browser client without rebuilding Electron:

```sh
bun --cwd packages/cli src/bin.ts web
```

This attaches to a running local host or spawns one. The browser receives a single-use launch token in the URL fragment, removes it from the address bar, and exchanges it for a per-window capability. The token expires after five minutes and works only for the page it was created for. The desktop bridge secret and provider credentials never reach browser URLs or logs.

Typing the host address (for example `http://127.0.0.1:13773`) into a browser does not open a session; the page asks you to open Octant from the desktop app or run `octant web`. Run `octant web` as the same OS user that runs the host: it reads the host's bridge secret from that user's private runtime directory to create the link. `octant web --no-open` prints the one-time link instead of opening it.

## Updates

> **Provisional.** This section describes the signed-update path as it exists
> in the desktop app and as designed in the signed-updates decision. A local
> unsigned package cannot update itself. A build that has not compiled in a
> release signing key cannot verify a feed either, so a check currently
> refuses rather than installing anything. The disclosure below is the
> intended minimum-necessary posture; it will drop this banner once signed
> self-updating releases are final.

Octant checks for updates, downloads them when you ask, and applies them the
next time you relaunch. It never replaces itself while it is running, and it
refuses to relaunch while an agent is still working or while it cannot confirm
what is running — finish or checkpoint that work first.

An update is only ever installed if Octant can prove where it came from.
Trust comes from a signature, never from the server that answered: Octant
verifies a signature over the release notice against a key built into the app,
and checks the downloaded bytes against the hash that notice named, before
anything is installed. On macOS the platform then verifies the replacement's
own code signature before swapping anything. On Linux there is no
operating-system code signature; the same feed signature and hash are the
gates, and Octant replaces the portable image you launched only after they
pass. If any of those refuses — a bad signature, a download that does not
match, a version that is not newer, a build for another computer, a Linux
install that is not a portable image, an image Octant cannot write, or an
update service it cannot reach — Octant tells you which and installs nothing.
The reason is shown in **Settings → General → Updates**. There is no way to
wave a failed check through.

Because the bytes are verified rather than the host, the download may be
served from anywhere the release notice points, and pointing Octant at a
different update service does not lower the bar an update has to clear.

### Release rings

Octant publishes three streams. Octant itself follows one of the first two,
which you pick in **Settings → General → Updates**; the third is the separate
Octant Nightly app:

- **Stable** — the released build. This is where a normal install stays.
- **Preview** — a pre-release of the next stable version, built by hand from
  a chosen ref and signed and notarized exactly as a nightly is. It has no
  schedule: its feed changes only when someone runs that build. The same
  Octant app follows it; switching is a setting, not a second download.
- **Nightly** — a scheduled build of whatever has been merged. Newer, less
  settled, and a separate app, Octant Nightly, which follows only this stream
  and has no channel switch.

Version numbers still carry the rings' internal names. A Nightly version
reads like `0.2.0-preview.20260828.4` and a Preview like
`0.2.0-candidate.20260828.12`. Each sorts _below_ the `0.2.0` it leads to.
That is what makes the handover work without any special case: Octant never
offers you an older version than the one you are running. So switching from
Preview back to Stable leaves you where you are until the next stable release
passes you.

Each ring is its own signed feed, and the ring is inside the signature. A
preview release published at the stable address is refused, not installed.

### Pointing Octant at a different update service

Feeds live at `<base>/<ring>/<platform>-<arch>.json`, and the default base is
`https://octant.sh/updates`. Set `OCTANT_UPDATE_FEED_BASE_URL` to an HTTPS URL
to use your own — useful if you mirror releases inside a team; mirror the same
directory layout underneath it. Octant refuses a non-HTTPS value rather than
quietly falling back to the default, and a release served from your endpoint
still has to carry a signature Octant's built-in key accepts.

### How often a check happens

Automatic checking is on by default once the saved preference is loaded,
including hosts that stored settings before updates shipped. The desktop
process itself starts with checking **off** and stays off until that
preference arrives, so turning the switch off is never raced by a
launch-time request.

When automatic checking is on, the first check waits ten minutes after
launch, then repeats once every twenty-four hours. That is often enough to
hear about a release and infrequent enough to say little about when the app
is used. A version check is kept out of startup.

You can turn automatic checking off in **Settings → General → Updates**. Off
means Octant does not contact the update service at all, rather than checking
quietly; you can still check by hand whenever you want. The same disclosure
sits next to that switch.

### What's new

After an update you chose to install finishes applying on relaunch, the
desktop shows what that version changed. **Settings → General → Updates**
keeps a **What's new** control for the build on disk, so you can re-read
those notes without waiting for another prompt.

Notes for the running build are a file inside the app. Opening them does not
contact the update service. If that file is missing, Octant shows an empty
state rather than fetching a substitute. A short summary for an offered
update, when present, is already inside the signed feed from a check you
asked for or allowed — not a second request, and not HTML from an unsigned
host. Turning automatic checking off stays off for that summary the same way
it is off for versions.

A remote browser or phone client does not own this surface: it does not
update the desktop app, and it does not fetch notes.

### What an update check sends

A check is a plain HTTPS GET for a small JSON file listing the latest
version. Octant still compares versions on this computer, so a service that
ignores what you send works identically. The request User-Agent is `Octant`
with no version, so it cannot reconstruct one. Cookies and stored credentials
are omitted. It sends:

- The Octant version you are running, so the service can say whether anything is newer.
- Your platform and processor architecture, so it offers a build that runs on this machine.
- The IP address the request comes from, as any network request discloses.
- The time of the request.

From that, whoever serves the file learns that someone at that IP address
runs Octant, which version, and roughly how often it is open. It learns
nothing that names you: no account, no install identifier, no Project or
thread, no configuration, no usage, and no cookie. This path carries update
checks and nothing else.

If the release notice points the download at a release hosted elsewhere,
that host sees your IP address when the download itself is fetched — a
download, not a check, and only when you ask for one. Octant hashes those
bytes locally before anything is installed. On macOS it then serves them to
the platform updater over loopback. On Linux it writes them beside the
portable image. Either way the artifact host is contacted once.

A remote browser or phone client never runs this path: only the desktop app
updates itself. See [Privacy and security](/advanced/privacy-and-security#host-initiated-network)
for how this sits next to marketplace fetches.

## Next steps

After installation, continue with [First Run](/guide/first-run) to configure
providers and create your first Project. Drafts of the
[privacy notice](/advanced/privacy-notice) and
[data residency](/advanced/data-residency) statements describe what the
data directory holds and which requests leave the machine.
