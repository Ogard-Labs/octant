# Octant

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
- **Code** — engineering in one Git repository with approval-gated access,
  managed worktrees, terminals, an editor, tests, and a thread board.

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
- Native macOS shell: borderless window, tabs and splits, translucent sidebar,
  command palette, and slash commands.

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

Octant is an **unsigned Apple Silicon technical preview**. It is not signed or
notarized, has no auto-updater, and ships no Intel, Windows, or Linux desktop
builds. Expect rough edges and breaking changes to local data formats between
previews. Remote clients, the Expo mobile app, and packaged native checks are
separate evidence gates from the local test suite.

## Requirements

- Apple Silicon Mac (M1 or later) running a recent macOS
- [Bun](https://bun.sh) 1.3.x for building from source (`packageManager` in
  `package.json` pins the exact version)
- Node 26 only for the optional Node SQLite portability smoke

## Quick start (users)

There are no prebuilt binaries yet. Build the app from source:

```sh
git clone https://github.com/Ogard-Labs/octant.git
cd octant
bun install --frozen-lockfile
bun run build
bun run package:desktop
open out/Octant.app
```

Because the app is unsigned, macOS Gatekeeper will warn on first launch;
right-click the app and choose Open, or allow it under System Settings >
Privacy & Security.

On first run, open **Settings > Providers**, enable or add a provider, run the
connection check, then create a Project and start a thread. Local data lives
in `~/Library/Application Support/Octant/` (override with `OCTANT_DATA_DIR`).

## Quick start (developers)

```sh
bun install --frozen-lockfile
bun run dev
```

`bun run dev` starts the Vite renderer for `apps/web` with hot reload and
launches Electron against it. The desktop shell spawns the server from source:
renderer edits hot-reload, server edits take effect on the next app relaunch,
and only `apps/desktop/src` edits need `bun run --cwd apps/desktop build`.

To run the host without Electron and attach a browser client:

```sh
bun --cwd packages/cli src/bin.ts server run   # terminal 1
bun --cwd packages/cli src/bin.ts web          # terminal 2
```

Common checks:

| Command             | Purpose                                                    |
| ------------------- | ---------------------------------------------------------- |
| `bun run fmt`       | Format with oxfmt (`fmt:check` to verify)                  |
| `bun run lint`      | oxlint                                                     |
| `bun run typecheck` | Typecheck all workspaces                                   |
| `bun run test`      | Run workspace tests (Vitest)                               |
| `bun run build`     | Build all buildable workspaces                             |
| `bun run verify`    | Full local chain: wiring, format, lint, types, test, build |

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
| `packages/client-runtime` | Authenticated transport and replay synchronization                           |
| `packages/host-runtime`   | Host identity, paths, ownership, service and artifact lifecycle              |
| `packages/extensions`     | Extension and skill packages, trust, and activation policy                   |
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
