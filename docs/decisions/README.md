# Architecture decision records

Short records of the durable architectural decisions behind Octant. Each ADR
states context, the decision as concrete rules, and consequences. They are the
distilled successor of the earlier long-form design specifications.

## Index

| ADR                                                           | Title                                                                                       | Status             |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------ |
| [0001](0001-plugin-architecture.md)                           | Plugin architecture                                                                         | Proposed           |
| [0002](0002-durable-event-journal.md)                         | Durable event journal and rebuildable projections                                           | Accepted           |
| [0003](0003-product-modes-and-authority.md)                   | Product modes: Chat, Work, and Code authority                                               | Accepted           |
| [0004](0004-monorepo-layering.md)                             | Monorepo layering and dependency direction                                                  | Accepted           |
| [0005](0005-provider-sdk-contract.md)                         | Provider SDK contract, registry, and honest capabilities                                    | Accepted           |
| [0006](0006-acp-agent-drivers.md)                             | ACP agent drivers as one generic stack with per-provider profiles                           | Accepted           |
| [0007](0007-direct-api-providers-and-native-harness.md)       | Direct API providers and the native agent harness                                           | Accepted           |
| [0008](0008-context-budget-and-capacity.md)                   | Context budget, provider limits, and capacity scheduling                                    | Accepted           |
| [0009](0009-sandbox-confinement-and-approvals.md)             | Sandbox confinement, approvals, and Plan mode                                               | Accepted           |
| [0010](0010-secure-preview-and-canvas.md)                     | Secure file preview and canvas artifacts                                                    | Accepted           |
| [0011](0011-extensions-activation-ladder.md)                  | Extensions and skills: the activation ladder                                                | Accepted           |
| [0012](0012-mixed-provider-subagents.md)                      | Mixed-provider subagents and agent runs                                                     | Accepted           |
| [0013](0013-remote-access-and-mobile.md)                      | Remote access: single host, paired devices, and mobile                                      | Accepted           |
| [0014](0014-apple-development-capability.md)                  | Apple development and validation as an app-managed capability                               | Superseded by 0043 |
| [0015](0015-workspace-shell-model.md)                         | Workspace shell model                                                                       | Accepted           |
| [0016](0016-component-foundation-and-theme.md)                | Component foundation and theme                                                              | Accepted           |
| [0017](0017-code-projects-bind-any-folder.md)                 | Code Projects bind any folder                                                               | Accepted           |
| [0018](0018-auto-accept-edits-posture.md)                     | Auto-accept edits as a fourth access posture                                                | Accepted           |
| [0019](0019-user-profile-and-first-run-setup.md)              | User profile and first-run setup                                                            | Accepted           |
| [0020](0020-checkpoints-and-restore-by-forking.md)            | Checkpoints and restore by forking                                                          | Accepted           |
| [0021](0021-remote-thread-surfaces.md)                        | Remote thread surfaces: watching the running product                                        | Accepted           |
| [0022](0022-pointed-at-product-feedback.md)                   | Pointing at the running product                                                             | Accepted           |
| [0023](0023-bringing-a-run-home.md)                           | Bringing a run home                                                                         | Accepted           |
| [0024](0024-curated-project-scaffolds.md)                     | Curated project scaffolds                                                                   | Accepted           |
| [0025](0025-long-running-goal-loops.md)                       | Long-running goal loops                                                                     | Accepted           |
| [0026](0026-shipping-to-a-user-owned-target.md)               | Shipping to a user-owned target                                                             | Accepted           |
| [0027](0027-plans-as-journaled-artifacts.md)                  | Plans as journaled artifacts                                                                | Accepted           |
| [0028](0028-the-artifact-library.md)                          | The artifact library                                                                        | Accepted           |
| [0029](0029-artifact-storage-mirror.md)                       | The artifact storage mirror                                                                 | Accepted           |
| [0030](0030-routines-that-run-themselves.md)                  | Routines that run themselves                                                                | Accepted           |
| [0031](0031-hosts-as-environments.md)                         | Hosts as environments                                                                       | Accepted           |
| [0032](0032-a-refusal-a-person-can-clear.md)                  | A refusal a person can clear                                                                | Proposed           |
| [0033](0033-first-run-asks-what-to-call-you.md)               | First run asks what to call you                                                             | Accepted           |
| [0034](0034-signed-updates.md)                                | Signed, notarized, user-controlled updates                                                  | Proposed           |
| [0035](0035-thread-retention-and-purge.md)                    | Thread retention and explicit purge                                                         | Accepted           |
| [0036](0036-thread-export.md)                                 | Thread export                                                                               | Accepted           |
| [0037](0037-a-thread-starts-in-a-project.md)                  | A thread starts in a Project                                                                | Accepted           |
| [0038](0038-owned-design-system-stylesheet.md)                | The owned design system stylesheet                                                          | Superseded by 0046 |
| [0039](0039-journal-compaction-of-superseded-observations.md) | Journal compaction of superseded checkout observations                                      | Accepted           |
| [0040](0040-share-a-host-or-a-git-remote.md)                  | Collaboration: share a host or a git remote                                                 | Proposed           |
| [0041](0041-panes-hold-one-surface.md)                        | Panes hold one surface; the sidebar is the only switcher                                    | Proposed           |
| [0042](0042-environment-is-a-transient-disclosure.md)         | Environment is a transient disclosure                                                       | Superseded by 0045 |
| [0043](0043-simulator-follows-the-active-thread.md)           | Simulator follows the active thread in the right sidebar                                    | Accepted           |
| [0044](0044-the-dock-hosts-live-thread-owned-tools.md)        | The dock hosts live thread-owned tools                                                      | Proposed           |
| [0045](0045-environment-summarizes-the-active-thread.md)      | Environment summarizes the active thread                                                    | Accepted           |
| [0046](0046-shadcn-recipes-own-product-controls.md)           | shadcn recipes own product controls                                                         | Accepted           |
| [0047](0047-workspace-translucency-opt-in.md)                 | Workspace translucency opt-in                                                               | Accepted           |
| [0048](0048-linux-stations-and-execution-capsules.md)         | Linux Stations isolate Code work in execution capsules                                      | Proposed           |
| [0049](0049-thread-dialogue-lane.md)                          | Explicit Chat thread dialogue                                                               | Accepted           |
| [0050](0050-bounded-live-child-conversation.md)               | Bounded live child conversation is a server read                                            | Accepted           |
| [0051](0051-board-cards-summarize-plan-progress.md)           | Board cards summarize plan progress                                                         | Accepted           |
| [0052](0052-canvas-boards.md)                                 | Canvas boards are the diagram block                                                         | Proposed           |
| [0053](0053-computer-use-destinations.md)                     | Computer-use destinations                                                                   | Accepted           |
| [0054](0054-headless-host-credential-store.md)                | The credential broker is a host capability, not a desktop one                               | Accepted           |
| [0055](0055-image-generation-provider-profiles.md)            | Image generation provider profiles                                                          | Accepted           |
| [0056](0056-image-generation-jobs-and-adapters.md)            | Image generation jobs, adapters, and artifact scope                                         | Accepted           |
| [0057](0057-linux-confinement-bubblewrap.md)                  | Linux confinement uses Bubblewrap as a scoped exception to the Seatbelt-only implementation | Accepted           |
| [0058](0058-cross-platform-desktop.md)                        | One desktop app across macOS, Linux, and Windows                                            | Proposed           |
| [0059](0059-multi-host-federation.md)                         | Multi-host federation completes without new host authority                                  | Proposed           |
| [0060](0060-usage-spend-ceilings.md)                          | Usage spend ceilings                                                                        | Proposed           |
| [0061](0061-in-app-changelog.md)                              | In-app changelog rides the update path                                                      | Proposed           |
| [0062](0062-simulator-frame-input-transport.md)               | Simulator frame input rides the Apple workbench channel                                     | Accepted           |
| [0063](0063-agent-to-agent-messaging.md)                      | Agent-to-agent messaging authority                                                          | Proposed           |
| [0064](0064-project-planner-thread.md)                        | A Project-scoped planner thread surveys the board and proposes work                         | Accepted           |

