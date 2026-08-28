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
- Bun 1.3.14 (required for development and local iteration)
- Node 26 only when running the Node SQLite portability smoke

### Linux x64 (Ubuntu dogfood)

- x64 Linux host (Ubuntu is the dogfood target)
- Bun 1.3.14 (required for development and local iteration)
- Bubblewrap and a live Secret Service session for Work/Code
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

The AppImage is a peer Machine: Electron owns the local server lifecycle the same way the macOS app does. It is **unsigned**. There is no Linux signed update feed yet, so the desktop updater refuses to install updates on Linux rather than treating an unsigned AppImage as an auto-update channel. Signed Linux artifacts and feed matrix work land separately.

Launch:

```sh
chmod +x out/Octant-*-linux-x64.AppImage
./out/Octant-*-linux-x64.AppImage
```

If your host cannot mount nested AppImages, run with `APPIMAGE_EXTRACT_AND_RUN=1`. Work/Code still need Bubblewrap and a live Secret Service session on the host (see below).

## Data directory

### macOS

Octant stores local data at:

```text
~/Library/Application Support/Octant/
```

The authoritative SQLite store is `octant.sqlite3`. Native window state lives in `octant-window-state.json`. Set `OCTANT_DATA_DIR` to an absolute path to override the default location.

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

Prefer the Linux AppImage dogfood path above when you want the Electron Machine on Ubuntu. A Linux host can also run the same server and browser client without Electron to exercise Chat, Work, and Code. Install Bun 1.3.14 or later first (same requirement as the system requirements above), then:

```sh
bash scripts/ade/install-linux-host-deps.sh
bash scripts/ade/start-secret-service-session.sh
# Load the bus address into this shell; new login shells also pick it up via bashrc.
. "${HOME}/.config/octant-host/session.env"
curl -fsSL https://chatgpt.com/codex/install.sh | sh
bun --cwd packages/cli src/bin.ts server run
bun --cwd packages/cli src/bin.ts web
```

`install-linux-host-deps.sh` installs `bubblewrap`, `libsecret-tools`, `gnome-keyring`, `dbus-x11`, and `dbus-user-session` when missing, and wires a shell hook that loads the live session bus address from `~/.config/octant-host/session.env`. `start-secret-service-session.sh` must run on every host boot: it probes a live D-Bus (and rejects a snapshotted socket path), starts `gnome-keyring-daemon` for the secrets component when needed, points the Secret Service `default` alias at the unlocked session collection so `secret-tool` does not block on a GUI prompt, writes `session.env`, and proves a store/lookup round-trip. Running the start script as a subprocess cannot export into the parent shell, so source `session.env` before `server run` in the same shell (or open a new login shell after install has wired bashrc).

The start script is the intended Cloud Agent environment `start` boot hook. Until a Saved environment persists and executes `start` on each agent boot, run `scripts/ade/start-secret-service-session.sh` manually after install (then source `session.env` as above). When configuring a Saved environment that does run `start`, keep install and start separate:

```text
install:
  bash scripts/ade/install-linux-host-deps.sh
  bun install --frozen-lockfile

start:
  bash scripts/ade/start-secret-service-session.sh
```

If that Saved environment runs `start` in a separate process from `server run`, start-script exports do not cross the subprocess boundary. Operators (or the server-launch shell) must source `${HOME}/.config/octant-host/session.env` in the same shell immediately before `server run` so the host inherits `DBUS_SESSION_BUS_ADDRESS`. A login shell that already ran the install bashrc hook also loads a live address from that file.

`bwrap` is the confinement runtime. On a graphical login the session bus and keyring are usually already present; the start script is then a no-op once Secret Service answers. Provider CLIs are ordinary host binaries. Keep `~/.local/bin` on `PATH`, install a CLI there (this host used the official Codex installer), and point the provider instance at that absolute path. Kimi Code's managed-profile confinement stays macOS-only and reports `incompatible`.

Do not remove or corrupt the default directory. Removing the native window-state file changes the window ID, while removing the SQLite file discards all local journal and shell data.

## Iterate with the browser client

Use `octant web` to open the authenticated browser client without rebuilding Electron:

```sh
bun --cwd packages/cli src/bin.ts web
```

This attaches to a running local host or spawns one. The browser receives a single-use launch token in the URL fragment and exchanges it for a per-window capability. The desktop bridge secret and provider credentials never reach browser URLs or logs.

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
refuses to relaunch while an agent is still working or a thread is waiting on
you — finish or checkpoint that work first.

An update is only ever installed if Octant can prove where it came from.
Trust comes from a signature, never from the server that answered: Octant
verifies a signature over the release notice against a key built into the app,
checks the downloaded bytes against the hash that notice named, and macOS
then verifies the replacement's own code signature before swapping anything.
If any of those refuses — a bad signature, a download that does not match, a
version that is not newer, a build for another kind of Mac, or an update
service it cannot reach — Octant tells you which and installs nothing. There
is no way to wave a failed check through.

Because the bytes are verified rather than the host, the download may be
served from anywhere the release notice points, and pointing Octant at a
different update service does not lower the bar an update has to clear.

### Release rings

Octant publishes two streams, and you pick one in
**Settings → General → Updates**:

- **Stable** — the released build. This is where a normal install stays.
- **Preview** — a nightly build of whatever has been merged. Newer, less
  settled, and a separate download.

A preview version reads like `0.2.0-preview.20260828.4`, and it sorts _below_
the `0.2.0` it leads to. That is what makes the handover work without any
special case: a preview install moves onto stable the day stable catches up,
and Octant never offers you an older version than the one you are running. So
switching from preview back to stable leaves you where you are until the next
stable release passes you.

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

### What an update check sends

A check is a plain HTTPS GET for a small JSON file listing the latest
version. Octant still compares versions on your Mac, so a service that
ignores what you send works identically. The request User-Agent is `Octant`
with no version, so it cannot reconstruct one. Cookies and stored credentials
are omitted. It sends:

- The Octant version you are running, so the service can say whether anything is newer.
- Your platform and processor architecture, so it offers a build that runs on this Mac.
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
bytes locally and then serves them to the platform updater over loopback, so
the artifact host is contacted once.

A remote browser or phone client never runs this path: only the desktop app
updates itself. See [Privacy and security](/advanced/privacy-and-security#host-initiated-network)
for how this sits next to marketplace fetches.

## Next steps

After installation, continue with [First Run](/guide/first-run) to configure
providers and create your first Project. Drafts of the
[privacy notice](/advanced/privacy-notice) and
[data residency](/advanced/data-residency) statements describe what the
data directory holds and which requests leave the machine.
