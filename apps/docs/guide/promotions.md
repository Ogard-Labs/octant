---
description: Promotions create a linked Code thread from Work work with explicit user approval and no inherited authority.
---

# Promotions

When Work work becomes software engineering, Octant offers an explicit promotion to a linked Code thread. The promotion never changes mode silently and never carries Work filesystem authority into Code.

## How promotions work

1. During a Work thread, the agent or user identifies that the work requires Code authority (Git, shell, repository tools).
2. Octant presents a promotion proposal with selected context from the Work thread.
3. The user reviews the proposal and explicitly approves or dismisses it.
4. On approval, a new Code thread starts in a linked Code Project.
5. The Code thread starts **approval-gated**, never inheriting the Work thread's authority.

## Authority boundary

A promotion proposal:

- Never silently switches modes.
- Never carries Work filesystem authority into Code.
- Requires explicit user approval before creating the Code thread.
- Starts the Code thread in approval-gated mode, regardless of the Work thread's authority level.

The Code thread resolves its own authority independently. The user can adjust the authority mode (Plan, Approval-gated, or Full access) through the Code thread's controls.

## Context transfer

The promotion proposal can include context from the Work thread, such as:

- Relevant memory entries, transferred with a provenance link.
- A summary of the Work work that led to the promotion.
- Referenced files or paths within the Work root.

The Code thread does not inherit the Work root binding. It binds its own folder selected during Project creation or thread configuration.

## Dismissing a promotion

A dismissed proposal leaves the Work thread unchanged. No Code thread is created, no authority is elevated, and no data is transferred. The user can initiate another promotion later.

## Next steps

- [Work](/guide/work) for the source mode of promotions
- [Code](/guide/code) for the target mode of promotions
- [Shared Memory](/guide/memory) for context transfer during promotions
