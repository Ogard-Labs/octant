# 0146. Allow input opens a device to clicks

**Status:** Accepted

## Context

0142 made the first tap, typed text, or key on an approval-gated Code thread
the confirmation that opens a Simulator to input for fifteen minutes. Used
from the live pane, that still raised a native dialog on the first click,
and a lagging grant snapshot could ask again. Driving an already-open device
is not a series of Code mutations to confirm. The confirmation is whether
this window may send input to that destination at all.

## Decision

- This record supersedes exactly one rule of 0142: that the first tap, typed
  text, or hardware key is the confirmation. The grant, its window/thread/
  destination key, fifteen-minute renewal, shutdown and discovery close, and
  Full access / Plan rules in 0142 stand. It supersedes 0145's rule that the
  pane may treat that first input as the confirmation.
- **`open-input` is the confirmation.** On an approval-gated Code thread the
  pane offers **Allow input**. That action is approved through the same native
  confirmation as other Code effects. Confirming it opens the 0142 grant for
  that window, thread, and destination. The prompt still says it covers input
  for fifteen minutes after each input.
- **Local pointer, keyboard, Home, and Lock never raise that confirmation.**
  On an already-open pane they are input to the destination, posted on the
  same workbench channel as today, and ride a live grant or Full access. With
  neither, they do not run and they do not open a dialog. The pane says to
  Allow input first.
- **Agent input, URL opens, boot, and shutdown still ask** when the posture
  requires it and no live grant covers input. The agent tool remains
  unavailable under approval-gated postures. A live grant the person opened
  still covers further input from that window on that thread, including an
  agent's, the way 0142 already keyed it.
- Closing the pane still does not shut the destination down (0145).

Non-goals: follow-the-finger input, accessibility overlay.

## Consequences

- A click on the live screen is a tap, never a permission dialog.
- One **Allow input** per destination session is what an approval-gated
  thread asks before the person drives the device.
- A pane that skips the confirmation is still refused by the host as
  unauthorized; it cannot widen anything.

## Related

- 0142 One approval opens a Simulator to input (one rule superseded)
- 0145 The agent opens the in-app Simulator pane (first-input confirmation superseded)
- 0009 Sandbox confinement, approvals, and Plan mode
- 0062 Simulator frame input transport
