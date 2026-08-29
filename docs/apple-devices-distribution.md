# Apple physical devices and distribution path

Design only. Does not pull TestFlight or App Store submission into the
technical preview. The first-release Apple loop stays Simulator and local macOS
on Apple Silicon ([0043](decisions/0043-simulator-follows-the-active-thread.md),
superseding surface of [0014](decisions/0014-apple-development-capability.md)).

## Capability split

Three layers sit on the same app-managed Apple workbench. They must not collapse
into one "devices" flag.

| Layer           | What it is                                                                                     | Preview                                 |
| --------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------- |
| Simulator       | Host-owned Simulator destinations, live frame, build/run/test, evidence                        | In scope (0043)                         |
| Physical device | `devicectl` / paired hardware destinations, provisioning profiles, device logs and screenshots | Later design; not preview               |
| Distribution    | Signing for release, TestFlight, App Store Connect submission                                  | Later; outside Current Release Boundary |

Physical device support reuses Simulator rules where they fit: stable
destination identity, leases so threads cannot steal each other's device,
structured actions, evidence by reference, ordinary Code approval for mutating
acts, read-only observation without checkout writes.

It adds what Simulator does not: developer portal membership, provisioning,
UDID inventory, and codesign identity selection. Those are host-local secrets
and admin acts — never remote-approvable, never journaled as raw material.

Distribution is a third layer. Shipping to TestFlight or the App Store is a
user-owned delivery target shape ([0026](decisions/0026-shipping-to-a-user-owned-target.md)
pattern), not an automatic step of "run on device." Preview must not grow a
submit button that implies store authority.

## Fail-closed on non-macOS hosts

Apple toolchain actions require a macOS host with Xcode and the selected
developer directory.

- Linux and Windows hosts report Apple destinations and tools `unavailable` or
  `incompatible`. They never approximate with a cloud Mac unless a separate
  decision opens that (none today).
- A remote client on any OS may **observe** Apple evidence the macOS host
  already produced, within remote policy. It cannot start device pairing,
  provisioning, or distribution from a remote principal
  ([0013](decisions/0013-remote-access-and-mobile.md) local-host-required
  defaults).
- Cross-platform desktop ([0058](decisions/0058-cross-platform-desktop.md)) does
  not move Apple validation off the Mac; it only clarifies that the desktop app
  elsewhere still fails closed for this capability.

## Sequencing on the Simulator loop

1. Keep Simulator workbench and right-sidebar tab correct and dogfoodable.
2. Design device destinations as peers of Simulator destinations in discovery
   and leases — still macOS-host-only.
3. Only after device run/test evidence is solid, design distribution as an
   explicit ship target with its own approvals and credentials.

## Start gate (parent Later item)

Leave Backlog until:

1. A Proposed ADR (or scoped extension of 0043/0014) separates device vs
   Simulator vs distribution and states the non-macOS fail-closed rules.
2. Provisioning and signing material use the credential broker / host secret
   store pattern; no plaintext in the journal.
3. An explicit maintainer request authorizes the scoped slice (device-only
   first; distribution only with a boundary update).
