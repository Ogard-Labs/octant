<p align="center">
  <a href="https://octant.sh">
    <img src="apps/web/public/icon.png" alt="Octant logo" width="120" />
  </a>
</p>

<h1 align="center">Octant</h1>

<p align="center">
  <a href="https://octant.sh">octant.sh</a>
</p>

Octant is a local-first macOS workspace for **Chat**, **Work**, and **Code**
across many AI providers. One authoritative local server owns your Projects,
threads, memory, approvals, and history; the desktop app (and optionally an
authenticated browser or remote client) is a renderer over it. Octant runs the
providers you already have — local coding CLIs, agent SDKs, Ollama, or any
OpenAI- or Anthropic-compatible HTTP endpoint — and no core capability
requires a specific vendor or an Octant-operated cloud service.

## Modes

- **Chat** — conversations in virtual Projects with scoped memory and no
  implicit filesystem or shell authority.
- **Work** — knowledge work confined to one user-approved folder: research
  with citations, artifacts, previews, and Goals.
- **Code** — engineering confined to one user-approved folder: approval-gated
  access, managed worktrees, terminals, an editor, tests, and a thread board.

Modes are enforced on the server, not toggled in the renderer. Work never
silently becomes Code; promotion to a linked Code thread requires explicit
approval.

## Key features

- Durable append-only event journal in SQLite; every projection is rebuildable
  by replay, and recovery and backup go through a verified boundary.
- Provider-neutral runtime: capabilities are reported honestly per provider and
  mode, and unsupported operations fail closed instead of pretending.
- Provider handoff mid-thread: change provider or model for the next turn with
  a recorded provenance trail.
- Context manifests and budgets with per-provider limits.
- Shared, Project-scoped memory across threads.
- Chat turn editing, thread branching, and Markdown export that states what it
  could not include.
- Managed subagents that run as in-process provider sessions with narrowed
  authority.
- Approval-gated Code threads with a read-only Plan mode, repository test
  discovery, Git worktrees, PR view, and a runtime-derived Code board.
- Plugin and skill marketplace: packages are quarantined on install, disabled
  by default, and contribute no context until enabled.
- App-managed browser and computer-use runtime with server-authoritative
  policy.
- Optional authenticated remote access (LAN or Tailscale) to a single host with
  device pairing, key rotation, and revocation.
- Semantic themes, presets, and font controls.
- Native macOS shell: borderless window, a split-tree workspace with one
  surface per pane, translucent sidebar, command palette, and slash commands.
  The right dock holds live thread-owned tools and restores them per window and
  thread; Environment is a transient disclosure; context usage sits on the
  composer meter.

Not everything above is equally polished; this is a technical preview. See the
user guide in `apps/docs` for the current honest boundaries of each area.

## Supported providers

Local CLIs and SDKs (Octant discovers installed runtimes and registers them
disabled until you enable them):

- Codex CLI
- Claude Code (Claude Agent SDK)
- OpenCode CLI
- Kimi Code CLI
- Devin ACP
- Kilo ACP
- Pi RPC
- Oh My Pi
- Mistral Vibe ACP
- Ollama (local HTTP)

Direct API endpoints:

- OpenAI-compatible HTTP (`responses` or `chat-completions`)
- Anthropic-compatible HTTP (`messages`)
- Azure AI Foundry (OpenAI-compatible v1 profile, API key)

Credentials are stored in the macOS Keychain, resolved by the desktop broker,
and never written to the event journal or returned to the renderer.

## Status

Octant is an **Apple Silicon technical preview**. Releases are signed with a
Developer ID, notarized, and update themselves — you choose when an update
applies, and it never replaces a running app or interrupts work in flight. It
ships no Intel, Windows, or Linux desktop builds. Expect rough edges and
breaking changes to local data formats between previews. Remote clients, the
Expo mobile app, and packaged native checks are separate evidence gates from the
local test suite.

## Requirements

### Apple Silicon (macOS)

- Apple Silicon Mac (M1 or later) running a recent macOS
- [Bun](https://bun.sh) 1.3.x for building from source (`packageManager` in
  `package.json` pins the exact version)
- Node 26 only for the optional Node SQLite portability smoke

### Linux x64 (Ubuntu dogfood)

- x64 Linux host (Ubuntu is the dogfood target)
- Bun 1.3.x for building from source
- Bubblewrap and a live Secret Service session for Work/Code on the host
- Node 26 only for the optional Node SQLite portability smoke

## Quick start (users)

There are no prebuilt binaries yet. Build the app from source:

```sh
git clone https://github.com/Ogard-Labs/octant.git
cd octant
bun install --frozen-lockfile
bun run build
bun run package:desktop
```

### Apple Silicon macOS

Packaging produces `out/Octant.app`. A build you package yourself is unsigned,
so macOS Gatekeeper will warn on first launch; right-click the app and choose
Open, or allow it under System Settings > Privacy & Security. An unsigned build
also does not update itself — the updater installs a replacement only when it
satisfies the running app's code signature. Signed releases carry that
signature and update in place.

