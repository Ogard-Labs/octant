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
3. Current specifications: `docs/architecture.md`, `DESIGN.md`, and the topic
   specifications indexed in `docs/design/README.md`.
4. The active Linear issue's acceptance criteria.
5. Tests and current code behavior.

Use the highest-priority source when they disagree. A direct maintainer request
that clearly changes the design authorizes updating the relevant specification
with the implementation in the same PR. Proceed without asking again merely
because the previous design differs. Ask only when a consequential choice is
unresolved or an action exceeds the authorized scope; continue independent work.

Historical ADRs explain earlier choices. Their status and supersession chains do
not independently constrain implementation or override a current specification.
When current documents disagree, use the topic owner identified by the design
index and reconcile stale summaries in the same change. When a specification
omits a consequential rule, inspect the relevant implementation, tests, and
history, preserve existing authority and data-integrity boundaries, and record
the resolved rule. Routine implementation choices need no new design approval.

## Start With The Smallest Relevant Context

- Before editing, inspect the repository root, branch, worktree, status, and
  whether the branch already has a pull request.
- Read the relevant current specification from the table below before editing.
  Read the architecture overview for cross-package or authority changes; follow
  historical references only when their rationale or missing detail is needed.
- Planning and implementation progress live in Linear. Keep tracker identifiers
  and state out of code, comments, test titles, and design specifications.

