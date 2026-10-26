# Mobile maturity phases beyond remote control

Phase B internal TestFlight distribution is authorized by
[0147](decisions/0147-internal-testflight-carries-the-existing-remote-client.md).
The remaining phases (Android internal builds, redacted push, capture and
voice, public store distribution) were authorized by the maintainer on
2026-10-26 as post-preview work, design-first: each is built only once its
owning specification documents its authority, privacy, and release
boundaries. Public App Store / Play distribution stays outside the first
release (Current Release Boundary in `AGENTS.md`), and store submission,
account creation, and spending each still need a separate explicit maintainer
action. The Expo remote-control client itself remains
in scope as a remote principal ([0013](decisions/0013-remote-access-and-mobile.md)).

Today mobile is a paired remote-control client: inbox of threads, live control,
approvals within remote policy, lightweight review. It is not a host, provider
runtime, filesystem root, or relay.

## Phases

Each phase needs its own architecture update before implementation; the
maintainer request was given for all of them on 2026-10-26. Earlier phases do
not imply later ones.

### Phase A — Harden remote control

Ship and dogfood the Expo client as remote-only: pairing, session TTLs,
biometrics for high-risk acts, honest stale/read-only when disconnected,
redacted notifications. Threat model:
[mobile-remote-control-threat-model](security/mobile-remote-control-threat-model.md).

Exit: daily remote steer and approve without wanting a second product on the
phone.

### Phase B — Device builds of the same remote client

Internal and TestFlight / Play internal tracks for the **same** Expo remote
client. Still not a public store listing. Signing and CI live with maintainer
credentials; _public_ store distribution is Phase E, not part of this phase
(see [mobile-store-v1-hold](mobile-store-v1-hold.md)).

Status: iOS internal TestFlight setup and device acceptance are active under
[0147](decisions/0147-internal-testflight-carries-the-existing-remote-client.md).
Android internal distribution remains unstarted.

Exit: testers install without a laptop sideload ritual.

### Phase C — Push that respects host authority

Host-originated push for approvals and run state. Payloads stay redacted;
tokens register per device on the host; revoke drops push with the device.
No push path bypasses remote-approvable vs local-host-required
([0013](decisions/0013-remote-access-and-mobile.md)).

Exit: a locked phone can surface a waiting approval without leaking secrets.

### Phase D — Capture and voice as input only

Photo/file capture and voice into the composer as ordinary remote inputs.
Processing and tool execution stay on the host. No on-device agent loop, no
local checkout authority.

Exit: attach evidence and dictate prompts without elevating the phone.

### Phase E — Public store distribution (post-preview)

App Store and Play listings for the remote client, after privacy/review
packaging and a specification of its boundaries; preview dogfood of A–D is the
recommended order. This phase is **post-preview**, authorized on 2026-10-26.
It is not part of the Apple Silicon technical preview, and each store
submission needs its own maintainer action.

## Boundaries between phases

Store distribution is Phase E and post-preview. Phases B–D must not sneak in
public listing, end-user cloud accounts (push/relay/hosted identity beyond the
host), or phone-side authority. Maintainer-owned Apple and Google developer
accounts for TestFlight / Play internal tracks in Phase B stay allowed.

## Start gate

Implementation of any phase may leave Backlog only when that phase has:

1. An architecture update that documents its controls, extending the
   remote-access rules.
2. Threat-model coverage for new device sensors or push.
3. An explicit maintainer request naming the phase (given for every phase on
   2026-10-26).

Phase E additionally requires a release-boundary update in the same PR that
opens store work.
