---
description: The in-app Android emulator pane for booting, watching, and driving an AVD beside a Code thread.
---

# Android emulator

The Android emulator dock tab is a device pane bound to the owning Code
thread and checkout. It is a separate destination from the iOS Simulator: it
uses the Android SDK's `emulator` and `adb`, not Xcode, `simctl`, or the iOS
device helper.

## What you can do

- Discover AVDs the SDK reports (`emulator -list-avds`) and which ones `adb`
  already sees.
- **Boot** a shut-down AVD, or **open** one that is already running, into
  Octant's Android emulator pane. Closing the tab does not shut the emulator
  down.
- Watch the screen as it changes while the pane is open, or after each
  input. Frames are not stored. **Capture screen** is how a still becomes
  validation evidence.
- Drive the device: click to tap, drag to swipe, type on the focused screen,
  and use Home, Back, and Lock. On an approval-gated thread, **Allow input**
  is the one confirmation; clicks never open a dialog.
- **Install** a checkout-relative APK and **launch** a package. Gradle build
  stays the repository shell.

A host without `adb` or `emulator` says the destination is unavailable
instead of inventing a picture. Remote and headless clients stay read-only
for live input the same way the iOS pane does.

## Agent tool

A Code thread on **Full access** reaches these actions through
`octant_android`. Begin with `discover` or `status`. `boot`, `open`,
`install`, and `launch` show the emulator in Octant's pane — do not start an
external emulator window as the place to look. The tool is unavailable under
Plan and approval-gated postures. Pane-driven input journals as
`local-user`; tool-driven input journals as `agent`.
