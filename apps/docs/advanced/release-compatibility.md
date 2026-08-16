---
description: Technical-preview boundaries, data location, and release compatibility and migration notes.
---

# Release Compatibility

Octant's first release is an **unsigned Apple Silicon technical preview**:
no signing, notarization, automatic updater, Intel, Windows, or Linux
packaging. Physical Apple devices, TestFlight, and App Store distribution are
post-preview. This page records what that means for compatibility and
migration.

## Data location

Your data directory is `~/Library/Application Support/Octant` on macOS,
overridable with the `OCTANT_DATA_DIR` environment variable. The directory
and its database are created owner-only (mode 0700). Releases on other
platforms are not shipped in the preview. The source headless runtime now uses
safe XDG defaults on Linux, but packaged Linux artifacts and real-host release
validation remain post-preview work.

## Compatibility notes

- **Apple Silicon only** in the first release; the preview depends on
  macOS-native surfaces (Keychain, project confinement, Simulator).
- **Provider-neutral**: Chat, Work, and Code work with any supported
  provider. No core capability requires Codex or Claude, and no core Apple
  capability requires an optional extension.
- **Version-aware pages**: where a guide page marks a surface as planned or
  in progress, treat it as direction. The preview does not claim that every
  technical-preview workflow is documented or shipped.
- **Browser-first**: shared renderer, server-backed UI, and remote-client
  behavior are verified in a browser first; packaged Electron behavior is
  exercised only where a native boundary requires it.

## Migration notes

- **No data migration from any prior product.** Octant starts with a clean
  store and has no upstream migrations.
- **Downgrade is unsupported.** Migration is forward-only and
  checksum-verified; a failed migration aborts and restores the complete
  pre-upgrade store and host-key state.
- **Releases are not auto-applied.** There is no updater in the preview;
  install new builds explicitly and keep a backup of your data directory.

## What is excluded from the preview

- Full IDE/LSP/debugger/extension-host scope (Monaco and external-editor
  handoff are primary)
- Hosted relay, Octant cloud account, and multi-host federation
- Automatic updater, signing, notarization, Intel/Windows/Linux packaging,
  and native mobile
- Mutating PR review and merge operations
- Schedules, connector/OAuth marketplace, and data migration from current
  Octant

These are tracked on the post-preview roadmap; nothing on this page is a
commitment that a deferred capability will ship.

## Next steps

- [Privacy and security](/advanced/privacy-and-security) for local-first storage
- [Recovery and troubleshooting](/advanced/recovery) for journal-based recovery
- [Remote access](/advanced/remote-access) for the preview's single-host boundary
