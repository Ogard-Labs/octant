# 0142. One approval opens a Simulator to input

**Status:** Accepted

## Context

0062 made a tap, typed text and a hardware key destination effects that
"follow ordinary Code approval like boot and shutdown". On an approval-gated
Code thread that meant one native confirmation per input. Used from the live
frame, that is a dialog for every tap: a person cannot drive a device that
way, and the maintainer called it unworkable after using the packaged app.
The approval exists to keep an effect on a destination from happening without
consent, not to make each touch of an already-consented destination a
separate decision.

## Decision

- This record supersedes exactly one rule of 0062: that every tap, typed text
  and hardware key is approved on its own. Everything else in 0062 stands —
  one request shape, one channel, one evidence record, actor attribution, the
  remote and headless fail-closed gate, and reads staying approval-free.
- On an approval-gated Code thread, the first input to a Simulator is approved
  through the same native confirmation as before. That approval opens the
  Simulator to input **for that window, on that thread** for fifteen minutes, and each
  delivered input keeps it open another fifteen. While it is open, further
  taps, text and keys to that Simulator run without a new confirmation. A
  swipe (0140) is input like a tap and is covered the same way.
- The grant is the host's. It lives in the server's memory, is keyed by window,
  thread and Simulator, and is consulted where the approval is validated, before
  any side effect. It belongs to the window whose confirmation opened it, as
  every other approval on this host does: a second client on the same thread,
  such as a browser tab, gets no input from it and needs its own confirmation,
  and the grant ends when its window's authority is revoked. The policy accepts a live grant in place of the one-shot
  approval a request would otherwise carry, for input only; a shutdown, a boot
  or any other effect still asks. Looking at a grant does not extend it: only
  an input that was delivered renews it, and a shutdown that succeeded, or a
  discovery that finds the Simulator no longer booted, closes it for every
  window and thread. The second covers a Simulator shut down from Xcode or
  `simctl`, which no Octant action sees; booting it again is a new device
  session and asks again. Only a discovery sees this, so a shutdown and reboot
  between two discoveries goes unnoticed, and the grant's fifteen minutes are
  what bound it. An input the grant itself admitted
  that finishes just after it ran out still renews it, within the longest an
  action may run. Input admitted another way, full access or the first one
  approved, never brings back a grant that ran out. A request the service
  answers again from memory delivered nothing and renews nothing; the service
  marks such an answer, so nobody infers it from timestamps. The grant's
  lifetime is measured on the host's suspend-aware authority clock, so sleep or
  a clock set back cannot stretch it. A restarted host has no grants and asks
  again.
- The pane learns of a grant only from the runtime snapshot, which reports
  when it ends on the wall clock the pane compares against, and uses it only
  to skip raising a confirmation the host would not require. A pane that skips
  wrongly is refused by the host as unauthorized; it cannot widen anything.
- The confirmation for an input says what it covers: input to this Simulator,
  for fifteen minutes after each input.
- Nothing else changes: boot, shutdown, terminate, build, run and test are
  approved one by one; Plan mode and read-only postures refuse input before
  any grant is looked at; Full access needs no approval as before; the agent
  tool is still unavailable under approval-gated postures.

## Consequences

- Driving a device from the live frame costs one confirmation per Simulator
  per working session instead of one per touch.
- A person who walks away for more than fifteen minutes confirms again. The
  window is a constant in the domain policy, not a setting.
- The grant is broader than the single action that was confirmed: any input to
  that Simulator from that window on that thread rides it. It is no broader
  than the window's own authority over the thread, and it never covers an effect on
  the checkout or the toolchain.
- Evidence is unchanged: every input still records who asked and what
  happened; the journal does not record the grant itself.

## Related

- 0062 Simulator frame input transport (one rule superseded; the rest stands)
- 0009 Sandbox confinement, approvals, and Plan mode
- 0043 Simulator follows the active thread in the right sidebar
- 0150 Allow input opens a device to clicks (first-input confirmation superseded)
