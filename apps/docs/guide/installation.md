---
description: Install Octant on Apple Silicon macOS and configure the local development environment.
---

# Installation

Octant is an unsigned Apple Silicon technical preview for macOS. It requires an Apple Silicon Mac and runs its local server through Electron's Node process. No cloud service, external relay, or Intel build is included in this preview.

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

Build and package the unsigned Apple Silicon app:

```sh
bun run build
bun run package:desktop
```

The command produces `out/Octant.app` for `darwin-arm64`. This boundary does not sign, notarize, publish, or create an update feed. The packaged app runs without Bun; it bundles its own rebuilt SQLite native module.

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

## Next steps

After installation, continue with [First Run](/guide/first-run) to configure providers and create your first Project.
