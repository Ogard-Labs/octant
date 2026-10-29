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

## Volume

The More menu offers **Volume up** and **Volume down** (after Lock) only when
the host's runtime snapshot lists `capabilities.volume`; a host that predates
the flag omits it and the items are left out, never shown disabled. Like Lock,
they appear only while input is allowed. The Simulator host reports it only
when the desktop's native device helper is wired in, because every Simulator
hardware key rides that helper; the emulator host always reports it.

Volume is not a new action kind: it is a `key-press` with the key
`volume-up` or `volume-down`, so it is input in every respect. It needs a
person's or agent's input authority exactly as Home and Lock do, Allow input
covers it, Plan refuses it, and evidence keeps the key name like any other
key. On the Simulator the desktop sends it as a hardware button (consumer-page
usages `0xE9` and `0xEA`, the same codes the managed `serve-sim` stream uses)
through the native helper, or through the stream while the legacy input
services still receive. On the emulator it is `serve-avd`'s `volume-up` and
`volume-down` buttons, or `adb shell input keyevent KEYCODE_VOLUME_UP` and
`KEYCODE_VOLUME_DOWN`.

## Rotate

The device pane's More menu offers **Rotate** only when the host's runtime
snapshot lists `capabilities.rotate`; a host that predates the flag omits it
and the item is left out, never shown disabled. Both the Simulator and
emulator hosts report it.

The Android request names the orientation to set, `portrait` or `landscape`
(`DeviceOrientation`), not a turn, so a repeated request is idempotent. The
pane names the one the emulator is not showing: it reads the streamed picture,
and with no picture it asks for `landscape`. The Apple request names none
(`orientation` is optional): the Simulator keeps streaming portrait-sized
frames after it turns, so the picture cannot say which way it sits, and the
desktop reads the Simulator's real screen (a screenshot's size, captured into the host-private capture directory and deleted at once) and turns it
the other way, so every Rotate alternates however the pane was opened. A request that does name one still sets it. There is no
upside-down or reverse-landscape choice.

On the Simulator, `simctl` has no rotate command and Octant does not script
Simulator.app, so the host hands the request to the desktop's device broker
like input, and the desktop runs `serve-sim rotate` against the managed
stream, starting it when needed (`landscape` is `landscape_left`). Without the
desktop app the action is `unavailable`; without the managed `serve-sim` tool
(dev builds do not vendor it) the desktop refuses with `rotate-unavailable`
and the pane says the device tool is not installed. On
the emulator the host turns auto-rotate off and sets the rotation through adb
(`settings put system accelerometer_rotation 0`, then `user_rotation` to `0`
for portrait or `1` for landscape), so the sensor cannot undo it.

**The Simulator's picture follows the turn.** serve-sim keeps sending
portrait-sized frames, and takes touches in the portrait frame's own space,
after the Simulator turns (measured on serve-sim 0.1.46 and 0.1.48: in
landscape the content sits sideways in the frame, and a touch at frame
fraction `(x, y)` lands at `x` of the way down the landscape screen and `y`
from its right edge). The desktop's answer to a Rotate carries the orientation
it left the Simulator in, the host keeps it per Simulator until shutdown, and
the runtime snapshot lists it as `orientations`; a Simulator not listed is
taken to sit in portrait. When that says `landscape` and the frames are
portrait-sized, the pane draws each frame a quarter turn clockwise (`landscape`
is `landscape_left`), so the picture, its bezel and the side keys sit the way
the device does, and a pointer or touch on it is turned back a quarter
counter-clockwise into the frame's pixel space before it is sent. Frames that
arrive already wide are drawn as they are. The host learns the orientation when
it rotates and once when a Simulator's stream starts: the desktop reads the real
screen (the same screenshot-size read Rotate uses, never one per frame), names
it in the watch response, the host records it like a rotate does, and the
stream's own response carries it to the pane (the snapshot is not polled while
no action runs), so a
Simulator already in landscape when the pane opens, or turned from outside
Octant, is drawn upright. The orientation follows the foreground app, not the last
Rotate: after a rotate the Home screen stays portrait while apps turn, so the
host re-reads the real screen (the same screenshot-size read, asked of the
desktop as a `read-orientation` input that changes nothing) and records it like
a rotate does. It reads shortly after a Home or app-switch key press or a tap
(which may bring another app forward), and on a slow interval (every 5 seconds
at most) while a live view is open. No Simulator is read more than once every 2
seconds, and never per frame; the pane picks the change up with its next
snapshot. The Android emulator streams rotated frames and needs none of this.

