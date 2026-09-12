---
description: Authenticated LAN and Tailscale access to one Octant host, pairing, revocation, and replay.
---

# Remote Access

Octant supports authenticated remote access to **one** desktop-owned macOS
host. The desktop app remains the local owner and control surface; a remote
client serves the web renderer over an authenticated HTTPS connection.

Remote access is **disabled by default** and opt-in. The current technical
preview provides the security foundation — typed dual-listener gateway,
authenticated self-service routes, and hostile-environment evidence — a
paired browser that opens the host's Chat, Work, and Code threads and sends
turns to them, and Settings → Remote access on the host for the listener,
pairing, and paired devices. This page documents the designed behavior;
where a control is not yet available, it says so explicitly.

## What a paired browser can do

After pairing or resuming, the browser shows the host's Chat, Work, and Code
thread lists. Opening a thread mounts the same thread workspace the desktop
uses — transcript, streaming replies, and composer — carried over the
authenticated session with a per-request device proof. A paired browser can:

- read Chat, Work, and Code threads and follow them live;
- create a Chat thread and send a Chat turn;
- send a follow-up on an existing Work thread;
- send a Plan-mode turn on an existing Code thread.

It cannot bind or relink a project folder, approve tool use, remember Full
access, manage provider credentials, or administer the listener and other
devices; those stay with the person at the host, and the server refuses them
for a remote principal regardless of what the browser shows. While the
connection is stale the thread stays readable, the composer keeps its draft on
the device, and sending is refused rather than queued.

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
  fallback. The browser holds the same line before it sends anything: a launch
  address that is plain HTTP to any host other than loopback is refused with an
  explanation, never used. Requests that send the window capability refuse to
  follow a redirect, so the header cannot hop onto plaintext HTTP.
- Exact-origin CORS, HSTS, CSP, `frame-ancestors 'none'`, no service worker,
  and no WebSocket in Phase 14 — HTTPS plus NDJSON replay streams.
- Tailscale is transport reachability only, never identity.
- Remote clients can never exceed host, mode, Project, thread, provider,
  tool, root, or approval policy. Pairing, listener and device admin, root
  and relink, remembered Full access, extension trust and install, provider
  credentials, and host-key rotation require a local user on the host.

## Enabling the listener and pairing from Settings

On the host, **Settings → Remote access** administers everything a paired
device depends on. It is only offered in the desktop app; a paired browser
sees an explanation instead, and the server refuses the same routes for a
remote principal.

- **Remote listener.** Enter the private LAN or Tailscale hostname, port, and
  the certificate and private key PEMs browsers will trust. Loopback and
  public addresses are refused before anything reaches the host. Enabling or
  moving the listener asks for confirmation that names the address, origin,
  and reach (Private LAN or Tailscale); cancelling changes nothing. Key
  material is sent once and is not kept in the page.
- **Pair a device.** With the listener up, create a single-use pairing link
  for the network the device will claim it over; it expires in five minutes.
  The claim then appears with its device label, origin, key fingerprint, and
  six-digit comparison code. Approve only when the code matches the device.
- **Paired devices.** Rename, revoke one, or revoke all. Revocation cancels
  that device's sessions and streams immediately.

The `octant pair`, `octant auth list`, and `octant auth revoke` commands remain
the equivalent path for a headless host.

## Device management

The host can rename or revoke devices, revoke all devices, and rotate host
identity from Settings → Remote access. Remote clients see only their
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
gates. Product dispatch to a paired browser is live for Chat, Work, and Code
threads; the desktop's sidebar, dock, and Settings are not yet served to a
remote browser. Listener and pairing administration lives in Settings →
Remote access on the host.

## Next steps

- [Privacy and security](/advanced/privacy-and-security) for the broader security model
- [Recovery and troubleshooting](/advanced/recovery) for reconnect and replay
- [Release compatibility](/advanced/release-compatibility) for preview boundaries
