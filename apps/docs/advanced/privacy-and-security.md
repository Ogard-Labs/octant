---
description: Local-first storage, credentials, approvals, confinement, and the security model of the technical preview.
---

# Privacy and Security

Octant is local-first. Projects, threads, memory, events, credential
references, and layouts stay on your host. The preview has **no telemetry,
analytics, crash reporting, or cloud dependency** by default, and no
credential storage inside the event store. The network traffic Octant
makes is the traffic you configure: provider API requests for Chat, Work,
and Code, and remote access when you enable pairing.

## Local storage

Your data directory is `~/Library/Application Support/Octant` on macOS,
overridable with the `OCTANT_DATA_DIR` environment variable. The directory
and its database are created owner-only (mode 0700). Private paths are never
logged in wire responses or diagnostics. Linux uses owner-private XDG roots and
an authenticated Unix-domain control socket; unsafe ownership, permissions,
relative paths, and symlink components fail closed before persistence opens.

The durable event journal is an SQLite-backed append-only store. Everything
Octant does that matters is journaled as versioned events, and every
projection can be rebuilt from the journal. A confirmed thread purge is the
one data-lifecycle exception that removes that thread's own journal events
and derived projections so a rebuild cannot resurrect the transcript. See
[Recovery and troubleshooting](/advanced/recovery) for how the journal backs
recovery.

An unsent composer draft is ordinary local client storage on the machine
where it was typed. It never enters the journal, diagnostics, or a provider
request until you send it. Deleting or purging the thread removes that
client's draft as well.

**Export thread** is a host-authoritative read of one thread you can already
open. The JSON bundle carries transcript, evidence, and provenance, and
names the instant it was cut. Credentials, OAuth tokens, raw provider
payloads, resume cursors, and host filesystem paths never enter the file.
Attachment bytes and other bulk content that live outside the journal are
named as omissions rather than inlined. A paired device may export only a
thread it can already read. This is not a host-wide dump.

## Credentials

Provider credentials are write-only and stored as **indirect references in
the macOS Keychain** — never returned to the interface, never journaled,
never placed in process arguments, never exported, and never included in
diagnostics. Provider OAuth and subscription login are delegated to the
provider's own runtime; those tokens are never stored, rendered, exported,
or journaled. Secrets Octant holds for an integration follow the same
Keychain path: the host keeps an opaque reference, plugins and the
interface never receive the raw token, and nothing is journaled, exported,
or included in diagnostics. Remote keys, session secrets, and raw headers
never enter the database, URLs, logs, exports, screenshots, or diagnostics.

The one deliberate exception is the **pairing bootstrap**: a short-lived
pairing link or QR carries a single-use 128-bit secret in the **URL
fragment** so the browser can present it. The page clears the fragment
immediately after reading it, the ticket is in-memory only with a five-minute
TTL, and the secret never enters the database, journal, logs, exports,
screenshots, or diagnostics. See [Remote access](/advanced/remote-access)
for the full lifecycle.

## Approvals

Authority checks happen **on the server before any side effect**, never only
in the interface. There are eight approval categories:

- Project file writes
- Shell commands
- Network access
- External application observation and control
- Destructive or irreversible actions
- Credential and secret access
- Access outside the selected Project
- Privilege expansion or sandbox changes

Grants are scoped and recorded. Child agents can never exceed their parent's
policy. A remote principal can never convert to a local principal or mint
native receipts; desktop admin routes are loopback-only.

## Confinement

- **Work** uses OS-enforced macOS project confinement for one bound root.
- **Code** starts approval-gated; Plan mode is strictly read-only, auto-accept
  edits waives only in-root file writes, and Full access must be explicitly
  selected. A per-message posture may only narrow the thread's grant; the
  server clamps composer intent. Full access is still confined to the
  bound folder for user work; merge authority is never granted.
- Provider execution and app-managed filesystem and shell tools cross an
  Octant-owned sandbox boundary; path checks alone are insufficient.
- Extensions stay quarantined until explicitly reviewed and trusted.
  Installation never implies trust, activation, enablement, or authority.
- Browser automation uses per-thread incognito contexts with an origin
  allowlist and credential-field protection.

## Remote transport

Remote access is HTTPS-only with browser-trusted certificates; certificate
validation is never disabled, no trust root is silently installed, and there
is no plaintext fallback. Tailscale is transport reachability only, never
identity. See [Remote access](/advanced/remote-access) for the full model.

## Boundaries

There is no app-level database encryption in the current preview; Octant
relies on owner-only filesystem permissions plus host storage protection.
Provider secrets are explicitly outside the journal. The multi-host
federation and hosted relay models are post-preview.

## Next steps

- [Remote access](/advanced/remote-access) for the authenticated transport
- [Recovery and troubleshooting](/advanced/recovery) for journal-based recovery
- [Release compatibility](/advanced/release-compatibility) for preview boundaries