Local data lives in `~/Library/Application Support/Octant/` (override with
`OCTANT_DATA_DIR`).

### Linux x64 AppImage

On x64 Linux the same command produces
`out/Octant-<version>-linux-x64.AppImage` (plus `out/Octant-linux-x64/` for
inspection). That AppImage is an unsigned dogfood artifact: Electron still owns
the local server as a peer Machine, but a dogfood AppImage is not signed
auto-update. Release workflows may scaffold `<ring>/linux-x64.json`; the
updater still refuses Linux installs until a maintainer-published signed feed
exists. Mark the AppImage executable and launch it directly. AppRun
keeps the Chromium sandbox when unprivileged user namespaces work, and only
adds `--no-sandbox` when that probe fails (AppImage mounts are `nosuid`).
Ubuntu 24.04+ AppArmor may still restrict Chromium userns; a dedicated profile
is out of scope for this dogfood path.

Local data uses the XDG layout (`~/.local/share/octant/` by default; override
with `OCTANT_DATA_DIR`).

On first run, the welcome surface collects a name and optional workspace
choices, then reports provider, Project, and a mode-valid default model
separately. One action starts a real thread when those facts are true; a
missing prerequisite opens its exact setup surface and returns to the same
draft.

## Quick start (developers)

```sh
bun install --frozen-lockfile
bun run dev
```

`bun run dev` starts the Vite renderer for `apps/web` with hot reload and
launches Electron against it. Electron attaches to the canonical host or starts
it from source when absent: renderer edits hot-reload, server edits take effect
on the next app relaunch when Electron started the host — an already-running
host that Electron attached to must be restarted separately — and
`apps/desktop/src` edits are rebuilt automatically
the next time you start `bun run dev`.

To run the host without Electron and attach a browser client:

```sh
bun --cwd packages/cli src/bin.ts server run   # http://127.0.0.1:13773/
```

Open `http://127.0.0.1:13773/` directly, or run
`bun --cwd packages/cli src/bin.ts web` as a convenience. Electron and every
local browser attach to this same canonical Machine, data store, Projects, and
threads.

For browser UI development with hot reload, use the development launcher
instead of pairing a hand-started server with Vite:

```sh
bun --cwd packages/cli src/bin.ts web --dev --no-open
```

It starts only the Vite renderer and points it at the canonical host. Renderer
mode never selects another data directory: browser QA, Electron, and Vite show
the same Projects and threads. Tests that need an isolated store must set an
explicit `OCTANT_DATA_DIR`.

Common checks:

| Command             | Purpose                                                               |
| ------------------- | --------------------------------------------------------------------- |
| `bun run fmt`       | Format with oxfmt (`fmt:check` to verify)                             |
| `bun run lint`      | oxlint                                                                |
| `bun run typecheck` | Typecheck all workspaces                                              |
| `bun run test`      | Run workspace tests (Vitest)                                          |
| `bun run build`     | Build all buildable workspaces                                        |
| `bun run verify`    | Full local chain: wiring, decisions, format, lint, types, test, build |

Credentialed provider smokes, packaged app smokes, and browser QA are opt-in
scripts (`bun run smoke:*`) and are not part of `verify`.

## Repository layout

| Path                      | Responsibility                                                               |
| ------------------------- | ---------------------------------------------------------------------------- |
| `apps/desktop`            | Electron lifecycle, native windows, Keychain broker, helpers, packaging      |
| `apps/server`             | Authoritative API, event journal, providers, tools, Projects, recovery       |
| `apps/web`                | Shared React renderer for desktop and authenticated browser clients          |
| `apps/mobile`             | Expo remote-control client (device distribution is a separate gate)          |
| `apps/docs`               | VitePress user guide, independently deployable                               |
| `packages/contracts`      | Versioned schemas, commands, events, and RPC contracts (schema-only)         |
| `packages/domain`         | Pure policy and state transitions                                            |
| `packages/provider-sdk`   | Provider driver interface, normalized runtime events, discovery, conformance |
| `packages/client-runtime` | Authenticated, prioritized transport, reconnect, and replay synchronization  |
| `packages/host-runtime`   | Host identity, paths, ownership, service and artifact lifecycle              |
| `packages/plugin-host`    | Extension and skill packages, trust, and activation policy                   |
| `packages/theme`          | Semantic theme schema and projections                                        |
| `packages/cli`            | `octant` server and browser launcher                                         |
| `scripts`                 | Dev loop, packaging, smokes, and repository checks                           |

Dependencies point inward: apps consume packages; contracts and domain never
import apps; provider-specific payloads stop at adapters.

## Documentation

- [Architecture](docs/architecture.md)
- [Decision records](docs/decisions/)
- [User guide](apps/docs/) (VitePress; `bun run --cwd apps/docs dev`)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Code of conduct](CODE_OF_CONDUCT.md)

## License

MIT. See [LICENSE](LICENSE).
