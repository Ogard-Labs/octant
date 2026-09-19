# Octant Mobile

Expo iOS/Android remote-control client (`@octant/mobile`).

## Status

The remote-control vertical slice, Distilled shell, Chat create,
host-advertised models, deep-link navigation, inbox honesty, and Work create
are on `main`. Internal TestFlight distribution is the active device-build
track. Voice, push, and a public App Store listing stay deferred.

## Threads and storage

Chat / Work / Code threads are **host-owned**. The phone is a remote client:
creates and follow-ups go to the host over authenticated remote-access routes and land
in the host’s SQLite journal (`octant.sqlite3` under `OCTANT_DATA_DIR` /
Application Support). The phone does not keep a separate IndexedDB/SQLite thread
database — only device keys, host registry, and session material locally.

## Develop

From the monorepo root (Bun 1.3+):

```bash
bun install
bun run --filter @octant/mobile typecheck
bun run --filter @octant/mobile test
bun run --filter @octant/mobile start
```

`start` launches the Expo dev server. Use an iOS Simulator, Android emulator,
or Expo Go / dev client on a device on the same network as a reachable host
listener (pairing arrives in A2).

## Mock UI review

The development-only mock workspace exercises the real mobile screens and
contract decoders without pairing a host or making network requests. It keeps
all session state in memory and displays a persistent `Mock data` banner.

```bash
# Rich Chat, Work, and Code threads plus ready, stale, and unavailable hosts
bun run --filter @octant/mobile start:mock

# A stale-host failure state for recovery and disabled-action review
bun run --filter @octant/mobile start:mock:stale
```

Both commands clear the Expo cache so changing scenarios is deterministic. To
return to live host-backed development after running a mock scenario, clear the
cache once as well:

```bash
bun run --filter @octant/mobile start -- --clear
```

Mock mode is accepted only by a development bundle. Production configuration
omits the scenario entirely, and production code fails closed to live mode.
The mock workspace never reads the paired-host registry, registers push tokens,
opens a remote session, or persists mock thread content.

## Internal and TestFlight builds

EAS profiles live in `eas.json`:

- `development` — dev client, internal distribution
- `preview` — direct internal-distribution artifacts
- `production` — App Store-signed iOS artifact for internal TestFlight

The app is linked to the maintainer-owned `@henrikogard/octant-mobile` EAS
project and App Store Connect record. A local production build can be queued
from this directory after EAS credentials are configured:

```bash
cd apps/mobile
eas build --profile production --platform ios
```

The repository's manually dispatched `Mobile (TestFlight)` GitHub workflow is
the canonical build path. Its protected `mobile-testflight` environment keeps
the Expo token off pull requests and limits builds to `main`; its `submit`
input decides whether a successful build is also uploaded to TestFlight. An
upload does not submit an App Store version for review.

See [`docs/mobile-testflight.md`](../../docs/mobile-testflight.md) for the
credential boundary, setup checklist, and device acceptance pass.

## Design

- Decision record: `docs/decisions/0013-remote-access-and-mobile.md`
- Distribution decision: `docs/decisions/0136-internal-testflight-carries-the-existing-remote-client.md`
- Threat model: `docs/security/mobile-remote-control-threat-model.md`
