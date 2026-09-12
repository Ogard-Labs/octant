# 0119. A Work Project keeps its status in its folder

**Status:** Accepted

## Context

Work is where a person keeps a client, a deal, or a launch: offers, decks,
notes, and the dates that go with them. A Work turn knew none of that. It read
its own transcript, the mentions in the prompt, and nothing else, so a task
started in the same Project two weeks later began from zero: the person had to
re-explain where things stood, and nobody was reminded that the offer was due
on the fourteenth.

Octant's own knowledge stores did not fit the gap. Project memory (0003) is
journaled and never reached a Work turn; the artifact library (0028) holds what
Octant produced, not what the work is about. The record of what a turn changed
(0083) is exact but says nothing about why. And the folder is shared with other
tools, synced, and edited by hand — a status that lived only inside Octant would
be one the person could not see or correct where they work.

## Decision

- **Every Work Project folder carries `AGENTS.md` and `STATUS.md`, and the
  files are the source of truth for the Project's brief and status.** The host
  seeds both when a Work Project is created — the default Project included —
  and seeds whichever is missing on a Project's first task. It never rewrites
  `AGENTS.md`; that file is the person's standing brief. This is a scoped
  exception to 0002's journal-first rule: Project knowledge in Work is a
  document the person and other tools own, not thread state, and the journal
  keeps its authority over threads, turns, and artifacts as before.
- **Both files are read into every Work turn.** They arrive as workspace
  context ahead of the thread's own transcript, read from the bound root each
  time and bounded in size, together with a standing instruction: update
  `STATUS.md` before finishing — current status, dated follow-ups and
  deadlines as `- YYYY-MM-DD what`, and the `Last updated:` line.
- **The agent keeps `STATUS.md`; Octant backfills only what it observed.** When
  a completed turn changed files (0083) but not `STATUS.md`, the host appends
  a dated line under `Recent changes` naming the task and the paths. It asserts
  which files changed in which task and nothing about what the change meant.
- **A quiet or urgent status opens with a resume brief.** A new task in a
  Project whose status is undated or older than the stale threshold (seven
  days), or whose dated lines include one that has passed or falls within three
  days, is told to take stock first: summarize status and dates from the file,
  ask what has happened since and what needs following up, update the file,
  then proceed with the request.
- **Dates become reminders without a second store.** The Work Project page
  shows the current status, follow-ups due, and what is coming up, parsed from
  the file on each read; the Work board's follow-up mark (0088) is derived the
  same way and lands on the Project's most recent open thread. The inbox reads
  the same derivation: the most urgent dated line rides the navigation
  runtime on that thread and surfaces as a `follow-up-due` attention signal,
  so the reminder reaches the badge and the banner without a journaled copy.
  Nothing is journaled; a hand edit to the file is in effect on the next
  read.
- **The Work Project page is where a Project is worked from.** Status, a new
  task composer, recent tasks, the folder's top level, and what Octant produced
  sit on one page composed from existing projections plus the two files.

## Consequences

- A task started weeks later begins from where the work stands, and the person
  is asked for an update instead of assumed to remember to give one.
- The structured parts of `STATUS.md` are fixed English headings and dated
  lines, so the parser and the agent agree; everything else in the file is free
  text the host never interprets or touches.
- A status that outgrows the size bound, or a name under `STATUS.md` that is a
  symlink or a folder, is left alone and reported as unavailable on the page;
  the turn still runs, without the brief.
- Every folderless Work thread shares the default Project's `STATUS.md`
  (0118), so unrelated quick tasks accrue one status. A person who wants a
  separate status makes a Project for it.
- Reminders reach the Project page, the board, and the inbox — all derived
  from the same read, so dismissing one surface does not lose the date and a
  hand edit moves every surface at once. What a reminder still cannot do is
  wake the person at a chosen hour; if that is wanted later it derives from
  the same read too.

## Related

- 0002 Durable event journal (scoped exception for Work Project knowledge)
- 0003 Product modes: Project memory remains for cross-mode, journaled entries
- 0083 A Work turn records what changed in its folder (the backfill's source)
- 0088 Completed and snoozed threads (the follow-up mark)
- 0118 A default folder for what nobody gave a home