Rotate is an effect, not input. Only a person (`local-user` or
`remote-device` in `requestedBy`) may ask for it; an agent or the host is
refused. Plan refuses it; Full access sends it unasked; on an approval-gated
thread each Rotate raises its own confirmation, and Allow input never covers
it. Evidence and its log record `rotate to <orientation> completed` (`rotate completed` when the host chose) and
nothing from the device. The agent tools do not offer Rotate.

## Record screen

The More menu offers **Record screen** only when the host's runtime snapshot
lists `capabilities.recordScreen`; a host that predates the flag omits it and
the item is left out, never shown disabled. While the snapshot's `recordings`
lists this device the same item reads **Stop recording**. Both the Simulator
and emulator hosts report it; the Simulator host does not wait on the desktop's
device helper, because `simctl` alone records.

Recording is two actions, `start-recording` and `stop-recording`. Starting
launches the recorder and returns once it is running; the recorder outlives
the action, and the host holds it until a stop, the time limit
(`DEVICE_RECORDING_LIMIT_SECONDS`, 60 seconds), the device shutting down, or
the host closing. On the Simulator the recorder is `xcrun simctl io <udid>
recordVideo --codec=h264 --force <file>`, writing into the same host-private
`0700` capture directory a screenshot uses, with that directory granted to
this launch alone. Stopping sends the recorder SIGINT and waits for it to exit, because `simctl` writes the file only then (SIGTERM leaves it empty and the device refusing any new recorder); only after a bounded wait does it escalate to SIGTERM and SIGKILL, and a recorder that cannot be confirmed gone reports `failed`. On the emulator it is `adb shell screenrecord` with a time
limit and a 1.5 Mbit/s bit rate, so a full-length recording stays under the
artifact store's 16 MiB bound; stopping sends it SIGINT (`pkill -2`) so the
device finishes the file, then reads it with `exec-out cat` and deletes the
device copy. A recorder that ends within the first moments never started and
reports `failed`.

Stopping stores the video as a `recording` evidence artifact beside the log,
under the same rules as a screenshot: the same artifact store and size bound,
a file that is not an ordinary single-link media file, empty, or too large is
refused as `failed` with a reason, and the raw file is removed whatever the
outcome. A recording left by a host that stopped is swept with stale captures.

Authority follows Open URL: only a person (`local-user` or `remote-device`)
may ask for either action, an agent or the host is refused, `octant_apple`
does not offer them, and the contract requires `requestedBy`. Starting is an
effect: Plan refuses it, Full access starts it unasked, and an approval-gated
thread confirms it ("Record this Simulator's screen?"); Allow input never
covers it. Stopping ends what a person already approved, so it never asks
again. Serving a saved recording back to the pane is not specified yet; the
pane reports a stopped recording as saved evidence only.

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
The broker waits up to 30 s for `serve-avd` to print its ready state, because
the bundled tool needed 5 to 17 s to attach on a Mac under heavy load; a launch
still starting when a request ends keeps going and the next request joins it.
The server then allows 20 s for the stream's response and for its first
picture. A stream that still misses those limits leaves the pane on snapshots
with the reason `timed-out` or `no-frames`, and the pane asks for the stream
again after 4 s and after a further 8 s, keeping the last snapshot on screen,
and stops after that. A person sees "Live stream" without reloading when the
tool only needed more time.
When the tool is missing, exits, or does not attach in time, the broker
answers with that reason. Every Android screen stream names its transport in
`x-octant-android-transport`: `stream`, or `screencap` with the reason the
stream is not used (no desktop, not an emulator, tool missing, tool exited,
timed out, desktop unreachable, or no frames). The pane shows it as a quiet
"Live stream" or "Snapshots, live stream unavailable: …" line, and an input
sent through `serve-avd` says so in its evidence. An agent must not launch
Simulator.app, `serve-sim`, or `serve-avd`.

