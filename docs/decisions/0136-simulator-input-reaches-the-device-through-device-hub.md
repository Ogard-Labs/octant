# 0136. Simulator input reaches the device through Device Hub

**Status:** Accepted

## Context

The Apple workbench shows a booted Simulator as a live frame and offers typed
text, hardware keys and taps on it (0014, 0043, 0062). The host delivered that
input by activating Simulator.app and sending it keystrokes through System
Events. Xcode 27 removes Simulator.app: a booted device runs headless under
CoreSimulator and is shown, when it is shown at all, by **Device Hub**
(`com.apple.dt.Devices`), an agent application that presents a device window
only when asked for one through its `devices://device/open?id=<udid>` URL.
`simctl` offers no input command, so on a current Xcode the old path fails by
construction, before any confinement or permission question arises.

Measured on such a host: Device Hub's device window carries the iOS
accessibility bridge (rows, toggles and text fields appear as `AXButton`,
`AXCheckBox`, `AXTextField` with their frames), and the embedded computer-use
driver (0113) can act on that window in the background without changing the
frontmost application. Pressing a bridged element by accessibility lands on the
device. Key presses for letters, digits, space and return land as typed.
Synthesized text and punctuation depend on the Mac's keyboard layout (a
Norwegian layout turned "-" into "+", and a whole word arrived as one wrong
glyph), and a pointer event posted at a screenshot pixel lands about 78 px away
from where the window draws it, while Device Hub's own toolbar under the same
pixels hit-tests correctly — one mis-aimed pointer click started a screen
recording.

## Decision

- On the desktop, Simulator `type-text`, `key-press` and `tap` requests are
  delivered through the desktop's private computer-use broker, which drives the
  device's Device Hub window with the embedded driver. The server keeps its
  `injectSimulatorInput` seam; the desktop is the reviewed adapter behind it.
  Hosts without the desktop broker (the CLI, remote clients) keep refusing with
  the host's named reason.
- The desktop finds the window by application name and device name among all
  windows, and opens it through the device URL when Device Hub shows none,
  without activating Device Hub. Discovery through the driver's application
  list is not used: Device Hub is an agent application and is not listed.
- Input is semantic first. A tap names an accessible element, either by the
  target's label or by the bridged element whose frame contains the tapped
  point, and presses it by accessibility. No pointer event is ever posted at a
  coordinate. A point with nothing accessible under it is refused by name.
- A tapped point is meaningful only together with the size of the screenshot
  it was read from. The workbench pane sends that size with every tap; a
  request without it is refused, not guessed. The screen's place in the window
  follows Device Hub's measured layout — a 52 px bar above and below the bezel,
  and a bezel about 2 % of the screen height thick — and Device Hub's own
  controls in those bars are never candidates, so a device tap cannot start a
  recording or press Home by accident.
- Typed text goes as key presses for letters, digits, space and newline, with
  shift for capitals. Any other character refuses the whole request by name
  rather than delivering a layout-dependent guess. The driver confirms each
  press before the next (about 1.3 s each, measured), so a typed-text action's
  deadline grows with its length up to the contract's ten minutes, and the
  desktop refuses text that cannot finish inside the deadline before the first
  key rather than leaving a typed prefix behind a timeout.
- The device Home button is Device Hub's own control and is pressed by
  accessibility. It is looked up only inside Device Hub's bars, never in the
  device's tree, so an app's own "Home" button is never pressed in its place.
  Other named keys map to the driver's key names.
- Simulator input borrows the embedded driver without enabling the Computer
  use plugin for agents. It starts no computer-use session, grants no
  application, and the Apple policy that admitted the request remains the
  approval. An input in flight still counts as driver work, so a staged driver
  update waits for it instead of replacing the driver mid-typing. It requires Octant's macOS Accessibility permission and refuses by
  name without it. Plan mode and read-only postures are refused before the
  request reaches the desktop, as 0009 requires.
- The driver's application list and Device Hub's toolbar labels are observed
  behaviour, not contracts. Their names are constants in one desktop module
  with the measurements that justify them.

## Consequences

- Attach, typed input, hardware keys and taps work on Xcode 27 hosts from the
  packaged desktop app; the live frame shows the effect and the evidence names
  the delivered action or the refusal.
- Typing punctuation, symbols and non-Latin text is refused rather than
  garbled. Delivering arbitrary text needs a layout-independent route (the
  bridge accepted an accessibility value write on a text field in testing) and
  is a follow-up with its own evidence.
- Taps reach what the accessibility bridge exposes. Custom-drawn content,
  gestures and web views inside the device are not tappable through this path
  and refuse by name.
- The bezel and bar measurements are Device Hub 27.0 behaviour. A Device Hub
  that lays its window out differently moves taps by a few pixels within the
  same row-sized element before it moves them onto another element; a wrong
  element is still an accessible element on the device, never Device Hub's own
  chrome.
- The `osascript` path stays for hosts that still have Simulator.app and no
  desktop broker, and is superseded on the desktop by this record.
- Verified with the driver against a booted iPhone 17 Pro on Xcode 27.0: a
  screenshot point on the Settings row "Generelt" opened it, key presses typed
  "xyz42" into the Settings search field, and the frontmost application did not
  change. The packaged-app round trip through the workbench pane is recorded on
  the tracking issue.

## Related

- 0014 Apple development and validation as an app-managed capability (input
  is semantic first)
- 0043 Simulator follows the active thread in the right sidebar
- 0062 Simulator frame input transport (the pane's tap now carries the frame
  size)
- 0113 Computer use is a bundled plugin with a managed driver (the driver is
  borrowed, the plugin is not enabled by this path)
- 0009 Sandbox confinement, approvals, and Plan mode
