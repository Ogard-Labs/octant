# 0151. Android emulator is a separate in-app device destination

**Status:** Accepted

## Context

0149 made the iOS Simulator dock tab a device pane and listed Android as a
non-goal. Building a mobile app needs both platforms. Folding Android into
the Apple helper, `octant_apple`, or CoreSimulator would mix two host
toolchains and two destination kinds. Computer-use destinations (0053)
already separate "is there a screen" from "how do I click".

## Decision

- This record supersedes 0149's non-goal that Android is out of scope. Every
  other 0149 rule stands, including helper-only iOS input and the iOS pane.
- **Android is its own destination.** Discovery, boot, shutdown, screenshot,
  and input use the Android SDK's `emulator` and `adb`, not `simctl` and not
  the iOS device helper. Unavailable SDK tools fail closed as a value.
- **The dock hosts an Android emulator tab** on Code threads, independent of
  an Xcode project. Closing the tab detaches the view only; it does not shut
  the emulator down. Shut down is an explicit action. An emulator already
  running on the host is attachable; Octant does not own it until it boots
  one, and shutdown of an attached emulator is still explicit.
- **`boot`, `open`, and a successful `run`/`install`+`launch` raise that
  pane**, the way 0149 raises the iOS pane. The tool result tells the agent
  not to launch an external emulator window as the place to look.
- **Input and Allow input follow 0150**, keyed by the AVD name as the
  destination identity (a branded non-UUID string). Taps, swipes, typed
  text, and keys are `adb shell input`. The picture refreshes after input,
  or streams by polling `adb exec-out screencap` while the pane is open. A
  tap on a stale still is not interaction.
- **`octant_android` is the agent tool**, plugin-shaped like `octant_apple`:
  status, discover, open, boot, shutdown, screenshot, tap, swipe, type-text,
  key-press, install (a checkout-relative APK), and launch (a package). It
  takes no shortcut a person on the pane could not take, and is unavailable
  under Plan and approval-gated postures.
- Accessibility overlay remains later. Gradle build stays the repository
  shell; this record does not add an Android workbench dump.

## Consequences

- A Code thread can show and drive an Android emulator beside iOS, so the
  same checkout can target both platforms without leaving Octant to look.
- A host without the SDK reports the destination absent instead of hanging
  or inventing a picture.
- iOS and Android grants, panes, and tools stay separate; only the grant
  lifetime policy is shared.

## Related

- 0149 The agent opens the in-app Simulator pane (Android non-goal superseded)
- 0150 Allow input opens a device to clicks
- 0053 Computer-use destinations
- 0043 Simulator follows the active thread
