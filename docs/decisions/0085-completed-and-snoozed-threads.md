# 0085. Completed and snoozed threads rest in shelves; completion archives on a timer

**Status:** Accepted

## Context

The sidebar had two answers for a thread a person was done with: leave it in
the active list, or archive it. Archive hides the thread from every list and
has no way back from the sidebar, so finished work stayed in the active list
and crowded the threads still in flight. Nothing parked a thread until later
either; a thread waiting on tomorrow's review sat beside today's work.

0035 fixed that a retention window never deletes on its own and that erasure
has no unattended timer. It says nothing about a timer that only files.

## Decision

- A Code thread has two resting states beside archive, recorded on the thread
  aggregate as optional fields: `completedAt`, and `snooze` with `until`,
  `at`, and `duringTurn`. Neither is a lifecycle value and neither needs a
  migration; an archived thread keeps whatever rest it had.
- **Complete** is manual only. The host refuses it while the thread's turn is
  running or while the thread waits on an approval or a question, because
  completing hides the row and would hide that work. Completing drops the pin
  and any snooze. **Reopen** is the way back, and a person sending the thread
  a turn reopens it as well; the host decides that reset, never the renderer.
- **Snooze** is an overlay on the active list, not a third lifecycle. A
  running thread may be snoozed, a thread waiting on the person may not, and
  the wake time must be ahead. No host timer wakes a snooze: clients derive
  visibility from the wake time. A snoozed thread comes back early when the
  agent needs the person, or when the turn that was running at snooze time
  ends. A snooze that ended stays on the record and the row says so until the
  thread is opened; opening it is what wakes it.
- Completed and snoozed threads leave the Project groups for two collapsed
  shelves at the foot of the sidebar. Search, boards, export, retention, and
  the thread surface itself do not change.
- The host archives a completed thread once its completion is older than
  `completedThreadArchiveAfterDays` in shell settings (default 7 days;
  `null` means never). The sweep runs hourly in the host process, re-decides
  each thread against the authoritative record before archiving it, journals
  the ordinary thread-updated event with the `system` actor, and never
  purges. This is a scoped exception to 0035's rule that there is no
  unattended timer: it files, and 0035's rule that only a confirmed purge
  deletes still stands in full.
- The shared sidebar renders Complete, Reopen, Snooze, and Wake only for a
  mode whose service carries these fields and refusals. Chat and Work take
  the same actions when their services do; until then their rows offer
  nothing they cannot honour.

## Consequences

- A thread never disappears with work in flight, and a hidden thread never
  keeps a person waiting: the host's refusals, not the renderer's beliefs,
  guard both.
- Archive stays the honest end state and gains a way to be reached without a
  hand on every thread; the Archive view and its restore path are unchanged.
- The one new timer is visible in Settings, off with one choice, and leaves
  every transcript, checkout, and journal event in place.
- Sidebar classification now depends on the clock, so the shell keeps a
  minute-coarse time and re-renders on it while visible.

## Related

- 0002 Durable event journal and rebuildable projections
- 0015 Workspace shell model
- 0035 Thread retention and explicit purge
- 0071 One navigation and surface hierarchy
