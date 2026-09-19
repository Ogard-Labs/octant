# 0134. A folded Project reports its strongest thread

**Status:** Accepted

## Context

A sidebar thread row has carried a single status mark for some time: one
trailing slot showing the strongest of working, an obligation, an ended snooze,
and unread activity, with the weaker ones kept in the mark's label. That
ranking lived inline in the row component, so it was a rendering detail rather
than a stated rule, and nothing outside that one component could read it.

The consequence was structural, not cosmetic. A Project heading is the row a
reader scans when the Project is folded shut, and it had no way to say anything
about the threads underneath it. Folding a Project therefore hid not only its
threads but every signal they carried, which makes folding a cost rather than a
way to keep a long sidebar readable. Any heading that wanted to report would
have had to re-derive the ranking, and a second derivation is a second answer:
a heading could then claim one state while the rows revealed by opening it
showed another.

## Decision

The sidebar has one named thread-status vocabulary, and a Project reports over
it only while its threads are out of sight.

- **One vocabulary, in the domain.** `working`, `attention`, `woke`, `unread`,
  and `idle`, in that descending strength, with their labels, live in a pure
  policy. Both the thread row and the Project heading resolve through it, so
  they cannot rank the same facts differently.
- **`idle` is the absence of a claim.** It carries no label and draws nothing.
  A row or heading with nothing to report says nothing rather than saying
  "Idle", which reads as a state somebody chose.
- **Only observed facts are statuses.** Every status here is a fact the sidebar
  already carries. A state the sidebar cannot observe — a failed run, a blocked
  check — is absent from the vocabulary rather than inferred from silence. A
  heading that under-reports is recoverable by opening the Project; one that
  invents trouble is not.
- **A Project reports its strongest status and how many threads reached it.**
  Each thread is counted once, at its own strongest status, so a thread that is
  both working and unread raises the working count and not the unread one. The
  count answers how many threads are in the state the heading is reporting.
- **The report appears only while the threads are hidden.** An open Project's
  rows already carry their own marks; repeating the strongest of them on the
  heading directly above would state the same thing twice within two lines.
- **The report is the mark its rows wear.** Opening the Project shows the
  reader the state the heading reported, in the same shape, rather than a
  second visual language for the same facts.
- **The report costs the row no width.** It shares the trailing run with the
  row's hover controls and yields its width the moment they appear, so a
  Project name never loses room to it and no row grows a second line.

## Consequences

A long sidebar can be folded down to Project headings without going blind: the
headings keep reporting, and the reader opens the one that says something.
Because the ranking is now a named policy rather than a rendering detail, a
later surface that wants to speak about thread state — a status filter, an
ordering that puts the loudest Project first, a remote client's compact list —
reads the same vocabulary instead of inventing a parallel one.

The vocabulary is deliberately narrower than the thread board's. The board
answers whether a thread's delivery target is satisfied; the sidebar answers
what is happening to it now. Adding a status here requires the sidebar to carry
the fact first.

## Related

- [0015 Workspace shell model](0015-workspace-shell-model.md)
- [0071 One navigation and surface hierarchy](0071-one-navigation-and-surface-hierarchy.md)
- [0088 Completed and snoozed threads](0088-completed-and-snoozed-threads.md)
