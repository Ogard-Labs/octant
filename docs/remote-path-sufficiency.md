# Research: LAN / Tailscale / SSH remote paths for dogfood

**Authorized post-preview on 2026-10-26, design-first.** The maintainer
unlocked a ciphertext-only hosted relay as post-preview work. It is not part of
the technical preview, and it is built only once its owning specification
documents its authority, privacy, and release boundaries, including the six
invariants below. Deploying a hosted relay, creating an account for it, and
spending money on it each still need a separate explicit maintainer action.
LAN, Tailscale, and SSH stay the default remote paths; the assessment below is
kept as the record of why.

[0013](decisions/0013-remote-access-and-mobile.md) already defines remote
access: authenticated HTTPS over LAN or a user-controlled private mesh;
user-managed SSH tunnels are compatible but not created or supervised. There is
no Octant cloud account, relay, or public ingress.

## Question

Do those user-network paths fall short for real dogfood of remote browser and
mobile clients? If yes, what properties would a ciphertext-only relay need
without holding authority?

## Assessment (evidence before the unlock)

**No gap that justified a relay before the unlock.** At the time of this
research, the recommendation was to keep the item closed until dogfood produced
a concrete failure that LAN, Tailscale, or SSH could not fix.

Observed and expected shapes that look like "relay demand" but are not:

| Symptom                                         | Usually caused by                      | Prefer                                                            |
| ----------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------- |
| Phone cannot reach host off-home Wi-Fi          | No mesh; CGNAT; host asleep            | Tailscale (or similar) on host and phone; wake policy             |
| Browser on another LAN machine fails TLS        | Wrong bind, cert trust, HTTP attempted | Existing remote listener rules in 0013                            |
| SSH tunnel works but is fiddly                  | User-managed tunnel UX                 | Docs and pairing polish; still not a relay                        |
| Corporate laptop cannot join personal Tailscale | Policy, not product                    | Stay on that org's mesh or SSH; Octant must not become the bypass |

A relay becomes interesting only when several independent dogfooders hit the
same hard stop: reachable ciphertext path between an already-paired device and
an awake host is impossible without a third party, after Tailscale/SSH were
tried and documented. A relay that became required would invent a cloud
dependency against the local-first default, so any relay stays optional and
the user-network paths stay the default.

## Invariants any relay must keep

Any relay must not break these invariants (ciphertext-only, no authority):

1. **Ciphertext only.** The relay sees opaque bytes. It cannot decrypt product
   traffic, session proofs, or pairing material.
2. **No authority.** The relay is not a principal. It cannot approve, revoke,
   elevate, mint device credentials, or speak for the host.
3. **Host remains source of truth.** Mode, Project, thread, provider, and
   approval checks stay on the host ([0013](decisions/0013-remote-access-and-mobile.md)).
4. **No Octant account required.** Pairing stays host-approved device keys; a
   relay login must not become product identity.
5. **Fail closed when the relay is gone.** Disconnected clients stay stale
   read-only; they never queue authority-bearing mutations for the relay to
   deliver later.
6. **Specification first.** Opening a relay requires updating the architecture's
   remote-access rules and the Current Release Boundary in the same change that
   authorizes implementation.

## Start gate (historical)

The maintainer opened the relay on 2026-10-26 without waiting for item 1.
Item 2 remains the design-first condition, and item 3 has been met. The gate
read:

1. Written dogfood evidence names the concrete reachability failure and why
   LAN, Tailscale, and SSH each failed or were unavailable.
2. A proposed architecture and Current Release Boundary update lists the six
   invariants above (or a tighter set) and how the design meets them.
3. An explicit maintainer request authorizes scoped work against that update.

Dogfood evidence of a reachability failure remains the best input for the
relay's design; its absence no longer holds the track back.
