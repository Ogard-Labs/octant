# 0139. The live Simulator screen is driven directly

**Status:** Accepted

## Context

0138 made the Simulator frame a live view, and 0137 made input land in tens
of milliseconds. The pane still offered a device the way a form would: click
for a tap, a text box with a **Type** button, and buttons for Return and
Escape. Nothing could be scrolled, because 0062 named tap, typed text and a
hardware key as the input kinds and a swipe is none of them. The maintainer
asked for a device surface a person can simply use.

Two things bound how direct it can be. 0062 keeps input on one channel, with
one request and one evidence record per input, decided by the server; a
stream of touch-move events from the renderer would be either dozens of
journaled actions per drag or an unjournaled side path, which 0062 rejects.
And the host runs one Simulator action at a time.

## Decision

- **A swipe is a workbench action.** `swipe` joins the Simulator action kinds
  with where the finger goes down (`point`), where it comes up (`toPoint`) and
  how long it takes (`durationMs`, 50–5000). It is input like a tap: same
  authority, approval, actor attribution, booted-destination rule and Plan
  refusal. Evidence records both ends and nothing typed. The `octant_apple`
  tool gains the same operation, so an agent scrolls the way a person does.
- **The pane reads a press and a release.** Less than ten pixels apart, it is
  a tap where the press began. Further, it is one swipe sent at release, as
  long as the drag took, held between 80 ms and 2 s. A press that began
  beside the screen is nothing; a drag that ran off it ends at the edge. The
  device does not follow the finger while it moves — the gesture is delivered
  when it is complete, and the live view shows what it did.
- **Typing goes to the device when the screen has focus.** Characters are
  collected and sent as one typed text once the keys pause for 350 ms, or
  before a key that acts on them. Return, Delete, Escape and the arrows are
  hardware keys. Shortcuts with Command or Control stay with the app, and so
  does Tab, which has to keep moving focus out of the screen.
- **Input made while an action runs is kept, in order.** The screen is not
  disabled while the host is busy, because a disabled control drops focus and
  the keys being typed with it. What a person does meanwhile waits and is
  sent as each action finishes; an input that never makes the pane busy stops
  being waited for after a second. What waits belongs to one Simulator: it
  outlives a live view that reconnects, and is dropped when the frame moves to
  another Simulator.
- **Home and Lock are buttons in the pane**, sent as the hardware keys the
  channel already carries.
- **A host without the device helper reports a swipe unavailable.** The
  scripted fallback of 0062 cannot drag.

Non-goals: a drag the device follows while it moves, long-press, pinch and
other multi-touch, rotation, and characters or keyboard layouts 0137 already
refuses.

## Consequences

- Lists scroll, pages turn, sheets dismiss and text fields take typing, from
  the pane and from agents, with one evidence record per gesture.
- Gestures that depend on the finger's path or on holding still — dragging a
  slider to a value, reordering a list, a context menu — are not reachable
  yet. They need touch phases on the channel, which is a separate decision
  about what a session of input records.
- A long typed passage becomes several evidence records, one per pause, each
  recording a length and never the text.

## Related

- 0062 Simulator frame input rides the Apple workbench channel
- 0137 Simulator input reaches the guest through a native device helper
- 0138 The Simulator frame is a live view streamed through the host
