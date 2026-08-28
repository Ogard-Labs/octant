# Design note: mobile store distribution out of V1

This note records a hold. It does not authorize App Store or Play submission
work.

## Hold

**Public mobile store distribution is outside V1 / the first release.**

The Current Release Boundary in `AGENTS.md` states the first release is the
Apple Silicon technical preview with the provider-neutral plugin/skill
marketplace, and lists native mobile store distribution among items not to add
unless a decision record and an explicit request authorize that scope.
[Roadmap Later](roadmap.md#later) defers mobile maturity (including public store
distribution) until designed.

## What stays in scope

The **Expo remote-control client** (`apps/mobile`) remains in scope as a remote
principal: pair to the user's host over LAN or a user mesh, steer threads,
approve within remote policy
([0013](decisions/0013-remote-access-and-mobile.md)). Sideload, Simulator, and
internal TestFlight / Play internal tracks may appear in later mobile maturity
phases ([mobile-maturity-phases.md](mobile-maturity-phases.md)) without opening
a public listing.

Remote control ≠ store packaging. Confusing them would either pull review and
listing work into the preview or wrongly defer the remote client itself.

## What stays out

- Public App Store and Google Play listings and review submissions
- Store-required cloud accounts or Octant-operated mobile backends
- Treating store presence as a gate for remote-control dogfood

## What would reopen it

All of the following, in one coherent change set:

1. Mobile maturity phases A–D dogfooded enough that store distribution is the
   remaining gap ([mobile-maturity-phases.md](mobile-maturity-phases.md)).
2. A decision record updates or extends 0013 / the release boundary for public
   listing, privacy copy, and signing ownership.
3. An explicit maintainer request authorizes that scoped store work.

Until then the parent Later item's store-distribution slice stays a reviewable
hold, not an implementation backlog.
