---
description: Install Octant on Apple Silicon macOS and configure the local development environment.
---

# Installation

Octant is an Apple Silicon technical preview for macOS, signed with a Developer ID and notarized by Apple. It requires an Apple Silicon Mac and runs its local server through Electron's Node process. No cloud service, external relay, or Intel build is included in this preview.

## System requirements

- Apple Silicon Mac (M1 or later)
- macOS Sequoia or later
- Bun 1.3.14 (required for development and local iteration)
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

Build and package the Apple Silicon app:

```sh
bun run build
bun run package:desktop
```

The command produces `out/Octant.app` for `darwin-arm64`. The packaged app runs without Bun; it bundles its own rebuilt SQLite native module.

Packaging locally produces an **unsigned** app and says so, because signing needs an Apple Developer ID that only the maintainer holds. An unsigned build works, but it cannot update itself: the updater replaces the app only when the replacement satisfies the running app's code signature, and an unsigned app has none. To produce a release build, set `OCTANT_SIGNING_IDENTITY`, `OCTANT_NOTARY_PROFILE`, and `OCTANT_SIGNING_TEAM_ID`, and declare it with `OCTANT_RELEASE_BUILD=1` — a declared release refuses to finish unsigned rather than emitting something that looks shippable.

## Data directory

On macOS, Octant stores local data at:

```text
~/Library/Application Support/Octant/
```

The authoritative SQLite store is `octant.sqlite3`. Native window state lives in `octant-window-state.json`. Set `OCTANT_DATA_DIR` to an absolute path to override the default location. Linux uses the standard XDG data, config, state, and runtime roots when no override is set.

To run the same local host without Electron during development:

```sh
bun --cwd packages/cli src/bin.ts server run
```

The foreground command drains on SIGINT/SIGTERM and reports an existing owner instead of opening a second store.

Do not remove or corrupt the default directory. Removing the native window-state file changes the window ID, while removing the SQLite file discards all local journal and shell data.

## Iterate with the browser client

Use `octant web` to open the authenticated browser client without rebuilding Electron:

```sh
bun --cwd packages/cli src/bin.ts web
```

This attaches to a running local host or spawns one. The browser receives a single-use launch token in the URL fragment and exchanges it for a per-window capability. The desktop bridge secret and provider credentials never reach browser URLs or logs.

## Updates

Octant checks for updates, downloads them when you ask, and applies them the next time you relaunch. It never replaces itself while it is running, and it refuses to relaunch while an agent is still working or a thread is waiting on you — finish or checkpoint that work first.

An update is only ever installed if Octant can prove where it came from. Trust comes from a signature, never from the server that answered: Octant verifies a signature over the release notice against a key built into the app, checks the downloaded bytes against the hash that notice named, and macOS then verifies the replacement's own code signature before swapping anything. If any of those refuses — a bad signature, a download that does not match, a version that is not newer, a build for another kind of Mac, or an update service it cannot reach — Octant tells you which and installs nothing. There is no way to wave a failed check through.

Because the bytes are verified rather than the host, the download may be served from anywhere the release notice points, and pointing Octant at a different update service does not lower the bar an update has to clear.

### Pointing Octant at a different update service

Octant checks `https://octant.sh` by default. Set `OCTANT_UPDATE_FEED_URL` to an HTTPS URL to use your own — useful if you mirror releases inside a team. Octant refuses a non-HTTPS value rather than quietly falling back to the default, and a release served from your endpoint still has to carry a signature Octant's built-in key accepts.

### What an update check sends

A check is a plain request for a small file listing the latest version. Octant still compares versions on your Mac, so a service that ignores what you send works identically. It sends:

- The Octant version you are running, so the service can say whether anything is newer.
- Your platform and processor architecture, so it offers a build that runs on this Mac.
- The IP address the request comes from, as any network request discloses.
- The time of the request.

From that, whoever serves the file learns that someone at that IP address runs Octant, which version, and roughly how often it is open. It learns nothing that names you: no account, no install identifier, no Project or thread, no configuration, no usage, and no cookie. This path carries update checks and nothing else.

If the release notice points the download at a release hosted elsewhere, that host sees your IP address when the download itself is fetched — a download, not a check, and only when you ask for one.

You can turn automatic checking off in **Settings → General → Updates**. Off means Octant does not contact the update service at all, rather than checking quietly; you can still check by hand whenever you want.

## Next steps

After installation, continue with [First Run](/guide/first-run) to configure providers and create your first Project.
