# 0058. One desktop app across macOS, Linux, and Windows

**Status:** Proposed

## Context

The first surface was Apple Silicon macOS because that is the maintainer's
daily driver, not because Octant is a Mac-only product. ADR 0034 and the
release boundary deferred Intel macOS, Windows, and Linux desktop packaging.
Headless Linux Stations (0031, 0048, 0054, 0057) already run the server without
Electron. Users still need the same Electron Machine on every OS: one product,
not a Mac app plus a thinner Linux/Windows shell.

## Decision

- Octant desktop is **one identical app** on macOS, Linux, and Windows. Platform
  differences are technical fail-closed posture, never a second product.
- 0034 stays `Proposed` and is revised in place in this same change: its rule
  that Intel, Windows, and Linux desktop packaging stay outside the release
  boundary is narrowed to open desktop packaging under its own signing rules.
  Every other 0034 rule stands:
  trust from signatures, fail-closed verification, user-controlled apply, and
  minimum update-check disclosure.
- **Machine shape.** A Linux or Windows desktop install is a peer Machine
  ("This computer"), same as "This Mac". The Electron process always owns the
  local server lifecycle. It does not attach to a foreign `octant server`.
- **Product surfaces.** Chat, Work, Code, approvals, terminals, Git, provider
  CLIs, and remote pairing ship on every desktop OS, with one exception:
  Windows Work and Code stay `incompatible` until a Windows confinement ADR
  exists (see Confinement). Computer-use ships when the
  destination driver reports support (0053). Simulator and Apple workbench stay
  macOS-only and fail closed. Vibrancy stays macOS-only. The host tray is
  portable via Electron Tray / AppIndicator with non-template icons.
- **Confinement.** macOS keeps Seatbelt. Linux desktop Work/Code uses Bubblewrap
  (0057). Capsules (0048) remain Station-only. Windows Work/Code stay
  `incompatible` until a Windows confinement ADR exists; Windows packaging
  follows Linux + macOS desktop parity.
- **Credentials and native helpers.** Desktop uses the host-runtime credential
  store (0054): Keychain on macOS, Secret Service on Linux, Credential Manager
  when Windows lands. Off macOS, skip every `swiftc` helper. Replace openers with
  `xdg-open` / portals on Linux and Explorer / `shell.openPath` on Windows.
- **Artifacts.** Unpackaged Electron is a valid first ship. Ubuntu dogfood next
  targets AppImage, then `.deb`. Flatpak waits on its own design (sandbox vs
  bwrap and Secret Service).
- **Updates.** Self-update is required on every platform. One compiled-in
  Ed25519 public key and one feed schema; feeds are per `platform` / `arch`.
  No update channel exists for a platform until that platform's artifact is
  signed. Signing and feed publish run through the release GitHub Actions
  pipeline. An updater on an unsigned build remains forbidden.

## Consequences

- Implementation is sequenced: Linux desktop shell (skip Swift, Secret Service,
  unpackaged launch, tray), then Ubuntu-dogfood AppImage packaging (unsigned;
  dogfood AppImage ≠ signed auto-update), then release-matrix scaffolding for
  `<ring>/linux-x64.json` beside `darwin-arm64.json` (in-app Linux channel
  still fail-closed until a signed feed is published), then Windows confinement
  + credentials + packaging.
- `apps/desktop` build must not require `swiftc` on Linux/Windows. Packaging
  scripts grow non-`.app` targets (Linux AppImage via the same
  `package:desktop` entry) without deleting the Apple Silicon path.
- Roadmap and the agent release boundary stop treating Linux/Windows desktop as
  unconditionally deferred; Windows Work/Code remain blocked on a future ADR.
- Headless Station work (0048) stays separate from desktop Electron parity.

## Related

- 0034 Signed, notarized, user-controlled updates
- 0054 The credential broker is a host capability, not a desktop one
- 0057 Linux confinement uses Bubblewrap as a scoped exception
- 0048 Linux Stations isolate Code work in execution capsules
- 0053 Computer-use destinations
- 0009 Sandbox confinement, approvals, and Plan mode
