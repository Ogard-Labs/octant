---
description: Draft privacy notice for the technical preview — what data exists, where it lives, what leaves the machine, and the export and purge rights that already ship.
---

# Privacy Notice

::: warning Draft pending legal review
This page is a draft. It describes current Octant behavior so a qualified
adviser can review it. It is **not** a published privacy notice, a data
processing agreement, or legal advice, and it does not certify GDPR
compliance.
:::

Octant is local-first software that runs on a machine you control. There is
no Octant cloud account and no Octant-operated store of your Projects,
threads, memory, or credentials. This notice covers the Apple Silicon
technical preview.

The operational security model — approvals, confinement, pairing — lives in
[Privacy and security](/advanced/privacy-and-security). This page answers
what personal data exists, where it sits, what leaves, and what you can
already export or erase.

## What data exists

Everything that matters for restart, replay, and recovery is journaled as
versioned events in a SQLite store on the host. Read models are projections
rebuilt from that journal. Provider secrets never enter it.

On the host, Octant holds:

- **The event journal and projections** — Projects, threads, layouts,
  settings, memory, extension state, and other aggregates the server
  commits.
- **Bulk content outside the journal** — attachment bytes, terminal
  transcripts, context summaries, and similar purgeable stores, referenced
  from the journal rather than inlined.
- **Unsent composer drafts** — ordinary client storage on the machine where
  you typed them. They never enter the journal, diagnostics, or a provider
  request until you send.
- **A local profile** — the name first run requires, plus an optional
  address, accent, and inlined avatar. The profile authenticates nothing
  and authorizes nothing.
- **Credential references** — opaque Keychain pointers, never the secret
  values.
- **Installed extension packages** under the host data directory.
- **Logs** under the host logs directory.

A paired phone or browser stores only device keys, a host registry, and
session material. Threads stay on the host.

## Where it lives

On macOS the data directory is
`~/Library/Application Support/Octant`, overridable with `OCTANT_DATA_DIR`.
The directory and its database are created owner-only (mode 0700). Logs
live in `~/Library/Logs/Octant`.

The headless Linux runtime uses owner-private XDG roots
(`~/.local/share/octant` by default). Packaged Linux is not part of the
preview. See [Data residency](/advanced/data-residency).

Private paths are never logged in wire responses or diagnostics. There is
no app-level database encryption in the current preview; Octant relies on
owner-only filesystem permissions plus host storage protection.

## What leaves the machine, and why

Octant has **no telemetry, analytics, or crash reporting**. The journal is
never synchronized through a cloud service. Network traffic is limited to
the following.

### Provider API calls you configure

Chat, Work, and Code turns are sent from this host to the provider instance
you added — a local CLI or SDK, or a direct HTTP endpoint you named.
Connection Check is non-generating: it reports readiness, version, models,
and capabilities without sending a prompt. See
[Providers and models](/advanced/providers) and
[Sub-processors](/advanced/sub-processors).

Provider OAuth and subscription login stay in the provider's own runtime.
Octant never stores, refreshes, or journals those tokens.

### Update checks

When automatic checking is on, or when you check by hand, the desktop app
makes a plain HTTPS GET for a small feed. The request carries the running
version, platform, and architecture, and uses the user agent `Octant` with
no version. It sends no account, install identifier, Project, thread,
configuration, counter, or cookie.

Whoever serves the feed — under `https://octant.sh/updates` by default, or an
HTTPS base you set with `OCTANT_UPDATE_FEED_BASE_URL` — can infer that someone
at that IP address runs Octant, which version, on which release ring, and
roughly how often it is open. The ring is part of the address rather than a
parameter, so the path itself says whether you follow stable or preview. That
is more than an IP alone.

Automatic checking is a switch in **Settings → General → Updates**. Off
means no request is made at all. The desktop process starts with checking
off until the saved preference loads; a store that never recorded the
setting decodes to on. When it is on, the first check waits ten minutes
after launch, then repeats once a day. You can still check by hand when
automatic checking is off.

