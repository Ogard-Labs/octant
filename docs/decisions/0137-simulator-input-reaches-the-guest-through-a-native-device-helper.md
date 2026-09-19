# 0137. Simulator input reaches the guest through a native device helper

**Status:** Accepted

## Context

0062 put tap, typed text and hardware keys on the Apple workbench channel and
left the delivery to a host adapter, `injectSimulatorInput`. The only adapter
that shipped scripts the Simulator application's window through macOS
Accessibility.

Observed on a Mac with Xcode 27: there is no Simulator application. Devices
run headless under CoreSimulator, `simctl` has no input command, and the
scripted adapter fails by construction. Three other routes were tried on that
host before this one:

- The host-side HID client the Simulator application used. It accepts every
  message and reports success; a tap, Home and Lock sent through it moved
  nothing on a freshly booted device.
- The device window of Xcode's device manager, driven by accessibility. Its
  bridge to the guest's elements came up empty more often than not, so a tap
  on a plainly visible row failed with no element at the point; when it
  worked, a key took about 1.3 seconds and only letters and digits arrived.
- `simctl pbcopy` with a paste chord, as a way to type any text. The command
  exits 0 and the Simulator's pasteboard stays empty.

What does work: from CoreSimulator 1155.4 the guest runs an input daemon that
takes plain XPC messages — touch phases at a fraction of the screen, keyboard
usages, hardware-button usages — over a connection built from a Mach port the
device's own launchd vends. Measured against a booted iPhone on that host: a
tap landed in 65 ms, fifteen typed characters in 82 ms, a swipe turned the home
screen's page, Home returned to it. Nothing came to the foreground.

Reaching that daemon needs CoreSimulator's private device lookup and two
private XPC entry points. That cannot run inside the confined process port the
server uses for `simctl`, and it is not something a TypeScript process can
call.

## Decision

- **A native helper delivers Simulator input.** `octant-device-helper` is a
  Swift executable built from `apps/desktop/native/device-helper`, compiled
  with `swiftc` at build and package time like the Keychain and Code file
  helpers, shipped under `Contents/Resources/native`, and signed with the
  bundle. It takes one Simulator identifier as its only argument, speaks
  length-prefixed JSON on stdin and stdout, answers every request once, and
  exits when stdin closes, so it never outlives the desktop that started it.
- **The desktop owns it.** The Electron main process starts one helper per
  Simulator on first input, stops it after two minutes idle or when it fails
  to answer inside the action's deadline, and stops every helper on quit. A
  loopback, token-guarded broker (`OCTANT_SIMULATOR_DEVICE_BROKER_URL`,
  `OCTANT_SIMULATOR_DEVICE_BROKER_TOKEN`) lets the desktop's own server child
  reach it; the variables are stripped from every process the server spawns,
  as the other broker variables are.
- **The transport is still 0062's.** The renderer and `octant_apple` post the
  same structured requests; the server checks authority and approval, then its
  `injectSimulatorInput` adapter hands the input to the desktop. Evidence,
  actor attribution, retry rules and the remote and headless fail-closed gate
  are unchanged. The scripted Accessibility adapter remains the fallback for a
  host with no desktop broker.
- **A tap is a point on a captured screen.** The helper reports the device's
  screen size in pixels, which is the space a capture is in, and the desktop
  divides. A point outside that screen is refused, not clamped to an edge. A
  tap that names an element instead of a point is reported unavailable: the
  helper reads no accessibility tree.
- **Typed text is sent as key positions, and only where that is known to be
  right.** A keyboard usage names a position; the guest turns it into a
  character with its own hardware layout, which follows the Simulator's
  keyboard language and not the Mac's. Observed on a Norwegian Simulator: the
  usage that types "-" on a US layout typed "+". Two rules follow. Only
  letters, digits, space and new line are typed; any other character refuses
  the whole string before the first key, and the refusal does not quote the
  text. And they are typed only on a Simulator whose keyboard keeps those keys
  where a US keyboard has them: the helper reads the guest's own keyboard
  record (`nb_NO@sw=QWERTY-Norwegian;hw=Automatic`), and types when the
  language is one of a short list (English, the Nordic languages, Dutch,
  Spanish, Portuguese), the software layout is QWERTY and the hardware layout
  is Automatic. French is AZERTY with symbols on the unshifted digit row,
  German swaps Y and Z, Turkish moves I: there, and wherever the record cannot
  be read, typing is refused rather than typed wrong.
- **Refusals are the helper's own.** No such device, not booted, toolchain
  missing, the guest vends no input service, the daemon did not answer its
  liveness probe (retried three times, because its start races the guest's
  boot), a send that was never seen leaving (the connection is dropped and the
  input reported as not delivered, never as delivered), unsupported character,
  unsupported or unreadable keyboard layout, unsupported key. For typed text
  the server keeps only the refusal's code in evidence, since a host's words
  can quote what was typed. The server records a refusal
  as a failed action naming that reason, and a helper or desktop that never
  answered as unavailable.
- **Private API is loaded at run time, never linked.** The helper `dlopen`s
  CoreSimulator from the path Xcode installs it to and resolves the XPC entry
  points with `dlsym`, so a Mac without Xcode gets a refusal rather than a
  launch failure, and the build needs no private SDK.
- **Two source files are vendored.** The message models and the XPC encoder
  that serializes them are copied unmodified from an MIT-licensed open-source
  simulator control library, with its license and the exact upstream commit
  beside them in `vendor/simulator-hid`. They depend on Foundation and XPC
  only. The maintainer approved that dependency; everything else in the helper
  is Octant's own.

Non-goals: a toolchain older than CoreSimulator 1155.4 (the helper refuses
with the guest vending no input service; the older transport could not be
observed working on any available host, so it is not shipped), streaming the
screen, swipes and multi-touch as workbench actions, characters outside the
safe set, physical devices, and rotated screens.

## Consequences

- Input from the pane and from agents lands in tens of milliseconds and no
  longer depends on a window, on Accessibility permission, or on what is in
  the foreground.
- Octant ships a third native helper, and it uses private Apple interfaces.
  Developer ID distribution permits that; a Mac App Store build would not,
  and 0034 does not plan one. A CoreSimulator release can change the wire
  shapes; the vendored files are the part to re-sync, and the helper's
  liveness probe turns a silent mismatch into a named refusal.
- The helper's protocol already carries touch phases and swipes, because a
  live, directly driven device surface needs them. They were observed working
  against a booted Simulator and are not yet reachable from the workbench
  channel.
- Typing punctuation needs the guest's layout and is a known gap, stated in
  the guide rather than typed wrong.

## Related

- 0062 Simulator frame input rides the Apple workbench channel
- 0043 Simulator follows the active thread
- 0034 Signed, notarized, user-controlled updates
- 0053 Computer-use destinations and fail-closed hosts
