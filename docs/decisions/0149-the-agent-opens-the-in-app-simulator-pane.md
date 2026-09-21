# 0149. The agent opens the in-app Simulator pane

**Status:** Accepted

## Context

0043 put the iOS Simulator in the right dock by rendering the full Apple
Development Workbench in that tab. 0139 made the frame a live view and 0140
let a person drive it, but two things still sent people to Simulator.app.

An agent's `octant_apple` `boot` or `run` prepared a destination and did not
raise the dock, so the only window that appeared was Apple's. Agents then
launched Simulator.app, `open -a Simulator`, or serve-sim to "see" the
device. And the dock tab still dumped scheme facts, Build/Test, and
validation evidence under the screen, so it did not read as a device.

Driving that pane still scripted Simulator.app through Accessibility when
the desktop helper was missing: typed text, Return, and named taps ran
`osascript` that activated Simulator.app. Observed 2026-09-19: that path
failed with `com.apple.hiservices-xpcservice` Connection Invalid, asked for
macOS permission in a loop, and brought Apple's window forward. Coordinate
taps already refused that path; clicks then raised a native confirmation
on every tap while the grant snapshot lagged.

This record supersedes exactly one rule of 0043: that the iOS Simulator dock
tab renders the existing Apple Development Workbench. It supersedes 0137's
rule that the scripted Accessibility adapter remains the fallback, and
0062's rule that Darwin's default Accessibility fallback accepts semantic
`target`, typed text, and keys. Every other rule in those records stands.
Follow-the-finger input stays a later decision (0140).

## Decision

- **`boot`, `run`, and `open` raise Octant's iOS Simulator pane.** An
  agent's `boot` or `run`, and `open` whether the destination was already
  booted, stamp an in-memory pane-open request on the runtime snapshot
  (`requestId`, `simulatorId`, `requestedAt`) as the action starts, so the
  pane rises while the destination is coming up. The renderer consumes each
  `requestId` once, the way it offers a written document: it opens the
  dock's iOS Simulator tab without moving composer focus. A tab the person
  closed stays closed until a later request. Closing the tab still does not
  shut the destination down.
- **`open` is the attach operation.** It boots a shut-down destination
  through the same `boot` path, and otherwise only stamps the request. It is
  not a destination effect of its own when the Simulator is already booted,
  so it asks for no approval. The tool result names `opensInAppPane: true`
  and tells the agent not to launch Simulator.app, `open -a Simulator`, or
  serve-sim.
- **The dock tab is a device pane.** It shows the live frame, a compact rail
  (the destination, Boot or Capture screen and Shut down, Home and Lock), and
  in-flight progress. It does not show scheme facts, Build, Test, or the
  validation-evidence dump. Typed text still goes to the focused screen
  (0140); the Type field stays on the full workbench and on a still fallback.
  The drawn screen is the hit region; bezel is not padding on that screen.
- **Input never activates Simulator.app.** Delivery is the desktop's device
  helper (0137). Without it, every input kind is unavailable. Octant does
  not script Simulator.app, System Events, or Accessibility to inject a
  tap, swipe, typed text, or key.
- **Watching stays a read.** The pane learns of a request only from the
  snapshot the workbench already reads. The request lives in the server's
  memory, is scoped to the thread and checkout, and dies with the process.
  It is never journaled. One input confirmation still opens the Simulator
  for fifteen minutes (0142); the pane must not raise that confirmation
  again for a grant the host already admitted.

Non-goals: follow-the-finger input, Android, a live view on a remote client,
and activating or quitting Simulator.app.

## Consequences

- An agent that boots or runs an iOS app shows the device in Octant, not in
  Apple's Simulator application.
- The dock reads as a device. Build, test, and evidence stay on the Apple
  workbench command.
- A person who closes the tab is not interrupted again until the agent asks
  to show the Simulator once more.
- Clicks, typing, Home and Lock on a host without the helper fail closed
  instead of asking for Accessibility or bringing Simulator.app forward.

## Related

- 0043 Simulator follows the active thread (one rule superseded; the rest stands)
- 0062 Simulator frame input transport (Accessibility fallback superseded)
- 0137 Simulator input through a native device helper (fallback superseded)
- 0139 The Simulator frame is a live view streamed through the host
- 0140 The live Simulator screen is driven directly
- 0142 One approval opens a Simulator to input
- 0150 Allow input opens a device to clicks (first-input confirmation superseded)
- 0151 Android emulator is a separate in-app device destination (Android non-goal superseded)