## Adding an ADR

- Take the next number (`00NN-short-slug.md`); never renumber existing records.
- Use the sections `# 00NN. Title`, `**Status:**`, `## Context`, `## Decision`,
  `## Consequences`, and optionally `## Related`; keep it under about 90 lines.
- Status is one of `Proposed` (agreed direction, not yet implemented),
  `Accepted` (implemented and enforced), `Superseded by 00NN`, or `Deprecated`.
- To change an `Accepted` decision, write a new ADR and add
  `**Status:** Superseded by 00NN` to the old one; do not edit history in place.
  A superseding number always points at a later record.
- A scoped exception may partially supersede one rule without replacing the
  whole record: leave the older record `Accepted`, and make the newer ADR name
  the exact rule it supersedes and state which remaining rules still stand.
- A `Proposed` record is still being agreed, so it is revised in place. There is
  no history to preserve until it is accepted, and superseding a proposal with a
  second proposal would leave two records describing one undecided direction.
- Add the record to the index above in the same change. `bun run decisions:check`
  gates numbering, status, required sections, and index agreement, and checks
  against the merge base that an `Accepted` number still holds the record it
  held. That last check needs history: it skips with a stated reason on a
  shallow or base-less clone rather than failing one. Set
  `OCTANT_DECISIONS_BASE` to compare against a different ref.