A download happens only when you ask. If the signed notice points the
artifact at another host, that host sees the IP address of the download.
An unsigned local package cannot install a replacement, and a build without
a compiled-in release key cannot verify a feed. The update-check disclosure
is **provisional** until signed self-updating releases are final. See
[Installation](/guide/installation#updates).

### Marketplace fetches

Opening **Settings → Skills & Extensions** or the Marketplace tab does not
contact a registry. Extension catalog **search** is local; **Inspect** and
install fetch a pinned GitHub tree. Standalone skill **Search skills**
queries [skills.sh](https://skills.sh/) and the npm registry with the text
you typed; preview and install then fetch the package. An empty query is
not sent.

Those requests disclose the query you typed (for skill search), the IP
address, and ordinary HTTP metadata. They do not send the journal,
credentials, or thread contents. Turn marketplace fetches off in
**Settings → General → Marketplace**; off means no request is made.

Local disk imports and `.agents/skills/` discovery do not contact a
catalog. Details live under
[Plugins and skills](/advanced/plugins-and-skills#what-a-marketplace-fetch-discloses).

### Gravatar, only if you press the button

The profile can look up a picture on gravatar.com. That lookup runs only
when you press the button, only after an address has been typed, and the
surface says in place that it sends a hash of the address. The image is
copied into local settings, not linked, so Octant does not contact
gravatar.com again on its own.

### Destinations you choose

Git remotes, GitHub when a Project is connected, browser and computer-use
destinations, and remote access you enable are traffic you pointed Octant
at. Remote access is off by default. See
[Remote access](/advanced/remote-access).

## What never leaves

These do not go to an Octant-operated service, and they are not included in
thread export, diagnostics, or logs:

- Provider credentials, OAuth tokens, session secrets, and raw provider
  payloads
- Host filesystem paths
- Resume cursors
- Unsent composer drafts, until you send
- The event journal as a store — it is not synced off the host

Diagnostics are a local, redacted evidence packet you can export. They are
not an upload channel.

## Rights that already ship

These are product behavior, not a future promise.

**Export one thread.** **Export thread** is a host-authoritative read of
one thread you can already open. The JSON bundle (`octant.thread-bundle/1`)
carries transcript, evidence, and provenance, and names the instant it was
cut. Secrets, raw provider payloads, resume cursors, and filesystem paths
are unrepresentable. Attachment bytes and other bulk content outside the
journal are listed as omissions rather than inlined. A paired device may
export only a thread it can already read. This is not a host-wide dump;
Chat Markdown remains a convenience copy, not the authoritative export.

**Retain and purge.** Retention windows are per host, Project, or thread.
The narrower scope wins. The host default is forever. Setting a window
never deletes anything, and there is no unattended timer. A confirmed
purge (`confirm: true`) is required. For each named thread it deletes
purgeable bulk content, removes derived projection rows, physically
deletes that thread's own journal events so a rebuild cannot resurrect the
transcript or title, then appends a tombstone. Usage attribution, canvas
documents, memory, credentials, Projects, and other threads stay unless a
later request names them. SQLite free pages may keep bytes until a vacuum
or store rebuild; that residual is reported, not hidden. A remote
principal cannot set a window or purge.

**Remove local data.** Reset, remove-all, and delete-remote-host are
explicit, reported per scope, and never implicit. Keychain cleanup is
attempted through the native host boundary and reports residual credentials
without values.

## Credentials

API keys are write-only Keychain items reached through the desktop broker
by opaque reference. They are never returned to the interface, never
journaled, never placed in process arguments, never exported, and never
included in diagnostics. Headless or non-macOS sessions report Keychain
cleanup as not integrated rather than writing secrets to disk.

## Next steps

- [Sub-processors](/advanced/sub-processors) for BYO-key and BYO-subscription
- [Data residency](/advanced/data-residency) for "your machine, your region"
- [Privacy and security](/advanced/privacy-and-security) for approvals and confinement
- [Recovery](/advanced/recovery) for journal-based recovery
