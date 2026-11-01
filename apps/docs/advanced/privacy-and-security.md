---
description: Local-first storage, credentials, approvals, confinement, host-initiated network, and the security model of the technical preview.
---

# Privacy and Security

Octant is local-first. Projects, threads, memory, events, credential
references, and layouts stay on your host. The preview has **no telemetry,
analytics, crash reporting, or cloud dependency** by default, and no
credential storage inside the event store. The one opt-in exception is
Claude Code's own usage telemetry in a thread where you choose
[Claude artifacts](/advanced/providers#claude-artifacts).

Most network traffic is yours to configure: provider API requests for Chat,
Work, and Code, a Canvas export to a GitHub Gist that you approve, and remote
access when you enable pairing. Public links are off until you turn them on:
a Canvas published to one goes to the public Canvas share service, which can
read it ([details](/advanced/privacy-notice#destinations-you-choose)). Two HTTPS calls
Octant makes on its own behalf are the exception: [update checks](/guide/installation#updates)
and [marketplace fetches](/advanced/plugins-and-skills#what-a-marketplace-fetch-discloses).
Neither is a telemetry channel. This page states the posture of those two
calls. Drafts of the [privacy notice](/advanced/privacy-notice),
[sub-processor position](/advanced/sub-processors),
[data residency](/advanced/data-residency),
[DPA template](/advanced/dpa-template),
[SCC position](/advanced/scc-position), and
[EULA placeholders](/advanced/eula-placeholders) describe the broader
boundary for legal review; they are not published notices or contracts.

## Local storage

Your data directory is `~/Library/Application Support/Octant` on macOS,
overridable with the `OCTANT_DATA_DIR` environment variable. The directory
and its database are created owner-only (mode 0700). Private paths are never
logged in wire responses or diagnostics. Linux uses owner-private XDG roots and
an authenticated Unix-domain control socket; unsafe ownership, permissions,
relative paths, and symlink components fail closed before persistence opens.

Octant sends no diagnostics. If you want help, you can save a redacted file
about your host and send it yourself; see
[Saving diagnostics to ask for help](/advanced/recovery#saving-diagnostics-to-ask-for-help).

The durable event journal is an SQLite-backed append-only store. Everything
Octant does that matters is journaled as versioned events, and every
projection can be rebuilt from the journal. A confirmed thread purge is the
one data-lifecycle exception that removes that thread's own journal events
and derived projections so a rebuild cannot resurrect the transcript.
Usage rows are de-linked rather than kept whole: their aggregates stay for
spend accounting while the purged thread's identity leaves them, and a
Project-scoped purge also erases that Project's memory and Canvases and
reports the scopes it deleted. See
[Recovery and troubleshooting](/advanced/recovery) for how the journal backs
recovery.

Settings → Data & storage includes a read-only data map of what this host stores and
where — journal, projections, artifacts, named Keychain or secret-service
entries (never values), caches, and the categories that leave the machine
(provider calls, update checks, marketplace fetches). A category the host
cannot verify is shown as unknown. The map itself performs no destructive
action; export and purge are separate confirmed operations on the same
Data & storage page. What you have allowed (remembered websites, remembered
tool approvals, public links) is on Settings → Permissions.

An unsent composer draft is ordinary local client storage on the machine
where it was typed. It never enters the journal, diagnostics, or a provider
request until you send it. Deleting or purging the thread removes that
client's draft as well.

**Export…** is a host-authoritative read of one thread you can already
open. The JSON bundle carries transcript, evidence, and provenance, and
names the instant it was cut. Credentials, OAuth tokens, raw provider
payloads, resume cursors, and host filesystem paths never enter the file.
Attachment bytes and other bulk content that live outside the journal are
named as omissions rather than inlined. A paired device may export only a
thread it can already read.

**Export my data** is the host-wide cut: a local-owner-only read of every
projectable thread across Chat, Work, and Code, plus Projects, memory,
Canvases, settings, usage rows, and retention state including purge
tombstones, streamed as line-delimited JSON. A remote or paired device
principal is refused before any export data is read, and the same secret and
path exclusions apply as in the thread bundle: some non-thread records that
carry a forbidden key are left out, with a generic entry on the export's
omissions page; a forbidden key in a thread or emitted page can instead
refuse the export. A confirmed thread purge
deletes that thread's journal events, projections, and bulk content, so a
later host export carries no content trace of it. Its id remains only in
the purge tombstone, by design. Its usage rows stay for accounting but are
de-linked, so they carry token counts and no thread id, and Project memory
is kept.

## Credentials

Provider credentials are write-only and stored as **indirect references in
the host's credential store** (the macOS Keychain, or Secret Service on
Linux) — never returned to the interface, never journaled,
never placed in process arguments, never exported, and never included in
diagnostics. Provider OAuth and subscription login are delegated to the
provider's own runtime, and Octant does not store, render, export, or journal
those logins. Octant never reads, stores, or injects a provider CLI's
credentials.
Where you choose **Sign in** on a direct endpoint that offers it (today
OpenRouter), Octant runs the sign-in itself and stores the API key it issues
in the same credential store as a typed-in key, under the same rules.
Secrets Octant holds for an integration follow the same
credential-store path: the host keeps an opaque reference, plugins and the
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

Claude subscription sign-in stays on the unmodified `claude auth login`
command in that account's assigned directory. Octant never reads those
credential files, never stores a Claude OAuth token, and never injects
`CLAUDE_CODE_OAUTH_TOKEN`. If you previously connected Claude for helpers,
Octant deletes that leftover token on upgrade. Revoke it with Anthropic;
Octant cannot.

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

### Outside content

When a thread reads content from outside, such as a web page, a tool's result,
an issue, or a message from another agent, Octant marks it. That includes a
web search or page fetch the provider runs with its own built-in tool, such as
Codex's web search or OpenCode's web fetch, and a tool the model's provider
runs on its own servers. The thread is marked as soon as the call starts, even
if it later fails or you deny it, because by then the provider may already
have the page. Where Octant can see what such a call returned, Octant Shield's Watcher reads
it for text aimed at the agent, hidden or encoded text, and requests to send
secrets out; a finding is tagged on the tool row, in Chat and Work as well as
Code, and never shown to the Judge as text. Some providers do not show Octant
the page, so their calls are marked but not read. An agent that reports a web search the same way as a search of
your files cannot always be told apart, so that search may not mark the
thread. If the provider's own reviewer is answering approvals in a Code
thread, the turn stops at that point and says why, so you answer the next
approval yourself. If Octant cannot record the mark, the turn stops, and the
thread's next turn is refused until the mark is recorded. While a thread is
marked, some actions ask each time and some remembered approvals stop applying.
Each of those approvals, in the desktop app, the browser, the phone app, and
the terminal client, says the thread took in outside content and lists where it
read from and when, ahead of the answer, so you can tell whether the action is
one you asked for. When the Computer Use preview is collapsed to a strip, its
approve button reads **Review before approving** and opens the full prompt, so
the list is on screen before you allow anything.
A notice above the message box says so, with a **Review** button. Review lists
where the thread read from, how often, and when. **Clear the mark** tells Octant
you looked at it, so those actions stop asking because of it.

Clearing removes nothing from what the model already read, and the next outside
content marks the thread again. A thread forked, branched, or restored from a
marked thread starts marked, and so does a thread started from a follow-up or
side task a marked thread suggested. Mentioning a marked thread with `#`, or
asking a Side Chat about one, marks the thread you ask in, because its model
reads that thread's conversation. Clearing one never clears the other. A running or queued turn holds the button back
until the thread is idle. You can clear a mark only at a window on the computer
that hosts the thread, not from a paired phone or browser.

## Confinement

- **Work** uses OS-enforced macOS project confinement for one bound root.
- **Code** starts approval-gated; Plan mode is strictly read-only, auto-accept
  edits waives only in-root file writes, and Full access must be explicitly
  selected. A per-message posture may only narrow the thread's grant; the
  server clamps composer intent. Full access is what it says: the provider
  runtime runs without Octant's deny-default sandbox, so keep it for folders
  and providers you trust. The [protected files](#protected-files) are guarded
  by Octant's own tools and redaction only, and a shell command can read them. No posture grants an agent merge authority; only you merge, from a pull
  request's review on the desktop after confirming.
- App-managed filesystem and shell tools cross an Octant-owned sandbox
  boundary; path checks alone are insufficient. Most provider runtimes cross it
  too.
- The Codex runtime does not: one Codex process serves every thread, which
  Octant cannot bind to a single folder and posture, so the shell it runs falls
  to the provider's own sandbox. That sandbox is on every posture except Full
  access, which you select explicitly and which is unsandboxed by design. The
  Claude runtime crosses the boundary on Plan turns, where Octant's own sandbox
  makes the folder unwritable and stops the runtime starting any process, with
  one exception on macOS: on a Claude subscription account the runtime may run
  Apple's `security` tool and read your login keychain file, because that is
  how Claude Code reads its own sign-in. No shell is allowed, and Octant
  refuses a file tool that names that folder. Its approval-gated and
  auto-accept-edits turns still fall to the provider's own sandbox.
- Every app-managed tool those two threads reach is still confined, and
  approvals still gate every app-managed action and every provider callback
  that reaches Octant. A write one of those runtimes makes inside its own
  sandbox without announcing it is not one Octant can prompt for.
- Extensions stay quarantined until explicitly reviewed and trusted.
  Installation never implies trust, activation, enablement, or authority.
- Browser automation uses per-thread incognito contexts with an origin
  allowlist and credential-field protection. A page is Private unless you put it
  in a Project or Personal profile, which keeps its sign-in on this Mac until you
  sign out; you can import cookies from another browser on this Mac into one of
  them, by picking it yourself, through macOS's own Keychain prompt. The agent
  asks you before it uses a signed-in site; a routine, a subagent, a terminal
  CLI, and a paired device cannot open one.

### Protected files

Some files are secrets whatever mode a thread is in. Below Full access (Ask
first, Accept edits, Auto, and Plan), no agent, and no command an agent runs,
can read or change them. At Full access they are guarded by Octant's own file
tools and redaction only, and a shell command can read them. Full access is
full access:

- SSH private keys in `~/.ssh` (`id_*`, `*.pem`, `*.key`, and any file with a
  `.pub` companion). `~/.ssh/config`, `known_hosts`, and public keys stay
  readable.
- Cloud command-line credentials (`~/.aws/credentials` and its sign-in caches,
  and the credential and token files under `~/.config/gcloud` and `~/.azure`),
  `~/.kube/config`, `~/.docker/config.json`, `~/.npmrc`, `~/.pypirc`, and the
  other package registry token files.
- `~/.git-credentials`, `~/.netrc`, and the forge command-line sign-in file
  `~/.config/gh/hosts.yml`.
- Keychain files other than your login keychain, and the local vault folders
  of password managers.
- Browser cookie and saved-login stores.
- Octant's own secrets, and every provider's stored sign-in except the one the
  running provider uses itself.

The work those files serve goes through a channel instead, so ordinary work
keeps working:

- **SSH** uses your SSH agent (`SSH_AUTH_SOCK`), a password manager's SSH
  agent included. Git over SSH works the same way.
- **Git over HTTPS** signs in through the system credential helper, which
  reads the keychain through the keychain service, not the file.
- **API keys and tokens** go through Octant's credential broker. Link the key
  in Octant, and the runtime receives it in its environment. For a cluster,
  point `KUBECONFIG` at a file you keep outside the protected list.

When an agent asks for a protected file, the refusal says which group refused
it and which channel to use. You see that message in the tool row.

Change the list in **Settings › Permissions › Protected files**. Add a file or
folder of your own, absolute or starting with `~/`. Removing a built-in group
asks you to confirm first, and Octant records the change. **Protect again**
undoes it.

Octant also redacts known key formats, and every key the credential broker
handed out, from what agents say and what their tools print, from thread
exports, and from the service log, at every level, Full access included.
Octant's own file tools refuse a protected file at every level too.

What to know:

- At Full access nothing is sandboxed, so programs that start a sandbox of
  their own, such as `swift package` and headless Chrome, run without extra
  flags.
- On Linux a protected file that does not exist yet when the agent starts is
  not covered until the next start.
- Claude Code's own commands below Full access run in Claude Code's sandbox,
  which keeps them to the Project folder. If the Project folder contains your
  home folder, Octant refuses Claude's file tools on a protected file, and a
  search whose folder holds one; its commands are held only by your approval
  or its reviewer.

### What the Claude runtime does on its own

Octant does not set Claude Code's blanket
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` switch: blocking every
non-essential channel at once was stricter than Octant needs. What Octant
turns off in Claude Code, it turns off by name on every launch:

- usage metrics and error reports (`DISABLE_TELEMETRY`,
  `DISABLE_ERROR_REPORTING`), except usage metrics in a thread that uses
  Claude artifacts (below)
- the runtime updating itself (`DISABLE_AUTOUPDATER`)
- the `/bug` and `/feedback` commands, which upload the conversation
  (`DISABLE_BUG_COMMAND`, `DISABLE_FEEDBACK_COMMAND`), and the session
  survey (`CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY`)
- auto-memory, the SDK's built-in agents, and marketplace auto-install

What the runtime may do on its own, under your Anthropic account: check
for release notes, pull-request badges, and service availability. None of
those carry Project content. It does not fetch feature flags: turning
telemetry off also turns that off, except in a thread that uses Claude
artifacts. Plugins, skills, and
Remote Control stay out because Octant starts the runtime without them. If
you export `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` yourself, Octant
passes it through.

Claude's own **Artifact** tool, which publishes a page to your claude.ai
account, stays off unless you turn on
[Enable Claude artifacts](/advanced/providers#claude-artifacts) for a Claude
account and then choose artifacts for a thread. Claude artifacts are a
per-thread choice, and **telemetry is sent only for those threads**: Claude
Code needs its usage telemetry on to learn whether claude.ai offers the tool,
so a thread that uses artifacts runs Claude Code with its usage telemetry to
Anthropic on. Error reports, the `/bug` and `/feedback` uploads, the survey,
and the runtime's self-update stay off, and every other thread keeps
telemetry off. If you export `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`,
`DISABLE_TELEMETRY=1` or `DO_NOT_TRACK=1`, your own setting wins: it keeps
telemetry and artifacts off everywhere. A page Claude publishes is
uploaded to claude.ai and stored there under your account: it leaves this
computer. Octant keeps the page's address and title and a local snapshot of
the file you approved publishing, and never downloads the page.

### Network limits for agents and safe networks

Network limits are off by default, because no live turn with a real
provider has run through the guard yet. Turn them on in **Settings → Access →
Network limits**. The switch applies to the next runtime you start; runtimes
already running keep the network they began with. While it is off, runtimes
have open network and the safe networks lists are saved but not applied. You
can edit the lists either way, and the page says whether limits are on.

With limits on, on a Mac, below Full access, each provider runtime Octant
starts (Codex, OpenCode, Pi, and ACP agents such as Mistral Vibe) gets a
network guard of its own. The runtime can reach:

- its provider's own endpoints, for sign-in and the model;
- the hosts your Project's network rules allow;
- the places you trust in **Settings → Access → Safe networks**.

Anything else is refused, and the refusal names the host, for example
`octant-egress-refused: no-rule registry.npmjs.org:443`. That includes the
runtime's own web fetch. Claude's commands at Ask first, Accept edits, and
Auto go through the same guard, because Octant points Claude's own command
sandbox at it. Full access stays open network.

**Safe networks** lists the places you trust, once for every Project and,
if you want, a different list for one Project. A place is one of:

- a host (`git.example.com`);
- a domain, which also covers every name under it (`example.com`);
- an address range (`192.168.1.0/24`);
- a private network: **This Mac**, **Local network**, or **Overlay
  network**.

Any place can be limited to one port. A range that reaches link-local
addresses, where cloud metadata services answer, cannot be trusted. Only
someone at this computer can change the lists, and every change is recorded.

**Recently refused** shows the hosts a Project's runtimes were turned away
from. Choose **Trust** to add one to the list you are editing; the runtime's
next attempt goes through. Octant does not hold the request open while you
decide. At Auto, Octant Shield will be able to let a single host through for
one runtime; until it is available, Auto treats an unlisted host as Ask first
does.

What this does not cover yet:

- On Linux, runtimes keep open network.
- Claude's own process keeps open network, including in Plan and for its
  built-in web fetch; only its commands go through the guard.
- Octant Harness commands keep their own per-thread network rules (Network
  access in a Code thread's Agents tab) and do not read safe networks yet.
- No live turn with a real provider has run through the guard yet, which is
  why limits ship off. With limits on, a runtime whose network client ignores
  the proxy settings cannot reach anything; turn the switch off to get its
  network back.

### Your servers over SSH

Agents can reach your own servers with `ssh`, in Work and Code alike. Register
each one in **Settings → Access → Servers**: the host alias from your SSH
config, the user you sign in as, and a profile.

- **Read-only**: status, logs, disk, processes, and service status.
- **Operate**: also restarts services, updates packages, and runs the deploy
  commands you describe, exactly as you wrote them.
- **Admin**: also edits configuration.

At Auto, Octant Shield lets a command through when the server's profile
covers it, and asks you about anything else. Some actions always ask you,
whatever the profile: firewall changes that can cut access, removing users or
keys, disk and partition changes, deleting data, and reboots. SSH to a host
you did not register always asks too. Every remote command is recorded with
its host and exit status.

Octant never reads your key files: `ssh` signs in through your SSH agent. You
can point each server at a notes file (a runbook); agents read it as
reference, and nothing written there changes what Shield allows. Only someone
at this computer can change the list.

What this does not cover yet: below Full access an agent's command runs in a
sandbox that cannot read your SSH config or open a connection to a server, so
`ssh` connects only at Full access today, where commands are recorded but not
reviewed. Exit status and runbook notes reach only Octant Harness threads.

## Remote transport

Remote access is HTTPS-only with browser-trusted certificates; certificate
validation is never disabled, no trust root is silently installed, and there
is no plaintext fallback. Tailscale is transport reachability only, never
identity. See [Remote access](/advanced/remote-access) for the full model.

## Host-initiated network

These two calls are the only traffic Octant originates without a provider,
remote listener, approved export, or other integration you turned on.

### Update checks

A signed desktop build may ask a static HTTPS feed whether a newer build
exists. The request is a GET with the running version, platform, and
architecture, a User-Agent of `Octant` with no version, and no cookies.
Automatic checks wait ten minutes after launch, then repeat once a day, and
start only after the saved preference is loaded. Turn them off in
**Settings → General → Updates**; off means no request is made. Manual
**Check for updates** still contacts the feed when you ask. Details, including
what a server can infer, live under [Installation](/guide/installation#updates)
and are **provisional** until signed self-updating releases are final.

### Marketplace fetches

Searching or inspecting the plugin and skill catalog can contact third-party
registries. Opening **Settings → Skills & Extensions** or the Marketplace tab
does not. Extension catalog **search** sends your query plus the
`agent-plugin` keywords to npm, then downloads candidate metadata and
tarballs; **Inspect** and install of a curated entry fetch its pinned GitHub
tree. Standalone skill **Search skills** queries skills.sh
and the npm registry with the text you typed; preview and install then fetch
the package. Turn marketplace fetches off in
**Settings → Skills & Extensions → Marketplace**; off means no request is made and
catalog search stays with the in-memory curated entries. Details live under
[Plugins and skills](/advanced/plugins-and-skills#what-a-marketplace-fetch-discloses).

### Provider update checks

Providers settings reads the newest published version of Codex, Claude Code,
Grok Build, GitHub Copilot and Cline from the npm registry, at most once a day
per tool. The request is a plain `GET` for the package name; it carries no
thread, Project, account or device identifier, and discloses only your IP address
and ordinary HTTP metadata. It follows the marketplace fetches switch: off means
no request is made. Octant runs a tool's own updater only when you click
**Update CLI**.

## Boundaries

There is no app-level database encryption in the current preview; Octant
relies on owner-only filesystem permissions plus host storage protection.
Provider secrets are explicitly outside the journal. The multi-host
federation and hosted relay models are post-preview.

## Next steps

- [Privacy notice](/advanced/privacy-notice) for what exists, what leaves, and export or purge
- Shared-host controller footing (repository draft at
  `docs/legal/shared-host-controller.md`) for when several principals share
  one host journal
- [Installation](/guide/installation#updates) for what an update check sends
- [Plugins and skills](/advanced/plugins-and-skills#what-a-marketplace-fetch-discloses)
  for what a catalog fetch discloses
- [Remote access](/advanced/remote-access) for the authenticated transport
- [Recovery and troubleshooting](/advanced/recovery) for journal-based recovery
- [Release compatibility](/advanced/release-compatibility) for preview boundaries

### Pending desktop confirmations

Desktop authority confirmations appear beside their owning composer. When more
than one is waiting, use **Previous** and **Next** to inspect them; navigation
does not approve a request. Up to eight requests can wait for the same composer.
Each expires five minutes after it was requested, including time spent viewing
other requests. Switching to another owner or closing the window cancels its
pending confirmations.
