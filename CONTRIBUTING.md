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
not touch your real data directory. `bun run smoke:packaged-desktop` is the
local unsigned developer-package smoke: it uses a clean `OCTANT_DATA_DIR`,
records the smoked commit, and is not the signed technical-preview release
gate.

A rendered check that needs a thread that already holds a finished turn with a
Canvas in it (an inline Canvas card, a prototype's **Run** button in the
transcript) does not need a paid model turn. `bun run seed:canvas-fixtures
--data-dir /absolute/scratch/path` writes a Chat Project and one Chat thread per
fixture (a document, a static design, and a running design at document size and
at phone size), each with a settled turn and the Canvas that turn left, through
the host's own services and journal and without contacting a provider. It
refuses a relative path, a real data directory, and any directory that is not
empty or one it seeded earlier. Start a host on the directory with
`OCTANT_DATA_DIR=/absolute/scratch/path bun --cwd packages/cli src/bin.ts
server run`. A document or static design is drawn inline in its thread; a
running design is a row that you expand in the thread and then start with
**Run**, because an agent cannot place a design that runs script inline.

## Check your work

| Command             | What it does                                                      |
| ------------------- | ----------------------------------------------------------------- |
| `bun run fmt`       | Format with oxfmt (`bun run fmt:check` in CI)                     |
| `bun run lint`      | oxlint, including unused disable directives                       |
| `bun run typecheck` | `tsc` across all workspaces                                       |
| `bun run test`      | Vitest across all workspaces                                      |
| `bun run verify`    | The full chain CI runs: wiring, fmt, lint, typecheck, test, build |