### Boot from the Android pane

Octant starts the emulator as `emulator -avd <name> -no-window -no-audio
-no-snapshot`: every boot is cold, and the emulator neither loads nor saves a
quickboot snapshot. A snapshot written at power-off loaded "successfully" on the
next boot and then left `adb` showing the emulator offline for minutes, so the
boot timed out; a cold boot reached the first frame in about a minute, and the
saved state is not worth that risk. The rule covers emulators Octant launches;
one the person starts themselves keeps its own snapshot behavior.

The emulator runs as the leader of its own process group, because the launcher
starts the emulator proper as a child. A boot that does not come online in time,
or is cancelled, ends that group (a polite stop, then a kill after 5 s, each
bounded) and nothing else. The group id is the process's pid, which the system
may reuse once the process is gone, so nothing is signalled after the process
Octant started has exited. Its evidence says `cleanup: "complete"` only when no
running member is left (a member that exited but was never reaped does not
count); if the group will not stop, or cannot be proven gone, the outcome is
`interrupted` with `cleanup: "uncertain"`.

### Shut down from the Android pane

Shut down is an approval-gated action like Boot: the pane raises the in-app
approval card for the whole request and, until the person answers, says on one
line that it is waiting for that approval, so a pane that is only waiting never
looks stuck. A declined or lapsed card runs nothing and says so; an approved one
sends the power-off through `adb` and the server records evidence for it,
including `timed-out` or `failed` when the emulator does not power off. No
native dialog is involved.

`reboot -p` returns once the power-off is accepted, and the emulator keeps
running while it saves its state: 10 s to about 80 s after, measured. Adb is no
witness of that wait: it lists the emulator as a device, then drops it for about
5 s while its transport restarts, then lists it as `offline` for the rest of the
save. Accepting is not stopping. From the moment the action starts the host
reports the emulator as `shutting-down` and the pane says "Shutting down" instead
of "No device running" or a live view; the pane applies that at once for a
shutdown it started rather than waiting for the next poll. The action ends only
when the serial has stayed off adb for 15 s, within a wait of up to 180 s polled
every second, and only then records `succeeded` and reports the emulator as shut
down. An emulator still listed or flapping at the end of the wait returns to
running with a `timed-out` outcome. Until the action ends, discovery keeps the
emulator as `shutting-down` whatever adb says, so a refresh cannot bring it back
as running or call it shut down. A `shutting-down` emulator is not streamed: the
host refuses a screen watch for it and the pane does not attach or reconnect the
live view, so "Live view lost" does not appear between "Shutting down" and "No
device running". A shutdown an agent (or another window) starts reaches a pane
the same way: while any emulator is not shut down the pane keeps reading the
host's runtime state every 3 s (only while visible), and it stops reading once
none runs.

`serve-avd` is keyed by serial and does not exit when its emulator does. When the
host records an emulator as stopped, by a shutdown or because discovery no longer
finds its serial on adb, it asks the desktop broker to release that serial (the
same loopback request with `release: true`), which stops the tool and drops its
session. The next emulator to take the serial then gets a fresh tool, and none
outlives its emulator.

## Accepted input limits

These limits are accepted, not pending work. They follow from the input channel
recording one request and one evidence record per input, from the host running
one device action at a time, and from what the native helper can send. Each
statement below is what the code shows today; the rationale for the non-goals
is in [ADR 0137](../decisions/0137-simulator-input-reaches-the-guest-through-a-native-device-helper.md)
and [ADR 0140](../decisions/0140-the-live-simulator-screen-is-driven-directly.md).
Anything the code does not settle is marked not verified.

**What works on the iOS Simulator's live screen.** A press and release less
than 10 px apart is a tap at the point where the press began. A longer drag is
one straight swipe, sent when the finger lifts, replayed over the drag's
duration and clamped to 80 ms through 2 s. Keys typed while the screen has
focus are sent as one text after a 350 ms pause. Return, Delete, Escape, and
the arrow keys are hardware keys, and Space types a space. Command and Control
shortcuts, and Tab, stay with the app. Home, Lock, and (where the host reports
them) Volume up and down are buttons.

