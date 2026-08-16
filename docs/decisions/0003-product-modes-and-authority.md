# 0003. Product modes: Chat, Work, and Code authority

**Status:** Accepted

## Context

Octant is one product with three ways of working: conversational Chat,
document- and outcome-oriented Work inside a confined folder, and
approval-gated engineering in Code. Earlier agent tools treat such modes as
renderer presets, so a chat window can quietly acquire shell or repository
authority. Octant needs modes to be real authority boundaries that survive
provider changes, remote clients, subagents, and UI redesigns, while letting
users start quickly without a setup modal.

## Decision

- Chat, Work, and Code are server-enforced domain modes. Mode determines
  authority, context, tools, and safety, not only presentation. Code is the
  core surface and cannot be disabled; Chat and Work can be disabled
  independently, and disabling never deletes their data.
- Project is the shared organizational and memory container in every mode:
  - Chat Projects are virtual and carry no implicit filesystem or shell
    authority; tools needing temporary files use an isolated scratch area.
  - Work Projects bind exactly one existing, OS-confined local folder.
  - Code Projects bind exactly one existing repository root; each Code thread
    additionally selects one checkout (existing checkout, existing worktree,
    or Octant-managed worktree), an execution posture, and a delivery target.
- Threads may start unfiled. Until a saved Project is explicitly attached, a
  thread has no filesystem, shell, Git, worktree, test, preview, mutation, or
  delivery authority. Attaching is an explicit, recorded authority transition.
  Octant never infers a root from the prompt, process directory, or another
  thread. The only folder Octant may create is the verified result of an
  explicitly approved managed repository clone into the host's inventory.
- Work never silently becomes Code. Coding discoveries offer a linked
  promotion into a new Code thread; promotion carries a handoff brief, chosen
  messages, memory, and provenance, and never carries approvals, secrets,
  runtime authority, or provider state.
- Code starts approval-gated. Users may elevate a thread to Full access and may
  choose to remember Full access for one Project; the default remembers it for
  the session only. Plan mode is strictly read-only under every preference.
  Elevation and Plan-to-execution transitions are explicit and journaled.
- Repository identity is an opaque digest of the canonical Git common
  directory, not a path. Managed worktrees live under a sibling root that
  requires its own confirmed grant, receive ownership receipts before use, and
  are never silently reset, pruned, or reused. A Code Project may remember
  whether new threads default to a managed worktree or the current checkout.
- File, terminal, test, and Git operations are server-owned services with
  checkout-relative targets, symlink and identity verification, atomic writes,
  bounded output, and structured verdicts. Panes are clients, not owners.
- Memory is scoped to one Project. Entries keep source, kind, timestamps, and
  supersession so stale conclusions are corrected without rewriting history.
  Cross-Project or cross-mode transfer is explicit and provenance-preserving.
- Provider and model are sticky per thread but changeable in-thread. A change
  validates readiness, journals old and new selection, leaves in-flight turns
  bound to their provider, starts a fresh provider session for the next turn,
  and never widens authority.
- Unread, runtime status, thread work-list state, and follow-up are four
  independent states. Only explicit user completion clears follow-up; viewing
  a thread never does.
- Referencing another thread from a composer grants a bounded read-only
  transcript excerpt for that turn; it never appends to, steers, or approves
  the referenced thread.
- Delivery targets (Work outcome; Code investigation, local implementation,
  opened PR, merged PR) are user-confirmed. A thread is Done only when the
  confirmed target is objectively satisfied; agents may propose but not lower a
  target. Ambiguous work resolves to Waiting.

## Consequences

- Every new capability must state its Chat, Work, and Code availability and be
  checked server-side before side effects; React never grants capability by
  showing a pane.
- Unfiled-first creation keeps onboarding light but requires every tool path
  to tolerate a rootless thread honestly.
- Worktree isolation and opaque repository identity survive renames and moves
  but demand an audited relink after copies or cross-volume replacement.
- Provider changes inside a thread are cheap for the user and honest about
  session boundaries; provider-native session reuse across a switch is
  deliberately not attempted.

## Related

- 0002 Durable event journal
- 0009 Sandbox confinement, approvals, and Plan mode
- 0012 Mixed-provider subagents
