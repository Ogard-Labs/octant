# 0162. Managed npm device tools share one release channel

**Status:** Proposed

## Context

The iOS Simulator and Android emulator panes benefit from upstream streaming
tools (`serve-sim`, `serve-avd`). Shipping them raises the same questions the
Computer-use driver answered (decision 0113): which build runs, how it is
verified, and how it stays current — but the distribution shape differs.

- The tools are published on npm, not GitHub releases. npm signs nothing per
  package: a packument's `dist.integrity` (sha512 over the tarball) is the
  strongest checkable claim, and a tampered manifest can pair any bytes with
  a matching hash. Verification can pin URL plus hash and refuse honest
  disagreement; it cannot prove publisher identity the way the driver's
  signature check does.
- The packaged app contains no npm or Bun, so an in-app update cannot shell
  out to a resolver. A tool update needs its dependency closure resolved in
  the app itself.
- The tools' tarballs contain adhoc-signed universal Mach-O payloads
  (`serve-sim` ships a `.node` addon, a camera-injector dylib, and helper
  executables). App-level deep-sign and notarization already cover helper
  payloads in Resources.
- A second bespoke updater beside the driver's would duplicate the
  check/stage/apply state machine every managed binary needs.

## Decision

One managed tool release channel serves any npm-distributed tool, with the
driver's GitHub channel kept for binaries only.

- `managedToolRelease.ts` is the channel: a per-tool descriptor (package
  name, entrypoint, platforms), a pinned bundled release (version, tarball
  URL, sha512 integrity), integrity verification, allowlisted tar entry
  extraction (no absolute paths, no `..`, no `:`), manifest identity checks,
  and an atomic `current.json` commit.
- `planDependencyClosure` resolves `^`/`~`/exact ranges against packument
  versions into a flat `node_modules` tree, nesting under the owning package
  on conflict, bounded to 64 packages and per-package integrity verification.
  The same code stages the bundled tools at package time and their updates
  inside the installed app.
- `managedToolUpdates.ts` generalizes 0113's state machine
  (check → stage → apply-when-idle, daily cadence, honest `failed` states);
  `computerUseDriverUpdates.ts` delegates to it.
- Activation launches the staged entrypoint under the desktop runtime
  (`ELECTRON_RUN_AS_NODE`, `process.execPath`) and adopts it only when it
  survives a short smoke window; a tree that cannot start keeps the previous
  release. No upstream installer or lifecycle script ever executes.
- `managedToolService` owns the instances, exposes `launchSpec`/`trackProcess`
  for pane transports, persists the automatic-update preference under
  `userData`, and reports per-tool status over three IPC channels to a
  "Device tools" Settings section.

Phase one ships the channel, the vendored tools, updates, and the Settings
surface. The Simulator pane attaches serve-sim for a booted Simulator and
keeps the native device helper when that stream is absent. The Android pane
attaches serve-avd for an already booted emulator serial and keeps adb
screencap and input otherwise. Boot still uses the emulator binary. Neither
pane starts a tool in a way that boots a device.

## Consequences

- Verification is package-level integrity, honestly weaker than the driver's
  signature story; a registry or account compromise that republishes a
  manifest could pair bad bytes with a consistent hash. Pinning the bundled
  release at package time keeps the shipped floor intact, and updates that
  disagree with their declared hash are refused.
- New managed npm tools cost a descriptor plus a bundled-release row, not a
  new updater — the stated motivation for generalizing.
- The in-app resolver implements only the range forms the tools' manifests
  use today; an upstream release declaring anything else fails honestly and
  keeps the previous version rather than resolving incorrectly.

## Related

- [0113](0113-computer-use-plugin-and-driver-updates.md) — the driver channel
  this generalizes.
- [0053](0053-computer-use-destinations.md) — destination-shaped capability
  posture the panes inherit.