| Change area                                                      | Current source                                                                                                                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Finding or changing a design rule                                | [Design index and maintenance](docs/design/README.md)                                                                                                                                 |
| Navigation, Projects, panes, content tabs, dock, workspace tools | [Workspace](docs/design/workspace.md)                                                                                                                                                 |
| Visual language, typography, Settings, controls, accessibility   | [Design system](DESIGN.md)                                                                                                                                                            |
| Process topology, Apple/device transport, host lifecycle         | [Architecture: process topology](docs/architecture.md#process-topology) and [device transport](docs/architecture.md#device-transport-and-evidence)                                    |
| Modes, Projects, checkout binding, thread authority              | [Architecture: modes](docs/architecture.md#modes-chat-work-and-code)                                                                                                                  |
| Journal, projections, replay, retention, export                  | [Architecture: persistence](docs/architecture.md#persistence)                                                                                                                         |
| Providers, harness, context, capacity                            | [Architecture: providers](docs/architecture.md#providers) and [context accounting](docs/architecture.md#context-and-usage-accounting)                                                 |
| Plugins, skills, activation, contribution boundaries             | [Architecture: extensions and skills](docs/architecture.md#extensions-and-skills), including [extraction boundaries](docs/architecture.md#plugin-boundaries-and-remaining-extraction) |
| Sandbox, approvals, remote access, credentials                   | [Architecture: security and authority](docs/architecture.md#security-and-authority)                                                                                                   |
| Packaging, updates, platform scope                               | [Current Release Boundary](#current-release-boundary) and [architecture](docs/architecture.md#current-release-boundary)                                                               |

Edit the owning specification in place when approved behavior changes. Ordinary
layout, defaults, and implementation choices do not require an ADR. Use a separate
rationale record only for a consequential tradeoff that benefits from preserving
its alternatives; keep the effective rule in the current specification.

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
- Editing existing code is a ratchet on reach: the surface you touch may keep the
  reach it has or lose some, never gain more. New calls into host internals from
  a feature identified as separable by the current plugin design are a boundary
  violation even when the surrounding code already makes them.
- When a change shows that a feature belongs behind a seam, judge it against that
  plugin design's candidate table and record the extraction as a follow-up. Extracting
  is its own deliverable with its own evidence, sequenced by the current plugin design; folding
  it into an unrelated fix or feature adds migration risk. Features the table
  keeps in the host are not candidates.
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
  OS-confined directory and starts approval-gated unless Full access was explicitly
  remembered; Plan mode is always read-only.
- Work never silently becomes Code. Coding work promotes to a linked Code
  thread only with explicit user approval.
- Every supported provider reports capabilities honestly in every mode and
  fails closed when unsupported. No core capability may require a specific
  vendor.
- Browser/computer use, tests, Apple validation, approvals, memory, and subagents
  are app-managed, provider-neutral capabilities. Core Apple development cannot
  depend on an optional extension.
- New providers, tools, and capabilities are built plugin-shaped: they reach the
  system through the published seams (`@octant/provider-sdk`,
  `@octant/plugin-api`, `@octant/plugin-host`) and take no shortcut a third-party
  plugin could not take. Shipping in-tree is allowed; wiring a provider or tool
  directly into server internals, or widening a seam for one vendor, is not. A
  capability that cannot be expressed through a seam is a reason to extend the
  seam in its own change, not to bypass it.
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
  calls, credential exposure, or cloud dependencies only when the request authorizes them and the current
  specification documents the boundary.
- Dependencies point inward: apps may consume packages; contracts and domain do
  not import apps. Provider-specific payloads stop at adapters.
- Authority checks occur on the server before side effects, never only in React.
  The event journal is authoritative; projections are rebuildable and idempotent.
- Keep contracts schema-only and domain logic pure. Use Effect when lifecycle,
  concurrency, resource safety, typed failure, or service composition materially
  benefits from it; keep simple synchronous or pure behavior direct.

## Code Style And Semantics

`oxfmt` owns formatting and `oxlint` owns lint; never hand-format or reformat
code a change does not otherwise touch. The rules below are semantics the
formatter cannot express.

- TypeScript runs with `strict`, `exactOptionalPropertyTypes`, and
  `noUncheckedIndexedAccess`. Satisfy them by modelling the value honestly, not
  by casting. `as` narrows a value the compiler cannot see into; it never
  invents one. `any` and non-null `!` do not appear in shipped code.
- Data crossing a boundary is `readonly`, and collections are `ReadonlyArray<T>`.
  Mutation stays inside the function that owns the value.
- Class state is `#private`. A field is exposed only when a caller needs it.
- Identifiers are branded (`CodeThreadId`, `WindowId`). Compare them with
  `String(a) === String(b)` rather than unbranding them into a shared type.
- Expected failure is a value, not an exception: return a discriminated union
  (`status`, `kind`) so every caller must handle the refused, failed, and
  truncated cases. Throw only for a broken invariant a caller cannot act on.
- Name things for what they mean to the product, not for their mechanism.
  `refuses`, `revoked`, `truncated`, and `approval-gated` are the vocabulary;
  `handler`, `manager`, `helper`, and `util` are not.
- Comments explain why a rule exists or what a reader would otherwise get wrong,
  and cite the observed behavior that motivated them. Do not restate the code,
  and do not leave commented-out code behind.
- Test titles are sentences about behavior a user or caller could observe
  ("refuses to fork a thread that lives on its own worktree"), never about the
  function under test or a tracker item.

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
| `packages/plugin-host`    | Manifests, normalized components, trust types, and pure effective-activation policy      |
| `packages/plugin-api`     | Public plugin manifest, component, and contribution schemas for third parties            |
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
  and keep the bottom or standalone pull request targeted at `main`. A dependent
  child in a native GitHub stack may target the immediately preceding feature
  branch. Never commit directly to `main` unless the maintainer explicitly asks.
- One pull request delivers one coherent outcome. Link the Linear issue in the PR
  description, not in code or docs.
- Before creating a branch or pull request, inspect open pull requests and branch
  ancestry for the same task or user-visible outcome. If an existing pull request
  already owns that outcome, continue on its branch and pull request; do not open
  a sibling pull request for follow-up work that belongs there.
- If an open pull request already owns this outcome, push to that branch. Review
  fixes, docs, and follow-ups stay there.
- Open a new pull request only for a different user-visible outcome, or when the
  next change cannot land without the unmerged parent (a real stack).
- Do not open a sibling `fix/*` or `feature/*` off `main` for work that belongs
  on an in-flight pull request.
- A report, assessment, audit, or Agent Store / Context document is not a reason
  to open a GitHub pull request. Those stay in the store or chat.
- Choose the smallest delivery shape that preserves reviewability:
  - Keep one outcome on one pull request when its jobs are not independently
    reviewable.
  - Use a native stacked PR chain for independently reviewable slices that depend
    on one another: the bottom PR targets `main`, each child targets its parent,
    and every PR records the stack order and links its adjacent PRs.
  - Use separate PRs targeting `main` for independent outcomes so the merge queue
    can group them without creating artificial dependencies.
- Treat a stack as one delivery unit: keep its branches linear, enqueue or merge
  it from the lowest eligible PR, and let GitHub perform the cascading rebase after
  each landed layer. If `main` moves before the stack lands, rebase the stack
  (`Rebase stack`, or `gh stack rebase` then `gh stack push`); do not merge `main`
  into a stack layer. Do not manually create sibling PRs or repeatedly rebase every
  child when the stack relationship already expresses the dependency. This
  explicit stack operation is the exception to the ordinary no-rewrite rule;
  never rebase unrelated or shared work.
- Update the owning current specification and affected user documentation in the
  same PR as a change to design, architecture, setup, workflow, security,
  deployment, or user-visible behavior. Reconcile conflicting summaries; link to
  the owner rather than duplicating its rules. Preserve historical ADRs as
  rationale without creating a superseding record for routine changes.
- Ready for review requires: acceptance criteria mapped to evidence, relevant
  checks run, current documentation, a pushed named branch, a non-draft standalone
  or bottom PR to `main` (or a child PR with its parent stack link), and no
  unexplained changes.
- A ready PR is not necessarily merge-ready. Required CI and any PR-owned
  pre-merge QA must pass on the exact head. Never merge without the maintainer's
  explicit instruction for that specific PR.
- State every skipped or unavailable check and residual risk precisely. Never
  infer success from intent or partial output.

## Current Release Boundary

The first release is the Apple Silicon technical preview with the
provider-neutral plugin/skill marketplace. It is
signed with a Developer ID, notarized, and updates itself — those three are one
deliverable, because an updater on an unsigned app is an unauthenticated
code-delivery channel and macOS refuses the replacement anyway. Cross-platform
desktop (macOS, Linux, Windows) remains authorized: Linux desktop shell next, Windows Work/Code only after an
explicitly approved Windows confinement design is documented. Do not add native mobile store distribution, hosted
relay, schedules, connector/OAuth marketplace, full LSP/extension host, or
product features that mutate pull requests unless an explicit request authorizes that scope and the current
specification documents its authority and release boundaries. Existing scoped
exceptions remain documented in the architecture; this workflow change opens no
new release scope.
