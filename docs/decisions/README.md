# Architecture decision records

Short records of the durable architectural decisions behind Octant. Each ADR
states context, the decision as concrete rules, and consequences. They are the
distilled successor of the earlier long-form design specifications.

## Index

| ADR                                                     | Title                                                             | Status   |
| ------------------------------------------------------- | ----------------------------------------------------------------- | -------- |
| [0001](0001-plugin-architecture.md)                     | Plugin architecture                                               | Proposed |
| [0002](0002-durable-event-journal.md)                   | Durable event journal and rebuildable projections                 | Accepted |
| [0003](0003-product-modes-and-authority.md)             | Product modes: Chat, Work, and Code authority                     | Accepted |
| [0004](0004-monorepo-layering.md)                       | Monorepo layering and dependency direction                        | Accepted |
| [0005](0005-provider-sdk-contract.md)                   | Provider SDK contract, registry, and honest capabilities          | Accepted |
| [0006](0006-acp-agent-drivers.md)                       | ACP agent drivers as one generic stack with per-provider profiles | Accepted |
| [0007](0007-direct-api-providers-and-native-harness.md) | Direct API providers and the native agent harness                 | Accepted |
| [0008](0008-context-budget-and-capacity.md)             | Context budget, provider limits, and capacity scheduling          | Accepted |
| [0009](0009-sandbox-confinement-and-approvals.md)       | Sandbox confinement, approvals, and Plan mode                     | Accepted |
| [0010](0010-secure-preview-and-canvas.md)               | Secure file preview and canvas artifacts                          | Accepted |
| [0011](0011-extensions-activation-ladder.md)            | Extensions and skills: the activation ladder                      | Accepted |
| [0012](0012-mixed-provider-subagents.md)                | Mixed-provider subagents and agent runs                           | Accepted |
| [0013](0013-remote-access-and-mobile.md)                | Remote access: single host, paired devices, and mobile            | Accepted |
| [0014](0014-apple-development-capability.md)            | Apple development and validation as an app-managed capability     | Accepted |
| [0015](0015-workspace-shell-model.md)                   | Workspace shell model                                             | Accepted |
| [0016](0016-component-foundation-and-theme.md)          | Component foundation and theme                                    | Accepted |
| [0017](0017-code-projects-bind-any-folder.md)           | Code Projects bind any folder                                     | Accepted |
| [0018](0018-auto-accept-edits-posture.md)               | Auto-accept edits as a fourth access posture                      | Accepted |
| [0019](0019-user-profile-and-first-run-setup.md)        | User profile and first-run setup                                  | Accepted |
| [0020](0020-checkpoints-and-restore-by-forking.md)      | Checkpoints and restore by forking                                | Accepted |
| [0021](0021-remote-thread-surfaces.md)                  | Remote thread surfaces: watching the running product              | Accepted |
| [0022](0022-pointed-at-product-feedback.md)             | Pointing at the running product                                   | Accepted |
| [0023](0023-bringing-a-run-home.md)                     | Bringing a run home                                               | Accepted |
| [0024](0024-curated-project-scaffolds.md)               | Curated project scaffolds                                         | Accepted |
| [0025](0025-long-running-goal-loops.md)                 | Long-running goal loops                                           | Proposed |
| [0026](0026-shipping-to-a-user-owned-target.md)         | Shipping to a user-owned target                                   | Proposed |

## Adding an ADR

- Take the next number (`00NN-short-slug.md`); never renumber existing records.
- Use the sections `# 00NN. Title`, `**Status:**`, `## Context`, `## Decision`,
  `## Consequences`, and optionally `## Related`; keep it under about 90 lines.
- Status is one of `Proposed` (agreed direction, not yet implemented),
  `Accepted` (implemented and enforced), `Superseded by 00NN`, or `Deprecated`.
- To change an `Accepted` decision, write a new ADR and add
  `**Status:** Superseded by 00NN` to the old one; do not edit history in place.
  A superseding number always points at a later record.
- A `Proposed` record is still being agreed, so it is revised in place. There is
  no history to preserve until it is accepted, and superseding a proposal with a
  second proposal would leave two records describing one undecided direction.
- Add the record to the index above in the same change. `bun run decisions:check`
  gates numbering, status, required sections, and index agreement, and checks
  against the merge base that an `Accepted` number still holds the record it
  held. That last check needs history: it skips with a stated reason on a
  shallow or base-less clone rather than failing one. Set
  `OCTANT_DECISIONS_BASE` to compare against a different ref.
