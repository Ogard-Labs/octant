# 0013. Remote access: single host, paired devices, and mobile

**Status:** Accepted

## Context

Users want to watch, steer, and approve agent work from a browser on another
machine or from a phone while the work stays on their own host. Hosted relays
and cloud accounts would break local-first and privacy defaults; a remote
client that inherits desktop authority would break the security model. Octant
also expects to run headless and to federate several hosts later, so the wire
contracts must not assume one machine even though the first release serves
exactly one.

## Decision

- The desktop-owned host is the source of truth. There is no Octant cloud
  account, relay, public ingress, or port forwarding. Supported paths are
  authenticated HTTPS over LAN or a user-controlled private mesh; user-managed
  SSH tunnels are compatible but not created or supervised.
- One server process and one store expose two listener trust classes: the
  existing loopback local-control listener (full API, desktop bridge, local
  launch session) and an opt-in HTTPS-only remote listener bound to one
  user-selected private address and explicit port that serves web assets,
  bounded hello and pairing endpoints, and authenticated product routes only.
  Local-only administration is never reachable remotely. Non-loopback HTTP is
  never supported; certificate validation is never disabled or bypassed.
  Wildcard, public, or ambiguous binds are rejected. Enabling or retargeting
  the listener requires a local packaged-host confirmation showing address,
  port, origin, certificate identity, and exposure class.
- Pairing uses a short-lived single-use ticket approved on the host. The
  durable credential is the client's non-exportable key plus the host's device
  record, not a reusable bearer token. Sessions have idle and absolute TTLs
  and rotate; every state-changing request carries a device-key proof, replay
  nonce, CSRF value, and exact origin checks. A cookie alone never authorizes
  anything. Revocation drops all sessions and streams before the response
  completes; host-key rotation revokes every device. Devices are the unit of
  inventory: label, expiry, coarse last-seen, self sign-out; full inventory,
  approve, revoke-others, and policy stay local-host only.
- Route handlers receive one strict `ClientPrincipal` (local window or remote
  device) from a shared authentication layer and never parse cookies, device
  headers, or origins themselves. Services re-resolve mode, Project, thread,
  provider, tool, root, and approval authority immediately before side
  effects. A remote principal never exceeds host, mode, provider, Project,
  thread, tool, or approval policy and can never be converted into a local
  principal or mint a native receipt.
- Approvals are classified in the policy catalog as `remote-approvable` or
  `local-host-required`. Pairing, listener and device management, root
  binding or relink, remembered Full access, extension trust and install,
  provider credentials, host-key rotation, and native-only actions are
  local-host-required. Missing or unknown actions default to
  local-host-required or unavailable, never allowed.
- Remote clients reconnect by sequence-based replay of the same versioned
  contracts desktop uses. Disconnected data is explicitly stale and read-only;
  authority-bearing mutations are never queued offline. Paths, credentials,
  and parser internals never appear in remote responses.
- Every entity is addressed as `{ hostId, entityId }` from the first thread,
  and every creation surface shows a host selector even while there is one
  implicit host, so multi-host federation later is a client-runtime and
  registry addition, not a redesign. In federation, clients hold independent
  connections per host and merge read models client-side; hosts never
  communicate with or trust each other, and provider tokens, credentials, and
  filesystem authority never cross hosts.
- Octant Mobile is a native remote-control client for iOS and Android built on
  the same contracts, pure domain, and client runtime, living in the same
  monorepo. It is not a host, provider runtime, filesystem root, or relay. It
  pairs as its own device with keys in platform secure storage, may run
  concurrently with desktop and browser sessions (approval decisions are
  single-winner on the host), and gates vault unlock and high-risk actions
  (approve, reject, merge, revoke, destructive thread actions) behind
  biometrics with passcode fallback. Its shape is agent-first: an inbox of
  threads across hosts, live thread control, approvals, and lightweight diff and
  PR review; no editor, no desktop shell.

## Consequences

- Remote use costs a deliberate opt-in and a real certificate; in exchange
  there is no third party in the path and no persistent bearer secret in the
  browser.
- The principal boundary keeps every product route honest for both local and
  remote callers, which also simplifies review of new routes.
- Federation and headless hosts can arrive without changing thread identity,
  contracts, or the UI pattern; only a registry and connection layer are added.
- Mobile shares logic through packages, not copied UI, so contract changes
  land once for every client.

## Related

- 0002 Durable event journal
- 0003 Product modes and authority
- 0009 Sandbox confinement, approvals, and Plan mode
