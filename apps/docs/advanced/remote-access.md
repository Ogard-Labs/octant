---
description: Authenticated LAN and Tailscale access to one Octant host, pairing, revocation, and replay.
---

# Remote Access

Octant supports authenticated remote access to **one** desktop-owned macOS
host. The desktop app remains the local owner and control surface; a remote
client serves the web renderer over an authenticated HTTPS connection.

Remote access is **disabled by default** and opt-in. The current technical
preview provides the security foundation — typed dual-listener gateway,
authenticated self-service routes, and hostile-environment evidence — while
the production remote web entry, product dispatch, pairing interface, and
device management UI remain planned. This page documents the designed
behavior; where a control is not yet available, it says so explicitly.

## How pairing works

Pairing uses a QR code or link carrying a 128-bit secret in the URL fragment,
or a 10-character human-entry code. The ticket has a **5-minute TTL**, is
single-use, and is never persisted. The page clears the URL fragment
immediately after reading it; the secret is never retained in browser
history, storage, or logs. The host approves pairing on the packaged
app, showing the device label, browser and OS class, origin, source address
class, host ID, key fingerprint, and a six-digit transcript comparison code.
Approval is host-side, never renderer-only.

Credentials are non-exportable P-256 WebCrypto keys in origin-scoped
IndexedDB. Device registrations expire after 30 days of inactivity or 90 days
absolute; sessions expire after 15 minutes idle or 12 hours absolute, with
rotation at least every 15 minutes. Key rotation requires proof of both old
and new keys. Revocation increments the device generation and cancels
sessions and streams synchronously.

After host approval, the browser stores only the non-secret device facts needed
to find that key again (key ID, device ID, credential generation, and host key
fingerprint). A page reload can therefore re-negotiate the existing device
without another pairing ticket. A missing key is surfaced as an explicit
lost-key state; an expired or revoked registration is reported to the remote
client only as a generic authentication rejection, with a clear start-over
recovery action. The local device panel retains the more specific lifecycle
reason, and no replacement key is silently created.

Browser storage loss means **re-pairing** — there is no export, sync,
recovery phrase, or localStorage fallback.

## Security properties

- **HTTPS only**, with a browser-trusted certificate (a Tailscale certificate
  or an admin-provided LAN certificate). Certificate validation is never
  disabled and no trust root is silently installed; there is no plaintext
  fallback.
- Exact-origin CORS, HSTS, CSP, `frame-ancestors 'none'`, no service worker,
  and no WebSocket in Phase 14 — HTTPS plus NDJSON replay streams.
- Tailscale is transport reachability only, never identity.
- Remote clients can never exceed host, mode, Project, thread, provider,
  tool, root, or approval policy. Pairing, listener and device admin, root
  and relink, remembered Full access, extension trust and install, provider
  credentials, and host-key rotation require a local user on the host.

## Device management

The host can rename or revoke devices, revoke all devices, and rotate host
identity from a local packaged device panel. Remote clients see only their
own metadata and can sign out or self-revoke.

## Replay and reconnect

Disconnected host data is explicitly stale and read-only; there are no
offline authority queues and no durable offline browser cache. On reconnect,
the client verifies the same host and key fingerprint, re-negotiates,
re-authenticates, fetches an authoritative snapshot, and resumes streams from
the last applied cursor. Gaps stop the stream and require a fresh snapshot —
never skip ahead. A host restart renews and replays; a host ID or key change
requires re-pairing. Revocation or expiry cancels streams and blocks
background reconnect until the user starts a new pairing flow. Remote
authentication failures remain generic to avoid revealing device lifecycle
state over the network.

## Current status

The dual-listener gateway, authenticated self-service routes (sign-out, key
rotation, self-revoke), and hostile browser and restart evidence are
integrated on `main`. The packaged host enable/disable/restart controls
now drive the server-owned private listener lifecycle over the loopback desktop
bridge — enabling, restarting an interface, and disabling operate on the real
dual-listener and report its authoritative status, and an occupied port,
interface loss, invalid certificate, or failed shutdown fails closed as a
retryable state without disturbing the loopback listener. The packaged server
composes this lifecycle controller from its own persistence graph and a host
identity provisioned under the local data directory (owner-only key material
that never leaves that boundary), so the disabled-by-default host can enable a
real listener without an injected startup configuration. Concurrent host
actions serialize onto a single lifecycle boundary so they cannot start
overlapping gateways. The browser-trusted Tailscale certificate, keychain-brokered
host-identity signing, and full macOS packaged listener QA remain environment
gates. Full production remote web entry and product dispatch are planned.

## Next steps

- [Privacy and security](/advanced/privacy-and-security) for the broader security model
- [Recovery and troubleshooting](/advanced/recovery) for reconnect and replay
- [Release compatibility](/advanced/release-compatibility) for preview boundaries
