# 0032. A refusal a person can clear

**Status:** Proposed

## Context

The local authority clock fails closed. When the wall clock jumps forward past
tolerance it latches `recovery-required`, freezes the effective time at a high
water mark, and refuses to mint window authority, launch sessions, Code
approvals, and managed-root grants. 0009 asks for exactly that: a capability
whose TTL was measured against a frozen clock would outlive its nominal life
once the clock is corrected, so nothing may be issued while the reading is in
doubt.

The refusal has no door out. The latched posture is persisted, restored on the
next process, and admits only one recovery: a reboot that also brings the wall
clock within twenty-four hours of the mark. Beyond that window the guard holds
whatever the clock now says, because a reboot discards the monotonic evidence
that could prove how much time really passed.

That window closes on its own. An install that latches on a Monday and is next
opened on a Wednesday is past it, and no reboot, no wait, and no in-app action
clears it. Observed on a maintainer's machine: latched at
`2026-08-17T17:38:47Z`, opened 39 hours later with the system clock accurate to
a millisecond, and every launch afterwards refused. The only way back was
deleting a row from SQLite by hand.

A person then sees "Octant could not open its Project window." The app knew the
reason and did not say it, which is a second failure and is addressed
separately; naming the reason still leaves them with a product that will not
open and no supported way to fix it.

Fail-closed is right. Fail-closed with no door is a product that bricks itself
on a clock jump, and the blast radius is every capability the guard protects.

## Decision

- **A fail-closed authority refusal must name a recovery a person can perform.**
  A posture that no user action, restart, or elapsed time can clear is not an
  acceptable resting state. This binds every consumer of the local authority
  clock, not the clock alone.
- **Recovery is explicit, attested, and journaled.** The way out is a deliberate
  act by the machine's owner that records what was cleared and why, not a
  widening of the automatic admission rules. Loosening the twenty-four hour
  reboot window, or trusting a corrected clock on its own word, would readmit
  the forward-jump attack the guard exists to refuse.
- **Recovery discards, never revalidates.** Clearing the posture invalidates
  every capability minted or held under it. A capability whose lifetime was
  measured against a frozen reading does not become trustworthy because the
  clock was corrected afterwards.
- **The refusal is visible before it is terminal.** The product says that host
  time recovery is required, and says it where the person is — not only in a
  log line they would have to know to read.

## Consequences

- Some surface must own the recovery act. A server-side operator command sits
  closest to the existing `db:*` tooling and needs no window authority, which
  matters because window authority is precisely what the latch withholds; an
  in-app affordance would have to be reachable without it.
- The recovery act is an authority boundary of its own and needs the evidence
  0009 expects: who cleared it, when, against what mark, and what was
  discarded.
- Until this lands, a latched install past the admission window is recoverable
  only by editing `local_authority_clock_guard` directly. That is a
  maintainer's workaround, not a supported path, and it should not be
  documented as one.
- The same gap applies to every posture that persists a refusal across
  restarts. New ones inherit this rule rather than repeating the trap.

## Related

- 0009 — sandbox confinement, approvals, and Plan mode: the fail-closed
  requirement this record does not weaken.
- 0002 — durable event journal: where a recovery act is recorded.
