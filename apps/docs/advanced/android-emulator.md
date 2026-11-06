---
description: The in-app Android emulator pane for booting, watching, and driving an AVD beside a Code thread.
---

# Android emulator

The Android emulator dock tab is a device pane bound to the owning Code
thread and checkout. It is a separate destination from the iOS Simulator: it
uses the Android SDK's `emulator` and `adb`, not Xcode, `simctl`, or the iOS
device helper. When the desktop has the managed `serve-avd` tool, the pane
uses it for the live picture and for tap, swipe, text, Home, Back, and Lock
on an emulator `adb` already reports as booted (`emulator-<port>`). Boot
still starts the emulator binary. If the stream is missing or shows no frame,
the pane keeps `adb exec-out screencap` and `adb shell input`. Do not start
`serve-avd` in a way that boots an AVD. The pane attaches only to a serial
that is already running.

Under the screen, the pane says which picture you are looking at. **Live
stream** means `serve-avd` is attached. **Snapshots, live stream unavailable**
means the pane is polling `adb screencap`, and it gives the reason: for
example `serve-avd` is not installed, stopped before it attached, or did not
attach in time, or this host is not running in the Octant desktop app.
`serve-avd` uses the same SDK and `adb` that Octant found, and runs with
`ADB_MDNS=0` like Octant's own `adb` commands.

## What you can do

- Discover AVDs the SDK reports (`emulator -list-avds`) and which ones `adb`
  already sees.
- **Boot** a shut-down AVD, or **open** one that is already running, into
  Octant's Android emulator pane. Closing the tab does not shut the emulator
  down.
- Watch the screen as it changes while the pane is open, or after each
  input. Frames are not stored. **Screenshot** in the toolbar is how a still
  becomes validation evidence.
- Drive the device: click to tap, drag to swipe, type on the focused screen,
  and use **Back**, **Home**, and **Lock** in the toolbar (**Lock** moves into
  **More** when the pane is narrow). On an approval-gated thread the line
  under the toolbar asks **Allow input on Pixel 9?**; **Allow** opens the one
  confirmation, **Not now** leaves the screen view only, and clicks never open
  a dialog.
- **Install** a checkout-relative APK and **launch** a package. Gradle build
  stays the repository shell.

The pane is the same device pane as the iOS Simulator's: one toolbar with the
emulator's name and state in words, at most one line for an error, the
approval, or typing, and the emulator on a quiet stage. The name opens a list
of the other AVDs so you choose which one the pane shows, and when more than
one is running and nobody has chosen, the pane asks instead of guessing.
**More** holds **Type text…**, **Open URL…**, **Volume up**,
**Volume down**, **Record screen** (**Stop recording** while it records),
**Switch device…**, **Diagnostics**, **Stop live view**, and **Shut down**.
**Open URL…** opens an
`http` or `https` address on the emulator with Android's view intent, asks
first on an approval-gated thread with the whole address in the confirmation,
and records only the address's origin as evidence; other kinds of address are
refused. **Rotate** turns the emulator between portrait and landscape and
asks first on an approval-gated thread. **Record screen** records the emulator
for up to 60 seconds or until you stop it, asks first on an approval-gated
thread, and saves the video as evidence the way a screenshot is. When the SDK
or an AVD is missing, a short checklist says what to install or create.

Octant finds the SDK through `ANDROID_HOME` or `ANDROID_SDK_ROOT`. Without
either, macOS hosts look in `~/Library/Android/sdk` (Android Studio) and then in
the Homebrew `android-commandlinetools` location under `/opt/homebrew/share` or
`/usr/local/share`, using the first that has both `adb` and `emulator`. Other
hosts look in `~/Android/Sdk`. A host without `adb` or `emulator` shows the
setup checklist instead of inventing a picture.

When no `adb` server is running, the first `adb` command Octant sends starts
one with mDNS discovery turned off (`ADB_MDNS=0`). Wireless-debugging
discovery is not available through a server Octant started. A server you
started yourself is used as it is, and Octant never stops it. If an input
loses the `adb` server before the device answers, the pane reports it as
interrupted rather than failed. Check the screen before you send it again. Remote and headless clients stay read-only
for live input the same way the iOS pane does.

## Agent tool

A Code thread's agent reaches these actions through `octant_android`. Begin
with `discover` or `status`. `boot`, `open`, `install`, and `launch` show the
emulator in Octant's pane — do not start an external emulator window as the
place to look. Discover, status, screenshot, `describe-ui`, `logs`, and
`open` of a device that is already running (it only shows the pane) work under
every posture, Plan included. On an approval-gated thread every other
operation asks in the thread first and runs only once you allow it; input the window's
**Allow input** already covers goes through without asking again. Plan mode
refuses them, and Full access runs them without asking. Pane-driven input journals as
`local-user`; tool-driven input journals as `agent`.

The agent can read the screen as text as well as a picture:

- `describe-ui` lists the labelled elements on screen, one line each with its
  class, text, content description (`desc`), resource-id (`id`), centre, and
  bounds, in the same pixels a tap uses. It shows at most 300 elements and says
  when it cut the list. If the screen keeps changing, uiautomator cannot read
  it and the agent is told to try again in a moment.
- `tap` can name an element (`target`) instead of a point. Octant reads the
  screen and taps the centre of the one element whose resource-id, content
  description, or text is exactly that name, in that order. When no element or
  more than one has it, nothing is tapped and the agent is told how many
  matched. It asks first on an approval-gated thread like any tap.
- `logs` returns a running app's own log lines (by `packageName`) in the tool
  result: the newest 500 lines or 32 KiB, or the last `sinceSeconds` (up to ten
  minutes) by the emulator's clock. With crashes asked for it adds the
  emulator's crash buffer, which also covers an app that has already stopped.