**Typed text takes one of two routes on the Simulator.** Text made only of ASCII
letters A to Z, digits 0 to 9, spaces, and new lines is typed as key positions
by the native helper. That route needs a QWERTY software keyboard with an
Automatic hardware layout in the languages listed under
[Native device helper and typed text](#native-device-helper-and-typed-text), and
a keyboard it cannot read or does not accept is refused
(`keyboard-layout-unknown`, `keyboard-layout-unsupported`) rather than typed
wrong. Any other text, including punctuation, letters such as æ, ø, å, or é,
and other scripts, is copied to the Simulator's pasteboard with
`xcrun simctl pbcopy` and pasted with Command-V. The paste route does not check
the keyboard layout. If the copy fails, the action is refused as unavailable
and no key is pressed. Whether the paste lands in every field, and how the paste
key behaves on a non-QWERTY layout, are not verified on a device; the desktop
tests mock the copy and the keystroke. Characters typed on the focused screen
go to the device as typed text, so an Option-modified key arrives as the
character it produces; only Command and Control shortcuts are kept by the app.

**Pinch and multi-touch are non-goals.** The helper's touch operation takes one
point per call, and there is no second-finger operation, so the channel cannot
carry two fingers. The pane acts only on the primary pointer: a second finger
neither starts nor ends a gesture, and a secondary button does nothing on the
screen. Neither pinch nor a second finger reaches the device
([ADR 0140](../decisions/0140-the-live-simulator-screen-is-driven-directly.md)
lists pinch and other multi-touch as non-goals).

**Long press is not sent.** A press that stays within 10 px is a tap on release,
however long it was held: the duration is not part of a tap. On the managed
stream the tap is `serve-sim`'s `tap` command, and how long that holds is not
verified. When input goes to the native helper instead (no stream, or after
Device Hub took input), the helper holds the tap for 60 ms. The Android path
sends `input tap` with no hold, and how long `serve-avd` holds its tap is not
verified. A long press therefore reaches the device as a tap, not as a hold.

**Follow-the-finger drag is not sent.** Nothing reaches the device while the
finger moves. When it lifts, the whole drag is one swipe from where the press
began to where it ended, or to the screen edge where it left the screen, drawn
as a straight line. Its steps are about 16 ms apart over the drag's duration,
so a drag longer than 2 s is replayed in 2 s, and a curved path arrives as a
straight one. A slow drag that holds still before it moves is the same swipe.
The Android pane sends the same straight swipe with `input swipe` (or
`serve-avd`'s swipe). The reason is the same as for multi-touch: a stream of
move events would be dozens of journaled actions per drag, or an unjournaled
side path, which [ADR 0062](../decisions/0062-simulator-frame-input-transport.md)
rejects, and gestures that depend on the path or on holding still need touch
phases on the channel, which is a separate decision about what an input session
records ([ADR 0140](../decisions/0140-the-live-simulator-screen-is-driven-directly.md)).

**The still-image fallback** takes a click as a tap at the same place. It sends
no swipe and no keys from the picture itself. The toolbar's Type text still
applies.

**Android typing has no character check in the host.** Text goes through
`adb shell input text`, with spaces sent as `%s` and the whole word quoted for
the device shell, or through `serve-avd`'s text action. The Simulator's
character rule does not apply. What the emulator types for punctuation,
non-Latin letters, or a new line is not verified.

**Not yet verified on a device.** The packaged run on Xcode 27 that exercises
these limits end to end, and any Android emulator run, are manual device checks
still open (see Verification).

## Verification

- Server: `apps/server/src/apple/appleToolchainService.test.ts`,
  `apps/server/src/android/androidToolchainService.test.ts`, and
  `apps/server/src/android/serveAvdBrokerClient.test.ts`.
- Desktop: `apps/desktop/src/simulatorDeviceHelper.test.ts`,
  `apps/desktop/src/serveAvdBroker.test.ts`, `managedToolRelease.test.ts`, and
  `managedToolService.test.ts`.
- Rendered input on a real Simulator or emulator remains a manual device check.
