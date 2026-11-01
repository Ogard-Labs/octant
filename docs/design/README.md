# Current design

[Decisions and requirements](decisions.md) is the one list of every current
product and architecture decision: the rule, its requirements, whether it is
built, and the specification section that owns its detail. Start there, then
read the owner below for the area you are changing. The precedence and
authorization rules for contributors live in
[AGENTS.md](../../AGENTS.md#mission-and-precedence); product rules live in the
specifications below.

## Sources of truth

| Area                       | Owner                                                                                                       | Read when                                                                                                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Decisions and requirements | [Decisions and requirements](decisions.md)                                                                  | Finding any current decision, its requirements, its build status, or which specification owns it                                                                                   |
| System architecture        | [Architecture](../architecture.md)                                                                          | Changing a product invariant (Overview and principles), processes, authority, modes, persistence, providers, plugins, or the Current Release Boundary; follow the relevant section |
| Workspace behavior         | [Workspace](workspace.md)                                                                                   | Changing navigation, Projects, panes, content tabs, tool presentation, or workspace lifecycle                                                                                      |
| Visual design              | [Design system](../../DESIGN.md)                                                                            | Changing typography, colour, materials, Settings composition, controls, or accessibility                                                                                           |
| Start screen               | [Start screen](start-screen.md)                                                                             | Changing start-screen tiles, tabs, cards, or Code's agent home; the rule set is in Workspace                                                                                       |
| Canvas                     | [Canvas](canvas.md)                                                                                         | Changing the Canvas tool, recipes, preview, block catalogue, boards, comments, the `design` block, or the artifact library and its tags                                            |
| Canvas visuals             | [Canvas visuals](canvas-visuals.md)                                                                         | Changing Canvas charts, tables, metric blocks, mockups, designs, or the design frame kit                                                                                           |
| Canvas public links        | [Canvas public links](canvas-public-links.md)                                                               | Changing public share links, their approval card, payload, terms, host records, or the share service                                                                               |
| Artifact replica sync      | [Artifact replica sync](artifact-replica-sync.md)                                                           | Changing replica entries, stores, membership, publish, pull, restore, the synced library, or store selection                                                                       |
| Provider settings          | [Providers and model endpoints](model-endpoints.md)                                                         | Changing Provider catalog or the Octant Harness model endpoint rows, detail pages, or Add endpoint                                                                                 |
| Provider runtimes          | [Provider runtimes](provider-runtimes.md)                                                                   | Changing a runtime's version-specific routes, an ACP agent profile or registry coverage, the local-server adapter, or a sign-in dialect                                            |
| Account distribution       | [Account distribution](account-distribution.md)                                                             | Changing how a new thread with no account picked chooses among a person's accounts of one provider, or that plan's terms gate                                                      |
| Enterprise identity        | [Enterprise provider identity](enterprise-provider-identity.md)                                             | Changing directory sign-in or cloud-IAM signing for a model endpoint, its broker operations, binding, or threat controls                                                           |
| Outside drivers            | [Outside provider drivers](outside-provider-drivers.md)                                                     | Changing how a provider-driver package from outside Octant is identified, admitted, confined, credentialed, verified, or updated                                                   |
| Device workbench           | [Device workbench](device-workbench.md)                                                                     | Changing Simulator or emulator panes, capture, input delivery, keyboard layouts, or managed device tools                                                                           |
| Disposable desktops        | [Disposable desktops](disposable-desktops.md)                                                               | Changing thread-leased Linux desktops, their providers, lease teardown, artifact transfer, or the Desktop pane                                                                     |
| Browser captures           | [Browser captures](browser-captures.md)                                                                     | Changing which Browser screenshots a thread keeps, their retention, the capture routes, or the Browser captures strip                                                              |
| Browser profiles           | [Browser profiles and extensions](browser-profiles.md)                                                      | Changing where Browser pages keep sign-ins, profile approvals, or browser extension install and enablement                                                                         |
| Server Projects            | [Server Projects](server-projects.md)                                                                       | Changing Code Projects bound to a folder on a registered server, their SSH connection, or what a thread there runs                                                                 |
| Terminal Browser grant     | [Terminal Browser grant](terminal-browser-grant.md)                                                         | Changing how a CLI typed into a Code thread terminal reaches that thread's Browser, or the grant's lifecycle and refusals                                                          |
| Tainted search queries     | [Search queries on a tainted thread](search-query-taint.md)                                                 | Changing which `web-search` queries the native harness refuses on a tainted thread                                                                                                 |
| Language services          | [Language services](language-services.md)                                                                   | Changing Code editor diagnostics or definitions, language-server or debug-adapter processes, their confinement, or their activation                                                |
| Mobile maturity            | [Mobile maturity](mobile-maturity.md)                                                                       | Changing Android builds, phone push notifications, phone capture or voice input, or public mobile store distribution                                                               |
| Hosted relay               | [Hosted relay](hosted-relay.md)                                                                             | Changing how a paired app reaches its host through a relay, relay grants and routes, the relay service, or what the relay can learn                                                |
| Hub and spokes             | [Hub and spokes](hub-and-spokes.md)                                                                         | Changing how hosts enroll with a hub, hub or peer grants, spoke-to-spoke delegation, or the hub's wake and push services                                                           |
| Octant Nightly             | [Octant Nightly](nightly-app.md)                                                                            | Changing the Nightly app's identity, which builds ship as it, or what it shares with Octant                                                                                        |
| Host names                 | [Host reads and commands](host-reads-and-commands.md)                                                       | Looking up or renaming a route, server command, or wire value a workspace surface uses                                                                                             |
| Threat models              | [Security threat models](../security/security-architecture-threat-model.md)                                 | Checking the threats, controls, and residual risks behind a security rule; the rule itself stays in its owning specification                                                       |
| Mobile release runbooks    | [Internal TestFlight](../mobile-testflight.md) and [Android internal builds](../mobile-android-internal.md) | Running or changing an internal phone build; the rules are in Mobile maturity                                                                                                      |
| Direction                  | [Roadmap](../roadmap.md)                                                                                    | Checking which horizon an item sits in; it records direction, not rules                                                                                                            |
| Active plan                | [Canvas universal artifact](../canvas-universal-artifact.md)                                                | Working on a slice of that plan; each slice moves its rules into Canvas and Canvas visuals when it lands                                                                           |
| History                    | [Legacy documents](../legacy/README.md)                                                                     | Reading how an earlier choice was reached; nothing there has authority or is cited by current documents                                                                            |

Architecture owns system and authority boundaries; each architecture topic
specification above owns the implementation detail of one area and links back to
the architecture section that states its boundary. Workspace owns navigation and
interaction behavior. DESIGN.md owns presentation and shared component rules.
A summary elsewhere links to that owner; it does not establish a competing rule.
The start-screen, Canvas-visuals, and provider-settings topics hold the detail
of one area so their owner can state its rules briefly. Host reads and commands
is a lookup of route, command, and wire names, not a behavior owner. Decisions
and requirements lists each decision once and links to its owner; where the
owner states more detail, the owner's detail applies. User guides describe
available behavior, while Linear tracks delivery progress.

## Changing the design

1. Read the decision's entry in [Decisions and requirements](decisions.md), its
   owner, and the touched implementation. Identify the requested outcome,
   existing constraints, and observable acceptance criteria.
2. Apply the maintainer's request. A clear request to change the design authorizes
   its corresponding specification update. Resolve routine implementation choices
   within the approved scope.
3. Edit the owning specification in place in the same PR as the implementation.
   State the effective rule and the reason for a consequential tradeoff. Update
   conflicting summaries or replace them with links to the owner.
4. Update the decision's entry in Decisions and requirements in that same PR:
   add an entry for a new decision, change the rule or requirements for a changed
   one, move its status when a slice lands, and remove an entry the change
   retires.
5. Verify the changed behavior with focused tests, boundary checks, or rendered
   inspection as appropriate. Cite the evidence and any remaining gaps in the PR.

Ask about a consequential ambiguity or an action outside the authorized scope.
A documentation change cannot itself authorize new credential access, weaken
confinement, expand release scope, or grant merge or deployment permission.
Preserve those boundaries unless the maintainer explicitly authorizes a change.

Examples:

- Changing the default interface face updates DESIGN.md, its entry in
  Decisions and requirements, preference behavior, and relevant tests together.
- Changing where files open updates Workspace, its entry, and the
  opening/navigation tests.
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

Add a row for it to the table above and entries for its decisions to Decisions
and requirements.

Approved design and implementation coverage are separate facts. Label an
approved but unfinished design explicitly ("allowed; not built yet", "designed,
not built"), state what is missing, and track its execution in Linear. New
unapproved ideas stay in planning until the maintainer chooses them; they do not
become constraints on unrelated work.

Git and the PR preserve routine change history. Do not write decision records:
the former archive is in `docs/legacy/decisions/`, closed, and has no authority.
When a durable tradeoff needs its alternatives or measurements preserved
(journal authority, plugin trust, a measured confinement grant, update signing),
write a short **Rationale** paragraph beside the rule in its owning
specification. `bun run decisions:check` refuses a new record and a current
document that cites the archive.

## Missing rules

When a task exposes a rule missing from a current specification, inspect the
relevant code and tests. Preserve authority and data-integrity constraints,
resolve the rule under the current request, and add it to the owner and to
Decisions and requirements in that same change. Escalate only a consequential
choice the evidence and request do not settle.

## Verification and completion

A design change is ready for review when the current specification and its entry
in Decisions and requirements state the resulting behavior, the implementation
and useful verification agree, conflicting summaries are reconciled, and the PR
records any missing evidence. Documentation hygiene checks establish valid
references and preserved history; they do not prove that code follows the
design. No new test is required for prose alone.

Use the [verification and stopping policy](../../AGENTS.md#testing-and-verification)
to bound checks and the [issue closeout policy](../../AGENTS.md#issue-closeout) to
finish delivery. Once the applicable evidence is sufficient, the next action is
delivery or closeout rather than additional tests without a named gap.
