# Octant Agent Contract

`AGENTS.md` is the canonical repository instruction entry point. Tool-specific
files (`CLAUDE.md` and similar) import or point here instead of duplicating it.

## Mission And Precedence

This file governs how Octant is developed. Build the smallest reliable product
that satisfies the approved design.

Product behavior is defined by the specifications, not by this file:
[architecture](docs/architecture.md) (including its
[principles](docs/architecture.md#overview-and-principles) and
[Current Release Boundary](docs/architecture.md#current-release-boundary)),
[DESIGN.md](DESIGN.md), and the topic specifications indexed in
[docs/design/README.md](docs/design/README.md). Implementations follow them.
Changing a product rule means editing the owning specification, which the
precedence list below already allows on a direct maintainer request.

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

| Change area                                                      | Current source                                                                                                                                                                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Finding or changing a design rule                                | [Design index and maintenance](docs/design/README.md)                                                                                                                                                               |
| Navigation, Projects, panes, content tabs, dock, workspace tools | [Workspace](docs/design/workspace.md)                                                                                                                                                                               |
| Visual language, typography, Settings, controls, accessibility   | [Design system](DESIGN.md)                                                                                                                                                                                          |
| Start-screen tiles, tabs, and cards                              | [Workspace rules](docs/design/workspace.md#start-screen-cards) and [Start screen](docs/design/start-screen.md)                                                                                                      |
| Canvas charts, tables, mockups, and designs                      | [Canvas visuals](docs/design/canvas-visuals.md)                                                                                                                                                                     |
| Provider catalog and model endpoint Settings                     | [Providers and model endpoints](docs/design/model-endpoints.md)                                                                                                                                                     |
| Process topology, Apple/device transport, host lifecycle         | [Architecture: process topology](docs/architecture.md#process-topology) and [device transport](docs/architecture.md#device-transport-and-evidence); detail in [Device workbench](docs/design/device-workbench.md)   |
| Canvas tool, blocks, preview, designs                            | [Canvas](docs/design/canvas.md) and [Architecture: Canvas documents, designs, and prototypes](docs/architecture.md#canvas-documents-designs-and-prototypes)                                                         |
| Modes, Projects, checkout binding, thread authority              | [Architecture: modes](docs/architecture.md#modes-chat-work-and-code)                                                                                                                                                |
| Journal, projections, replay, retention, export, artifact sync   | [Architecture: persistence](docs/architecture.md#persistence); replica detail in [Artifact replica sync](docs/design/artifact-replica-sync.md)                                                                      |
| Providers, harness, context, capacity                            | [Architecture: providers](docs/architecture.md#providers) and [context accounting](docs/architecture.md#context-and-usage-accounting); runtime wire detail in [Provider runtimes](docs/design/provider-runtimes.md) |
| Plugins, skills, activation, contribution boundaries             | [Architecture: extensions and skills](docs/architecture.md#extensions-and-skills), including [extraction boundaries](docs/architecture.md#plugin-boundaries-and-remaining-extraction)                               |
| Sandbox, approvals, remote access, credentials                   | [Architecture: security and authority](docs/architecture.md#security-and-authority)                                                                                                                                 |
| Packaging, updates, platform scope, release boundary             | [Architecture: Current Release Boundary](docs/architecture.md#current-release-boundary)                                                                                                                             |

Edit the owning specification in place when approved behavior changes. Do not add
ADRs: the decision archive is closed. When a consequential tradeoff needs its
reasons, rejected alternatives, or measurements preserved, write them as a short
rationale beside the rule in the owning specification.

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

## Building Within The Product Rules

The product rules live in the specifications named above; the rules below are how
to build without breaking them. For any rule they point to, the specification
wins.

- Modes, Project binding, thread authority, and Done are server-enforced
  ([principles](docs/architecture.md#overview-and-principles),
  [modes](docs/architecture.md#modes-chat-work-and-code)). Do not move a mode or
  authority decision into the renderer, and do not widen a thread's authority or
  convert its kind.
- Report provider capabilities honestly and fail closed when a provider does not
  support one ([principles](docs/architecture.md#overview-and-principles)).
- Build new providers, tools, and capabilities plugin-shaped: through
  `@octant/provider-sdk`, `@octant/plugin-api`, and `@octant/plugin-host`, taking
  no shortcut a third-party plugin could not take. Do not wire a provider or tool
  into server internals or widen a seam for one vendor; extend the seam in its own
  change instead.
- Installation, trust, and enablement stay separate steps, and discovery
  never grants authority
  ([extensions and skills](docs/architecture.md#extensions-and-skills)).
- Add telemetry, external calls, credential exposure, or cloud dependencies only
  when the request authorizes them and the current specification documents the
  boundary ([principles](docs/architecture.md#overview-and-principles)).
- Stay inside the [Current Release Boundary](docs/architecture.md#current-release-boundary):
  do not build, and do not widen, what it defers or places out of scope.

## Originality And Architecture

- First-party packages, environment variables, identifiers, storage, URLs, copy,
  and assets use `@octant/*`, `OCTANT_*`, and Octant naming.
- Never import another product's source, assets, schemas, copy, identifiers, or
  distinctive implementation structure. Third-party code enters only as an
  approved dependency with a compatible license and explicit architectural fit.
- Dependencies point inward: apps may consume packages; contracts and domain
  do not import apps. Provider-specific payloads stop at adapters.
- Authority checks occur on the server before side effects, never only in React.
  The event journal is authoritative; projections are rebuildable and idempotent.
- Keep contracts schema-only and domain logic pure. Use Effect when lifecycle,
  concurrency, resource safety, typed failure, or service composition materially
  benefits from it; keep simple synchronous or pure behavior direct.

## Code Style And Semantics

`oxfmt` owns formatting and `oxlint` owns lint; never hand-format or reformat
code a change does not otherwise touch. The rules below are semantics the
formatter cannot express.

`bun run style:check` refuses new `any`, non-null `!`, `as unknown as`, and
tracker ids in shipped code against `scripts/code-style-baseline.json`.

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
- For a bug fix, first use the closest existing test that reproduces the defect.
  Add or extend it only if useful behavior or a realistic failure is uncovered.
  Refactors may rely on existing behavior coverage without manufacturing a
  failing assertion.
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

Before editing, identify acceptance criteria, the delivery requirement, and the
smallest applicable checks in the issue or PR. The table scopes verification to
affected behavior; it is not a requirement to add a new test at every layer.
Existing coverage counts. Broaden only for a named gap or affected risk:

| Changed surface                                                          | Minimum additional verification                                                                                |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Documentation only                                                       | Formatter, link/path and consistency checks                                                                    |
| Configuration                                                            | Relevant configuration validation and affected runtime/build checks                                            |
| Contracts                                                                | Focused contract tests and typecheck every consuming package                                                   |
| Domain policy                                                            | Focused red/green policy tests and affected consumers                                                          |
| Server, API, or persistence                                              | Route registration, auth/permission negatives, response/event shape, migrations/replay, and client integration |
| Provider                                                                 | Provider-sdk conformance plus real-provider smoke when credentials or runtime exist                            |
| Web UI                                                                   | Closest component/integration test for changed behavior plus rendered QA at relevant viewport/state boundaries |
| Desktop/native lifecycle, sandbox, Keychain, terminal, IPC               | Desktop tests plus native-process or packaged-app smoke                                                        |
| Broad integration, shared infrastructure, or uncertain dependency impact | `bun run verify` locally unless a precise blocker is recorded                                                  |

For bounded changes, run the applicable local checks and let required hosted CI
perform the full integration suite. Crossing a package boundary alone does not
require a full local run: validate the changed contract and affected consumers.
Local and hosted evidence are complementary; CI does not replace a required
native, rendered, provider, or packaged scenario that it does not exercise.

Once those checks pass, proceed to delivery or closeout. Add or rerun checks only
for changed relevant inputs, a failure, an uncovered criterion, or a concrete
in-scope risk; name that gap first. Reuse evidence with its commit/build,
environment, scenario, result, and limitations when still applicable. Label
cached results and distinguish them from fresh execution. Live native/provider
acceptance needs execution in the relevant environment; a known failure cannot
be replaced by an older or cached pass. Required CI stays tied to the exact head.

Agents perform the applicable tool-accessible checks. Reserve human acceptance
for an explicit issue criterion or capability that actually requires personal
credentials, physical-device access, release authority, or subjective judgment.
An unavailable required check remains a named blocker; extra unit tests do not
satisfy it. Ordinary issues do not acquire a blanket human-signoff gate.

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
  the owner rather than duplicating its rules. Leave historical ADRs unchanged;
  a specification change never needs a new or superseding record.
- Ready for review requires: acceptance criteria mapped to evidence, relevant
  checks run, current documentation, a pushed named branch, a non-draft standalone
  or bottom PR to `main` (or a child PR with its parent stack link), and no
  unexplained changes.
- A ready PR is not necessarily merge-ready. Required CI and any PR-owned
  pre-merge QA must pass on the exact head. Never merge without the maintainer's
  explicit instruction for that specific PR.
- State every skipped or unavailable check and residual risk precisely. Never
  infer success from intent or partial output.

## Issue Closeout

These rules govern Linear issues, not the product's Work/Code thread lifecycle.
Implementing a tracked issue includes keeping its evidence and status current.
An instruction to validate or finish an issue includes closing it when the
conditions below are met; it does not authorize merging or releasing.

- Use the issue's stated outcome, acceptance criteria, and delivery requirement.
  For an implementation issue without a narrower explicit target, Done requires
  the change landed on `main`, required checks passed, acceptance evidence is
  sufficient, and no known in-scope defect remains. An explicit investigation,
  local-only, or PR-delivery target uses that target rather than inventing a merge
  requirement. A ready implementation PR normally remains In Review.
- Deployment, packaged/native validation, real-provider checks, device testing,
  and subjective acceptance are additional gates only when the stated outcome
  or affected boundary requires them. Preserve explicit gates; do not silently
  remove an unmet criterion to close an issue.
- Map each criterion to existing evidence before doing more work. Reuse child
  evidence in parent acceptance; execute only uncovered scenarios or those whose
  relevant inputs changed. Integration acceptance remains distinct from child
  completion. A required merged-build check still needs that build.
- A new finding blocks this issue only when it violates its criteria, is a
  regression caused by the change, or prevents relevant verification. Record
  independent defects as separate follow-ups; do not expand the finish line.
- When the conditions are met, update the acceptance summary and transition the
  issue to Done in the same pass. Read back the status. Otherwise record the exact
  remaining action, its owner, and missing prerequisite or evidence; use In Review
  for review/merge, and identify validation or access blockers explicitly rather
  than treating them as more implementation work.
- Lead the issue description with its current outcome/delivery requirement,
  criterion-to-evidence summary, remaining blockers, and closure decision. An
  issue description holds exactly one dated status block: on every update,
  replace it in place; never add a newer block above an older one. When the
  replaced block carries evidence the new block does not restate, extract
  only that evidence (the dated fact, the build, the result) into a comment
  or into one clearly labeled history section at the end; the history section
  holds evidence lines, not status blocks, so it does not count against the
  one-block rule. Historical statements such as "still In Progress" do not
  reopen a completed issue. (Stacked status blocks grew one issue past 57,000
  characters in October 2026 and hid the current state.)
- An action only the maintainer can perform (a credential, a billed provider
  turn, a second machine, a signing key, a subjective sign-off) is recorded
  once, in full, as an item on the standing maintainer-actions issue, titled
  "Maintainer live smokes". Each item names the issue, the exact action, and
  what it unblocks. The issue's status block still names the blocker in one
  line (owner "maintainer", the prerequisite, and a link to the list) so the
  closeout rule above is met, but the steps live on the list alone, so a
  maintainer sitting can run the whole list in one pass and hygiene passes do
  not repeat it per issue.
- An issue whose code is complete and whose only remaining items are
  maintainer live checks is closed as Done. Those checks stay as items on the
  maintainer-actions issue, which reports their results back to the issue they
  confirm.
- Reopen a closed issue only for a reproduced regression or evidence its closure
  was incorrect. Preserve the closure evidence and explain the reason.
