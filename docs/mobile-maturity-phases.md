# Mobile maturity phases beyond remote control

Design only. Does not authorize store packaging or native distribution work.
Public App Store / Play distribution stays outside the first release (Current
Release Boundary in `AGENTS.md`). The Expo remote-control client itself remains
in scope as a remote principal ([0013](decisions/0013-remote-access-and-mobile.md)).

Today mobile is a paired remote-control client: inbox of threads, live control,
approvals within remote policy, lightweight review. It is not a host, provider
runtime, filesystem root, or relay.

## Phases

Each phase needs its own decision records and maintainer request before
implementation. Earlier phases do not imply later ones.

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
credentials; the release boundary for _public_ store distribution stays closed
(see [mobile-store-v1-hold](mobile-store-v1-hold.md) when that note lands).

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

App Store and Play listings for the remote client only after preview dogfood of
A–D, privacy/review packaging, and an explicit boundary change. This phase is
**post-preview**. It is not part of the Apple Silicon technical preview.

## Explicit hold

Store distribution is Phase E and post-preview. Phases B–D must not sneak in
public listing, required cloud accounts, or phone-side authority.

## Start gate (parent Later item)

Implementation of any phase may leave Backlog only when that phase has:

1. A Proposed or Accepted decision (or a scoped extension of 0013) for its
   controls.
2. Threat-model coverage for new device sensors or push.
3. An explicit maintainer request naming the phase.

Phase E additionally requires a release-boundary update in the same PR that
opens store work.
