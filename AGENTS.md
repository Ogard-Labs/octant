# Octant Agent Contract

`AGENTS.md` is the canonical repository instruction entry point. Tool-specific
files (`CLAUDE.md` and similar) import or point here instead of duplicating it.

## Mission And Precedence

Octant is an original, local-first macOS workspace for Chat, Work, and Code
across multiple AI providers. Build the smallest reliable product that satisfies
the approved design.

Apply sources in this order:

1. Direct maintainer request.
2. This contract.
3. Decision records in `docs/decisions/` and `docs/architecture.md`.
4. The active Linear issue's acceptance criteria, which may narrow but not
   weaken a decision.
5. Tests and current code behavior.

Use the highest-priority source when they disagree. Stop only when sources at the
same priority conflict or resolution requires an unauthorized scope, product,
architecture, security, privacy, release, or destructive decision.

## Start With The Smallest Relevant Context

- Before editing, inspect the repository root, branch, worktree, status, and
  whether the branch already has a pull request.
- Read `docs/architecture.md` for the system shape and the decision record that
  owns the area you are changing. Do not load every decision record by default.
- Planning lives in Linear. Do not put issue numbers, phase names, or tracker
  state into code, comments, test titles, or documentation.

## Implementation Discipline

Quality means correct, secure, clear, maintainable behavior with useful evidence;
it is not measured by code volume, abstraction count, coverage percentage, or
test count.

- Define the requested outcome and acceptance criteria before editing. Implement
  the smallest complete change that satisfies them and the repository invariants.
- Prefer, in order, existing behavior, an existing project pattern, the standard
  library or native platform, an already-installed dependency, and finally the
  minimum new code. Every option must satisfy the acceptance criteria and the
  repository's architecture, security, privacy, and authority boundaries.
- Prefer direct control flow, explicit names, established boundaries, and local
  reasoning over cleverness or speculative flexibility.
- Add an abstraction only when it removes meaningful duplication, protects a
  required boundary, or makes the requested behavior materially clearer. Do not
  add interfaces, service layers, factories, configuration, compatibility paths,
  or extension points for hypothetical future requirements.
- Add a dependency only when existing project or platform capabilities cannot
  reasonably satisfy the current requirement and its benefit outweighs its
  maintenance, security, privacy, and packaging cost.
- Fix bugs at the narrowest shared boundary that addresses the root cause and
  relevant callers. Do not broaden a focused fix into a subsystem rewrite.
- Refactor only the code needed to deliver a correct, understandable change. Do
  not perform unrelated cleanup, broad renaming, file movement, or architectural
  modernization.
- Do not increase mixed ownership or architectural coupling. Split a module only
  when the requested change would otherwise make its responsibilities materially
  less clear or violate an explicit repository boundary.
- Record worthwhile adjacent improvements as follow-ups. Include them now only
  when inseparable from correctness, security, privacy, accessibility, data-loss
  protection, or the stated acceptance criteria.
- Stop when the acceptance criteria are satisfied, the changed code is clear,
  proportionate verification passes, and no known in-scope correctness problem
  remains.

## Product Invariants

- Chat, Work, and Code are server-enforced domain modes, not renderer flags.
  Code is always available; disabling Chat or Work never deletes their data.
- Chat Projects are virtual, memory-scoped containers with no implicit filesystem
  or shell authority. Work binds one OS-confined project root. Code binds one
  repository root and starts approval-gated unless Full access was explicitly
  remembered; Plan mode is always read-only.
- Work never silently becomes Code. Coding work promotes to a linked Code
  thread only with explicit user approval.
- Every supported provider reports capabilities honestly in every mode and
  fails closed when unsupported. No core capability may require a specific
  vendor.
- Browser/computer use, tests, Apple validation, approvals, memory, and subagents
  are app-managed, provider-neutral capabilities. Core Apple development cannot
  depend on an optional extension.
- Extension installation never implies trust, activation, enablement, or
  authority. Disabled components contribute no context; executable components
  remain quarantined and subject to ordinary sandbox and approval policy.
- Structured extension or plugin references cannot install, trust, enable,
  elevate, or bypass policy. Discover skills only from valid `.agents/skills/`
  packages in the permitted repository ancestry and user-global directory.
- Use the unified real-thread hierarchy and server-authoritative Work/Code
  boards. Chat has no board.
- A Work or Code thread is Done only when its user-confirmed delivery target is
  objectively satisfied. Remote clients never exceed host, mode, provider,
  Project, or thread authority.

## Originality, Privacy, And Architecture

- First-party packages, environment variables, identifiers, storage, URLs, copy,
  and assets use `@octant/*`, `OCTANT_*`, and Octant naming.
- Never import another product's source, assets, schemas, copy, identifiers, or
  distinctive implementation structure. Third-party code enters only as an
  approved dependency with a compatible license and explicit architectural fit.
- Preserve local-first and privacy-preserving defaults. Add telemetry, external
  calls, credential exposure, or cloud dependencies only when a decision record
  and the request require them.
- Dependencies point inward: apps may consume packages; contracts and domain do
  not import apps. Provider-specific payloads stop at adapters.
- Authority checks occur on the server before side effects, never only in React.
  The event journal is authoritative; projections are rebuildable and idempotent.
