# Design note: mobile store distribution out of V1

**Authorized post-preview on 2026-10-26, design-first.** The maintainer
unlocked public store distribution of the remote client as post-preview work.
It is built only once its owning specification documents its authority,
privacy, and release boundaries. Submitting to the App Store or Google Play,
creating a store or developer account, and spending money each still need a
separate explicit maintainer action. The hold below is kept as the record of
why store work stayed out of the first release; it still holds for the
technical preview.

## Hold (first release)

**Public mobile store distribution is outside V1 / the first release.**

The Current Release Boundary in `AGENTS.md` states the first release is the
Apple Silicon technical preview with the provider-neutral plugin/skill
marketplace, and lists mobile maturity, including public store distribution, among the
post-preview tracks authorized on 2026-10-26 and built design-first.
[Roadmap Later](roadmap.md#later) lists the mobile maturity track.

## What stays in scope

The **Expo remote-control client** (`apps/mobile`) remains in scope as a remote
principal: pair to the user's host over LAN or a user mesh, steer threads,
approve within remote policy
([0013](decisions/0013-remote-access-and-mobile.md)). Sideload, Simulator, and
internal TestFlight / Play internal tracks may appear in later mobile maturity
phases ([mobile-maturity-phases.md](mobile-maturity-phases.md)) without opening
a public listing.

The iOS internal TestFlight slice is now authorized by
[0147](decisions/0147-internal-testflight-carries-the-existing-remote-client.md).
It creates the private App Store Connect record needed for build processing but
does not prepare or publish a public product page.

Remote control ≠ store packaging. Confusing them would either pull review and
listing work into the preview or wrongly defer the remote client itself.

## What stays out of the technical preview

- Public App Store and Google Play listings and review submissions
- Store-required cloud accounts or Octant-operated mobile backends
- Treating store presence as a gate for remote-control dogfood

## What would reopen it (historical)

The maintainer request in item 3 was given on 2026-10-26. Item 2 is now the
design-first condition for store implementation, and item 1 is sequencing
advice rather than a gate:

1. Mobile maturity phases A–D dogfooded enough that store distribution is the
   remaining gap ([mobile-maturity-phases.md](mobile-maturity-phases.md)).
2. The architecture's remote-access rules and the release boundary are updated
   for public listing, privacy copy, and signing ownership.
3. An explicit maintainer request authorizes that scoped store work.

Until that specification exists, store-distribution work is design, not
implementation.
