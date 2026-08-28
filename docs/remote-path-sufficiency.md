# Research: LAN / Tailscale / SSH remote paths for dogfood

Research and design only. Does not authorize a hosted relay. The Current
Release Boundary still excludes hosted relay unless a decision record and an
explicit maintainer request open it.

[0013](decisions/0013-remote-access-and-mobile.md) already defines remote
access: authenticated HTTPS over LAN or a user-controlled private mesh;
user-managed SSH tunnels are compatible but not created or supervised. There is
no Octant cloud account, relay, or public ingress.

## Question

Do those user-network paths fall short for real dogfood of remote browser and
mobile clients? If yes, what properties would a ciphertext-only relay need
without holding authority?

## Assessment (current evidence)

**No gap that justifies a relay yet.** Keep the Later item closed until dogfood
produces a concrete failure that LAN, Tailscale, or SSH cannot fix.

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
tried and documented. Until that evidence exists, shipping a relay would invent
cloud dependency against the local-first default.

## If a gap is proven later

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
6. **Decision record first.** Opening a relay requires superseding or extending
   0013 and the Current Release Boundary in the same change that authorizes
   implementation.

## Start gate (parent Later item)

Leave Later until:

1. Written dogfood evidence names the concrete reachability failure and why
   LAN, Tailscale, and SSH each failed or were unavailable.
2. A Proposed ADR lists the six invariants above (or a tighter set) and how
   the design meets them.
3. An explicit maintainer request authorizes scoped work against that ADR.

Absent that evidence, the answer is: **no gap — keep Later.**
