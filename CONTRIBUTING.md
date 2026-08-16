# Contributing to Octant

Thanks for your interest. Octant is a small, opinionated project; the notes
below explain how to get a change from idea to merged with the least friction.

## Set up

Requirements: an Apple Silicon Mac, Bun (the exact version is pinned by
`packageManager` in `package.json`), and Node 26 only if you want to run the
Node SQLite portability smoke.

```sh
git clone https://github.com/Ogard-Labs/octant.git
cd octant
bun install --frozen-lockfile
```

## Run

- `bun run dev` — hot-reloading desktop loop (Vite renderer + Electron; the
  shell spawns the server from source, so server edits need an app relaunch).
- `bun --cwd packages/cli src/bin.ts server run` and, in another terminal,
  `bun --cwd packages/cli src/bin.ts web` — headless host plus browser client.
- `bun run build && bun run package:desktop` — unsigned `out/Octant.app`.

Use `OCTANT_DATA_DIR=/absolute/disposable/path` when experimenting so you do
not touch your real data directory.

## Check your work

| Command             | What it does                                                      |
| ------------------- | ----------------------------------------------------------------- |
| `bun run fmt`       | Format with oxfmt (`bun run fmt:check` in CI)                     |
| `bun run lint`      | oxlint, including unused disable directives                       |
| `bun run typecheck` | `tsc` across all workspaces                                       |
| `bun run test`      | Vitest across all workspaces                                      |
| `bun run verify`    | The full chain CI runs: wiring, fmt, lint, typecheck, test, build |

Run `bun run verify` and `git diff --check` before opening a PR. Per-workspace
scripts exist too (for example `bun run --cwd apps/server test`) for a faster
loop while iterating.

Provider smokes that need real credentials (`bun run smoke:*`) are opt-in and
are not required for a PR.

## Branches and pull requests

- `main` is the only long-lived branch. Work on a feature branch
  (`feature/<short-topic>` or `fix/<short-topic>`) and open a PR against
  `main`.
- Keep PRs small and focused on one outcome. Split unrelated changes.
- CI must be green on the exact head being merged. Rebase or merge `main` in
  if it has moved.
- Behavior changes come with tests (see below). Documentation changes to
  `docs/`, `apps/docs`, or this file are welcome on their own.
- Describe what changed, why, and how you verified it. Link the issue if
  there is one.
- The maintainers review and merge; expect questions rather than silent
  rewrites.

## Commit messages

Use conventional commits: `type(scope): summary` in the imperative mood.
Common types are `feat`, `fix`, `refactor`, `test`, `docs`, `chore`. Scope is
optional and usually the app or package (`server`, `web`, `code`, `desktop`).
Examples:

```
feat(code): let users answer agent-initiated approvals from the thread view
fix(server): make provider turn timeouts idle-based
docs: consolidate repository documentation
```

## Coding principles

- Decide the outcome and acceptance criteria first, then make the smallest
  complete change that meets them.
- Prefer, in order: existing behavior, an existing project pattern, the
  standard library or platform, an installed dependency, new code. Add a
  dependency only when nothing already present reasonably does the job.
- Straightforward control flow and explicit names beat cleverness. Do not add
  abstractions, config knobs, or extension points for hypothetical futures.
- Fix bugs at the narrowest boundary that covers the root cause and its
  callers. Do not turn a fix into a rewrite; leave unrelated cleanup for a
  separate PR.
- Respect the architecture: apps consume packages, contracts stay
  schema-only, domain logic stays pure, provider-specific payloads stop at
  adapters, and authority checks happen on the server before side effects.
- Keep local-first and privacy defaults: no telemetry, no external calls, and
  no credential exposure unless the change explicitly requires and documents
  it.
- New identifiers, env vars, and storage use `@octant/*`, `OCTANT_*`, and
  Octant naming.

## Testing principles

- Tests exist to catch meaningful regressions, not to raise a coverage number.
- For a bug, add or extend the closest existing test so it fails before the
  fix and passes after.
- For a feature, test observable behavior or a public contract; prefer one
  focused test over several that probe internal steps.
- Add failure and edge cases where they represent real risk: authority,
  security, privacy, persistence, recovery, data integrity, accessibility.
- Use the lowest test level that proves the behavior reliably; extend an
  existing suite rather than adding a parallel one.
- Do not test trivial getters, pass-through wiring, or framework behavior.
  When no useful automated test is practical, say so in the PR and describe
  the manual verification you did.

## AI-assisted contributions

Using AI tools to write or review code is fine. You remain the author: read
and understand every line you submit, run the checks yourself, and be ready to
explain the change in review. PRs that the contributor cannot explain will be
sent back.

## Bugs and ideas

Open a GitHub issue. For bugs, include the app version or commit, macOS
version, the provider involved, exact steps, and what you expected versus what
happened. Do not include credentials, tokens, or private paths. For
vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of filing a public
issue.
