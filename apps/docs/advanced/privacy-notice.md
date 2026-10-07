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
- **A local profile** — an optional display name, address, accent,
  and inlined avatar. The profile authenticates nothing
  and authorizes nothing.
- **Credential references** — opaque Keychain pointers, never the secret
  values.
- **Secrets in the credential store** — the API keys you entered, the key a
  direct endpoint sign-in issued, and, only if you connected it, the Claude
  for helpers token. They sit in the macOS Keychain (the Secret Service on
  Linux) behind those references, never in the journal.
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

Provider sign-in takes one of two forms. When the provider's own CLI or SDK
handles the login, it stays in that runtime, and Octant never stores,
refreshes, or journals those tokens, with one exception you opt into:
[Claude for helpers](#claude-for-helpers-only-if-you-connect-it). When you
choose **Sign in** on a direct endpoint that offers it, which today is
OpenRouter, Octant runs the sign-in itself and keeps what the provider issues:
see [Sign in on a direct endpoint](#sign-in-on-a-direct-endpoint-only-if-you-choose-it).

### Claude for helpers, only if you connect it

Claude Code on a Claude subscription signs in through Claude's own runtime,
and Octant never holds that login. A Plan turn, and every Chat subagent, runs
confined, away from the keychain where that login lives.
**Settings → Providers → Claude Code → Connect Claude for helpers** gives
those runs a sign-in of their own. It is the one provider token Octant
stores from a provider's own runtime, and it exists only if you press the
button.

- **What is stored.** The long-lived token that Claude's own
  `claude setup-token` prints after you approve once in a browser window.
  Octant runs that command on this Mac and reads the token from memory, so
  you never copy it. It is never logged, placed in a process argument, or
  written to the journal, an export, or diagnostics.
- **Where.** In the host's credential store — the macOS Keychain, or the
  Secret Service on Linux — under that Claude Code provider, reached through
  the credential broker by an opaque reference. Settings shows whether the
  token is connected, connecting, or expired, never the token.
- **Who receives it.** Only the confined Claude runtime that Octant starts
  for a Plan turn or Chat subagent on that provider. The token reaches it as
  the `CLAUDE_CODE_OAUTH_TOKEN` environment variable for as long as that
  launch lives, and the runtime presents it to Anthropic to sign in. Turns
  that are not confined, and every other provider, never receive it, and no
  Octant-operated service does.
- **How to remove it.** Press **Disconnect**, which deletes the token from
  the credential store and says so if the store cannot be reached. Removing
  the Claude Code provider also tries to delete it, but the removal still
  completes when the store is unreachable, and the token can then stay
  there, so disconnect first. A token Claude refuses is replaced by an
  expired marker, and Settings asks you to connect again. Only a window on
  this Mac can connect or disconnect; a paired device cannot. Removing it
  deletes Octant's copy only. Octant cannot revoke the token with Anthropic,
  so the token itself stays valid there until it expires or is revoked
  outside Octant.

### Sign in on a direct endpoint, only if you choose it

A direct HTTP provider pointed at OpenRouter's API offers **Sign in** beside
**Use an API key**. After you acknowledge a short terms summary, Octant runs
OpenRouter's own browser sign-in on this Mac. You authorize at openrouter.ai,
and the browser returns to a loopback address that Octant opened for that one
attempt.

- **What is stored.** The API key OpenRouter issues for your account. There is
  no refresh token, and the key does not expire on its own.
- **Where.** In the same credential store as an API key you typed, reached
  through the credential broker by an opaque reference. The journal records
  that you acknowledged the terms, and that a sign-in started, finished, was
  refused, or was signed out, with that reference and never the key.
- **Who receives it.** OpenRouter, as the key on that provider's requests. The
  sign-in attaches only to OpenRouter's API address, and no Octant-operated
  service receives it.
- **How to remove it.** Press **Sign out** under that provider, which deletes
  the key from the credential store. Sign out before you remove the provider.
  Only a window on this Mac can sign in or out. Octant does not revoke the key
  with OpenRouter, so it stays valid there until you revoke it there.

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
contact a registry. Extension catalog **search** sends your query plus the
`agent-plugin` keywords to npm, then downloads candidate metadata and
tarballs; **Inspect** and install of a curated entry fetch its pinned GitHub
tree. Standalone skill **Search skills** queries [skills.sh](https://skills.sh/)
and the npm registry with the text you typed; preview and install then fetch
the package. An empty query is not sent.

Those requests disclose the query you typed, the IP address, and ordinary
HTTP metadata. They do not send the journal, credentials, or thread
contents. Turn marketplace fetches off in
**Settings → Skills & Extensions → Marketplace**; off means no request is made and
catalog search stays with the in-memory curated entries.

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
destinations, a Canvas export to a GitHub Gist, and remote access you enable
are traffic you pointed Octant at. Remote access is off by default. See
[Remote access](/advanced/remote-access).

A Canvas export to a GitHub Gist publishes content to GitHub. It posts the
rendered Markdown of one Canvas, with the Canvas title as the gist
description, to github.com through the GitHub connection this host already
has; Octant never reads that token. Nothing is sent until you approve a card
that shows the exact text, the GitHub account it posts as, and who can see
it. **Secret**, the default, is unlisted: it appears on no profile and in no
search, but anyone with the link can read it. **Public** is readable by
anyone on the internet. The text passes the same check as every other
export, so absolute paths and secret-shaped values are refused rather than
posted. The journal keeps the receipt, the gist's address and id. Octant
does not delete a gist afterward; take it down on GitHub. A folder export
makes no network call. See
[Export a Canvas or artifact](/guide/export#export-to-a-github-gist).

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
journal are listed as omissions rather than inlined. A paired device may export
only a thread it can already read. Chat Markdown remains a convenience
copy, not the authoritative export.

**Export this host.** **Export my data** is the host-wide cut
(`octant.host-export/1`): one local-owner read of every thread the host
can project — across Chat, Work, and Code — plus Projects, memory,
Canvases, settings, usage rows, and the retention state including purge
tombstones, streamed as line-delimited JSON. It is local-owner-only: a
remote or paired device principal is refused before any export data is read.
The same unrepresentable rules as the thread bundle apply — no credentials,
no filesystem paths, no raw provider payloads. Some non-thread records that
carry a forbidden key are left out of the bundle; the export's omissions page
adds a generic entry naming that class of omission without identifying the
records or giving their count. A forbidden key inside a thread record or an
emitted page instead causes the whole export to be refused, and if the walk
cannot finish, nothing is saved.

**Retain and purge.** Retention windows are per host, Project, or thread.
The narrower scope wins. The host default is forever. Setting a window
never deletes anything, and there is no unattended timer. A confirmed
purge (`confirm: true`) is required. For each named thread it deletes
purgeable bulk content, removes derived projection rows, physically
deletes that thread's own journal events so a rebuild cannot resurrect the
transcript or title, then appends a tombstone. Usage rows keep their token
and cost aggregates for accounting but the thread's id leaves them, so a
purged thread is no longer named anywhere in usage attribution. That
usage appears as erased threads in Usage and in the host export. Canvas
documents, credentials, Projects, and other threads stay unless a later
request names them. Project memory belongs to the Project: it survives a
thread purge with its provenance de-linked, it is included in the host
export, and a Project-scoped purge erases the Project's memory and Canvases
and reports those scopes. SQLite free pages may keep bytes until a vacuum
or store rebuild; that residual is reported, not hidden. A remote
principal cannot set a window or purge. A later host export carries no
content trace of a purged thread; the purge outcome names exactly which
scopes it deleted and which it retained.

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

The Claude for helpers token, if you connect one, and the key a direct
endpoint sign-in issues are held the same way and are never returned to the
interface, journaled, exported, or included in diagnostics. See
[Claude for helpers](#claude-for-helpers-only-if-you-connect-it) and
[Sign in on a direct endpoint](#sign-in-on-a-direct-endpoint-only-if-you-choose-it)
for who receives them and how to remove them.

## Next steps

- [Sub-processors](/advanced/sub-processors) for BYO-key and BYO-subscription
- [Data residency](/advanced/data-residency) for "your machine, your region"
- Shared-host controller footing (repository draft at
  `docs/legal/shared-host-controller.md`) when a team shares one host
- [DPA template](/advanced/dpa-template) for processor clauses if a hosted component ships
- [SCC position](/advanced/scc-position) for transfer posture on BYO vs hosted surfaces
- [Privacy and security](/advanced/privacy-and-security) for approvals and confinement
- [Recovery](/advanced/recovery) for journal-based recovery
