# Current design

Read the current rule for the area you are changing. Update that rule with an
approved change; use history when the reasoning matters. This index identifies
the owner so implementation does not require reconstructing ADR supersessions.
The precedence and authorization rules live in [AGENTS.md](../../AGENTS.md#mission-and-precedence).

## Sources of truth

| Area                   | Owner                                                           | Read when                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| System architecture    | [Architecture](../architecture.md)                              | Changing processes, authority, modes, persistence, providers, plugins, or release boundaries; follow the relevant section                 |
| Workspace behavior     | [Workspace](workspace.md)                                       | Changing navigation, Projects, panes, content tabs, tool presentation, or workspace lifecycle                                             |
| Canvas                 | [Canvas](canvas.md)                                             | Changing the Canvas tool, recipes, preview, block catalogue, boards, comments, the `design` block, or the artifact library and its tags   |
| Canvas public links    | [Canvas public links](canvas-public-links.md)                   | Changing public share links, their approval card, payload, terms, host records, or the share service                                      |
| Artifact replica sync  | [Artifact replica sync](artifact-replica-sync.md)               | Changing replica entries, stores, membership, publish, pull, restore, the synced library, or store selection                              |
| Provider runtimes      | [Provider runtimes](provider-runtimes.md)                       | Changing OpenCode's version-specific routes, an ACP agent profile or registry coverage, the local-server adapter, or a sign-in dialect    |
| Device workbench       | [Device workbench](device-workbench.md)                         | Changing Simulator or emulator panes, capture, input delivery, keyboard layouts, or managed device tools                                  |
| Apple devices          | [Apple physical devices and distribution](apple-devices.md)     | Changing physical-device destinations, device leases, development signing, or a person's App Store Connect upload, submission, or release |
| Disposable desktops    | [Disposable desktops](disposable-desktops.md)                   | Changing thread-leased Linux desktops, their providers, lease teardown, artifact transfer, or the Desktop pane                            |
| Browser captures       | [Browser captures](browser-captures.md)                         | Changing which Browser screenshots a thread keeps, their retention, the capture routes, or the Browser captures strip                     |
| Tainted search queries | [Search queries on a tainted thread](search-query-taint.md)     | Changing which `web-search` queries the native harness refuses on a tainted thread                                                        |
| Browser profiles       | [Browser profiles and extensions](browser-profiles.md)          | Changing where Browser pages keep sign-ins, profile approvals, or browser extension install and enablement                                |
| Terminal Browser grant | [Terminal Browser grant](terminal-browser-grant.md)             | Changing how a CLI typed into a Code thread terminal reaches that thread's Browser, or the grant's lifecycle and refusals                 |
| Mobile maturity        | [Mobile maturity](mobile-maturity.md)                           | Changing Android builds, phone push notifications, phone capture or voice input, or public mobile store distribution                      |
| Octant Nightly         | [Octant Nightly](nightly-app.md)                                | Changing the Nightly app's identity, which builds ship as it, or what it shares with Octant                                               |
| Visual design          | [Design system](../../DESIGN.md)                                | Changing typography, colour, materials, Settings composition, controls, or accessibility                                                  |
| Start screen           | [Start screen](start-screen.md)                                 | Changing start-screen tiles, tabs, cards, or Code's agent home; the rule set is in Workspace                                              |
| Canvas visuals         | [Canvas visuals](canvas-visuals.md)                             | Changing Canvas charts, tables, metric blocks, mockups, designs, or the design frame kit                                                  |
| Provider settings      | [Providers and model endpoints](model-endpoints.md)             | Changing Provider catalog or the Octant Harness model endpoint rows, detail pages, or Add endpoint                                        |
| Enterprise identity    | [Enterprise provider identity](enterprise-provider-identity.md) | Changing directory sign-in or cloud-IAM signing for a model endpoint, its broker operations, binding, or threat controls                  |
| Outside drivers        | [Outside provider drivers](outside-provider-drivers.md)         | Changing how a provider-driver package from outside Octant is identified, admitted, confined, credentialed, verified, or updated          |
| Language services      | [Language services](language-services.md)                       | Changing Code editor diagnostics or definitions, language-server or debug-adapter processes, their confinement, or their activation       |
| Hosted relay           | [Hosted relay](hosted-relay.md)                                 | Changing how a paired app reaches its host through a relay, relay grants and routes, the relay service, or what the relay can learn       |
| Hub and spokes         | [Hub and spokes](hub-and-spokes.md)                             | Changing how hosts enroll with a hub, hub or peer grants, spoke-to-spoke delegation, or the hub's wake and push services                  |
| Host names             | [Host reads and commands](host-reads-and-commands.md)           | Looking up or renaming a route, server command, or wire value a workspace surface uses                                                    |
| Release holds          | [Release-boundary holds](../release-boundary-holds.md)          | Checking which post-preview tracks were unlocked on 2026-10-26, their design-first rule, or the former connector and LSP start gates      |
| Historical rationale   | [Decision archive](../decisions/README.md)                      | Investigating why a choice was made, a rejected alternative, or detail not yet consolidated                                               |

Architecture owns system and authority boundaries; each architecture topic
specification above owns the implementation detail of one area and links back to
the architecture section that states its boundary. Workspace owns navigation and
interaction behavior. DESIGN.md owns presentation and shared component rules.
A summary elsewhere links to that owner; it does not establish a competing rule.
The start-screen, Canvas-visuals, and provider-settings topics hold the detail
of one area so their owner can state its rules briefly. Host reads and commands
is a lookup of route, command, and wire names, not a behavior owner.
User guides describe available behavior, while Linear tracks delivery progress.

## Changing the design

1. Read the relevant owner and the touched implementation. Identify the requested
   outcome, existing constraints, and observable acceptance criteria.
2. Apply the maintainer's request. A clear request to change the design authorizes
   its corresponding specification update; an old ADR is not a reason to ask
   again. Resolve routine implementation choices within the approved scope.
3. Edit the owning specification in place in the same PR as the implementation.
   State the effective rule and the reason for a consequential tradeoff. Update
   conflicting summaries or replace them with links to the owner.
4. Verify the changed behavior with focused tests, boundary checks, or rendered
   inspection as appropriate. Cite the evidence and any remaining gaps in the PR.

Ask about a consequential ambiguity or an action outside the authorized scope.
A documentation change cannot itself authorize new credential access, weaken
confinement, expand release scope, or grant merge or deployment permission.
Preserve those boundaries unless the maintainer explicitly authorizes a change.

Examples:

- Changing the default interface face updates DESIGN.md, preference behavior, and
  relevant tests together. It does not require a numbered typography ADR.
- Changing where files open updates Workspace and the opening/navigation tests.
  A historical content-strip decision does not block the new request.
- Changing a credential boundary requires explicit scope, an updated architecture
  rule, and permission-negative verification. Its reasons and rejected
  alternatives go in a short rationale beside that rule, not in a new record.

## Writing a topic specification

Create a topic file only when an existing owner is too broad to explain the
behavior clearly. Organize it by the questions a contributor needs answered:

- **Current behavior or approved design:** what the user or caller can rely on.
- **Constraints:** authority, persistence, lifecycle, and accessibility boundaries.
- **Rationale:** reasons and tradeoffs that are not obvious from the rule.
- **Verification:** relevant behavior tests, source entry points, and manual checks.

Approved design and implementation coverage are separate facts. Label an
approved but unfinished design explicitly, state what is missing, and track its
execution in Linear. Do not infer approval or implementation from an archived
`Proposed` or `Accepted` label. New unapproved ideas stay in planning until the
maintainer chooses them; they do not become constraints on unrelated work.

Git and the PR preserve routine change history. The decision archive is closed:
do not add records to `docs/decisions/`. When a durable tradeoff needs its
alternatives or measurements preserved (journal authority, plugin trust, a
measured confinement grant, update signing), write a short **Rationale** paragraph
beside the rule in its owning specification. `bun run decisions:check` refuses a
record numbered after the last archived one.

## Historical detail and consolidation

Workspace behavior, visual design, and the architecture topics above are the
consolidated topics. Other areas use the relevant architecture section, with
existing historical links available for detailed rationale. The archive remains at its existing paths to
preserve code comments and external links; it is not a second design authority.

When a task exposes a rule missing from a current specification, inspect the
relevant code, tests, and historical record. Preserve authority and data-integrity
constraints, resolve the rule under the current request, and add it to the owner
in that same change. Escalate only a consequential choice the evidence and request
do not settle. Consolidate the touched topic, not the entire archive.

## Verification and completion

A design change is ready for review when the current specification states the
resulting behavior, the implementation and useful verification agree, conflicting
summaries are reconciled, and the PR records any missing evidence. Documentation
hygiene checks establish valid references and preserved history; they do not prove
that code follows the design. No new test is required for prose alone.

Use the [verification and stopping policy](../../AGENTS.md#testing-and-verification)
to bound checks and the [issue closeout policy](../../AGENTS.md#issue-closeout) to
finish delivery. Once the applicable evidence is sufficient, the next action is
delivery or closeout rather than additional tests without a named gap.
