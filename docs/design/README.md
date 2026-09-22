# Current design

Read the current rule for the area you are changing. Update that rule with an
approved change; use history when the reasoning matters. This index identifies
the owner so implementation does not require reconstructing ADR supersessions.
The precedence and authorization rules live in [AGENTS.md](../../AGENTS.md#mission-and-precedence).

## Sources of truth

| Area                 | Owner                                                  | Read when                                                                                                                 |
| -------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| System architecture  | [Architecture](../architecture.md)                     | Changing processes, authority, modes, persistence, providers, plugins, or release boundaries; follow the relevant section |
| Workspace behavior   | [Workspace](workspace.md)                              | Changing navigation, Projects, panes, content tabs, tool presentation, or workspace lifecycle                             |
| Visual design        | [Design system](../../DESIGN.md)                       | Changing typography, colour, materials, Settings composition, controls, or accessibility                                  |
| Release holds        | [Release-boundary holds](../release-boundary-holds.md) | Considering connector marketplace or full language-tooling scope                                                          |
| Historical rationale | [Decision archive](../decisions/README.md)             | Investigating why a choice was made, a rejected alternative, or detail not yet consolidated                               |

Architecture owns system and authority boundaries. Workspace owns navigation and
interaction behavior. DESIGN.md owns presentation and shared component rules.
A summary elsewhere links to that owner; it does not establish a competing rule.
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
  relevant tests together. It does not require another numbered typography ADR.
- Changing where files open updates Workspace and the opening/navigation tests.
  A historical content-strip decision does not block the new request.
- Changing a credential boundary requires explicit scope, an updated architecture
  rule, and permission-negative verification. A separate rationale record may
  help explain alternatives, but its status is not an extra approval ceremony.

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

Git and the PR preserve routine change history. Use a short rationale record in
`docs/decisions/` only when a durable architectural tradeoff needs its own account
of alternatives, such as journal authority, plugin trust, or update signing.
Always keep the effective rule in its current specification.

## Historical detail and consolidation

Workspace behavior and visual design are the first consolidated topics. Other
areas use the relevant architecture section, with existing historical links
available for detailed rationale. The archive remains at its existing paths to
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
