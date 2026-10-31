# 0030. Routines that run themselves

**Status:** Accepted

## Context

A person who runs the same work every Monday should not have to be present on
Monday. Octant already has everything that work needs — modes, Projects,
bindings, execution profiles, authority profiles, approvals — and no way to say
"do that again at nine".

The tempting shape is a scheduler that holds the authority to do the work: it
remembers what you approved once and acts on it forever. That turns a schedule
into a standing grant, and a standing grant is exactly what a person cannot
audit. The first time a binding moves or a Project is archived, a scheduler
holding its own authority runs the old thing against the new world.

This record amends the boundaries drawn by 0009 (sandbox confinement and
approvals) and 0013 (remote clients) for time-triggered work. It changes
neither: it says what a schedule may and may not be under them.

## Decision

- **A routine is a journaled definition, not a privilege.** It names work — a
  mode, a Project, a binding, an execution profile, an authority profile, a
  delivery target, a trigger — and nothing else. Firing it starts the _ordinary_
  gated path. A routine can never do something the person could not do by hand
  at that moment.
- **Authority is revalidated at fire time, against live host facts.** Host,
  Project, binding, execution profile, provider capability, authority digest,
  and extension trust are each checked against the immutable definition and
  fail closed with a typed reason. A definition that outlived its world is
  blocked, not adapted. **Full access is ineligible**: a schedule is the worst
  place to hold the posture that asks for nothing.
- **One host owns a routine and only that host fires it.** Ownership is a
  property of the definition, not of whoever is looking. Another host renders it
  and never runs it.
- **Fires and misfires are both journaled.** Claiming an occurrence, skipping
  one, creating a run, changing its status, blocking it, recording a dispatch
  intent, and cancelling one all append frames. A run that did not happen leaves
  a record saying so, because "it silently did not run" is the failure a person
  cannot debug and cannot trust.
- **A missed window is a decision, not a backlog.** The missed-run policy is
  part of the definition, and recovery is capped: a host that was asleep for a
  week does not wake up and run seven days of work at once.
- **Every surface reads the schedule from one resolver.** The row's next-run
  line and the calendar both ask the same function the scheduler fires on. A
  second projection of the same rules would eventually disagree with the host
  about when something runs, and the disagreement would surface as a run that
  never came on the day someone was watching.
- **Remote parity, within remote authority.** A paired device manages routines
  exactly as a local window does, through the same commands, subject to 0013:
  managing a routine is remote-approvable, a device may only act on the host
  that owns the routine, and a request that tries to carry its own principal or
  origin is refused outright rather than trusted.
- **A routine is drafted in words and confirmed as a routine.** The composer
  proposes; it never creates. What runs is what the person saw and confirmed in
  the ordinary editor, because a schedule that was never read is a schedule
  nobody agreed to.

## Consequences

- A routine cannot outlive the authority it was created under. Someone who
  archives a Project or moves a binding will find routines blocked rather than
  quietly running against the new state — the safe answer, and the one that
  needs an explanation in the run history where it already appears.
- Blocking is common enough that its reasons must read like sentences a person
  can act on. A typed reason nobody can interpret is the same as no reason.
- Capped recovery means a host that was off for a long time loses runs. Losing
  them visibly is better than a thundering herd of stale work, and the journal
  says which ones were skipped.
- The calendar can only draw what the resolver can enumerate. A routine that
  runs more often than daily is drawn as its cadence rather than as a wall of
  times, and a month that could not enumerate everything says so instead of
  quietly stopping.
- Because remote clients use the same commands, every new routine capability
  needs its remote negative tested at the same time. That cost is the point:
  the alternative is a surface that is safe locally and open remotely.

## Related

- 0002 Durable event journal and rebuildable projections
- 0003 Modes, Projects, and thread authority
- 0009 Sandbox confinement, approvals, and Plan mode
- 0013 Remote clients and mobile
