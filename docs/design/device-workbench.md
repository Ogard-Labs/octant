# Device workbench

This topic specification owns the iOS Simulator and Android emulator device
panes: pane states, discovery, screen capture, input delivery, keyboard layouts,
and the managed streaming tools. Architecture owns the device authority rules,
including how `octant_apple` and `octant_android` follow the thread's turn
posture and what **Allow input** grants
([Architecture: device transport and evidence](../architecture.md#device-transport-and-evidence)).

## Device pane

The iOS Simulator dock tab
is a device pane: the Simulator's screen streamed through the
host as it changes, authorized like a screenshot and never stored (see
[decisions/0139-the-simulator-frame-is-a-live-view-streamed-through-the-host.md](../decisions/0139-the-simulator-frame-is-a-live-view-streamed-through-the-host.md)),
or the latest host-held screenshot evidence when there is no live view — with
honest setup, unavailable, booting, live, interrupted, and stale-after-restart
states; closing the tab does not shut down the destination. When Apple
discovery fails, the failure may carry an optional, additive `step` (`xcode`,
`licence`, `runtime`, or `project`) naming the probe that failed — Xcode
selection, `xcodebuild -license check`, Simulator listing, or project listing —
so the setup checklist marks that row and treats earlier rows as passed; a host
that omits it leaves every row unchecked. An agent's
`octant_apple` `boot`, `run`, or `open` raises that pane once per request
instead of launching Simulator.app. That request lives only in server memory,
keyed by thread and served only to the same thread and checkout; it is never
journaled and dies with the process (see
[decisions/0151-the-agent-opens-the-in-app-simulator-pane.md](../decisions/0151-the-agent-opens-the-in-app-simulator-pane.md)).
Apple artifact and restart-receipt reads validate regular-file identity and size
on an open handle before allocation. Reads reject linked files and size changes,
with a 16 MiB artifact limit and 1 MiB receipt limit; existing records are not
rewritten.

## Screen captures

A screenshot's raw capture lands in a host-private directory under the data root
(`<data>/apple-runtime/captures`, created `0700`) that the confinement profile
denies outright to every launch except the one taking the capture — the deny is
emitted after the broad launch-root grants, so a checkout bound to an ancestor
of the directory cannot read another thread's screen either, and only the
capture launch re-allows it through its own write root. A subtree grant is
acceptable here because the directory holds only host-minted, per-attempt UUID
names, re-read with no-follow, single-link, size-bound, and PNG-signature checks
before becoming an artifact. Redirecting the whole Apple temporary directory
instead was measured and reverted: `xcrun` and the Simulator services need the
host's real temporary and cache roots
([decisions/0160-an-apple-screen-capture-lands-in-a-directory-only-its-launch-can-write.md](../decisions/0160-an-apple-screen-capture-lands-in-a-directory-only-its-launch-can-write.md)).

## Android

An Android emulator is a separate dock destination and `octant_android` tool,
not an iOS helper feature
([decisions/0153-android-emulator-is-a-separate-device-destination.md](../decisions/0153-android-emulator-is-a-separate-device-destination.md)).
`octant_android` installs only a checkout-relative APK; an absolute path or
one that resolves outside the checkout is refused (`invalid-destination`).
Android commands are one-shot `adb` clients. The shared `adb` server that a
client forks puts itself in its own session, so Octant's group cleanup of a
finished command never reaches it, and Octant never stops a server. Each
client runs with `ADB_MDNS=0`: a server started with mDNS discovery on aborts
within seconds on macOS 27, and every later command then restarts it while the
emulator reconnects as `offline`. An input whose client exits 255 with
neither a client nor a device message lost its server after handing the
command over. It is reported `interrupted` (delivery unknown), not `failed`,
so a retry cannot type the same text twice. With no `ANDROID_HOME` or
`ANDROID_SDK_ROOT`, SDK discovery tries the Android Studio home location and
then the Homebrew `android-commandlinetools` prefixes, taking the first that
has both `adb` and `emulator`.

## Input channel

Tap, typed text,
and hardware-key input ride the same Apple workbench control channel as boot
and screenshot, with XCTest-less host injection behind that channel only,
computer-use-style actor attribution, and the same remote/headless fail-closed
attach gate (see
[decisions/0062-simulator-frame-input-transport.md](../decisions/0062-simulator-frame-input-transport.md)).

## Native device helper and typed text

Under the desktop app that injection is the native device helper of 0137: a
tap is a point on the captured screen, typed text is letters, digits, spaces
and new lines, and every refusal names the helper's own reason. Typed text is
sent only when the guest keyboard is a QWERTY software layout with an
Automatic hardware layout in English, Norwegian (`nb`, `nn`, `no`), Danish,
Swedish, Finnish, Dutch, Spanish, or Portuguese
(`apps/desktop/native/device-helper/KeyUsages.swift`). The list was derived
from Apple's QWERTY hardware layouts, where A–Z and the unshifted digit row sit
on US key positions; AZERTY (French), QWERTZ (German), Turkish, and every other
or unreadable layout refuse the whole string rather than type the wrong text. Evidence for a failed typing keeps
only the helper's refusal code, never a message that could quote the text. A
point outside the screen is refused (`point-off-screen`), never clamped.
Without that
helper every input kind is unavailable; Octant does not script Simulator.app
to inject a tap, swipe, typed text, or key
([decisions/0151-the-agent-opens-the-in-app-simulator-pane.md](../decisions/0151-the-agent-opens-the-in-app-simulator-pane.md)). A swipe is a
fourth input kind on the same channel, for the pane and for `octant_apple`
alike, and the live screen is driven directly: a press and release is a tap, a
drag is one swipe sent when it ends, keys typed on the focused screen go to
the device as one text per pause, Home and Lock are buttons, and what a person
does while an action runs is kept and sent in order (see
[decisions/0140-the-live-simulator-screen-is-driven-directly.md](../decisions/0140-the-live-simulator-screen-is-driven-directly.md)).

## Swipes

A swipe reaches the device as a finger that moves: it goes down at the start,
moves in even steps of about 16 ms along the straight line to the end over the
swipe's duration, and lifts there. The native helper paces the steps itself;
on the managed `serve-sim` stream the desktop sends them through one held
connection to the stream's input socket, because that tool's command line
starts too slowly to send a path one touch at a time. A swipe that starts
within 2% of a screen edge is flagged as an edge touch on that stream, which
is what lets a drag from the bottom go Home or unlock. Only straight
single-finger swipes exist: a press held in place is a tap, and there is no
long press or pinch.

## Device Hub input and Repair input

Touch and buttons sent through the managed `serve-sim` stream are reported
delivered only while the Simulator's legacy input services still receive them.
Xcode 27's Device Hub can take those services over: its guest input daemon
starts on demand (the native helper's first connection starts it), raises the
guest notification `com.apple.coredevice.dtuhidd.active` to `1`, and from then
on `serve-sim` exits successfully while the device drops every tap, swipe, and
Home. Before each tap, swipe, button, or finger-down on that stream the desktop
reads the notification; at `1` it sends nothing through `serve-sim` and hands
the input to the native device helper, which speaks to Device Hub's daemon and
proves it answers before sending (a finger that went down that way stays on
it until it lifts). When the helper cannot deliver either, the input is
refused with the reason `input-disconnected` ("Simulator input is
disconnected. Repair input restarts the Simulator's home screen."). When the
guest does not answer the question within 1.5 seconds the input is sent
through `serve-sim` as before. **Repair input** is a fifth input kind,
offered by the device pane only after that refusal: it runs
`serve-sim repair-input` (which restarts the guest's `backboardd`, so the home
screen restarts and running apps close) and drops the stream so the next input
reconnects it. It rides the same Allow input grant as a tap, never runs
automatically, and is refused unless a person (`local-user` or
`remote-device`) requested it; `octant_apple` does not offer it.

## Open URL

The device pane's More menu offers **Open URL…** only when the host's runtime
snapshot lists `capabilities.openUrl`; a host that predates the flag omits it
and the item is left out, never shown disabled. Unknown capability flags are
ignored rather than refused, so a host can report the next item without
breaking an older pane. Both the Simulator and emulator hosts report it.

The address is a credential-free `http` or `https` URL of at most 2,048
characters, in exactly the form the URL parser writes it back
(`DeviceOpenUrl`). The pane reads a bare host as `https://` and sends the
parsed form. `javascript:`, `file:`, `data:`, `content:`, `intent:`, and app
deep-link schemes are refused at the contract, before authority is resolved.
Requiring the parsed form means the address the confirmation shows is the
address the device receives, byte for byte. Custom app schemes are
deliberately out until a rule says which ones may be opened; universal links
over `https` still reach an app that claims them.

On the Simulator the host runs `xcrun simctl openurl <udid> <url>` with the
address as one argv entry. On the emulator it runs `adb shell am start -a
android.intent.action.VIEW -d <url>`; `adb` joins its argv into one line the
device shell parses again, so the address is passed single-quoted, as typed
text is. `am start` can exit 0 after printing `Error: Activity not started`,
so such a line makes the action `failed`.

Open URL is an effect, not input. Only a person (`local-user` or
`remote-device` in `requestedBy`) may ask for it; an agent or the host is
refused, as with Repair input.
Plan refuses it; Full access sends it unasked; on an approval-gated thread
every address raises its own confirmation, which names the whole address and
is bound to it, and Allow input never covers it. Evidence and its log keep only
`open-url completed (<origin>; path and query not recorded)`: the tool's own
output can quote the address, so none of it is kept, for the same reason typed
text is redacted. The agent tools do not offer Open URL.

## Rotate

The device pane's More menu offers **Rotate** only when the host's runtime
snapshot lists `capabilities.rotate`; a host that predates the flag omits it
and the item is left out, never shown disabled. Both the Simulator and
emulator hosts report it.

The request names the orientation to set, `portrait` or `landscape`
(`DeviceOrientation`), not a turn, so a repeated request is idempotent. The
pane names the one the device is not showing: it reads the streamed picture,
and with no picture it asks for `landscape`. There is no upside-down or
reverse-landscape choice.

On the Simulator, `simctl` has no rotate command and Octant does not script
Simulator.app, so the host hands the request to the desktop's device broker
like input, and the desktop runs `serve-sim rotate` against the managed
stream, starting it when needed (`landscape` is `landscape_left`). Without the
desktop app or the managed `serve-sim` tool the action is `unavailable`. On
the emulator the host turns auto-rotate off and sets the rotation through adb
(`settings put system accelerometer_rotation 0`, then `user_rotation` to `0`
for portrait or `1` for landscape), so the sensor cannot undo it.

Rotate is an effect, not input. Only a person (`local-user` or
`remote-device` in `requestedBy`) may ask for it; an agent or the host is
refused. Plan refuses it; Full access sends it unasked; on an approval-gated
thread each Rotate raises its own confirmation, and Allow input never covers
it. Evidence and its log record `rotate to <orientation> completed` and
nothing from the device. The agent tools do not offer Rotate.

## Managed device tools

The iOS Simulator and Android emulator panes ride
upstream streaming tools (`serve-sim`, `serve-avd`) that Octant vendors like
the Computer-use driver: each release is a pinned npm tarball the packager
verifies against the registry's published `dist.integrity` (sha512) and lands
in `Resources/managed-tools/<tool>` with its license. A release build re-signs
every Mach-O file found there with Octant's Developer ID, hardened runtime, and a
secure timestamp, and none of Octant's entitlements, before sealing the app,
because notarization rejects the upstream ad-hoc signatures. Camera passthrough
from the bundled helper is unsupported in a packaged app: it would need a camera
entitlement and a camera usage description, and Octant declares neither, so the
app never asks for the camera. Electron main owns the
per-tool instances; tools launch under the desktop runtime
(`ELECTRON_RUN_AS_NODE` with `process.execPath`), never a system Node. Tools
run unconfined under Octant's signed identity: no sandbox profile limits them,
and macOS may attribute their access to Octant's privacy (TCC) grants. They
need `simctl`, the Simulator's frameworks, and the shared `adb` server, and
Octant has no confinement profile for them yet. Octant narrows what they
inherit instead: each
launch receives only an allowlisted environment (`PATH`, `HOME`, user and
locale variables, `TMPDIR`, `DEVELOPER_DIR`, and the Android SDK and `adb`
variables), never provider keys, tokens, broker credentials, or other `OCTANT_*`
values. The same updater state machine as the driver checks
`registry.npmjs.org` daily only when the person turns automatic updates on in
Settings › Device tools; it is off by default, a saved choice is kept, and a
manual check or Update still works. A newer release stages with its dependency closure resolved
in-app (no npm or Bun is available inside the packaged app), each package
integrity-verified, and activates only while idle and after its entrypoint
survives a smoke launch. A staged tree that cannot start keeps the previous
release. Extraction accepts only allowlisted tar entries (no absolute path, no
`..`, no `:`) and never runs an upstream installer or lifecycle script. The
in-app resolver handles only `^`, `~`, and exact ranges, nests a conflicting
version under its owner, and stops at 64 packages; an upstream release that
needs anything else fails honestly and keeps the previous version. Settings
shows each tool's channel, version, and update state.
Verification is the registry's package-level integrity hash — npm publishes
no per-package signature — so the design pins URL plus hash and reports
honestly when they disagree. OpenCode is a descriptor on this same channel,
not a second updater. Version checks use the `@opencode/cli` registry
package; the staged bytes are the host's platform package at that version.
Its wrapper lifecycle script is never run. The platform binary is not
vendored into the app; Update stages it into the managed location on demand.
Settings › Providers shows the installed and available versions, an Update
action, and the reason when a check or activation fails. A release that fails
verification or does not start keeps the previous managed copy. Update never
replaces a binary outside that managed location. Choosing Octant's copy
switches the provider's configured path to the managed executable; it does
not overwrite an OpenCode the person installed elsewhere. See
[decisions/0162-managed-npm-device-tools-share-one-release-channel.md](../decisions/0162-managed-npm-device-tools-share-one-release-channel.md).

## Streaming attach and fallbacks

The Simulator pane attaches `serve-sim` for an already booted Simulator and
keeps the desktop device helper when that stream is missing or produces no
frame. The Android pane attaches `serve-avd` for an already booted
`emulator-<port>` serial and keeps `adb` screencap and `adb shell input`
otherwise. Boot still uses the emulator binary. The tools run in Electron
main. The server reaches Android streaming through a loopback broker
(`OCTANT_SERVE_AVD_BROKER_URL`, `OCTANT_SERVE_AVD_BROKER_TOKEN`) the same way
it reaches the Simulator device helper. Each attach request carries the SDK
root the server discovered. The broker accepts only an absolute root that,
once normalized, holds `platform-tools/adb`, and runs `serve-avd` with that root as
`ANDROID_HOME` and with `ADB_MDNS=0`, so the tool uses the server's `adb` and
any shared `adb` server it starts stays up. `serve-avd` prints its ready state
as indented JSON over several lines, and the broker reads the whole object. Its
`stream.mjpeg` carries JPEG parts, or PNG parts when the emulator image cannot
encode `screencap -j`; the server cuts parts by `Content-Length` and passes
either image type to the pane.
When the tool is missing, exits, or does not attach in time, the broker
answers with that reason. Every Android screen stream names its transport in
`x-octant-android-transport`: `stream`, or `screencap` with the reason the
stream is not used (no desktop, not an emulator, tool missing, tool exited,
timed out, desktop unreachable, or no frames). The pane shows it as a quiet
"Live stream" or "Snapshots, live stream unavailable: …" line, and an input
sent through `serve-avd` says so in its evidence. An agent must not launch
Simulator.app, `serve-sim`, or `serve-avd`.

## Verification

- Server: `apps/server/src/apple/appleToolchainService.test.ts`,
  `apps/server/src/android/androidToolchainService.test.ts`, and
  `apps/server/src/android/serveAvdBrokerClient.test.ts`.
- Desktop: `apps/desktop/src/simulatorDeviceHelper.test.ts`,
  `apps/desktop/src/serveAvdBroker.test.ts`, `managedToolRelease.test.ts`, and
  `managedToolService.test.ts`.
- Rendered input on a real Simulator or emulator remains a manual device check.