- Keep contracts schema-only and domain logic pure. Use Effect when lifecycle,
  concurrency, resource safety, typed failure, or service composition materially
  benefits from it; keep simple synchronous or pure behavior direct.

## Repository Ownership

| Surface                   | Owns                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `apps/desktop`            | Electron lifecycle, native windows, Keychain, macOS sandbox helpers, packaging           |
| `apps/server`             | Authoritative command/event control plane, providers, tools, Git, terminals, remote      |
| `apps/web`                | Shared React renderer for desktop and authenticated remote clients                       |
| `apps/mobile`             | Expo remote-control client                                                               |
| `apps/docs`               | VitePress user guide, independently deployable                                           |
| `packages/contracts`      | Schemas, commands, events, RPC, and versioned wire contracts; no runtime logic           |
| `packages/domain`         | Pure policies and transitions; no Electron, React, database, filesystem, network, or I/O |
| `packages/provider-sdk`   | Driver interfaces, normalized runtime events, discovery, and conformance harness         |
| `packages/client-runtime` | Authenticated transport, reconnect/replay, and query synchronization                     |
| `packages/host-runtime`   | Host identity, paths, ownership, service and artifact lifecycle                          |
| `packages/extensions`     | Manifests, normalized components, trust types, and pure effective-activation policy      |
| `packages/theme`          | Semantic theme schema, built-ins, importer, and editor/terminal projections              |
| `packages/cli`            | `octant` server and browser launcher                                                     |
| `scripts`                 | Dev loop, packaging, smokes, and repository checks                                       |

## Testing And Verification

Tests exist to catch meaningful regressions in requested behavior. Test value,
not test count or coverage percentage, determines what to add.

- For behavior changes with a meaningful automated assertion, use
  red-green-refactor: prove the missing or broken behavior, implement the smallest
  correct fix, and refactor only if the changed code needs it.
- For a bug fix, add or extend the closest stable test that reproduces the defect
  before the fix when a useful automated assertion is practical.
- For a feature, test observable behavior or a public contract. Prefer one focused
  test that proves the acceptance criterion over several tests of internal steps.
- Add failure and edge cases when they represent a realistic risk to authority,
  security, privacy, persistence, recovery, data integrity, accessibility, or a
  documented contract.
- Prefer extending an existing suite over creating a new suite for the same
  behavior. Use the lowest level that proves it reliably; add a broader test only
  when integration between boundaries is part of the risk.
- Do not add tests for trivial getters, pass-through wiring, framework behavior,
  private implementation details, speculative requirements, or coverage numbers
  alone.
- When no useful automated test is practical, do not manufacture one. Run the
  nearest relevant existing checks, perform reproducible manual or rendered
  verification when applicable, and say why a new test was omitted.
- Use repository scripts rather than substitutes (`bun run test`, not raw
  `bun test`). Always run `git diff --check`.

Start with the focused check for the changed surface, then broaden:

| Changed surface                                            | Minimum additional verification                                                                                |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Documentation or configuration only                        | Formatter, link/path and consistency checks                                                                    |
| Contracts                                                  | Focused contract tests and typecheck every consuming package                                                   |
| Domain policy                                              | Focused red/green policy tests and affected consumers                                                          |
| Server, API, or persistence                                | Route registration, auth/permission negatives, response/event shape, migrations/replay, and client integration |
| Provider                                                   | Provider-sdk conformance plus real-provider smoke when credentials or runtime exist                            |
| Web UI                                                     | Closest component/integration test for changed behavior plus rendered QA at relevant viewport/state boundaries |
| Desktop/native lifecycle, sandbox, Keychain, terminal, IPC | Desktop tests plus native-process or packaged-app smoke                                                        |
| Broad or cross-package change                              | `bun run verify` (wiring, format, lint, typecheck, test, build) unless a precise blocker is recorded           |

Agents perform all available automated, browser, and tool-accessible
verification. The maintainer owns human acceptance and checks requiring personal
credentials, physical devices, release authority, or subjective judgment.

## Delivery And Completion

- `main` is the only long-lived branch. Work on `feature/*` or `fix/*` branches
  and open a pull request to `main`. Never commit directly to `main` unless the
  maintainer explicitly asks.
- One pull request delivers one coherent outcome. Link the Linear issue in the PR
  description, not in code or docs.
- Update canonical documentation (`README.md`, `docs/architecture.md`,
  `docs/decisions/`, `apps/docs`) in the same PR when design, architecture,
  setup, workflow, security, deployment, or user-visible truth changes. Add a
  new decision record when a change would contradict or extend an existing one.
- Ready for review requires: acceptance criteria mapped to evidence, relevant
  checks run, current documentation, a pushed named branch, a non-draft PR to
  `main`, and no unexplained changes.
- A ready PR is not necessarily merge-ready. Required CI and any PR-owned
  pre-merge QA must pass on the exact head. Never merge without the maintainer's
  explicit instruction for that specific PR.
- State every skipped or unavailable check and residual risk precisely. Never
  infer success from intent or partial output.

## Current Release Boundary

The first release is the unsigned Apple Silicon technical preview with the
provider-neutral plugin/skill marketplace. Do not add signing, notarization,
updater, Intel, Windows/Linux packaging, native mobile store distribution,
hosted relay, schedules, connector/OAuth marketplace, full LSP/extension host,
or product features that mutate pull requests unless a decision record and an
explicit request authorize that scope.