Use the [verification policy](AGENTS.md#testing-and-verification) to select
checks. Bounded changes use focused local checks and required hosted CI; broad
integration or uncertain dependency impact needs full local `bun run verify`.
Always run `git diff --check`. Existing tests may supply the required coverage;
adding tests is justified by an uncovered behavior or concrete risk.

A web UI test that passes locally but fails now and then in CI usually reads
state that an async render has not produced yet. To make such reads fail far
more often, run the web DOM tests from `apps/web` with
`OCTANT_TEST_ASYNC_STRESS=1 bun run test [file]`. It removes the short wait
after each user-event action; `waitFor` and `findBy*` are unaffected and are
the fix. The stress mode is a local diagnostic, not a CI gate: a pass does not
prove a test is race-free.

Run real-provider smokes when the issue's outcome or affected provider boundary
requires them and credentials are available. If a required smoke is unavailable,
record the exact blocker; synthetic checks do not replace that acceptance.
Once applicable checks pass, proceed to delivery under the
[issue closeout policy](AGENTS.md#issue-closeout).

## Branches and pull requests

- `main` is the only long-lived branch. Work on a feature branch
  (`feature/<short-topic>` or `fix/<short-topic>`). A standalone or bottom PR
  targets `main`; a dependent child PR may target the immediately preceding
  feature branch.
- Before opening a branch or PR, search the open PRs and branch ancestry for the
  same task or user-visible outcome. Continue an existing PR for follow-up work
  that belongs to it instead of creating a sibling PR.
- Keep PRs small and focused on one outcome. Split unrelated changes.
- Prefer one PR when the work is one outcome and not independently reviewable.
  Use a native GitHub stack for independently reviewable dependent slices: link
  the parent and child PRs, record their order, keep the stack linear, and queue
  it from the lowest eligible PR. Use separate `main` PRs for independent work.
- CI must be green on the exact head being merged. If `main` has moved, a
  standalone PR may rebase or merge `main`. A native stacked PR must
  cascading-rebase onto the new `main` (`Rebase stack`, or `gh stack rebase`
  then `gh stack push`); do not merge `main` into a stack layer. This explicit
  stack operation is the exception to the ordinary no-rewrite rule; do not rebase
  unrelated or shared work.
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

## Design changes

Start from the [current design index](docs/design/README.md). Architecture owns
system boundaries, Workspace owns navigation and interaction, and DESIGN.md
owns presentation. Update the owning specification in place alongside an
approved implementation change, and reconcile any conflicting summaries.
Historical ADRs explain earlier rationale; the archive is closed, so no change
adds or supersedes one. A clear maintainer request to change the design authorizes
the corresponding specification update. Ask about unresolved consequential scope,
not merely because an old document says something different.

Review the resulting specification and behavior together. Link useful tests or
rendered evidence in the PR, and distinguish approved design from unfinished
implementation. See [AGENTS.md](AGENTS.md) for authority and delivery rules.

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
- Keep local-first and privacy defaults: no telemetry, no new external calls,
  and no credential exposure unless the change explicitly requires and
  documents it. Host-initiated update checks and marketplace fetches already
  exist; do not widen what they send.
- New identifiers, env vars, and storage use `@octant/*`, `OCTANT_*`, and
  Octant naming.

## Testing and closeout

[AGENTS.md](AGENTS.md#testing-and-verification) owns the verification rules and
[issue closeout conditions](AGENTS.md#issue-closeout). The PR should map the
changed acceptance criteria to evidence and name remaining blockers. Existing
coverage is sufficient when it proves the behavior; do not add duplicate tests
or repeat unaffected checks simply for another handoff.

Keep the Linear description's current summary consistent with its status. An
implementation issue normally closes after merge and its applicable acceptance
checks; an explicit different delivery target is honored. Preserve required
native/provider/human checks, and keep unrelated discoveries in separate issues.

## Releases

Two rings, both built by GitHub Actions. Apple Silicon (`darwin-arm64`) is
Developer ID signed and notarized; Linux x64 ships an unsigned AppImage dogfood
artifact on the same matrix. Feed documents use the rings layout from
[decision 0034](docs/decisions/0034-signed-updates.md):
`<base>/<ring>/<platform>-<arch>.json`. A dogfood AppImage is not code-signed.
In-app update still requires that signed feed, and refuses a package, an
archive, or a location it cannot write.

- **Preview** — `.github/workflows/release-preview.yml` runs nightly, builds
  `main`, and publishes feeds under `<base>/preview/` for each matrix arch
  (`darwin-arm64.json`, and `linux-x64.json` when feed signing material is
  present). It skips itself when `main` has not moved since the last preview.
  Force one with `gh workflow run 'Release (preview)' -f force=true`.
- **Stable** — `.github/workflows/release-stable.yml` runs on a
  `vMAJOR.MINOR.PATCH` tag and publishes under `<base>/stable/` for the same
  matrix. The `stable` environment requires an approval, so pushing the tag
  proposes the release and a maintainer approves it before anything is signed.

Cutting a stable release is two steps: set
`DESKTOP_PACKAGE_IDENTITY.version` in `scripts/package-desktop.ts` to the
version you are releasing, then push the matching tag. The workflow refuses a
tag that disagrees with that constant, because an app that announces one
version while the feed offers another makes every install compare the wrong
pair. After the release, bump the constant to the next version you are working
toward; previews are prereleases of it.

Credentials — the Developer ID certificate, the notary key, the Ed25519 feed
signing key, the deploy key that publishes the feed, and the Tailscale OAuth
secret that lets a job reach the feed host — are environment secrets, never
repository secrets, so a workflow on a side branch cannot read them. Linux matrix rows may dry-run the feed path without that key; darwin-arm64
still requires it. `scripts/setup-release-credentials.sh` walks a maintainer
through creating and installing all of them; run it once, and again when a key
is rotated.

### Publishing the feed

The host that serves `https://octant.sh/updates` accepts SSH only over the
tailnet. Each job that publishes a feed (the two release workflows and the
bridge) first runs `.github/actions/join-feed-tailnet`, which joins the tailnet
as an ephemeral node tagged `tag:octant-feed-ci`, then rsyncs the signed ring
directory over SSH. The job fails before any upload, naming what is missing,
when the Tailscale credential is not set.

What has to exist, none of it in this repository:

- A Tailscale OAuth client with only the writable `auth_keys` scope, limited to
  the tag `tag:octant-feed-ci`. The client ID is the variable
  `OCTANT_FEED_TAILSCALE_OAUTH_CLIENT_ID`; its secret is the environment secret
  `OCTANT_FEED_TAILSCALE_OAUTH_SECRET` in `preview` and `stable`.
- A tailnet policy that lets that tag reach the feed host on `tcp:22` and
  nothing else.
- On the feed host, an account that can only write the feed directory: its key
  in `authorized_keys` behind `restrict,command="rrsync -wo <feed directory>"`.
  Its private key is the environment secret `OCTANT_FEED_SSH_KEY`.
- The feed directory served by the website at `/updates/`, so that
  `<ring>/<platform>-<arch>.json` and `<ring>/<platform>-<arch>.preview-key.json`
  resolve under `https://octant.sh/updates`.
- Variables `OCTANT_FEED_SSH_HOST` (the host's tailnet name),
  `OCTANT_FEED_SSH_USER`, `OCTANT_FEED_REMOTE_PATH` (`.` when `rrsync` fixes the
  directory), and `OCTANT_FEED_SSH_KNOWN_HOSTS` (the host key line for exactly
  that name; the workflows never accept a host on first use).

A leaked upload credential can withhold updates or overwrite a feed file, but
installs refuse any feed the pinned signing keys did not sign.

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
