# 0139. The Simulator frame is a live view streamed through the host

**Status:** Accepted

## Context

The iOS Simulator dock tab shows a thread-bound frame (0043). Until now that
frame was a still: the latest captured screenshot, fetched as a PNG artifact.
A person had to press **Capture screen** to see anything, and again after
every tap to see what the tap did. The maintainer, after using it, asked for a
live device surface.

0137 put a native device helper behind the desktop, next to the Simulator's
own display surface. Measured on a booted iPhone: reading that surface and
encoding it as a JPEG scaled to 1100 pixels tall takes 1.7 ms, the render
server reports each presented frame, and a frame is about 90 KB. A swipe
produced frames of the page mid-transition, which no capture can show.

0062 and 0137 each list streaming the screen as a non-goal. This record
supersedes that one item in both; every other rule in them stands. What must
hold is what 0062 and 0043 already require: one channel, the
server deciding who may look, and clients that cannot attach failing closed.

## Decision

- **The frame shows the Simulator's screen as it changes.** While the dock tab
  shows a live destination, the pane watches its screen; the captured still
  remains the fallback whenever there is no live view, so nothing that worked
  before stops working.
- **Watching is a read, authorized by the server like a screenshot.** The
  renderer posts `apple-screen-stream-request` to `/api/apple/screen-stream`
  with its window capability; the server resolves the same thread and checkout
  authority it resolves for an artifact read, and asks no approval. Plan mode
  may watch. A window without that authority gets 403 before the desktop is
  asked.
- **Frames travel helper → desktop broker → server → renderer.** The helper
  writes length-prefixed JPEGs on file descriptor 3; the desktop broker's
  `/v1/simulator-device/stream` relays them to the server child, and the
  server relays them to the window. The renderer never reaches the broker or
  the helper, so the route would serve a remote client the same way. It does
  not yet: a remote client still reports the frame `not-attachable` (0062) and
  asks for no stream. Showing the frame remotely is its own decision.
- **The host chooses size, quality and rate** (1100 pixels tall, quality 0.7,
  at most 30 frames a second). A client cannot ask for more. The response
  names the device's screen in pixels in `x-octant-simulator-screen`, because
  frames are scaled and a tap is a point on the device's own screen.
- **Frames are sent on change and dropped under pressure.** A still device
  sends its current screen once and then nothing. While a reader is still
  taking a frame the next one is dropped, at the helper and again at the
  broker, so a slow viewer sees the newest screen rather than an old queue.
- **A view lives as long as someone looks.** Viewers of one Simulator share one
  stream. Closing the dock tab aborts the request, which ends the relay at
  each hop and stops the helper's stream with the last viewer. A watched
  helper is not stopped for being idle. A view that ends on its own is asked
  for again three times, then reported unavailable.
- **Frames are never journaled and never evidence.** They are not written to
  disk, not stored as artifacts, and not placed in model context. **Capture
  screen** remains the way a screen becomes validation evidence, and the rule
  that captures showing typed or secure values are masked before persistence
  (0062) is untouched because nothing here persists.
- **The helper checks its frame channel once, at start.** Descriptor numbers
  are reused; asked later, "is descriptor 3 open" is answered by whatever file
  or socket landed there, and frames would be written into it. The helper
  accepts only a pipe or socket it was started with.

Non-goals: recording, audio, rotation, touch phases and keyboard focus from
the live view (the next record), and a live view on a host the desktop app did
not start.

## Consequences

- The pane shows what the device shows, including what a tap or an agent's
  action just did, without a capture in between.
- A watched Simulator costs one encode per changed frame and roughly a
  megabyte a second while it animates; nothing while it is still.
- The server holds an open response per viewer. It is bounded by the dock
  showing one Simulator per window and ends with the request.
- A host without the desktop app answers 404 with a stated reason, and the
  pane falls back to the still.

## Related

- 0137 Simulator input reaches the guest through a native device helper
- 0062 Simulator frame input rides the Apple workbench channel
- 0043 Simulator follows the active thread
