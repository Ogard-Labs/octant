# 0037. A thread starts in a Project

**Status:** Accepted

## Context

0003 let a Work or Code thread start unfiled: no Project, no bound root, and
no authority, with an explicit attach transition available later. Octant grew
a whole parallel stack to keep that promise honest — a rootless thread
aggregate, its own turn runtime, its own scratch area, its own projections,
its own navigation group, and a folder selector in the composer — because a
rootless thread cannot use any of the Project-backed paths.

Dogfooding showed the cost without the benefit. Every rootless thread the
product produced was an experiment that immediately wanted a folder, and the
sidebar grew a second, permanently-unfiled group of threads that no Project
owned and no board could schedule. The parallel stack also had to be taught
every capability twice, and the second copy was consistently the one that
lagged: unread, boards, memory, context, and delivery all worked in the
Project-backed thread and had to be re-explained as "unavailable" in the
rootless one.

The mode that already answers "I want to work without a repository" is Work,
which binds one ordinary folder. Nothing about starting quickly required a
thread with no container at all.

## Decision

- Every Work and Code thread belongs to exactly one Project. There is no
  unfiled thread state and no rootless thread aggregate.
- A composer with no Project selected cannot start a turn. It offers the two
  honest ways forward — choose an existing Project, or create one from a
  folder — and starting the turn is the same explicit, recorded authority
  transition that attaching used to be, moved to the front.
- Chat is unchanged. Chat Projects are virtual and carry no root, so a Chat
  thread has always had a container without needing one on disk.
- Amends the "Threads may start unfiled" rule in 0003 and the consequence
  that every tool path must tolerate a rootless thread. All other rules in
  0003 — approval-gated Code, Plan is read-only, no inferred roots, explicit
  and journaled authority transitions — are unchanged.
- Rootless thread journal events remain in the journal as history. Their
  projections are dropped; no projector reads them, and nothing replays them
  into a live thread.

## Consequences

- One thread stack instead of two. A capability is taught to the
  Project-backed thread once and every mode has it.
- The sidebar, boards, search, and Zen lose their unfiled group. A thread's
  Project is now a fact every surface can rely on rather than an optional.
- Starting work costs one more explicit choice up front. That choice is the
  authority transition 0003 always required — it now happens before the first
  turn instead of after it.
- Rootless threads created by earlier builds stop appearing. The three states
  this removes (rootless, attached-by-transition, project-backed) collapse to
  one, so no migration has to guess which folder an unfiled thread meant.

## Related

- 0003 Product modes: Chat, Work, and Code authority (amended)
- 0017 Code Projects bind any folder
- 0002 Durable event journal and rebuildable projections
