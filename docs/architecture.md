# Octant architecture

Octant is a local-first desktop workspace for Chat, Work, and Code across many AI
providers. The first shipping surface is Apple Silicon macOS; Linux and Windows
desktop are the same product, sequenced in the
[Current Release Boundary](#current-release-boundary).
This is the current architecture specification. Read the relevant section for
system boundaries; use the [design index](design/README.md) for topic owners.
Edit the current rule with an approved change in the same PR. Historical links
provide rationale and supporting detail, not a competing source of authority.
Sections explicitly label approved designs that are not yet fully implemented;
archive status alone is neither approval nor implementation evidence.

## Overview and principles

Octant is one Electron application that hosts a Bun HTTP server, a React
renderer, and (optionally) remote clients that connect to that same server.
Everything the user cares about — Projects, threads, memory, event history,
credential references, layouts — stays on the host machine. Artifact versions
are the exception once sync is on: they are copied into a store the user owns,
not into a store Octant operates. The journal does not leave. See
[Persistence](#persistence).

The design rests on a small set of invariants that every package obeys:

- **Local-first.** No Octant cloud account, relay, or telemetry is required.
  Artifact sync, when the person turns it on, uses a store that person owns.
  Octant operates none of it; an S3-compatible store is contacted only at the
  endpoint the person configured and only while the Settings › Sync switch is
  on. Remote access is host-to-device over the user's
  own network. Three host-initiated
  HTTPS calls exist in code: desktop update checks against a signed feed, managed
  device-tool update checks against the npm registry, and server marketplace
  fetches when the person searches, inspects, previews, or installs from the
  catalog. All have a Settings off switch: marketplace off means no catalog
  request; Updates off disables automatic update checks (manual Check for
  updates may still contact the signed feed); device tools' automatic updates
  start off, and off means no registry request (a manual check may still
  contact it). An in-app
  changelog rides that update path and bundled notes rather than adding a
  separate call ([decisions/0061-in-app-changelog.md](decisions/0061-in-app-changelog.md)).
  Opening Updates reads the desktop's current local update state so the installed
  version and saved preferences appear without requesting the signed feed.
- **The server is the authority.** Every authority check (mode, Project,
  thread, provider, approval, remote principal, optional spend ceiling) runs in
  `apps/server` before a side effect. The renderer and mobile app render what
  the server says is allowed; they never decide it.
- **The event journal is authoritative; projections are rebuildable.** Commands
  append versioned events to a SQLite journal. Read models are idempotent
  projections that can be dropped and rebuilt from the journal at any time.
- **Contracts are schema-only, domain is pure.** `@octant/contracts` holds
  Effect Schema definitions and nothing else. `@octant/domain` holds pure
  policy and state transitions with no I/O.
- **The host reads strictly; a client ignores what it does not know.**
  Everything the host decodes refuses unknown fields: requests and commands
  from any client, the journal, projections it rebuilds, provider and extension
  payloads, and plugin manifests. A client reading a host answer (a response
  body or a stream frame) decodes it with `decodeHostAnswer`, which drops fields
  it does not know, so a newer host can add an optional field without an older
  phone, browser, or CLI losing the thread. A known field with the wrong type
  still fails. Asks a person decides on (approvals, questions, and proposals,
  marked `personDecides` in the contracts) stay strict inside an answer: an
  unknown field there refuses the whole answer, so a person is never shown less
  than the ask authorizes. Versions are not negotiated per field.
- **Dependencies point inward.** Apps consume packages; contracts and domain
  never import apps. Provider-specific payloads stop at the provider adapter.
- **A provider question has one answer identity.** Each question in a provider
  question set reaches Chat, Work, and Code with a distinct request id. The
  adapter collects answers in the provider's original question order, rejects
  duplicate answers, and settles the underlying callback only when complete.
- **Capabilities are honest and fail closed.** Every provider reports what it
  supports in every mode; an unsupported capability is disabled or refused,
  never silently emulated. Claude Code and Codex are the first-class providers
  and may offer a capability in full; every other provider gets a documented
  degraded form, listed in the [provider capability
  matrix](#security-and-authority) ("degraded on"), or reports the capability
  unsupported. The app-managed tools below stay provider-neutral, and a seam is
  never widened for one vendor.
- **Install ≠ trust ≠ enable.** Extensions contribute nothing until each of
  those steps has been taken explicitly, and even then only within the mode,
  Project, thread, and provider policy that applies.

Packaged macOS hosts use a restricted executable search path containing system
utilities and standard package-manager locations. `/usr/sbin` is included so
local-server discovery can invoke the system `lsof`; arbitrary inherited PATH
entries are excluded.

## Process topology

```mermaid
flowchart LR
  subgraph mac["Host Mac"]
    desktop["apps/desktop<br/>Electron main process<br/>windows · Keychain · credential broker · browser broker"]
    server["apps/server<br/>Bun HTTP server<br/>routes · services · journal · projections · providers"]
    renderer["apps/web<br/>React renderer<br/>(BrowserWindow, Vite in dev)"]
    tools["Sandboxed children<br/>provider CLIs · git · terminals · tests · extension executables"]
    keychain[("macOS Keychain")]
    db[("SQLite<br/>event journal + projections")]
  end
  subgraph remote["User's network (LAN / Tailscale)"]
    browser["Paired browser<br/>(same apps/web bundle)"]
    mobile["apps/mobile<br/>Expo iOS/Android"]
  end

  desktop -- "attaches or starts" --> server
  desktop -- "loads with native client context" --> renderer
  renderer -- "HTTP + streaming<br/>127.0.0.1" --> server
  server -- "loopback broker<br/>indirect refs only" --> desktop
  desktop --- keychain
  server --- db
  server -- "sandbox-exec" --> tools
  browser -- "HTTPS, device key" --> server
  mobile -- "HTTPS, device key" --> server
```

**Desktop (`apps/desktop`).** The Electron main process owns native windows,
menus, the macOS Keychain, project-root, plugin-folder, and runtime-binary
pickers, and the in-app updater. A picker hands the server the chosen path
under the desktop bridge secret and gives the renderer only a single-use
receipt bound to its window, so a renderer can act on a path only the person
picked. It attaches to the canonical host at
`http://127.0.0.1:13773`, or starts that independently runnable host when it is
absent, then probes storage readiness before showing a window. It passes
native broker coordinates and the desktop bridge secret that native-only
operations require. A packaged launch also passes the app's version in
`OCTANT_ARTIFACT_VERSION`; a development launch does not. It also runs loopback-only
brokers the server talks back to: the credential broker (Keychain access by
opaque reference), the browser runtime broker, and on macOS the Simulator
device broker, behind which one native device helper per Simulator delivers
workbench input (see
[decisions/0137-simulator-input-reaches-the-guest-through-a-native-device-helper.md](decisions/0137-simulator-input-reaches-the-guest-through-a-native-device-helper.md)).
Every app window confines top-level navigation, redirects, and opened windows to
the exact packaged renderer asset or configured Vite development origin. Native
IPC also requires that trusted renderer URL, and the packaged renderer ships a
strict Content Security Policy; external pages are opened through explicit
server- or host-authorized flows instead of replacing the app window.

**Server (`apps/server`).** A Bun HTTP server bound to the stable canonical
loopback endpoint `127.0.0.1:13773`. It registers route modules per feature (`chatRoutes`,
`workThreadRoutes`, `codeRoutes`, `projectRoutes`, `extensionRoutes`,
`remote/*`, …), resolves a **client principal** for every request — a
process-local client context on the loopback listener (internally still named
`local-window` while that contract is migrated), or a `remote-device` principal
carrying authenticated remote identity — and runs all mutations through
services that append to the journal. Providers, tools, Git, terminals,
subagents, extensions, and recovery live here. A headless host runs the same
server through `@octant/cli` (`octant server run`, `octant web`). The
installable headless artifact (`scripts/package-headless.ts`) is self-contained:
it carries the bundled CLI (`bin/octant`), the bundled server (`lib/server`), the
web assets, and a top-level `node_modules` holding the third-party and native
dependencies both bundles leave external, built on the target platform itself.
An installed CLI starts that server under its own Bun runtime with
`OCTANT_ARTIFACT_ROOT` and `OCTANT_ARTIFACT_VERSION` set. The server verifies
every listed file before it opens the store, and reports that version on
`/health`, in a diagnostics export, and on the owner receipt. When the stamped
version is missing or unusable, the CLI still sets `OCTANT_ARTIFACT_VERSION`
to empty so a value inherited from the parent process cannot replace it. The
host treats an empty or over-long value as unset and reports the package
version a development script exports, or `0.0.0-dev` when that is absent. For Code,
verified remote requests carry their principal through an async request scope:
the paired device may reach existing active Code Projects without a desktop
workspace, while services retain thread, checkout, provider, and approval checks.
This admission ends on cancellation or dispatch completion. Local windows retain
their selected-Project restriction (ADR 0148). A killed start can leave the
control secret with no receipt and no socket; the next acquire quarantines
that file and continues, and it checks the socket is still absent before the
move so a peer that bound in the meantime keeps the secret it just wrote. A start
takes over from a recorded owner only when its control socket does not answer
and its process is gone: the pid no longer exists, is an unreaped zombie (an
aborted owner whose parent has not collected it yet), or belongs to a process
with a different start time (a recycled pid, including one now held by another
user). If the process cannot be inspected, the owner counts as live and the
start refuses. An ownership failure names the code, the artifact path, and the
next step.

**Host resources.** `GET /api/host/resources` is a read-only snapshot of this
host's load: CPU use averaged over a short sample of the process's CPU times,
used and total memory, the core count, and used and free space on the volume
that holds the data directory. The disk figures are omitted when that volume
cannot be read. The snapshot names no path, no user, and no process. The server
keeps one snapshot for about five seconds. The local owner always receives it.
A paired remote device with an active session receives it under the same
`project.overview.read` action as the Project overview reads; an
unauthenticated caller is refused, with no figures in the refusal. The route
also compares the device's host identity with this host's, but every paired
device row on a host carries that host's own identity, so the comparison does
not separate one paired device from another. The Computers card
reads the route only while the card is on screen and the window is visible,
about every ten seconds, at most one read per host at a time and each abandoned
after five seconds, and does not poll in the background.

**Renderer (`apps/web`).** One React application served to the desktop window
and to authenticated remote browsers alike. It talks to the server through
`@octant/client-runtime` and never holds authority of its own. In development
Vite serves it with hot reload; in a packaged build the server serves the
built assets. A paired browser mounts the remote shell rather than the desktop
workspace: the same Chat, Work, and Code thread workspaces, driven by the
ordinary product clients over `createRemoteProductFetch`, which carries each
request on the device session and never presents a window capability. The
desktop's window-bound sidebar, dock, and Settings are not served remotely.

**Mobile (`apps/mobile`).** An Expo iOS/Android remote-control client. Threads
are host-owned; the phone stores only device keys, a host registry, and session
material. It uses the same contracts and client runtime as the browser. The
phone creates Chat, Work, and Code threads, reads their transcripts, and sends
follow-up turns under each thread's own authority (`start-work-thread-turn`
with the thread's binding; `start-provider-turn` on the thread's checkout).
Approvals, folder binding, file edits, and shell remain host-only and the
composer says so. Native startup supplies WebCrypto for the shared pairing and
request-proof clients; keys persist in platform secure storage. Native remote
fetch sends the proof-bound session cookie explicitly and disables the shared
cookie jar to prevent duplicate or stale cookies. Browser cookie ownership is
unchanged, and native remote requests refuse redirects.

Internal TestFlight distributes this same client and grants the phone no new
authority. The bundle is `app.octant.mobile` (installed name Octant) at source
version `0.1.0`; EAS Build signs and archives it, with build numbers from EAS
remote version state, and the `production` EAS profile means store
distribution, never a public release or App Review submission. The manually
dispatched `Mobile (TestFlight)` workflow builds only from `main` in the
protected `mobile-testflight` environment and uploads only when its `submit`
input is set; pull requests get no release credential. GitHub holds only the
revocable Expo token; Apple certificates, profiles, and the App Store Connect
key stay in EAS's credential service. The App ID enables no optional Apple
capability (push, associated domains, Sign in with Apple, iCloud), testers are
maintainer-controlled App Store Connect users, and external groups, public
links, and store listing stay closed under the
[mobile store hold](mobile-store-v1-hold.md). A build counts only after the
device pass in the [TestFlight runbook](mobile-testflight.md), not when EAS or
Apple finishes processing it.

**Local client context.** The local trust class is "holds a secret only the
host's OS user can read", not "is on loopback". Loopback plus an admitted
Origin says nothing about who is calling: another OS user on the same machine,
an `ssh -L` forward, a proxy that rewrites `Host`, or a local service account
all arrive that way, and a forged `Origin` header costs a non-browser caller
nothing. The secret is the desktop bridge secret, which the host owner projects
into the owner-only runtime directory. Electron windows and every CLI command
(`octant agent`, `octant listener`, pairing, `octant web`) present it on the
`/api/desktop/*` routes. A browser gets a session only through a one-time
launch token: the launcher (`octant web`, `octant web --dev`, or the desktop's
"Open in browser" action) mints it through `/api/desktop/launch-sessions` with
the bridge secret and opens a URL carrying it in the fragment. `octant web`
sends the secret only to the host that this OS user's owner-only host receipt
names (same address and instance), never to an endpoint that merely answers
`/health`, because another OS user can bind the port while the real host is
stopped. The token is
single-use, expires after five minutes, and is bound to the renderer origin it
was minted for, which must be one this listener serves (below). The renderer
strips it from the address bar with a history replace before it exchanges it at
`/api/shell/launch-session`; an exchange from any other origin, or with no
Origin, is refused and burns the token. `/api/shell/local-session` never mints
authority: it only refreshes a capability the tab already holds (so a reload
keeps its session) and answers 401 otherwise. Typing the host address by hand,
reopening a tab after the host restarted, or opening a copied tab therefore
shows "Open Octant from the desktop app or run `octant web`" instead of the
app. Electron, ordinary browsers, and Vite still read the same Machine-owned
Projects, threads, settings, and journal; a Vite renderer qualifies only when
the host was started with its origin in `OCTANT_WEB_URL` (the desktop dev loop
and `octant web --dev` set it for the host they start), and `octant web --dev`
mints its token for that origin. The context id scopes window-local presentation
and guards against accidental cross-window commands, but it is not a separate
Machine or durable authentication epoch. The packaged renderer additionally
proves its native renderer identity for desktop-only integration. When the host
instance changes, Electron re-registers every live Project window, replaces the
main-process authority and renderer identity, and publishes the new capability
so the renderer rebuilds its clients before snapshot recovery. The loopback
transport still validates the actual Host header, rejects non-loopback origins,
and removes process-local registration when its owning client closes. The
listener admits only its own loopback origin (under any loopback name), the
packaged renderer, and the development renderer origin named by
`OCTANT_WEB_URL`; a page on any other loopback port is refused before dispatch
and gets no CORS grant, because agents start local dev servers whose pages the
person opens in an ordinary browser. The listener never reflects a non-loopback
web origin into local authority. One residual window remains: the launcher
hands the token URL to the system browser as a process argument, which another
OS user can read for the moment that process runs, and the token is valid until
the browser exchanges it. The renderer holds the matching
line before its first request: a launch address that is plain HTTP to a
non-loopback host is refused with an explanation and never used
(`docs/decisions/0103`). Requests that send the window capability set
`redirect: "error"` so a later hop cannot carry the header to an address the
parser never judged.

Managed runtime tool transport uses the provider SDK's existing tool-request
and tool-answer contract. The adapter's in-process server exposes only the
current app-authored catalogue; external provider tool-server configuration
stays disabled. Code browser sessions can request an inline approval without
raising thread access. The grant is bound to the exact browser context and
owner, and browser-service policy is checked again before effects. Answering
the prompt with "always allow" journals the origin into shell settings, so a
new browsing context for that origin opens without asking — in Code, in Work,
and for later sessions — until the person forgets it under Settings; rebinding
an existing context to a different model or authority still asks, because the
remembered grant covers the page, not who drives it. The remembered set grows
only through that approval answer: `replace-settings` may remove an origin but
rejects additions, so a client cannot grant itself origins the prompt never
showed. Plan refuses every Code browser operation except stopping the
thread's own browser (`plan-mode-read-only`). See
[decision 0093](decisions/0093-app-owned-tools-use-managed-runtime-transports.md).

Tool definitions carry the agent's usage guidance alongside their argument
schemas. App-owned tools are capability families: one tool per object —
`octant_browser`, `octant_computer`, and in Code `octant_terminal`,
`octant_apple`, and `octant_android` — with its actions in an `operation`
enum. Decision 0067 keeps the always-visible tool prefix small and
cache-stable, so a family's description says only what an agent must know
before its first call, and its `help` operation returns the full usage on
demand. The managed tool set answers help from the family's own static text
(`withToolFamilyHelp`) and only for a family the turn offers; help never
reaches the family's executor, so every other action passes the same server
policy before any effect. A family whose grant or capability is off is
omitted rather than advertised and refused: Browser when the provider has no
verified tool transport, the thread's tool constraints exclude it, or a Code
host lends no browser; Apple or Android when the host has no toolchain to
lend; the planner's `octant_board` and `octant_propose_thread` outside the
designated planner thread. Browser shares one definition across modes.

Each mode offers only its admitted tools, so every runtime receives the same
definitions without a separate global tool installation or prompt catalogue,
through the transport its adapter verified:

| Runtime                             | App-managed tool transport                                                                                                                                                                                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code                         | The Agent SDK's in-process MCP server `octant`, owned by the provider connection                                                                                                                                                                           |
| Codex                               | App-server `thread/start.dynamicTools`                                                                                                                                                                                                                     |
| OpenCode                            | A connection-private loopback MCP endpoint, registered through OpenCode's own server API                                                                                                                                                                   |
| ACP runtimes                        | An HTTP MCP bridge when the runtime advertises and accepts it; ACP client file and terminal capabilities are separate                                                                                                                                      |
| Pi                                  | Octant's own Pi extension, calling a token-authenticated loopback bridge                                                                                                                                                                                   |
| Native harness and direct endpoints | Definitions in the request, for models with verified tool support                                                                                                                                                                                          |
| Typed CLI in a thread terminal      | Browser only, on a loopback MCP endpoint per grant, reached through `octant mcp`; the person adds that command to their CLI, and Octant writes no provider configuration. The macOS app ships the command too ([detail](design/terminal-browser-grant.md)) |

No transport edits a person's provider MCP, hook, or global configuration;
OpenCode's per-launch posture stays in its connection-private configuration.
Decisions 0006, 0093, and 0121 therefore hold.
The local-server adapter binds its private tool endpoint to one connection's
session and exact offered catalogue, and reports app tools only with a process
receipt attesting that external MCP, plugins, and skills cannot enter the
runtime; see [Provider runtimes](design/provider-runtimes.md#local-server-provider-adapter).

Browser and Computer are granted differently. Browser is a Work and Code
capability; Chat never offers it. It is offered on every Work or Code turn
whose provider carries app-managed tools, `@Browser` only adds selection
guidance, the first effect for an origin asks inline, and Plan mode refuses
effects. Computer is the bundled plugin plus a per-send `@Computer`
selection: only that send carries the full `octant_computer` family. A turn
without the selection carries the refusal-only definition described under
[Computer use plugin](#extensions-and-skills), and none at all when Computer
use is disabled, constrained out, or in Plan mode. Each application still
needs its own approval.

Canvas follows the same rule through its read-only `describe` operation: the
always-visible `octant_canvas` description says only what an agent needs before
its first call, and `describe` answers per-block guidance, recipes, and schemas.
The tool, recipes, presentation, preview, block catalogue, boards, comments, and
the `design` block are specified in [Canvas](design/canvas.md). Their boundaries:
`describe` reads no Project data and creates no artifact, and a recipe is a
starting shape, not authority; every new block kind or field is gated by a Canvas
schema version, so an older runtime refuses a document rather than misreading
it (the presentation-only table column `display` and chart, table, and metric
`format` fields are the one ungated exception, which the strict schema still
refuses on a runtime that predates them); a version is immutable, and a person's change (a plan task's status, a
diagram layout) is journaled as a new head version with the `local-user` actor
the host stamps itself; the host stamps comment authors, so a renderer never
authors as an agent; only a host window moves board nodes; `preview` renders
with the network off and no server address or credential; a static `design`
frame never receives `allow-scripts` and no frame has both `allow-scripts` and
`allow-same-origin`; a share carries a design only with the sharer's
acknowledgement that markup is shared as written, and refuses an action block; and
nothing drawn inline in the thread can journal a version.

Descriptions explain the existing presentation flows and distinguish creation,
queued jobs, and work proposals from opened previews or completed work.
Work also includes a short, budgeted artifact instruction in its required
context, so runtimes that use their own file tools know how written documents
appear in Files and Document. That instruction offers no tools or authority.

### Desktop menu bar

The menu bar is the closed-window fleet roster; the Inbox is the in-window list.
It prioritizes Open Octant, New task, and three compact sections: **Needs you**,
**Working**, and **Done since you looked**, at most six rows each. Empty
sections disappear. A row names the thread title, its mode, and its Project,
and choosing it opens and focuses that thread in the main window, opening the
window first when none is open. Local host contains status, browser access,
applicable lifecycle controls, and redacted diagnostics; Quit Octant retains
the existing active-work confirmation. The text beside the glyph is `!` while
the host itself needs attention (provider readiness, a lost host), otherwise the
count of threads that need the person.

The roster comes from the host, not from open windows, so it stays current with
every window closed. The shell registers its own local-window authority for the
menu bar with the desktop bridge secret it already holds, replaces it when the
host instance changes, and revokes it when the menu bar goes; it reads exactly
what any local window could. It polls `GET /api/fleet-activity` with the host
probe (every 2 s while a window is visible, 10 s otherwise). Every row names its
`activitySource`:

- **Needs you** is the pending-requests read
  ([pending requests across modes](#security-and-authority)): a Work request or
  any turn decision is `journal`; a Code approval or question, or a Chat
  question, is `session`, the live provider session parked on it. Code reach is
  per bound window and the menu bar's own window binds no Code Project, so its
  Code rows are the requests and decisions each local window with a persisted
  Code binding could answer; a Code Project no local window binds stays out. A
  waiting subagent is read the same way. The menu bar's window binds no
  Project, so its subagent rows are the waits that each saved local window with
  a Work or Code Project binding could open, whether or not that window is open
  now; a window bound to no Project adds none. Each parent is one needs-you
  row whose `activitySource` is `session`, and like every fleet row it carries
  the thread title, mode, Project name, state, and time, never the request
  text, the child's task, or its role. A thread that is both waiting and
  running is listed once, as needs you.
- **Working** is each mode's own navigation run state, the journaled fold the
  sidebar and board already use, so it is `journal`.
- **Done since you looked** is the one state the host cannot know, because only
  the shell knows when the person last opened a thread. A thread that leaves the
  host's list between two successful reads finished; it stays done until the
  thread is opened in a window or from the menu bar, or runs again. A focused
  window showing the thread when it finishes never makes it done. A failed or
  truncated read changes nothing, so a lost host cannot fake a finish. Done rows
  live in memory and start empty with each app or host instance.
- `screen` is reserved for an agent CLI seen only in a terminal pane. The
  contract refuses it for needs you, it never becomes done, it never counts
  toward the menu-bar number, and its row reads "seen in terminal". No current
  producer emits it: Octant does not scrape a PTY or screen for agent state.

Each row's tooltip names its source ("read from the journal", "read from the
live session"). The menu bar raises no notifications; banners and the dock badge
stay with the renderer's attention signals. Windows report only which thread
they show, which clears that thread's done row and tells the shell the window
can open a thread it is asked for. The read is local-window only, like pending
requests. Titles never enter the public health response or redacted
diagnostics. Separately managed hosts retain their existing lifecycle
restrictions. Nothing here writes provider MCP or hook configuration.

### Desktop context menus

Trusted top-level desktop windows may contribute a bounded native context menu
through the preload bridge: at most 160 entries, four submenu levels, and labels
up to 256 characters. Contributions contain presentation and opaque action IDs;
they cannot supply Electron roles, callbacks, paths, URLs, or native commands.
The shell returns the selected ID to the same window, which invokes its existing
renderer action and ordinary server authority checks. Dismissed, refused, closed,
or navigated windows select no action. Each window owns at most one contributed
native popup. The desktop's own text editing menu uses Chromium's edit flags and
fixed native roles; embedded browser frames cannot contribute workspace menus.

### Canvas documents, designs, and prototypes

Canvas produces three kinds of finished work: documents a person reads (a
spec, an article, a brief with tabs, metrics, diagrams, and badge tables),
designs they review (app screens, a site, a deck, a design system), and
prototypes they try (a flow that reacts to input and keeps state). It does so
in three tiers that an author mixes in one Canvas, using the lowest tier that
delivers the result. The static frames' `document` size and workspace theme
(Canvas schema version 16), their images named by asset id (version 17), and
running frames (version 18) have shipped, as described with the
[`design` block](design/canvas.md#design-block). The rest is accepted
direction: each rule below replaces the matching shipped rule in
[Canvas](design/canvas.md) when its slice ships, and until then the shipped
rule holds. Each tier is a Canvas schema bump, so an older runtime refuses the
document as a future version. Frames follow the
[Canvas HTML frames threat model](security/canvas-html-frames-threat-model.md).

- **Typed blocks carry data.** Metrics, tables, charts, plans, and the diagram
  family stay the catalog, because comments anchor to them, revision edits
  them, and shares keep their structure. Shipped at schema version 19 (see
  [Canvas](design/canvas.md)): `tabs` and `columns`, which name existing child
  blocks, a dashboard among them; closed diagram node roles (process, decision,
  terminator), edge styles, and group tones drawn by the one deterministic
  layout; a Gantt view of `plan`; and import of a bounded Mermaid subset into
  typed diagram blocks. Mermaid never renders; an unknown construct fails
  closed and stays a code block.
- **Static frames carry the look.** A `design` keeps a frame that runs
  nothing and has a `document` size whose height the host measures, which
  needs `allow-same-origin` and therefore never `allow-scripts`, and an opt-in
  workspace theme (semantic tokens, light or dark, the bundled fonts, and a
  first-party stylesheet for articles, cards, CSS-only tabs, badges, metric
  tiles, tables, callouts, and code), unthemed by default at device sizes,
  and images named by asset id, which the server resolves under the thread's
  mode and Project authority and the host inlines before drawing; all three
  have shipped. The frame itself loads nothing.
- **Running frames carry behavior.** A `design` may declare that it runs
  script. Its page comes from a host route fetched with a single-use ticket
  scoped to one Canvas version, never the session credential, with a
  `sandbox allow-scripts` response directive and a policy that allows inline
  script and style and no connection; the parent sandboxes the frame without
  `allow-same-origin`, `allow-top-navigation`, `allow-popups`, or
  `allow-forms`. A host-written bridge reports size, script errors, and a
  heartbeat, grants no tool, journal, or file capability, and a frame that
  stops answering or loads a second page is removed. Desktop does not draw a
  running design in a frame: a page policy does not cover WebRTC, so the
  prototype is a `<webview>` in a session of its own whose every connection,
  loopback included, goes to a proxy that is never a proxy. The main process
  attaches that surface only for a ticketed design page it was named, serves the
  page itself under a private scheme, refuses new windows, navigation,
  permissions, and downloads, and reserves a shortcut page script cannot
  intercept to return focus to host chrome. If the surface cannot be made the
  prototype does not run. A name lookup the page asks the resolver for can still
  leave the app, and the notice under the prototype says so. A remote browser cannot
  cancel a frame's own navigation or contain its peer connections, so there a
  running frame is not network-contained; that exposure is accepted, bounded
  by what the frame holds, and the Run control there says so. This tier has
  shipped.
- **The thread can hold the whole Canvas.** A person may expand any Canvas in
  its thread; the agent may ask for `inline` on a reading document, or on a
  `document`-size design that runs no script, without the 12-block cap; a
  running frame in the thread starts only on **Run**. Editing,
  comments, and sharing stay in the sidebar, and nothing drawn in the thread
  writes a version.
- **Agents are taught and checked.** `describe` presents the tiers with a
  finished example of each, in-tree recipes cover an article, a design brief,
  a design system, and a clickable prototype, and `preview` draws frames and
  returns overflow, contrast, missing-asset, and script-error warnings. This
  has shipped (see [Canvas](design/canvas.md)).
- **Shares and exports carry what they can draw safely.** Typed blocks travel
  as today. A frame travels in an authenticated snapshot only when the viewer
  draws it under the same frame policy and the sharer acknowledges that markup
  is shared as written, because the secret filter reads values, not markup;
  this has shipped at share version 10 (see [Canvas](design/canvas.md#shares)).
  HTML export writes frames as sandboxed `srcdoc` pages with the policy
  inside, the approval card names the markup it writes, and a themed design
  is drawn in the theme the person's window hands over; this has shipped.
  Markdown export writes the title. Public links stay out.

_Rationale:_ a `srcdoc` frame inherits the app policy (`script-src 'self'`),
so a running frame needs a page the host serves, and a frame sandboxed without
`allow-same-origin` has an opaque origin wherever it is served, so no separate
origin or desktop protocol is needed for that isolation. Growing only the
typed catalog was rejected because every new look becomes a schema change and
no closed set reaches a finished design or article. A separate origin, or an
Electron view per artifact, was rejected because it cannot be laid out in the
thread and does not exist for a remote browser; revisit if a frame ever needs
script with `allow-same-origin`. Rendering Mermaid was rejected as a second
layout, and an external design service because it sends Project content to a
third party and makes a core capability depend on one vendor.

### Device transport and evidence

The iOS Simulator and Android emulator are dock device panes: the screen is
streamed through the host, authorized like a screenshot, and never stored, and
closing a tab does not shut the destination down. An agent's request to raise
the pane lives only in server memory for the same thread and checkout. A raw
screen capture lands in a host-private directory only its own capture launch
may read or write. `octant_android` installs only a checkout-relative APK.
Input (tap, swipe, typed text, and hardware keys) rides the workbench control
channel with actor attribution and the remote/headless fail-closed attach gate;
an input whose delivery is unknown is reported `interrupted`, not `failed`, and an off-screen point or unsupported keyboard layout is refused,
never clamped or guessed. Octant does not script Simulator.app, and an agent
must not launch Simulator.app, `serve-sim`, or `serve-avd`. **Repair input**
runs only when a person requests it. **Record screen** starts and stops a time-limited recording a person asked for;
the video is stored as evidence under the screenshot rules and starting is an
effect confirmed per recording. **Open URL** opens a credential-free
`http`/`https` address a person asked for; it is an effect confirmed per
address (Allow input never covers it), and evidence keeps only the origin. **Rotate** turns the device between portrait
and landscape for a person who asked; it is an effect confirmed on its own
(Allow input never covers it). Pane states, discovery, capture, input
delivery, keyboard layouts, and the managed streaming tools are specified in
[Device workbench](design/device-workbench.md).

On an approval-gated thread, **Allow input** is the confirmation that opens
that destination; clicks, typing, Home, and Lock never raise it
([decisions/0152-allow-input-opens-a-device-to-clicks.md](decisions/0152-allow-input-opens-a-device-to-clicks.md)).
The agent's `octant_apple` and `octant_android` tools follow the thread's
turn posture per operation, not a Full-access gate on the whole tool:
`discover`, `status`, and `screenshot` are reads and run under every posture,
Plan included, as is `open` of a destination already booted or booting: it only
shows the pane, changes nothing on the device, and has no host action an
approval could bind to. Every other operation is an effect, including `open` of
a shut-down destination, which boots it. Plan refuses it; Full access
sends it with no approval; under approval-gated and auto-accept-edits the
server asks in the thread (an `approval-requested` turn event, answered like a
Browser session ask) before the pane opens or the host is called, and an
approval mints the host's one-use, five-minute approval bound to exactly that
request and its checkout context — the same receipt a workbench confirmation
yields, validated by the same Apple or Android policy. A denial, expiry, or
thread that went stale or into Plan while waiting refuses the call. Input to a
destination the turn's window already holds open under Allow input rides that
grant without asking; an approved agent input opens or renews it as a pane
input does. `octant_terminal` still requires Full access: it runs arbitrary
shell commands, which an approval-gated thread already reaches through its
provider's own per-command approvals.

## Modes: Chat, Work, and Code

Modes are server-enforced domain policy, not renderer flags. Chat and Work can
be disabled in settings; Code is always available; disabling a mode never
deletes its data.

The shell shows two modes, **Work** and **Code**. Work presents the Chat and
Work domains together: one sidebar lists both kinds of thread and Project, and
a new-thread composer chooses **Chat** (creates a Chat thread, no folder) or
**In a folder** (creates a Work thread bound to a Project root). The choice is
only which create command the composer sends; the active server mode still
follows the thread or draft on screen, each row opens in its own mode and
reaches its own kind's commands, and nothing in the renderer can turn a Chat
into Work or a Work thread into Chat. Settings' Chat and Work switches still
gate their domains: with one off, the composer offers only the other kind.

| Mode     | Binds to                                                                                                                            | Authority                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Chat** | A virtual, memory-scoped Project, or no Project at all                                                                              | No filesystem or shell authority. Optional safe research tools; scratch space is isolated per thread.                                                                                                                                                                                                                                                                                                                                                                             |
| **Work** | Exactly one OS-confined project root                                                                                                | Confined reads and bounded writes inside that root, approval-gated unless the thread's access is auto-accept-edits; no shell and no Git; document adapters (docx, pptx, pdf, image); research with citations; server-authoritative board.                                                                                                                                                                                                                                         |
| **Code** | Exactly one directory, ideally a repository root; Code threads select a checkout (current checkout or a managed worktree) inside it | Starts approval-gated; Full access only when explicitly remembered for that Project. Plan mode is always read-only. Git, terminals, tests, PR observation, and managed subagents run inside the bound root. Creating a Code Project may explicitly initialize Git in that folder (`docs/decisions/0079`) so a Code thread can prepare a checkout immediately; if that initialization fails, creation is refused and no Project is journaled. Binding without Git remains allowed. |

Work's missing shell and Git are withheld, not approval-gated: a person is
never asked to approve a command in Work, because approving one would give the
thread authority its mode does not hold. Every Work turn records that posture
(`shell: "denied"`, `git: "denied"`). Each provider driver enforces it for a
session acquired in Work mode, since a provider's own shell tool is outside
anything the host can gate after the fact. Claude and Pi start without their
shell tool. OpenCode's session rules deny `bash` and its `task` delegation.
Codex threads start and resume with `features.shell_tool` and
`features.unified_exec` off, because a Codex command that only reads runs under
its read-only sandbox without escalating; a `command` or sandbox-widening `permissions` request that still
arrives is declined at the agent. An ACP agent's `execute` permission request
is refused at the agent. The declared kind is all Octant sees of an ACP call,
and `other` also covers Octant's own managed MCP tools, so an agent that labels
a command `other` still reaches a person's approval rather than running unasked.
Because a provider's in-process shell can emit no protocol request at all —
observed on Linux where a Vibe Work turn ran real commands inside its jail —
the ACP, OpenCode, and Pi runtimes also launch confined in Work with process
exec and fork denied, so the OS itself refuses a shell the protocol never
sees. An ACP profile whose entrypoint spawns its own stdio server keeps fork,
which reaches no shell without a second exec target. Work never runs at Full
access, so these launches are always wrapped. The Codex app-server and the
Claude postures Work uses are not wrapped (see
[security and authority](#security-and-authority)); they withhold the shell
through the thread config and tool list above instead. Octant's own harness
gives Work no shell port. File writes inside the Project
remain approval-gated in every driver. Work that needs a shell or Git is
promoted to Code (below).

Chat's missing filesystem and shell authority is withheld the same way, and
more completely: a Chat session is acquired on its per-thread scratch
directory, and nothing a provider asks for in Chat is anyone's to approve, so
every approval request is declined at the agent. A provider sandbox that only
blocks writes is not enough, because reads never escalate. Pi starts with no
built-in tools. OpenCode and ACP agents launch confined with process exec and
fork denied and the scratch directory read-only. Claude's gate keeps its reads
inside the scratch directory, and its shell and edits ask and are declined.
Codex threads get no execution environment (`environments: []` on the thread
and on every turn), which removes its shell, `apply_patch`, and `view_image`;
they also start and resume with the shell, image, plugin, and app features
off, so a CLI that ignores `environments` still has no shell, and the user's
own Codex plugins do not load. MCP servers from the user's Codex config run
outside any environment (a `node_repl` server read another repository with
none), and no setting turns them all off, so the driver reads the effective
config and switches each named server off for the thread; a Chat thread whose
servers cannot be listed does not start. Octant-managed tools (research,
Canvas) are unaffected; they run on the host, not in the provider's
environment.

Provider-owned memory stays off in every mode. Octant's memory is scoped to a
Project, and a provider's global memory reaches across all of them: Codex runs
with `features.memories` off, which also keeps its memory folder out of its
sandbox's readable roots, and Claude runs with no setting sources.

Withholding the shell does not cut Work off from a person's integrations.
Work is for files, browsers, and documents, and what separates it from Code
is Git and the developer environment, not the tools a person plugs in. An MCP
server the person installed and enabled as an Octant plugin is selectable in
Work and Code exactly as in Chat (see
[Extensions and skills](#extensions-and-skills)). It runs in Octant's own
supervised session rather than inside the provider, so the Work-mode launch
confinement does not stop it, and every call it answers waits for a person
unless a remembered approval of that tool in that Project covers it.

A Work or Code thread started without a chosen Project lands in the mode's
**default Project**: the host provisions `<default folder>/Work` or
`<default folder>/Code` on first use, binds it as an ordinary Project marked
`origin: "default-folder"`, and reuses it after. The default folder is the
`defaultFolder` shell setting (`~/Octant` unless changed, always inside the
user's home), and artifact files mirror under its `Artifacts` subfolder until a
mirror setting says otherwise. It sits at the top of home rather than in
`~/Documents`, which macOS guards with a privacy prompt. Work always offers its
default Project. Code has one choice, the `requireGitRepository` setting ("Code
needs a Git repository", on by default). Off, a Code thread may start in a
folder that is not a repository on a `plain-folder` checkout whose head is
`none`, and that includes the Code default Project; every Git-backed feature
reports itself unavailable there rather than inventing a revision. On, both are
refused. See
[decisions/0118-a-default-folder-for-what-nobody-gave-a-home.md](decisions/0118-a-default-folder-for-what-nobody-gave-a-home.md).

The default folder used to be `~/Documents/Octant`, and threads without a
Project in Code had a separate `allowDefaultFolderThreads` switch beside the Git
requirement. A stored folder is kept, so an install that stored
`~/Documents/Octant` keeps it; only an install that never stored one follows
the new default. A window saves shell settings whole, filled-in folder
included, so in practice any install that saved a setting while the old default
was in effect stored it. Default Projects already bound under the old folder
stay ordinary Projects with their threads, and a changed folder creates a new
default Project beside them. Settings, journal events, and update commands that
still carry `allowDefaultFolderThreads` decode, and the switch is dropped: the
Git requirement each install stored is the one choice it keeps. The host only
ever stored that switch on with Git not required, so on-and-on never existed;
an install that had Git off and the switch off now also offers the Code
default Project, which is the one combination the single choice cannot keep.

Code task creation accepts a plain-folder checkout when the server admits it under
Code settings. The renderer preserves its proposed branch as delivery intent without
claiming a checked-out branch; detached Git checkouts remain refused. Git-dependent
actions continue to report unavailable for plain folders.

An authorized repository test remains cancellable while the host rediscovers its
command definition. Cancellation during discovery prevents process launch; runtime
shutdown also cancels pending discovery and waits for it to settle. Thread and
checkout authority checks still precede both run and cancellation.

Every Project, in any mode, may carry one optional **colour**: a theme palette
role (red, orange, yellow, green, teal, blue, purple, or pink) the person picks
as the Project's identity. It lives on the Project record and is journaled as
`project.color-changed@1`, so every client sees the same colour. Absent means no
colour was picked and reads as a neutral mark; older Projects and events replay
without it. `change-project-color` carries the role, or `null` to clear it, and
follows the same rules as a rename: an archived Project refuses it, and a change
that would leave the colour as it is journals nothing. The colour grants no
authority and carries no status.

A Work Project may opt into a **status file**: `STATUS.md` at the top of its
folder, where the work stands, with dated follow-ups and deadlines. The setting
lives on the Project record as `statusFile` and is journaled as
`project.work-status-file-changed@1`; absent reads as disabled, so every
Project, including one created before the setting existed or whose folder
already holds a `STATUS.md`, starts off. The default-folder Project refuses it
on the server: it holds what nobody gave a home, so there is no single piece of
work for a status to describe. Enabling seeds `STATUS.md` if it is missing.
While enabled, the file is read into every Work turn ahead of the thread's
transcript with a standing instruction to keep it current; a completed turn
that changed files without touching it gets a `Recent changes` line appended
from the 0083 record; and a stale status or a near or passed date makes the next
task open by taking stock and asking for an update. The Work Project page, the
Work board's follow-up mark, and the inbox's `follow-up-due` attention signal
read the same file on demand; nothing about its content is journaled. While
disabled, Octant reads nothing from the folder for this purpose, adds no
instruction, and writes nothing there; turning the setting off leaves an
existing file untouched. Octant never writes an agent brief (`AGENTS.md`,
`CLAUDE.md`, or similar) into a user folder, and a Work turn does not read an
existing one: Claude Work turns load no project settings or instruction files,
and Codex Work threads start and resume with `project_doc_max_bytes = 0`, which
skips the `AGENTS.md` discovery Codex otherwise runs from the repository root
down to the Project root. This narrows the always-on
behavior first recorded in
[decisions/0119-a-work-project-keeps-its-status-in-its-folder.md](decisions/0119-a-work-project-keeps-its-status-in-its-folder.md).

Work never silently becomes Code. When coding work is detected in a Work
thread, the server records a **promotion proposal**; only explicit user approval
creates a linked Code thread, and the new thread inherits no authority from the
Work thread.

Rebinding a Code Project supersedes the checkout its existing threads were
created against, and no later observation can produce those threads' checkout
ids again, so the server reports them as unavailable rather than waiting on a
reconnection nobody is attempting. Per `docs/decisions/0032`, that refusal names
a way out: the thread's fail-closed surface offers an explicit rebind that moves
it onto the checkout the Project binds now. The server authorizes and journals
the move, and it never happens on its own — a matching filesystem root is not
consent to change what authority a thread holds. A session grant of Full access
does not survive the move; the thread lands on its persisted posture. A thread
that owns a managed worktree is refused, because that checkout is the thread's
own tree rather than the Project's.

A Code fork (`fork-code-thread`) is a managed-worktree creation the host
resolves itself: the client names the source thread and a finished turn, and
the host picks the files from its own record — the checkpoint the next writing
turn captured before it ran (a Plan turn in between writes nothing and is
skipped), or a fresh capture of the source checkout when the named turn is the
newest. It refuses a turn that has not finished and a point a writing turn
passed without a capture rather than guess. The worktree starts at that
checkpoint's commit on a new delivery branch, and the captured trees are laid
over it, so uncommitted work arrives too; a failure to lay them down removes
the worktree and creates nothing. The fork starts approval-gated with
current-session persistence and inherits no profile, pending outcome proposal,
running turn, or session grant. Every Code thread creation checks a
`forkedFrom` origin on the server: it must name another thread of the same
Project, and the fork's text handoff (below, "Fork handoff (Code)") must be
selectable from that thread through the named turn right now. A fork or
Restore from here whose handoff cannot be built is refused with the reason
before any worktree is prepared, because the text handoff is the one
conversation transfer every fork can fall back to.

A fork or Restore from here copies its source's conversation, and a harness
fork its tool results too, so a thread made from a source marked with
outside content starts marked. A Code creation with a `forkedFrom` origin
whose source is marked appends `thread.external-content-ingested@1` on the new
thread
(`external-content`, label `code-fork`, content reference
`code-fork-<source thread>-<fork turn>`) before it journals the thread, so no
moment exists at which the thread is created and unmarked; a mark that cannot
be journaled refuses the creation and removes its worktree. The mark and the
thread commit as one journal unit, so a creation that fails after the mark
leaves no mark behind: only a person's clear may forget a mark, so a failed
creation is never undone by a later event. An unmarked source
makes an unmarked thread. The source's mark is read when the creation is
checked, as its handoff reports it. A source a person cleared is unmarked, and
its fork starts unmarked: the clear holds until the next ingestion, and a
fork brings in nothing the person has not reviewed. A source marked again
after its clear marks its fork. The new thread's mark is its own. It
survives replay, a purge of the new thread erases it, and a person clears it
there like any other.

A Chat branch (`branch-chat-thread`, which Chat's Restore from here also
sends) copies its source's messages and completed replies, so a branch of a
marked source starts marked by the same rule: the mark (`external-content`,
label `chat-branch`, content reference
`chat-branch-<source thread>-<branch turn>`) and the branch commit as one
journal unit with the mark first, and a mark that cannot be journaled refuses
the branch with nothing created. The source's mark is read from its
outside-content projection when the branch is made; the cleared-source,
replay, purge, and clear rules above hold unchanged.

A follow-up or side task a model suggested on a marked thread starts marked
too, in every mode, by the same rule (label `follow-up`, content reference
`follow-up-<source thread>-<new thread>`). It copies no transcript, but its
title and prompt are text an agent wrote after reading what marked the source,
nothing bounds what that text can carry, and a side task sends its prompt as
the new thread's first message. Starting one is not a review the way a clear
is. The host's follow-up creator reads the source's mark when it creates the
thread and hands the mark to the Chat, Work, or Code creation as a host-only
input no wire command can carry; a source a person cleared passes on nothing.

A thread a person confirms from a Code planner's proposal starts marked when
the planner thread is marked, by the same rule (label `planner-proposal`,
content reference `planner-proposal-<planner thread>-<proposal>`). The planner
agent wrote the proposal's title and intent after reading whatever marked its
thread, and the intent becomes the new thread's opening prompt; confirming
reviews the proposed work, not what the planner read. The planner service reads
the planner thread's mark at the confirm and hands it to the Code creation as
the same host-only input; a mark that cannot be journaled refuses the confirm,
creates nothing, and leaves the proposal pending.

Fork, branch, follow-up, and planner proposal journal their marks through one
shared step.

A Work-to-Code promotion starts its linked Code thread unmarked. The proposal
names a Work Project, not a Work thread: its summary is text the person typed
into the proposal, its artifact refs are opaque names the host checks for
leaked authority and never reads into the Code thread, and the linked thread
takes only that summary, as its title. No agent-written or outside text
crosses, and there is no source thread whose mark the host could read; marking
from one would mean trusting a thread id the client names. A promotion that
comes to carry a Work thread's transcript or text an agent wrote must mark by
the rule above.

A `#thread` mention or a Side Chat's source brings another thread's
transcript into a turn, so a source marked with outside content marks the
thread reading it (labels `thread-mention` and `side-chat`, content reference
`<label>-<source thread>`). The host reads the source's mark after reading its
transcript and appends the reader's mark before it hands the framed text to
the turn, the order the sibling-thread `read` keeps, so the reader's provider
never sees a marked source's text on an unmarked thread. A mark that cannot be
recorded withholds the text: a mention is answered as unreadable, which costs
the mention and not the send, and a Side Chat turn is refused. The reference
names the source, so mentioning one source again journals nothing new until a
person clears the reader. The sibling-thread `read` marks its caller on every
call, whatever the target, because an agent chose to read; a mention or a
Side Chat is the person's own choice of thread, so an unmarked or cleared
source passes on nothing, as for a fork. Chat, Work, and Code mentions share
one resolver, and a thread that mentions itself is not marked again. A Side
Chat's state section also carries finished subagents' replies, and a reply
marks its parent only when it is delivered, which waits while the parent's
turn runs, so each reply in that section marks the sidecar itself (label
`subagent-result`, content reference `subagent-result-<run>`) by the same
order; a reply that cannot mark it refuses the turn.

A Canvas carries the mark of what wrote it. Every Canvas version commits
through the Canvas event store, and when the thread the Canvas belongs to, or
the managed child writing it, is marked at that moment, the store first appends
`canvas.outside-content-carried@1` (aggregate `canvas-outside-content`, one
event per writer, naming the writer and the first marked version) in the same
journal unit as the version, so no moment exists at which the Canvas holds that
text unmarked; a mark that cannot be read or recorded refuses the version
(a create, revise, board drag, refresh, or adopted version is refused with
`unavailable` and a message to try again, never reported as a race). This
covers an agent's create and revise, a child's, a hand-off document, a person's
edit, and a version taken from another computer, which marks the thread it
lands in first (`Synced from …`). A version taken from another computer is
recorded under its own author, an agent whose id is the version's id, and the
Canvas carries that author whenever the thread it lands in is marked, so a
person's clear of that thread never makes the synced text the thread's own. A version taken before it recorded its own author is named the same way at host start, from the thread's journaled ingestion of it (`replica-artifact:<canvas>:<version>`), which a clear does not erase. The Canvas tool's `read` and `preview` are how
another thread's model reaches a Canvas (any Canvas of its Project, by id), so
both mark the reader (label `canvas`, content reference `canvas-<canvas>`)
after the Canvas is read and before anything from it is returned, when the
Canvas records a writer other than the reader or the thread it belongs to is
marked now; the second rule covers a Canvas written before marks were recorded
at write time. A reader that cannot be marked is not given the Canvas. Every mode follows this
rule, Chat included: only a `read` or `preview` that returns content from a
marked Canvas marks the reader, so `describe`, a create, a revise, and a read
of a clean Canvas leave the thread unmarked. A child
is marked under its run, as its other tools are. A writer reading its own
Canvas passes on nothing. The mark recorded at write time is the Canvas's own:
a person's clear on the writer reviews what that thread read, not every thread
that will read the Canvas later, so it leaves the Canvas marked. It survives
replay, and a purge of the Canvas, or of the thread it belongs to, erases it.
A Chat Canvas selection carries only its name into planning, never the
Canvas's text, and a Canvas's mirrored or exported files are files: another
thread that reads them with its own file tools is not marked, as for any file a
marked thread writes.

An in-place restore (`restore-git-checkpoint`, sent by both Restore files to
this point and Undo restore) overwrites a checkout other threads may share, so
the host refuses it, as a `conflict` before Git is touched and before any undo
point is taken, while another thread has a live turn that may write there: a
turn in state `running` or `waiting` whose posture is not Plan. A turn parked
on an approval counts, because it writes as soon as it is answered. "The same
checkout" is the same resolved checkout root path, not the same checkout id:
the id derives from Project and binding revision, so two Projects on one folder
have different ids for one directory, and a managed worktree has its own path
and so never matches. The refusal names the other thread by title (cut to 100
characters) only when it is in the requesting thread's Project; otherwise it
says a thread in another Project is writing. A writing turn counts from just
before the host captures its checkpoint, through the runtime's preparation
(credentials, session seeding, fork preparation), until the runtime has taken
it on, so a restore cannot land between the capture and the launch. A start
that is refused or fails while preparing stops counting at once and holds
nothing back after that. Stopping a turn that is still preparing releases its
root at once, even if a preparation step never returns, and the turn is
refused at its next admission check, at the latest just before the runtime
takes it on, so it never reaches its provider. The stop is journaled as the
start's result when Stop returns, so the transcript shows the turn stopped and a
retry of that operation, including a start recovered after a restart, answers
from the journal instead of launching it. A stopped start whose preparation
settles later clears and settles only its own runtime bookkeeping (pending
start, spend reservation), keyed by its operation, never that of a newer turn
on the same thread. The other order is serialized
by root too: a turn that starts while a restore that passed this check is still
overwriting the same root holds the root, so no further restore starts, and
waits for the overwrite to finish before it captures its checkpoint, so it
starts from the restored files. A second restore of a root that is being
overwritten is refused as a `conflict` as well. Git alone queues only per
checkout id, which would let a turn or a restore in another Project on the same
folder, or a recovered start that captures nothing, run on a half-restored
tree. Restore from here and Fork from here create a thread on its own worktree
and are not subject to the check. Discard and revert also overwrite files and
are not yet covered.

A child AgentRun starts only when the thread's agent delegates through the
Octant Harness `delegate` tool or a provider harness's `octant_agents` tool.
Both entry points use the same host admission, routing, workspace, and lifecycle
services. Either parent harness can target either child harness; provider-owned
hidden subagents remain disabled. The host's AgentRun routes read and control
existing runs but create none. Admission (`admitAgentRunControlRequest`) prepares the child's workspace
on the server: Chat a research-only virtual workspace, Work the current
confined Project root and binding revision, and Code an isolated managed
worktree that is confirmed before admission. No client supplies a path, a
receipt, or a claimed `verified` flag. Admission, restart, and replay refuse
stale, expired, foreign-thread, foreign-Project, parent-checkout, unavailable,
or wider-than-parent grants. Whether the agent may delegate is one host
setting, on by default; a stored Ask from the retired "only when I start them"
choice reads as off.

Each Code child allocation is keyed by its parent and delegation request. Two
sibling requests receive distinct managed worktrees; only the same request can
reuse its verified receipt. The host checks the actual Git worktree inventory
and records the starting commit. Children start from committed source only; the
parent checkout's uncommitted edits are not copied into a child worktree, and
there is no opt-in to seed one from the parent's working tree. A child that
must see an edit starts after the parent commits it.

Provider-owned child reports are read-only observations through the existing
`child-agent-activity` SDK event. Chat attempts, Work turn updates, Code operation
frames, and managed-child conversations retain the normalized facts in their
existing journals or purgeable content. Identity includes the mode, root thread,
optional managed parent, provider instance, session, and provider child ID.
An observation never receives an AgentRun ID, workspace grant, or managed control.
Missing child model or task metadata stays unknown; the lead model is not a
substitute. Status is the provider's last report, not proof of a live process.
Replay is idempotent; conflicting reported identities become unknown, and missing
or circular child lineage is excluded. Each source retains at most 16 observed
children and eight history entries per child, with explicit partial/truncated
history. Parent reads include at most 64 observations. No current in-tree adapter
advertises native-child observation support: their existing child-disable and
provenance gates remain in force. SDK fixture coverage does not establish
real-provider native-child acceptance.

Child result packets retain at most 16 generations, including the current
generation's availability, immutable execution target and workspace receipt.
The reported summary is a bounded 4,096-character view of the generation's
existing result content. Lifecycle blockers come from recorded settlement facts.
Normalized file-change reports and host-executed tool returns are stored beside
the generation's reply, atomically with settlement, in the same subject-owned
content store. Each section retains at most 32 records and 60,000 serialized
characters; tool output is bounded to 2,048 characters. File paths outside the admitted workspace are omitted and
make the section truncated. Provider file reports are explicitly unverified;
host tool returns remain an unknown check outcome even when their output says
a test passed. No result implies parent delivery, review, merge, or deployment.
Writable managed Code children capture their isolated workspace before execution
and after confirmed provider teardown through the host's Git checkpoint port.
The same path covers Octant Harness and provider harnesses. The private session
record preserves the original tree and workspace identity across waits and retries
within one generation; a new follow-up generation starts its own comparison.
Git captures include tracked and non-ignored untracked files without changing the
real index, HEAD, or branch. Captures describe observed workspace changes, not proof
that the child alone authored them.

A settled comparison retains at most 128 paths and 65,536 diff characters, with a
120,000-character serialized ceiling, in subject-owned content beside the result.
Comparison captures create no Git refs, so a crash cannot leave pinned source
content behind. The retained diff remains readable after later edits or Git object
collection; collection before comparison can make the capture unavailable. A resumed generation
whose original tree was collected cannot substitute its current midpoint and
reports review unavailable. Waiting generations can advance their snapshot at the
next settlement; completed generations keep their original comparison. Failed
captures invalidate an earlier partial comparison for that same generation.
Review reads accept only the managed run and generation, check current parent and
child read authority, and never resolve a client-supplied filesystem path. Summary
polling carries metadata only. The existing Review surface opens the saved diff
without checkout mutation or parent-file navigation. Chat, Work, Plan, legacy
sessions without a baseline, and unavailable captures report review unavailable;
a parent checkout is never substituted.
Parent and child scope checks precede reads, streams recheck scope before each
frame, and a parent purge removes all generations' text and evidence. Nested
observations retain the authorized root thread and identify their managed parent
separately. Result reads do not consume or acknowledge delivery.

A managed child's lifecycle moves from Starting to Running once its workspace
is verified and its provider session starts, not at completion. One turn,
from provider acquisition to its terminal event, may work for at most 30
minutes (`MANAGED_AGENT_RUN_TURN_DEADLINE_MS`); a turn that reaches that bound
is recorded as Interrupted and releases its capacity. The bound counts working
time only: it pauses while the child waits for a person's approval or answer and
resumes with the remaining time once every pending request is answered, because
a child cut off with its approval card still open lost its work to the person's
pace rather than its own. No separate overall wall-time cap exists, by decision: the working
deadline is the only bound, since a cap that counted a person's wait would
cut off the work it protects. A waiting child keeps its capacity slot until
the request is answered, the run is cancelled, or the host restarts.

Managed children retain a private provider-session cursor and a bounded,
purgeable conversation alongside their journaled lifecycle. A cursor is bound
to the run, provider, model, workspace, context, and authority. Resume uses that
same native session only when the provider supports it and the binding still
matches; it never silently starts a fresh session. Missing or invalid continuity
requires Retry. Restarted conversation views are marked stale until execution
reconnects, and a purged subject cannot restore its session or conversation.

Children on either harness use the host's approval and question stores. Each
prompt identifies its child, provider, and model and is checked against the
live parent and child authority before and after the answer. A child approval
permits only that request, never consumes or creates a remembered lead-session
grant, and cannot approve an opaque provider action in Plan mode. Cancelled or
expired requests and requests whose transport was lost at restart cannot be
answered. The composer signals pending child input and opens its detail view. The same
request is a Needs you row naming the parent thread and the child (see
pending requests across modes); the row has one action, which opens the parent's
Agents tab on that child, and no way to answer.

Live child steering is optional on a provider connection. Codex uses its
current-turn steering command; Octant's harness inserts a note after a complete
tool-results step or response and persists it before acknowledging delivery.
Only notes retained in the fitted provider request are recorded and acknowledged;
notes omitted to fit the context limit are refused.
Unsupported steering is reported as such; a saved note alone is not evidence
that the running child received it.

Delegation resolves explicit provider/model selections against the parent's
current eligible catalog, including Project policy and supported reasoning
values. With no explicit target, both harnesses use the same role-to-slot
mapping and host/Project model slots (Settings names them model roles). An unconfigured route can inherit the
authorized parent target; a configured but unavailable or disallowed route does
not bypass its settings. The selected target and routing decisions remain
visible. Off, paused, tainted, and unauthorized parents cannot start helpers.

Parent conversation context is opt-in and fixed at admission. Chat uses its
admitted conversation; Work and Code expose bounded accepted prompts and
completed replies with source attribution, provider/model identity, taint, and
omission metadata. Work/Code selections contain at most 24 blocks of 4,000
characters, including metadata. Reasoning and tool bodies are excluded. A
foreign, changing, or incompletely read selection fails closed. A Code or Work
parent's own running turn is readable: its accepted prompts are selected and its
unfinished reply is disclosed as omitted. The selection is read before a child
workspace is allocated, so a refusal names the reason (for example, no readable
messages yet or a conversation that changed during the read) and leaves no
worktree behind.

Finished siblings currently owing a result to the same parent can be delivered
in one ordinary parent turn, capped at 16 members and 32,768 prompt characters.
Delivery does not wait for every sibling to finish. Each member's identity and
result generation are validated and journaled on the receiving turn; replay
settles only those members. Actual fallback provider/model attribution is kept.
The delivery service serializes work per parent and defers while it is busy.
A Chat delivery names the parent at its thread aggregate's head version, the
version Chat admission checks, and a refusal that only says the parent is
mid-turn or moved on is deferred and retried, never journaled as a failed
delivery. Delivery runs as the host, under the same per-process host scope a
[routine](#modes-chat-work-and-code) runs under, never through a window: a
child's result reaches its parent with no window open, and an open window lends
it neither identity nor Project binding. Admission still rechecks the parent's
Project access (an inactive Code Project refuses and the delivery fails), mode,
and posture as for any turn. A Work delivery waits while Work is turned off,
since no window stands in for the mode switch, and lands once Work is back on.
A Work delivery turn is journaled as the host's `system` actor, and any
approval it raises reaches the Project's local windows the way a routine's
does. A child that ends without a reply (failed, interrupted, or cancelled)
reports why on the managed `wait` and `status` answers and in the delivered
outcome line: its journaled reason, redacted with the diagnostics rules and cut
to 512 characters.

A completed managed child accepts an explicit follow-up through either
delegation tool or the Agents views. The caller supplies its current version
and a bounded message; native resume support, saved identity, current authority,
workspace, capacity, and spend are rechecked. Both tools and the UI revalidate
the saved provider, model, and reasoning against the parent's current eligible
catalog, including after asynchronous workspace preflight. Code workspace ownership and the
saved physical identity are verified asynchronously before a new generation
starts; current version and exact-window authority are checked again after
that wait. Execution preparation reserves spend and provider capacity before the
lifecycle commit, and releases both when the commit or host admission refuses.
A synchronous admission refusal leaves the completed generation, prior result,
and follow-up draft unchanged. An accepted execution binds its window before
provider acquisition. One accepted completed-child follow-up is staged in its
private session record before the lifecycle commit, bound to that session and
the next generation; an uncommitted future generation cannot replay it. Recovery
resumes an unsent message verbatim. A provider failure before sending that message
interrupts the generation so Resume can recover the accepted input in the saved
session. The record is marked uncertain before send
and cleared on confirmed completion; an uncertain delivery refuses automatic
resending and asks the caller to inspect the retained conversation. This is one
continuation input, not an editable work queue.
The child keeps its identity and conversation, while a new result generation gets its own delivery and
acknowledgement. Legacy delivery marks cover generation 1 only. A cancelled
child cannot continue, and unsupported continuation never becomes a silent
fresh start. The prior result must first reach its parent or be explicitly
collected; a refused follow-up keeps that result available. Status reads do not
consume replies. Only complete replies that fit the tool response bound are
consumed by explicit collection or single-child wait.

Managed Claude children persist the identity written by the adapter in private,
purgeable child content, bound to the admitted child and saved session. This
contains no credentials and is removed with parent content or provider removal.
The existing adapter still verifies the exact identity and native history;
a saved cursor alone cannot reconstruct missing proof.

Children can form a dependency graph. A run admitted with `dependsOn` (up to
eight existing sibling runs of the same parent thread) parks as Waiting under
`waiting-on-dependencies`: it holds no capacity slot, the capacity queue never
starts it, and a restart leaves it parked. `AgentRunDependencyScheduler` asks
the orchestration service to settle it on every committed status change, when
the parent thread's harness session is resumed, and once at boot, through the
pure `decideAgentRunDependencies`. When every dependency completed, the run
starts (or joins the capacity queue if no slot is free) and receives each
dependency's reply as a context block; a reply that is gone fails the start
closed. A ready run is held instead while its parent's harness session is
paused or `recovery-required` (the same rule that refuses a new `delegate`),
and a restart never starts one on its own: every run already parked when the
host boots stays parked, even once its dependencies complete, until a person
resumes it or resumes the parent's session; a person's resume of the run
itself is refused while the parent's session is held. The hold lives in the
orchestration service and is rebuilt the same way at every boot. A dependency that failed or was cancelled fails
the dependent without running it (`dependency-failed: <id>`); an interrupted
dependency does not, because a retry can still complete it. A run cannot be
admitted on a sibling that already failed or was cancelled, and since only
existing runs can be named, a cycle cannot be expressed.

How many children run at once is the person's setting
(`AgentRunPolicySettings.concurrency`: per thread and on the host, defaults 4
and 8, each at most `MAX_AGENT_RUN_CONCURRENCY` = 16). Run slots enforce it at
start: `createInMemoryCapacityPort` counts reservations per thread and per
host, reads the limits on every reservation, and reports which limit is full;
the capacity queue skips a waiter whose own thread is full so another thread's
waiter can take a freed slot. A run waiting on dependencies or a slot holds no
slot. Admission separately caps unfinished children (any active status,
waiting included) at 16 per parent and 32 per host as the runaway guard.

Threads form one real hierarchy (Project → thread → linked or child thread).
Work and Code have server-derived thread boards (Ready / In progress / Waiting /
Done); Chat has no board. Code lists active open and draft pull requests from
connected Projects in a manually refreshed workspace and joins exact
thread-owned PR status onto Code board cards. A Code thread is Done only when
its user-confirmed delivery target is objectively satisfied; ambiguous state
resolves to Waiting, and no person's mark overrides it. A Work thread is Done
when a person
marks it Done (`confirm-work-thread-completion`, naming the thread's current
title). The mark is final: it needs no evidence text, and stale supporting
evidence, a later rename, or an outstanding child run does not return the card
to Waiting. Requiring fresh, matching evidence filled boards with Waiting cards
for work the person had already finished. The host refuses the mark from a
routine or anything else acting as the host, and no provider tool can send it,
so an agent cannot mark a thread Done. An optional note sent with the mark is
kept as the thread's completion evidence; without one the thread carries no
evidence record.

The mark locks the thread on the host until the thread is archived and
reactivated, which clears it; a lock only in the window let a queued message,
a routine, or a child's result start a turn anyway. Work turn admission, the
one path every Work turn takes, refuses a turn on a marked thread before it
counts as the person re-engaging, whoever sends it: a window or phone, the
message queue, a usage-limit continuation, a child run's result delivery, a
goal round, or a routine. The host also refuses a provider or model change
and a new resume-at-reset opt-in. Each refusal reaches the window and the
phone through the ordinary refusal of that command. Renaming, archiving,
putting away and cancelling a scheduled resume stay open. Nothing owed to the
thread is dropped silently:

- The message queue holds. It refuses a new message, keeps the messages it
  already has with the visible `thread-unavailable` hold, and the person
  resumes or removes them after reactivating.
- A child run's result waits, readable on the run, and is delivered as a turn
  once reactivation commits.
- A resume-at-reset that falls due while the mark stands ends as
  `invalidated` with a note on the thread. Held until reactivation, it would
  run at a time the person never chose.

Work artifacts belong to the Project, not the thread, so the mark does not
lock them; changes from the thread happen in turns, which it refuses. A turn
already running when the mark lands finishes normally.

**Pull-request merge.** The person at a local desktop window may merge one
open pull request from its review (`POST /api/code/project-pull-requests/merge`).
That is the only pull-request mutation Octant performs; approving, commenting,
requesting changes, editing, closing, reopening, and force-pushing stay absent.
The rules:

- **Who.** Only a `local-window` principal. The route answers 403 to a paired
  remote device before decoding the command, and the server service refuses
  any initiator other than `user` as `not-authorized`. No provider, agent tool,
  plugin, routine, or Code posture (Full access included) can reach it.
- **Confirmation.** The review enables Merge only for a fresh, unambiguous,
  open, mergeable observation. Merge opens an inline confirmation that names the reviewed head
  and focuses Cancel; nothing merges until the person chooses Confirm merge.
- **Server checks before the effect.** The command names the Project, the
  repository, the number, a method (merge, squash, or rebase), and the head SHA
  the person reviewed. The server refuses unless that Project is connected on
  this window and resolves to exactly that github.com repository, and refuses
  while GitHub access is revoked. It then re-reads the pull request and refuses
  `not-open`, `not-mergeable`, or `stale` (head moved), and passes
  `--match-head-commit` so GitHub also refuses a head that moves in between.
- **Credential.** The host's installed `gh` CLI with its own stored login.
  Octant stores no GitHub token; ambient `GH_TOKEN`, `GITHUB_TOKEN`, and
  `GH_ENTERPRISE_TOKEN` are stripped and prompts are disabled.
- **Record.** Every attempt that reaches the server merge path appends one
  `code.project-pull-request-merge-recorded@1` event, as its own aggregate,
  before the outcome returns: the local user as actor, the Project, the
  repository, the number, the method, the approved head SHA, and the result
  (merged, refused with its reason, unavailable with its reason, or failed as
  `aborted` or `error` when the merge call throws and the effect is unknown;
  the error is rethrown and its text is never journaled). The payload carries
  no credential, title, or body, and no projection reads it;
  it is Octant's own record beside GitHub's history. A failed local append
  fails the request even when GitHub already merged; the next refresh still
  observes Merged. The outcome also drops the cached detail and list rows. A
  thread linked to the pull request reaches Done only through the ordinary
  observed-state rule, never from this record.

**Delivery (publishing to a user-owned target) is dormant.** The ship service
and its journaled events exist, but the host wires no target source, no
artifact observer that saw a build produced, and no issuer of the per-act
approval bound to the exact target, revision, and build (`server.ts` passes an
empty target list, `observedArtifact` and `approval` that return nothing, and a
publish path that fails). The renderer shows Delivery only when a thread has an
enabled target (`hasActionableDelivery`), so it stays absent. It stays absent
until all three exist; a standing grant never substitutes for the per-act
approval.

**The Project planner thread is a server-only capability.** A Code Project may
designate one of its own Code threads as its planner, whose agent surveys the
Project's board and proposes new Code threads for a person to accept. The
server, contracts, domain policy (`@octant/domain/code-planner-policy`), and
the client-runtime transport implement it; no renderer, phone, or CLI surface
designates a planner, lists proposals, or resolves them, and the shell does not
advertise it. Because nothing in the shell designates a planner, no thread
receives the planner tools in ordinary use. Any later surface must keep the
rules below:

- **Routes.** `GET /api/code/planner/:projectId` returns the designation, its
  version, and the proposals; it needs only the authenticated window's access
  to that Project. `POST /api/code/planner/commands` (designate or undesignate)
  and `POST /api/code/planner/proposals/commands` (confirm or decline) accept
  only the `user` initiator; a principal gated as an agent, such as a paired
  remote device, is refused as unauthorized before decoding. Every command
  carries the expected aggregate version, and a stale one is refused, never
  merged. A body cannot supply window identity.
- **Designation.** Only an active Code Project, one planner per Project, and
  only a non-archived thread of that same Project. Designating while one is
  designated refuses, even for the same thread; undesignate first.
- **Agent tools.** `octant_board` and `octant_propose_thread` are offered only
  to the currently designated planner thread, and both re-resolve the
  designation on every call, so an undesignation takes effect mid-turn. The
  board read is the same server read-model the board UI queries, scoped to the
  planner's own Project, with no GitHub call. A proposal executes nothing: it
  is journaled as pending (at most ten unresolved per Project) with the
  planner thread as actor. Both tools sit before the Code posture gate because
  neither touches the checkout, but still pass the stale-identity and profile
  tool-constraint checks.
- **Resolution.** Only a person confirms or declines. A confirm creates its
  thread through the ordinary Code creation command, inside the proposal's own
  Project only; the planner has no creation authority of its own.

**Routines (Automation Center).** A routine is a host-owned, Project-bound
definition that starts an ordinary Work or Code thread with a fixed task prompt
on a trigger: once, every N minutes (15 minutes to 30 days), or weekly at a
local time in an IANA time zone. Chat has no routines. Each occurrence creates
at most one new thread (target policy `new-thread`) and runs its first turn
through the ordinary thread and turn services; a routine cannot do anything the
thread it creates could not do.

- **Authority ceiling.** A definition captures an execution profile (an existing
  agent profile: provider, model, policy, permission persistence) and an
  authority snapshot whose effective authority never widens the requested one
  and fits under the profile. Work routines get no shell or Git authority. Full
  access is never eligible, whether or not it was remembered elsewhere: the
  contract refuses it on the snapshot and dispatch blocks it as
  `full-access-ineligible`. Code runs are always created approval-gated. Work
  runs bind the Project's confined root like an interactive Work thread, and
  their unattended first turn runs ask-first even when the host's Work default
  is auto-accept-edits, unless the routine's captured effective authority is
  itself auto-accept-edits; the hold only narrows. A Code first turn runs with
  the `agent` initiator, so approvals wait for a person.
- **Revalidation at every occurrence.** Before creating a thread the dispatcher
  re-reads live host facts and blocks with a typed reason when the host, the
  Project (active, same mode, same version), the binding revision, the Code
  checkout, the execution profile version and policy, the provider and model,
  the authority digest, or the confirmed delivery-target template no longer
  matches. A stale definition never adopts replacement authority.
- **Who may author.** Routes accept only an authenticated principal from the
  transport; a body cannot supply principal or origin. A create must target a
  Project of the same mode that principal can reach, and every other command
  must address a routine whose Project it can reach. A paired remote device may
  author only on its own host and within those Projects; its routines get the
  same ceiling. Automation-origin execution cannot create, edit, run, pause, or
  archive a routine (`automation-recursion`), and no agent or provider tool
  reaches the routes.
- **Asleep or offline.** The scheduler is an in-process timer in the running
  host over journaled definitions. Nothing wakes the computer or runs in a
  cloud. On return it reconciles missed occurrences by the routine's policy:
  `skip` records them as skipped; `run-once` records all but the newest as
  skipped and runs the newest once. No catch-up burst. More than the missed-run
  cap blocks the routine as `missed-run-cap-exceeded`. A routine with an active
  run never overlaps itself.
- **Runs as the host.** A routine is host-owned, so its run creates the thread
  and starts the first turn as the host, never through a window: it runs with
  no window open, and an open window lends it neither identity nor Project
  binding. The routine scope is minted per process and never registered, so no
  route, renderer, or paired device can act as it; it reaches only active
  Projects of the routine's mode, after the revalidation above, and every
  ceiling here still applies. The thread's creation, and a Work run's first
  turn, are journaled as the host's `system` actor, so the journal tells a routine's thread from one a person
  started. A browser-origin approval a routine's turn raises has no window of
  its own, so it is offered to every local window that may drive that thread's
  browser (one bound to the routine's Project); answering settles only that
  prompt, and an "always allow" is journaled by the answering window.
- **Journal.** Definitions, revisions, lifecycle changes, occurrence claims and
  skips, runs, dispatch intents and claims, and cancellations are journaled. A
  claim commits the deterministic run before the occurrence ledger, so a crash
  repairs forward to the same run and never dispatches twice. Run-now and
  cancel are idempotent by request id.
- **Turning one off.** Pause stops future occurrences; Resume restarts from the
  next occurrence; Archive ends the routine and keeps its history (there is no
  delete). Cancel stops a run before its first turn starts; afterwards the
  thread's own interrupt applies.

A `#thread` mention points at another thread the sender can already Open. The
host resolves a bounded, read-only title, status, and transcript window at send
time. Dragging a sidebar thread onto a composer, or choosing Attach as context
from that thread's row menu, uses this same path: the mention search, given
the thread's id, returns that thread only when this window can Open it, so
where its title would rank does not matter, and the renderer does not read the
transcript to attach the chip. In Chat, an explicit mention also grants the source provider the bounded
`octant_thread_message` tool for that turn: it may send one of the user's
instructions to the mentioned Chat thread and receive its completed reply. The
target's own Chat turn, provider, Project, and authority remain authoritative;
an active target returns Waiting rather than being interrupted or duplicated.
Coordination is one hop and unavailable, unauthorized, or deleted targets fail
closed. Work and Code mentions remain read-only. In Work and Code, an `@file`
mention completes a path inside the thread's bound root; the host refuses a path
outside that root before reading it. Chat Projects have no filesystem authority,
so `@file` is absent there. Unknown `@` text stays ordinary text; `@plugin` /
`$skill` addressing is unchanged. Side Chat is a Chat-mode sidecar about
exactly one source thread: ordinary Chat with no inherited Work or Code
authority and no path that messages, approves, steers, or appends to the
source. Each turn the host re-resolves the source on the sender's window and
frames it as the conversation's subject: the newest 40 messages within 32,000
characters, with truncation stated, plus a current-state section capped at
8,000 characters. For Code that section names the branch, clean or dirty with
line totals, up to 50 uncommitted paths from Git (status joined with numstat
against HEAD, untracked files included), up to 50 paths the thread's turns
changed, and the delivery target; for Work, the Project folder and working folder; for every mode, the
newest five subagent results. Each state part that cannot be read says so on
its own; an unreadable transcript refuses the turn. The source block is a
required context entry, so the planner blocks with its usual remedies rather
than silently dropping the thread the Side Chat is about. On a provider that
keeps its own conversation, a byte-identical snapshot whose previous delivery
completed is replaced by a one-line "unchanged" notice, and the full snapshot
is resent at least every fifth turn. A Side Chat about a Work or Code thread
also gets read-only list, search (Code only), and read tools over the
source's files as app-managed tools; see
[security and authority](#security-and-authority).

A Chat attempt that fails or is interrupted carries a bounded failure code,
and the client-safe process diagnostic when the provider supplied one. The
transcript states Octant's sentence for that code. The provider's own message
stays off the attempt. A refusal Octant itself authored before the provider
answered (for example an unsupported capability or an unready provider) also
journals that host sentence, so replay after a restart shows the same refusal
the live turn did; provider-originated text is never persisted there. App-managed tool and research calls use the turn's own
deadline; a call that never returns ends the attempt instead of leaving it
running, and a cancellation is not recorded as that call having failed.

A turn stopped by the provider's own usage-limit signal additionally carries a
provider-neutral `usageLimit` fact in every mode: `temporary` (a live rate
window or overload), `exhausted` (the provider says the allowance is spent), or
`billing` (the provider reports an account/credit problem), plus the
provider-declared `resetsAt` instant when one exists. Only an explicit protocol
signal — Codex's `turn.error.codexErrorInfo`, Claude's assistant `error` and
result `terminalReason`, a rejected rate-limit message — produces the fact;
message-text matching never does, and account usage telemetry alone does not
prove this turn stopped. Providers without such a signal keep their ordinary
honest failure. An unknown reset stays unknown: the notice states the provider
did not say when the limit clears rather than fabricating a countdown, and a
billing stop gets no reset line at all. The fact is bound to the single
affected turn: each later attempt transition, successful recovery, provider or
account switch, and replacement error clears it. In Chat the fact rides the
parked `waiting` attempt (which records no failure); in Work it rides the
turn's `rate-limited` failure category; in Code it rides the journaled turn
failure and parks the turn as `waiting`. Drafts, queued input, and completed
tool results are untouched.

A stop that disclosed `resetsAt` additionally offers an explicit per-thread
opt-in: Resume when the limit resets. A billing stop never offers it, and a
stop that preserved no resumable provider state — the parked Chat attempt's or
Work turn's `resumeCursor`, or the Code turn's journaled evidence — cannot
take it. Accepting journals `usage-resume.scheduled@1` on the thread's own
aggregate with a record naming the exact turn or attempt, provider instance,
limit fact, and reset instant; the same commit emits the mode's
`thread-updated` so every connected client sees the scheduled state and its
cancel affordance. At the reset instant a host-owned scheduler re-reads the
journaled record, rechecks the thread's mode, lifecycle, provider account, and
that the bound stop still waits on the limit, then continues through the
ordinary serialized turn-admission path — the same command shape a manual
retry takes — so capacity gates, admission ordering, and the single-continuation
bound all hold unchanged. The dispatch settles by appending
`usage-resume.settled@1` plus the mode's `thread-updated` in one commit; the
outcome it records (`dispatched`, `invalidated`, or `failed` with the refusal
detail) stays on the thread until a newer thread event replaces it.
The old stop's notice describes a dispatched recovery as started, rather than
implying that the resumed turn is still running after it settles.
Cancellation, a manual retry, archival, a provider change, or any superseding
turn transition settles a stale recovery as `invalidated` rather than letting
it fire against newer state; a dispatch the admission path refuses settles as
`failed`. The dispatch runs as the host, under the same per-process host
scope a [routine](#modes-chat-work-and-code) runs under, never through a
window: it resumes with no window open, and an open window lends it neither
identity nor Project binding. The admission path still rechecks the thread's
Project access (an inactive Project refuses and settles `failed`), mode, and
posture exactly as for a person's retry, and a Work resume refuses while Work
is turned off, since no window stands in for the mode switch; a Work continuation is journaled as
the host's `system` actor. Any approval the resumed turn raises is offered the
way a routine's is: a browser-origin or extension-tool prompt goes to every
local window that may drive that thread (one bound to the Project the prompt
recorded), and
answering settles only that prompt. This resume timer is deliberately narrow and separate from
[routines](#modes-chat-work-and-code): an in-process host timer over journaled
opt-ins that only continues a stopped turn — no cloud wake, no background claim
beyond the host's own running process, and no billing automation. A host that was down or unreachable at the reset instant
rescans `status = scheduled` rows on return and dispatches the still-valid
ones; a record that cannot be re-validated settles `invalidated` and never
re-arms.

A child AgentRun stopped by the same provider usage-limit signal parks as
`waiting` with the normalized `usageLimit` fact on the run — never `failed`,
which would report a bounded wait as a dead run and offer Retry where the
honest action is waiting out the reset. The fact rides the run's own
aggregate on `agent.run-status-changed@1`, so the run's row, the parent's
delegated-task read, and the managed `status`/`wait` tools all report the
limit and any armed recovery rather than a pending result or a perpetual
Working child. A run still parked on a journaled limit survives a host
restart as `waiting`, the same as a run waiting on its immutable pool
decision. The same explicit opt-in exists on the run: a person arms or
withdraws it through the same `usage-resume.*@1` journaled contract — the
record binds the run's id, its execution provider, and the disclosed reset —
and the provider or parent agent cannot arm it silently. Dispatch goes
through the ordinary `start` path with the parent thread's live grant
re-derived at dispatch time (a Code parent contributes its execution policy
only while still active), so capacity gating, authority clamps, workspace
checks, and approval freshness apply unchanged; a run whose parent grant is
gone settles `failed` instead of being orphaned awake. The run leaving its
waiting state for anything but the resume's own dispatch — cancellation,
subtree withdrawal, a different disclosed reset — settles the opt-in
`invalidated`; a wait re-entered on the same declared reset leaves it armed.
The settle journals `usage-resume.settled@1` on the run's aggregate and folds
the outcome back into the run, so the opt-in's version stays the aggregate
head and a stale `expectedVersion` cannot overwrite it.

Agent-to-agent messaging is a separate, host-delivered channel beside mention
excerpts and that Chat one-hop tool. Its design is recorded in
[decisions/0063-agent-to-agent-messaging.md](decisions/0063-agent-to-agent-messaging.md)
and its threats in
[security/agent-to-agent-messaging-threat-model.md](security/agent-to-agent-messaging-threat-model.md),
both approved by the maintainer on 2026-10-12. 0063 stays a Proposed historical
record; this section is the effective rule, and it is narrower than the record.

- **Who may message whom.** A thread may message only another active thread of
  its own Project; any other id (unknown, another Project or mode, a child
  run, itself) refuses `unauthorized` in the same words, so a refusal never
  confirms a thread exists. Only Code turns are offered the
  `octant_agent_message` tool and a Project has one mode, so today this means
  Code to Code inside one Project. Chat threads, Work threads, and child runs
  neither send nor receive.
- **Sending.** The tool is omitted from a turn in Plan and from a profile whose
  tool allowlist leaves it out, and a call made anyway, or after the thread
  dropped to Plan mid-turn, is refused before anything is stored. A refusal made
  there, for a call that names a recipient, is journaled as
  `agent.message-refused@1` without a body. An admitted
  send journals `agent.message-sent@1` on the `agent-message` aggregate, one
  message per recipient, and keeps the body in the host's store under an
  opaque reference; bodies never enter the journal. The sender is told `sent`
  and nothing more: sending starts no turn, grants no authority, and returns
  no reply. Bounds are four recipients per send, a 64 KiB body, and eight
  messages per sender that no turn has carried yet; a waiting message whose
  recipient closed or left the Project is refused at the sender's next send,
  so it stops holding a slot.
- **Delivery.** Admission is not delivery. When the recipient's next Code turn
  assembles its context, the host rechecks that the sender is still active,
  that both threads still share a Project, and that the recipient is active,
  and journals `agent.message-refused@1` otherwise. A message that passes
  marks the recipient with `thread.external-content-ingested@1` and is added
  to that turn as one context block: a host sentence naming only the sender's
  thread id, then the body inside the shared external-data frame. A turn
  carries the oldest waiting messages up to 64 KiB, at least one, and the rest
  wait for the turn after. `agent.message-delivered@1` is journaled once the
  provider has accepted that turn's prompt and context, not when the turn was
  taken on: a turn that was refused, cancelled, or failed before its send, and
  a host that stopped before it, leave the message waiting for the next turn.
  Delivery is therefore at least once. A host that stops after the provider
  accepted the turn and before the event is appended carries the same message
  into the next turn too; a host stop never drops a message unread. The block
  reaches every Code provider the way a `#thread` mention does and is part of
  that turn only.
- **Bodies.** A body lives only while its message waits: delivery and refusal
  delete it, purging either thread deletes it with the message, and at start
  the host keeps only the bodies of waiting messages. A message an earlier
  host journaled as delivered without a turn carrying it stays as journaled
  and is never offered.
- **Not built.** Nothing journals `agent.message-acknowledged@1`, and a sender
  has no tool to read what became of a message. 0049 remains the Chat mention
  path.
- **Refusals in the Agents center.** A refusal is journaled at the send, at
  the tool (a turn in Plan, a profile without the tool, a call with no
  message; a cancelled turn is not a refusal), and at delivery, with these
  limits. A send naming more than four recipients is refused as a whole and
  journaled for its first four. A turn journals each distinct (recipient,
  reason) refusal once and at most eight in all; past that a refusal is still
  the answer the sender gets but is not journaled, because every journaled
  refusal is read back at each start under a fixed scan bound and a model
  looping on a refused call must not fill it. A call too malformed to name a
  recipient is not journaled. The refusal event names its sender and
  recipient threads, because a message refused before admission has no
  `agent.message-sent@1` to say who sent it, and a purge of either thread
  takes the message aggregate with it, so a restart replays neither. The
  projection keeps the newest fifty such refusals per sender and counts the
  rest, beside the messages that were refused later. The Agents center lists
  the newest five with the sender, the thread named, the reason, and its age,
  and states how many more there are. The `/api/agent-messages` read is
  scoped by the sender thread: a window sees the counts and refusals only of
  messages sent by a thread it may open, asked afresh on every read and never
  remembered, so a refusal never reveals a thread to a window that could not
  already see its sender. The recipient id shown is the one the sender's own
  transcript holds. A refusal journaled before the event named its endpoints
  is not shown.

Seeing sibling threads is the read-only companion to messaging, approved by
the maintainer on 2026-10-13. The `octant_threads` tool lets a Code turn see
the other threads of its own Project before it messages one or while it waits
for one to finish. No action creates, messages, steers, completes, archives,
or stops a thread.

- **Who may see whom.** The caller is a Code thread's turn; the targets are
  the other Code threads of the same Project that are neither completed nor
  archived. Threads of another Project, the caller itself, child runs (they
  have the managed `status` and `wait`), deleted threads, and every Chat or
  Work thread are never listed or readable. The host decides the set from the
  caller's own thread on every call; the model supplies no Project, path, or
  window.
- **Actions.** `list` returns, for each target, a reference, the title, the
  state (`working`, `waiting-for-person`, or `idle`), and when the state last
  changed: at most 32 rows, most recently changed first, with `truncated`.
  `read` returns one target's title, state, and the same bounded transcript
  window a `#thread` mention resolves (12 messages within 8,000 characters,
  truncation stated), and no tool payloads beyond that window, files, or diff.
  `wait` returns when the target leaves `working`, or after the caller's
  timeout, 30 seconds by default and at most 120 like a child run's `wait`,
  with the state only; `working` in its answer means the time ran out.
- **References.** A reference is `<thread id>@<project id>`: the thread part
  is the id messaging addresses. It grants nothing; `read` and `wait` re-decide
  the set at the call, so a reference refuses once its thread is completed,
  archived, deleted, or in another Project than the one it was listed in, and
  it never resolves to a different thread. `read` decides again after its
  transcript read, and `wait` on every look, so a thread that closes or moves
  meanwhile refuses too, as does one the `#thread` mention read cannot serve.
  A reference does not carry the thread's working state, since `wait` exists
  to see that state change. Every reference outside the set, malformed text
  included, refuses `unauthorized` with one sentence, so a refusal confirms
  nothing outside the caller's Project. A call
  whose input fails the tool's schema (an unknown action, an extra field, a
  timeout out of range, a reference over 128 characters), whose turn was
  cancelled, whose profile leaves the tool out, or whose caller is unknown,
  completed, or archived refuses `policy`; none depends on another thread.
  The caller and the turn are re-checked wherever the target is. Inside
  it, `list` makes the set visible on purpose; a `sent` answer from messaging
  already confirmed it.
- **Taint and framing.** A `read` or `list` answer joins the turn inside the
  shared external-data frame, like a delivered agent message. `read` and
  `list` (a title is text a person or an agent wrote) mark the caller with
  `thread.external-content-ingested@1` before the result returns, every time;
  a call that cannot be marked returns `unavailable` and nothing else. Each
  call journals its own mark, under the source label `sibling-thread`,
  whether or not the caller was already marked. `wait` returns a closed set
  of states and does not mark. A thread that lists its siblings therefore
  asks for single-use confirmation on risky actions afterwards, and that mark
  clears only by a person.
- **Offer and bounds.** The tool is offered in Plan, since no action changes
  anything outside the caller's own context, and omitted from a turn whose
  profile allowlist leaves it out. A turn may make 8 `read` and 4 `wait`
  calls; the next refuses `rate-limited`. Every `read` and `wait` whose input
  decodes counts, refused or not, so probing references spends the same
  budget as reading them. `list` is not counted. Each answered `read` and
  `wait` is journaled as `thread.sibling-observed@1` on the reader's own
  `sibling-thread-observation` stream with reader, target, action, time, and
  the bytes returned, never the text; purging the reader purges it. A call
  the host cannot journal returns `unavailable` and nothing else. A refused
  call is not journaled, and `list` is recorded only by its mark.
- **Carriage.** The Code runtime adds the tool to each turn's app-managed
  tool set, created once per turn so the bounds above are that turn's. It
  reaches the provider on the transport that runtime already uses for every
  app-managed tool: an in-process MCP server for Claude, dynamic tools for
  Codex, a loopback MCP bridge for ACP agents and OpenCode, a loopback
  custom-tool bridge for Pi, and function calling for direct endpoints. A thread whose runtime carries no
  app-managed tools (Ollama, OpenCode without Octant's isolated
  configuration, an ACP agent that does not take the bridge, a direct-endpoint
  model nobody verified for tools) is offered none, this one included. Child
  runs compose their own tool sets and are never offered it.
- **Facts.** The host answers from its own records on every call. Threads
  are the persisted Code threads; a deleted thread's row is erased and a
  child run never has one, so neither resolves. The state comes from the
  evidence that files a thread on the Code board: running work is `working`;
  an unanswered approval or question, a step whose outcome is unconfirmed or
  that waits on a decision, an interrupted last turn, or a finished turn that
  asked the person to decide is `waiting-for-person`; anything else is
  `idle`. `stateChangedAt` is the newest update among the latest provider
  turn and every other runtime work record, or the thread's creation when it
  has never run; a turn parked on an approval keeps its running record, so
  its time is when that turn last moved. `read` takes its transcript from
  the Code `#thread` mention read for the window the turn runs for, judged on
  that window's standing authority like every Project check in a turn's tool
  call (see [Security and authority](#security-and-authority)).

## Agent task display

Providers that report their own task plans (Claude, Codex, ACP, OpenCode) emit
`task-progress` runtime events, and the host journals them. Each thread surface
shows the agent's restated plan as a live "N of M tasks completed" panel while
any task is open or the turn is still writing: Code from its journaled
operation events, Chat from `ChatAttempt.tasks` carried on
`chat.attempt-updated@1`, and Work from `WorkTurnState.tasks` journaled on
`work.turn-updated@1` with a live `turn-tasks` stream frame. The panel is a
projection of journaled state, never a renderer-owned plan; per-step detail
stays in the transcript's activity rows.

## Tool calls in Chat and Work

Every mode shows a turn's tool calls as the same compact group in the
transcript (see [DESIGN.md](../DESIGN.md) Transcript). Code replays them from
its journaled `tool-activity` events. Chat and Work record exactly the same
step per tool call and nothing more: the provider's tool call id, the tool
name, a state (`started`, `running`, `completed`, `failed`), and an optional
progress or result message of at most 2048 bytes, redacted before it is kept. No tool
input and no tool output is captured. A turn keeps at most 64 steps in arrival
order and sets a truncated flag when it called more. Chat carries them as
`ChatAttempt.toolSteps` on `chat.attempt-updated@1`; Work carries them as
`WorkTurnState.toolSteps` journaled with the settled `work.turn-updated@1`,
with a live `turn-tools` stream frame while the turn runs. They live on the
attempt or turn record, so they are thread content and purging the thread
removes them with it. Both fields are optional, so a turn saved before they existed
still decodes, and the group draws nothing for a turn that called no tool. This
changes rendering and recording only; Chat's and Work's authority, and Work's
withheld shell, are unchanged.

## Workspace shell

[Workspace behavior](design/workspace.md) owns navigation, Projects, panes,
content tabs, dock tools, and their presentation lifecycle. [DESIGN.md](../DESIGN.md)
owns their visual treatment. Those current specifications replace the historical
shell and visual-language migration descriptions; server authority and durable
state remain owned by the architectural sections here.

## Persistence

```mermaid
flowchart LR
  cmd["Command<br/>(validated by contracts)"] --> policy["Domain policy<br/>mode · capability · authority"]
  policy --> version["Expected aggregate version"]
  version --> append["Append events<br/>(atomic, versioned envelope)"]
  append --> journal[("event_journal<br/>aggregate_heads")]
  journal --> proj["Projections<br/>(idempotent, checkpointed)"]
  proj --> read[("Read tables<br/>chat · work · code · project · usage · theme · …")]
  append --> publish["Publish committed sequence"]
  publish --> reactors["Reactors<br/>provider turns · tools · subagents"]
  read --> clients["Renderer / remote clients"]
  journal -. "db:rebuild" .-> proj
```

- **Store.** One SQLite file under `OCTANT_DATA_DIR` (default
  `~/Library/Application Support/Octant`), created with owner-only permissions.
  A single narrow SQLite port has two adapters — `bun:sqlite` in production
  and `better-sqlite3` for the Node portability smoke — that pass the same
  conformance suite. Journal, migration, and projection code depend only on
  the port. Settings → Data & privacy exposes a read-only, server-authoritative data
  map of those locations (and per-Project facts) so a person can see what
  this host stores without opening a document. Categories the host cannot
  verify are `unknown`; the map never carries secret values.
- **Envelope.** Every event carries schema version, event id, aggregate id and
  version, global sequence, correlation and causation ids, actor, host id, and
  timestamp. Unknown or future events are quarantined rather than dropped.
- **Projections.** Each feature owns its projection and persistence schema
  (`persistence/*Projection.ts`, `*PersistenceSchema.ts`). Projections are
  checkpointed by sequence, detect lag, and can be rebuilt individually or
  wholesale (`db:status`, `db:verify`, `db:rebuild`). A projection whose state
  lives only in process memory (AgentRuns, Canvases, image jobs, managed
  GitHub clones, artifact replicas) declares `holdsStateInMemory` and replays
  from the start of the journal at every host start, because its stored
  checkpoint describes the previous process rather than this one. It names
  the aggregate types it applies, and that replay reads only those rows.
  Automations are also in memory; the host rebuilds them with their own
  hydration after catch-up instead, which leaves them empty and reported
  unloaded rather than partial when it cannot finish (see the next item).
- **Startup hydration reads a store's own rows.** Every in-memory store and
  projection rebuilds at start from its own aggregate types, read in journal
  order through the (type, sequence) index, so no store reads, decodes, or
  counts another store's rows: a journal dominated by Code turn frames (one
  row per streamed provider delta) cannot lock out an unrelated store or slow
  its start. The start-up compatibility check still decodes every row, so a
  row that no longer decodes stops the start as before. Each scan cap counts
  only the store's own rows, and what passing it does differs by store:
  - Work threads, Work settings, Work turns, Work artifacts, and agent
    messages apply rows one batch at a time under a 1,000,000-row cap, and
    refuse to start the host past it.
  - Work promotions and workflows collect every frame in memory before
    applying them, keep a 100,000-row cap, and refuse to start the host past
    it.
  - Work research keeps a 100,000-row cap; past it the host starts and
    research reports unavailable.
  - Automations apply rows one batch at a time under the 1,000,000-row cap.
    Past it the host still starts, but the Automation list reports that
    history could not be loaded (the Automation Center says so and that
    nothing is scheduled), Automation commands are refused, and the
    scheduler does not start, so nothing fires against history the host never
    read. The journal is untouched; the state clears on a start that can read
    it.
  - Work requests and the uncapped stores read all of their own rows.
- **Reads while a window is open stay off the full journal.** Every service
  checks that the store is usable before each read, and that check answers
  from the latest store inspection (the integrity check plus a decode of every
  journal row): the one startup ran, or a newer one host diagnostics asked
  for. It never starts one itself. A Code thread's whole operation history,
  which the board, the sidebar's pull-request join and child observations
  read every few seconds, is read through a (type, thread, sequence) index
  and kept decoded between reads: a later read decodes only the rows appended
  since, and a thread whose slice shrank (a purge) is read afresh. The kept
  histories are shared by every reader of the journal and bounded at 100,000
  frames across threads, least recently read dropped first.
- **Migrations.** Ordered, forward-only, checksum-verified, applied in
  transactions before the server reports ready. A changed checksum or an
  unknown newer migration fails closed; a store backup is taken before a
  migration runs. Restart integration tests prove replay per feature.
- **Untrusted-content taint.** Browser observations, tool results, and imported
  external content that already carry tainting provenance append
  `thread.external-content-ingested@1` with thread identity and bounded source
  labels. Raw bodies never enter the payload; a provider runtime's own web tools
  append it too, as the next item describes. The thread-lifetime taint
  projection rebuilds from the journal; session, turn, and restart boundaries
  never clear it. Irreversible or authority-bearing actions on a tainted thread
  still require fresh confirmation after replay. One gate enforces that:
  `resolveThreadElevation` in `packages/domain/src/toolCallPolicy.ts` asks
  afresh, under every posture that allows the tool at all, Full access
  included, for each closed-catalog entry marked `irreversibleUnderTaint`
  (MCP tools, computer-use, the harness's `web-fetch`, `bash`, `edit`,
  `write`, and `goal-check`); Plan refuses all of these but `web-fetch`
  before that check. A contract test refuses a catalog entry in a
  destructive, credential, outside-Project, or privilege-expansion class
  without that flag. A Code Git action a person takes from a window is that
  person's own per-action act, and no agent tool issues one.
  The prompt that asks says why. A harness approval asked for the thread's
  own call (`singleUse`), an MCP tool prompt, and a Computer use approval on
  a marked thread carry `outsideContent`: the sources that marked it, most
  recently read first, each with its read count and first and last read
  time, at most eight, and the total number of sources. The host reads them
  from the ingestion projection when it asks; no client supplies them, and
  they hold labels and times only, never content or a content reference. The
  web, phone, and terminal prompts say the thread took in outside content,
  so the call is approved once, and list them in the words the Clear review
  uses (one definition in `@octant/domain`), ahead of the answer controls.
  The full-screen terminal panel cannot scroll, so it runs the source names
  and counts together on a few wrapped lines and leaves times to the plain
  prompt and `--json`.
  The collapsed Computer use strip never offers Approve for a marked
  approval: it offers a review that opens the full prompt. A
  Computer use approval the host gates as marked but whose sources it cannot
  read carries an empty list, so it still says so. A child run's approval
  names no sources: it is never remembered in the first place.
- **Provider runtimes' own web tools.** A runtime's built-in web search or page
  fetch, or a tool the model's provider runs on its own servers, hands its
  result to the model without Octant seeing it. The adapter reports the call
  as a normalized `outside-content-read` event when it first sees it:
  `web-search`, `web-fetch`, or `hosted-tool`, the runtime's tool name, and the
  query or address as one redacted line bounded in UTF-16 units, when the
  runtime gave one. A call that later fails, is denied, or is cancelled may
  already have returned a page, so the start marks. A driver may report it
  whether or not it reports tool activity.
  - Chat, Work, and Code turn runners mark the thread. A child run's runner
    marks the run's own id, which is where its harness tools read the mark.
    Each runner marks before it looks at its event budget or a Stop, since
    the read reached the model either way.
  - The label is `runtime-web-search`, `runtime-web-fetch`, or
    `runtime-hosted-tool`, with origin `tool-result`. The reference is
    opaque: `runtime-web-`, the tool's name when it is a plain identifier, and
    a SHA-256 of the tool, the turn, the call, and the query or address. No
    query, address, or page content is journaled.
  - A mark that cannot be recorded stops the turn, because the content has
    already reached the model. The read stays owed in the host process: the
    thread's next turn records it before it starts, or is refused with the
    same reason, so retrying cannot resume the provider session that read it
    while the thread is unmarked. A host restart forgets what is owed.
  - Marking does not gate a tool the runtime executes itself. A Code turn
    whose approvals the runtime's own reviewer answers (harness auto-review)
    is stopped at the mark and tells the person why, because the reviewer was
    chosen for the session while the thread was unmarked. The next turn
    starts without it, as auto-review is off on a marked thread.
  - A single-shot request (a context summary, a hand-off document, a commit or
    pull-request draft, a harness single shot) has no thread of its own to
    mark, so an answer written after such a read is not used.
  - Codex: its `webSearch` item, on `item/started`. A start may carry an empty
    query. Octant does not switch Codex's web search off.
  - OpenCode: `webfetch`, `websearch`, and `codesearch`, and any call its
    provider executed (`provider.executed`, or `executed` on the 2.0.22
    stream), on `tool.called`. A call a person then denies has already marked.
  - ACP agents: a tool call whose kind is `fetch`, or whose kind is `search`
    with a `rawInput.query` and no path, pattern, glob, or other place to
    look, the first time the agent reports it. A web search an agent reports
    under `search` with a path-like input, or with no `query`, is not marked;
    `search` also covers local file searches, so that residual stays.
  - Claude: `WebSearch` and `WebFetch`. The driver offers Claude neither tool
    and refuses a session that reports either, so this marks the thread only
    if one is ever offered.
  - Pi and the direct endpoints have no built-in web tool. Pi is launched with
    only its file and shell tools, and a direct endpoint fails a turn whose
    stream carries a hosted or server-side tool's output.
- **Clearing taint.** Taint keeps its thread lifetime, and a person at a local
  window may clear it. A clear records that they reviewed what the thread read.
  - It appends `thread.external-content-cleared@1` on the thread's
    `thread-external-content` aggregate with actor `local-user`. The payload
    holds the thread, the window, the cleared source labels, and the ingestion
    count, never content.
  - The request names the aggregate version the person was shown. A newer
    ingestion refuses it as `stale`; an untainted thread answers
    `already-clear` and journals nothing. It is refused while the thread's
    turn is running or queued, when its last turn ended without the host
    learning how (Code's `ambiguous`), and when the thread's own mode cannot
    be read for that window. A message still in the thread's message queue
    counts as a queued turn, whether the queue is moving, paused, or held.
    The message queue answers all of this for every mode, and the check and
    the append run under its per-thread ordering, so a send through the queue
    cannot land between them.
  - Only the local-only `POST /api/thread-external-content` clears. Its `read`
    returns each source with its count and first and last time, and the
    version a clear must name. The private listener answers a paired device
    404, the handler refuses a paired device and the host's own scope, and the
    route sits on the loopback chain only. No tool, command, model output,
    structured reference, agent message, or host-run turn (routine, goal
    loop, usage-limit resume, child-run delivery) can clear.
  - The mark is keyed by the bare thread id, and Chat, Work, and Code
    threads share one id space: the journal refuses to start a thread under an
    id another mode's thread already holds, so a client-chosen id cannot share
    another mode's mark or, by being purged, erase it. A mark that threads of
    two modes already share (history from before that check) cannot be told
    apart, so a clear of it is refused as `thread-unavailable`.
  - One clear covers that thread and only it. A child run and a fork keep
    their own taint; a Code fork, a Chat branch or restore, a follow-up or
    side task, and a thread confirmed from a planner proposal start with their
    source's mark when they are made, and a mention or Side Chat of a marked
    thread marks the thread reading it (see the Code fork rule under Modes).
    A Canvas written while its writer was marked keeps that mark after the
    writer is cleared, and marks the next thread that reads it.
  - A clear removes the mark only. Nothing leaves the model's context and the
    provider session is not restarted, so what the thread read can still steer
    the model.
  - A clear holds for nothing. The next ingestion taints the thread again,
    including a content reference recorded before the clear: the clear
    forgets the thread's ingestion rows, which are what deduplicate a
    reference. Until then everything taint was gating applies as on an
    untainted thread: Full access, remembered harness approval classes,
    remembered MCP tool grants, computer-use grants, auto-review, and helper
    starts.
  - It covers every mode and provider because it changes only Octant's own
    gate. It cannot cover a provider runtime's own tools: those run under the
    runtime's approvals and sandbox, and a clear changes nothing about them.
  - On replay a clear deletes the thread's ingestion rows and zeroes its taint
    row, and the projection ignores an event at or below the last one it
    applied for that thread. A journal without the event replays unchanged.
  - The surface is one notice in the composer of a Chat, Work, or Code thread
    that a local window has open, drawn only while the thread is marked, with a
    Review action. The notice reads the mark when the thread opens and again
    when a turn starts or settles. Review lists the sources in plain words
    with their counts and times (a row projected before the host recorded
    times shows none), says that clearing removes nothing the model read and
    that the next outside content marks the thread again, and holds Clear the
    mark back while a turn is running or messages are queued. Every refusal
    is shown as its own sentence, and a `stale` one reloads the list. A client
    that is not on a loopback host (`externalContentAvailable`) neither
    reads nor draws it. Approval prompts do not yet say that the mark is why
    they ask: neither the MCP tool approval view nor the harness approval
    carries that reason.
- **Browser captures.** Only a screenshot the agent asks for with the browser
  tool, or the person takes with the Browser pane's Screenshot control, is kept
  with the thread that owns the Browser. The bytes live in the host's managed
  attachment store and the journal holds only a reference, the page origin, URL,
  title, content hash, and time. A thread keeps its newest 32 captures and they
  are erased with the thread. Only a local window that can open the thread reads
  them, never a paired device. They never reach a Canvas share, replica sync, or
  a diagnostics export. They leave the host only in an export the local owner
  takes: that thread's export, or the host-wide data export that embeds it. A capture adds no Project filesystem authority and no
  second taint mechanism: the observation that produced it already taints the
  thread. Detail is in [Browser captures](design/browser-captures.md).
- **Recovery.** Sequence-based reconnect replay for local and remote clients —
  a dropped stream catches up from the authoritative snapshot before it reopens,
  keeps retrying while the host is unreachable, and a remote session whose window
  closed during sleep is renewed from the device key rather than re-paired —
  crash-safe
  append, explicit terminal reasons for turns, tools, terminals, and subagents,
  preservation of partial provider output, and recovery of outstanding
  approvals after restart. A parked provider question is the exception: the
  session that would consume the answer died with the process, so an answer
  submitted after restart settles the attempt interrupted — naming the outcome
  and leaving the turn retryable — instead of holding an undeliverable card
  forever. Multi-host Settings uses the
  same rule per registered host: reconnect renews from that host's device key;
  only a revoked, expired, lost, or host-changed credential forces a new pair.
  Revoke-self drops that host's sessions and streams before the client clears
  the local registry entry.
  Removing a host, from the desktop's federated hosts or the phone's host list,
  stops that host's session and deletes its device key from secure storage;
  other hosts' keys stay. On the phone, Remove works with no connection to the
  host, asks first, and sends nothing to the host, so it does not revoke: the
  host keeps listing the device until it is revoked from the desktop. The host
  leaves the list even when the key cannot be deleted, and the phone says so.
  Reopened Code terminals retain their runtime-work identity and resume at the
  persisted aggregate version, including restart interruption events. Live
  recorders keep their expected version so conflicting writes remain refused.

  On host restart, orphaned running Code turns become Waiting in both runtime
  and conversation state. Recovery appends a status event without replacing prompts,
  provider session cursors, or earlier events. Already settled turns remain settled;
  repeated startup does not append duplicate recovery events. A follow-up resumes
  the retained native identity under the ordinary current-authority checks.

- **Fast thread reads.** A thread paints from an authoritative snapshot before
  auxiliary Files, Git, Browser, or Computer Use observations begin. Code
  conversation evidence is read in bounded batches and page results paint as
  they arrive; live Code operation frames carry bounded display text beside
  their durable evidence references. Work uses a bounded delta feed over its
  durable transcript. Work, Chat, and Code threads open on their newest turns
  through a windowed read and load earlier pages on request; each page is one
  contiguous run of whole turns, bounded by count and by text, and the
  journal and projection stay complete ([thread windows](design/host-reads-and-commands.md#thread-windows)).
  Chat pages over the active conversation only and counts the turns edits
  superseded, so nothing derived from the whole thread goes partial; the
  Markdown copy and the thread's totals read the whole thread first. A Code
  page carries the usage of every older turn, so the thread's totals stay
  whole, and its window read starts from the newest turns without scanning the
  thread; a fork's earlier pages continue into its source at the fork point.
  The forward Code conversation read is unchanged for export, forks, hand-off,
  mentions, and the CLI's live feed. The phone and the CLI open a Code thread
  on its newest window without Load earlier, and read the tail of the forward
  read from a host without the window route.
  The older whole-transcript route answers with the newest 64 turns of a longer
  thread, oldest first; export and `#thread` mentions read the whole thread on
  the host. One post-commit Machine change feed invalidates mode
  navigation and Project/extension projections instead of independent polling
  timers. A running turn's start time and latest step (a tool name and one
  redacted, truncated argument, or a wait on approval or an answer) ride on the
  same Chat, Work, and Code navigation rows as `executing`, optional and absent
  together outside a live turn. They are held in memory by one process-local
  live-turn registry the three turn runners feed from the normalized runtime
  events, are never journaled (a restart interrupts every turn, so there is
  nothing to rebuild), and are cleared when the turn ends. A provider reports
  an argument only where it can (Codex shell commands and file paths today);
  the others show the tool name alone. Redaction happens at the adapter and
  again when the event is observed: a login-shell wrapper is unwrapped, the first line only, no
  heredoc body, secret-shaped values and environment assignments replaced, every
  absolute path reduced to its last segment, then a length cap; a file change
  names its Project-relative path and never its contents. A step change is not a
  journal event, so the registry publishes a coalesced notice to the Machine
  change feed for the mode's navigation topic; the reads still follow the feed
  and add no timer. Rows are already filtered by the caller's Project and
  thread authority, so a remote client sees a step only for a thread it can list.
  Every process-local feed sends `snapshot-required` after gaps,
  overflow, or host restart. The client transport bounds and prioritizes reads,
  coalesces identical work, cancels obsolete thread switches, renews local
  client context without replaying mutations, and windows long transcripts.
  See [0075](decisions/0075-thread-reads-are-snapshot-first-and-change-driven.md).
- **Data lifecycle.** Reset, remove-all, delete-remote-host, and thread
  retention/purge operations are explicit, reported per scope, and never run
  implicitly. Removing a paired host or Project deletes what it owns and
  reports what it retained. A retention window (host default, Project
  override, or thread override) never deletes on its own; only a confirmed
  purge erases a thread's bulk content, derived projections, attachments,
  canvases authored in that thread (including their comments, shares,
  refreshes, actions, and mirrored files), agent-run session and content
  stores, harness sessions, and a managed worktree only when no other
  thread still references it, and only at a path inside that repository's
  managed worktree directory: a receipt that names any other path, or one
  the sweep cannot read, leaves every owned worktree in place and keeps
  its file so the leftover is visible. It then records a tombstone so a
  rebuild cannot resurrect the transcript. Usage records are de-linked,
  not erased: their token and cost aggregates stay for host accounting, the
  thread's identity leaves them (`subject_id` becomes NULL, modelled as a
  `deLinked` usage subject), and replay never re-links a purged thread.
  The thread's child runs are erased with it, so their `agent-run` rows
  are de-linked the same way; replay treats a run whose
  `agent.run-requested@1` event is gone as purged.
  A de-linked row belongs to no Project, so it reads as unfiled usage and
  as an "Erased threads" line in the dashboard and the host export; no
  thread or Project spend ceiling counts it. Project memory is Project
  data: a thread purge keeps the entries and removes the thread from their
  provenance. A Project-scoped purge also erases that Project's memory
  entries and every Canvas it owns, each with its comments, shares,
  receipts, mirrored files, journal history, aggregate heads, and
  quarantine rows, and evicts those Canvases from the live projection so
  reads stop serving them at once. The outcome lists what was de-linked and
  which Project scopes were deleted.
  The tombstone, other threads, Projects, credentials, external
  repositories, and SQLite free pages are named retained scopes rather
  than hidden leftovers. The effective window is the most specific one set
  (thread, then Project, then host, else forever). A thread-scoped purge
  erases the named thread; a Project- or host-scoped purge erases only threads
  whose last update is older than their effective window; purging an
  already-purged thread succeeds idempotently. A remote principal can neither
  set a window nor purge. A purge erases by the bare thread id, so a thread
  whose id another mode's thread also holds (history from before the journal
  refused that, below) is never purged: a thread-scoped purge refuses it as
  `invalid`, and a Project- or host-scoped purge passes over it. See
  `docs/decisions/0035`. The one self-applying
  exception is startup journal compaction, which removes a
  `code.checkout-observed@1` event only when the next event of the same
  checkout observes the identical state; it preserves every answer a
  projection, rebuild, subscription, or export can give and reports how many
  events it removed. It runs in one transaction per store, renumbers each
  aggregate's surviving versions contiguously with its heads and checkout
  projection, skips any aggregate with quarantined events, version gaps, or a
  head or projection that disagrees with the journal tail, and keeps every
  event another names as its cause. See `docs/decisions/0039`. The other self-applying
  exception files rather than erases: the completed-thread sweep archives a
  thread the person completed once the Settings window has passed, keeping
  its transcript, checkout, and journal in place (`docs/decisions/0088`).
  A thread the caller
  may already Open can be exported as an `octant.thread-bundle/1` JSON cut
  of the journal — transcript, evidence, and provenance, named with the
  instant it was taken. A missing thread and one the caller cannot read get
  the same `not-found` refusal, so an export never reveals a hidden thread.
  Secrets, raw provider payloads, and filesystem
  paths never appear; attachment bytes and other bulk content outside the
  journal are listed as omissions. The thread's generated images and retained
  Browser captures appear as attachment records without bytes. A local owner
  can also take one `octant.host-export/1` cut of what this host holds: a thread bundle for
  every thread of every mode, Projects, Project memory, Canvases, a
  non-secret settings summary, usage export rows, and retention windows
  with purge tombstones. That call is a host-control read on the loopback
  route chain. A remote principal and a paired device are refused, and the
  remote forward list does not carry the path. The same forbidden-key walk
  runs over the assembled cut. Large stores are read and written in bounded
  pages, so a transcript, usage row, or tombstone table is not loaded all
  at once; each page is walked before it is written. The cut names what it
  leaves out — credentials, filesystem paths, attachment bytes, raw
  provider payloads, unsent drafts, paired-device keys, and window
  capabilities — and why. See `docs/decisions/0036`. User-facing
  drafts of the privacy notice, sub-processor position, data-residency
  statement, DPA template, SCC position, and EULA governing-law placeholders
  live in `apps/docs/advanced/` and are marked pending legal review; they
  describe this behavior rather than changing it. The draft shared-host
  controller footing for small teams lives in
  `docs/legal/shared-host-controller.md` and aligns with
  `docs/decisions/0040` without shipping the shared team host.
- **Artifact mirror.** After each committed artifact version the host
  rewrites that artifact's mirrored files in place (removing old names on
  rename) and journals every outcome as a receipt, including skipped and
  refused; a write failure never unwinds the version. Plan, an unbound or
  unavailable destination, and an unauthorized one are refused. A repository
  destination writes the working tree only; optional auto-commit (off by
  default, refused without a repository destination) commits only the files
  it just wrote, refuses when other work is staged, and never pushes.
  Settings changes need the current `expectedVersion`. An external edit comes
  back only through an explicit re-import that appends a version. The
  `/api/artifacts/mirror` route is loopback-only and refuses a paired device.
  See [0029](decisions/0029-artifact-storage-mirror.md).
- **Artifact replicas.** A replica is an append-only log in a store the user
  owns — a synced folder, or an S3-compatible bucket. Each host writes only
  its own write-once entries, one per committed artifact version or deletion,
  named by host id and sequence. No file is written by two computers, so a
  sync client's conflict copies and lost updates cannot happen. An entry is a
  readable JSON bundle in the
  [0029](decisions/0029-artifact-storage-mirror.md) format, with a detached
  signature from the writing instance's device signing key. The storage provider can
  read those files; they are not encrypted. Before an entry is written, and
  before an imported entry is accepted, the host applies the same refusal and
  redaction as a shared bundle: credentials, secret-shaped values, and absolute
  filesystem paths in free-form text do not leave, and a bundle that still
  contains them is refused. Each host's own journal stays the source of truth.
  A pull imports other hosts' entries as appended versions with provenance —
  the computer's name, the host id, and the origin sequence. It never adopts
  another journal and never overwrites a version. An imported entry keeps that
  origin identity. The importing host does not publish it again under its own
  sequence. A later edit on this host is a new version and a new entry. If two
  computers revise the same artifact from the same parent, the library shows
  both heads. The person picks one or merges them, and the merge is a new
  version. Nothing is silently chosen. Deletion is a tombstone entry. A
  tombstone and a revision from the same parent are two heads: the revision
  stays visible, and the tombstone is not discarded. Other computers hide the
  artifact only when the tombstone is the only head, and they offer to undo.
  A later version from another computer after a tombstone is a new version;
  the tombstone stays in the log. Each host's own erase and purge rules still
  apply locally. The mirror and the export stay separate. They still write
  plain files for people and other tools, and they still never push to git.
  Sync is Octant to Octant through the store. The log holds every artifact
  version, so a computer that joins can import those versions. It does not
  recreate threads, Projects, or settings. Binding an imported version to a
  local Project follows the existing artifact import rule and is not widened
  here. Scope is artifact and Canvas versions and tombstones, and changes to
  a Canvas's comment threads under the same rules. Threads and settings are
  not in this log. A
  replica-store contribution offers list, get, and put-if-absent. A folder
  store and an S3-compatible store ship in-tree on that seam. Direct cloud
  APIs for a host with no desktop sync client come later as plugins. Every
  publish, pull, refusal, and failure is journaled. A failed upload never
  unwinds a local version. Plan mode, and a host with sync off, make no store
  calls. See
  [0163](decisions/0163-artifact-replicas-in-storage-the-user-owns.md).
- **Artifact replica sync.** The entry format, store contract, membership
  derivation, publish, pull, restore, comment sync, synced library, binding, and
  store selection are specified in
  [Artifact replica sync](design/artifact-replica-sync.md). Their boundaries:
  membership is derived from signed, write-once records and never journaled as
  a fact; only an admitted computer's entries within its cut are imported, and
  an import enters no thread until a person binds it under that thread's
  authority; store selection, membership commands, and binding are host-only
  and refuse a paired device, which may read only the status view under
  `project.overview.read`; store credentials and device keys live in their own
  credential-store namespaces and never leave the host; and with sync off, no
  store chosen, or Plan mode, no store call is made.
- **Unsent composer drafts.** Each Chat, Work, and Code thread keeps one unsent
  composer draft in ordinary renderer storage on the client that typed it.
  Drafts are not journaled, not included in diagnostics, and not sent to a
  provider until the user sends the message. Mentions that live in the typed
  text persist with the draft; staged attachments and extra composer
  selections do not, and the composer says so when a restored draft dropped
  them. Sending or clearing removes the draft; deleting or purging the thread
  removes it too.

- **Accepted message queue.** Chat, Work, and Code share a host-owned ordered
  queue for messages the user submits while a turn runs. A successful enqueue
  acknowledges durable storage; the renderer then relinquishes the submitted
  draft and attachment ownership without clearing newer edits. Queue metadata,
  ordering and delivery identities are journaled. Prompt bodies, selected
  context and trusted attachment metadata stay in purgeable private storage.
  Versioned edit, reorder and removal commands detect concurrent clients;
  stable submission identities prevent an acknowledgement retry from adding
  another message.
  Code dispatch records a distinct operation identity for each attempt before
  admission begins. A durable pre-launch refusal keeps the queued message and
  attachments; explicit resume creates a fresh attempt instead of replaying a
  cached refusal. Recovery reconciles the recorded attempt before any retry,
  while genuine failures after admission remain terminal for that attempt.
  Before sending a queue command, the client saves a bounded local retry receipt
  containing the exact command and original draft identity, without window
  capabilities. An unresolved receipt survives navigation and reload and blocks
  a fresh submission until the original outcome is reconciled. Acknowledgement
  clears only the unchanged original draft. Receipt cleanup follows composer
  draft deletion and purge; a storage failure is visible and prevents an unsafe
  submission or retry.
  One dispatcher per thread sends through the mode's ordinary turn admission,
  regardless of harness. Every dispatch checks the current Project, provider,
  model, checkout, access and context policy. Only normal turn completion
  advances the queue automatically. Cancellation, failure, changed authority,
  unavailable attachments, uncertain delivery and a Work thread's Done mark
  hold it with a visible reason.
  Restart recovery also holds pending work until an authenticated user resumes
  it; recovery never restores a temporary grant or guesses that an ambiguous
  send failed. Closing a composer cannot delete an accepted queued attachment.
  Thread purge removes queued private content and retained attachments.
  A queued message remains bound to the provider, model and authority settings
  present at enqueue. After changing those settings, restore them before
  resuming, or remove and resubmit the message with the new settings. Local
  authenticated windows share the queue; paired remote queue commands remain
  unavailable until dispatch can revalidate the originating device's grants.
  Queuing a future message is distinct from steering a running turn; steering
  remains subject to the active runtime's actual capability.

- **Composer placeholder.** An empty follow-up composer in a Chat, Work, or
  Code thread says "Reply…" and nothing else: a rotating feature tip in the
  place of a prompt read as noise to someone who already knew the feature and
  said nothing to someone who did not. A start screen's composer asks in plain
  words instead ("Ask anything…", "Describe the work…", "Describe the change…"),
  because a first-time person has not started a conversation to reply to.
  Active responses retain their send-next-message placeholder. Accessible input
  labels remain stable.

## Providers

The provider layer is defined by `@octant/provider-sdk` and implemented in
`apps/server/src/providers`.

- **Project provider policy.** A Project allows all providers (the default),
  an explicit list of provider instances, or `eu-zdr`: a provider instance or
  its selected model must carry an `eu` or a `zdr` data tag. Either tag
  suffices, as the Project page says; `eu-zdr` does not by itself guarantee
  zero retention. The host checks the policy before every Work and Code turn
  and handoff, including child runs, and refuses a disallowed provider.

- **Driver interface.** A `ProviderDriver` exposes `probe` (readiness and
  capability report without side effects), `acquire` (a `ProviderConnection`
  for a workspace), and tool verification. OpenCode and ACP probe refusals
  carry a closed Octant-authored `reason` plus bounded process diagnostics;
  free-form driver or provider text does not cross to clients, and Settings
  maps the reason to copy and next-step guidance. A version check may show
  its structured minimum version in provider readiness; free-form probe text
  remains redacted. HTTP endpoint drivers (OpenAI-compatible,
  Anthropic-compatible, Azure AI Foundry, Ollama) fail only with fixed
  Octant-authored sentences that carry no response body or credential, so a
  failed probe keeps that sentence on the observation and it survives a
  reload. An answer that is not the expected protocol (an HTML page, a body
  that is not a model list) is `incompatible`, not `degraded`. Readiness
  otherwise follows the driver's failure category, so an unreachable
  endpoint is `unavailable`, and so is an OpenAI-compatible,
  Anthropic-compatible, or Ollama endpoint answering a timeout, overload or
  gateway status (HTTP 408, 500, 502, 503, 504, 529). A connection
  offers `subscribe` — a
  scoped subscription to its normalized events, established before a caller
  sends so a provider that answers immediately is not missed (0082) — plus
  `start`, `resume`, `send`, `interrupt`, `stop`, `answerApproval`,
  `answerUserInput`, and `answerTool`, with optional current-turn `steer`. Every driver passes
  the shared conformance harness (chat, child-agent, and context-facts
  suites) before it is selectable.
- **Probe scheduling.** Operations on one provider instance run one at a time.
  A probe asked for while another probe of that instance is running joins it
  and shares its result, unless an enable or configuration change queued after
  it, which gets a fresh probe; so a slow endpoint costs one round trip however
  many surfaces ask. The host's HTTP listener allows a request 255 seconds
  (Bun's maximum) without bytes, because a probe or tool verification answers
  only when the endpoint does; the endpoint's own deadlines bound the wait.
  A direct-endpoint model list shows the models a person configured under their
  own heading ahead of the ones the endpoint reports.
- **Model configuration.** Model variants may carry normalized family and choice
  labels (for example a Fusion lead and sidekick). Choosing a label binds an
  already advertised model id; the renderer never constructs provider ids or
  adds combinations. Reasoning and other model settings remain declared options,
  validated by the server and applied before both new and resumed sessions send.
  Devin discovery selects each advertised model in a disposable, non-generating
  ACP session to obtain its own effort and speed choices. This can take tens of
  seconds for a large catalog. An explicit model-unavailable refusal omits only
  that model from the selectable catalog; authentication, configuration, transport,
  timeout, and protocol failures still fail discovery. Its model-config options exclude model and mode:
  they cannot change thread access, workspace roots, or approval policy. A choice
  the runtime stops offering or fails to confirm refuses session startup rather
  than silently falling back. Fusion remains a provider-owned model pairing;
  native subagent tools stay disabled and Octant still owns AgentRun delegation.
- **Registry.** Providers are multi-instance: each instance has a stable id,
  driver kind, configuration, readiness state, model list, capability report,
  and environment policy. A selected model is `{ hostId, providerInstanceId,
modelId }`, and the model picker is provider-first. Each Claude instance is
  one account. An account is a provider instance with a display name, an
  accent, an Octant-assigned provider-owned state directory, and a
  sign-in command. Each CLI driver that supports more than one account
  declares one account profile: the environment variables that point
  the CLI at that state directory, the default host directory, the
  assigned-directory pattern for extra accounts
  (`~/.<provider>-accounts/<instanceId>`), the sign-in and status
  commands, and whether multi-account is supported. Settings, the
  model picker, thread pinning, and usage history are written against
  that profile. Octant never reads, stores, or injects that provider's
  credentials ([0005](decisions/0005-provider-sdk-contract.md)).
  Plan usage limits (rolling windows, per-model weekly, overage) come
  only from the provider's own process: session `rate-limit-window`
  events, or a process reading a person asks for. That reading starts
  the provider's process, so it is made only on an explicit refresh
  (`onDemand` on the context-facts input), never on the schedule or
  before a turn. Observed with Claude Code 2.1.296, a process started
  only for the question holds no windows until it has made a model
  request, and answers with none; that is no answer, and the last
  snapshot stays. Octant never reads a token or credential file to
  fetch those numbers, and never calls a vendor usage endpoint
  itself. Each account keeps its own snapshot, keyed by
  the instance and the state directory that session ran under. The
  snapshots live in `providers/plan-usage.json` in the host store,
  readable by its owner only and listed in the host data map; removing
  an account removes its snapshots. An
  API-key account reports that plan limits do not apply rather than
  drawing empty bars, also when it kept the directory it had as a
  subscription account. Overage reads as in use once something was
  spent, not when it is merely switched on. A failed or missing
  refresh keeps the last snapshot and shows its age. Claude is the
  first adopter.
  Claude is the first adopter (`CLAUDE_CONFIG_DIR` and
  `CLAUDE_SECURESTORAGE_CONFIG_DIR`, default `~/.claude`, extras
  `~/.claude-accounts/<instanceId>`, `claude auth login` /
  `claude auth status`). Codex uses the same profile
  (`CODEX_HOME`, default `~/.codex`, extras
  `~/.codex-accounts/<instanceId>`, `codex login` /
  `codex login status`). Octant never reads Codex `auth.json` or
  the keyring, and never writes `cli_auth_credentials_store` into
  the user's config: Codex names its keyring entry by a hash of the
  canonical `CODEX_HOME` path (read in the Codex source at
  `rust-v0.162.1`), so two homes hold two logins without forcing
  file storage. The first account holds the host profile, and a new
  account takes it again once no account holds it. The first
  account keeps inherited `OPENAI_API_KEY` and the other Codex
  auth variables (existing installs authenticate that way). Extra
  assigned homes strip those variables so they cannot share the
  host key, and strip `CODEX_SQLITE_HOME` so their thread state
  database is not the host's. The AWS profile and file variables
  stay for every account: they choose among the AWS identities of
  the one operating-system user and hold no login of their own. An
  explicit API-key instance still receives only the
  broker-resolved key. Each Codex account has its own
  long-lived app-server and never shares that process with another
  account. Codex Plan uses Codex's own read-only sandbox, not an
  OS wrap; the account `CODEX_HOME` is the only extra path that
  launch receives. Extra Claude accounts are a
  maintainer-approved exception to the rule that a CLI uses its
  documented host profile and does not take a second login
  ([0121](decisions/0121-provider-owned-cli-runtime-and-updates.md)):
  two logins cannot share one profile without sharing credentials and
  session history. The implicit first subscription account keeps the
  host profile (`~/.claude`, or the inherited host overlay). Every
  extra account, and every API-key account, uses its assigned leaf.
  A leftover custom directory keeps working until the person
  explicitly re-assigns it; Octant never silently points that login
  at another path. Removing an account leaves its assigned directory
  in place, with that account's sign-in and history: Octant says
  where it is, the host data map lists `~/.claude-accounts` and
  `~/.codex-accounts`, and
  deleting it is the person's step. An accent is presentation only:
  changing it alone neither stops a running session nor resets the
  account's readiness. Sign-in is the unmodified CLI command in a
  terminal for that account. Connection check uses what the CLI or
  SDK reports. Two instances of the same driver cannot share one
  effective state directory after trailing-slash identity, including
  when a host overlay points two instances at the same existing
  directory. A relative inherited overlay refuses only that implicit
  directory-less subscription account. A replayed extra subscription
  that still omits a stored directory stays unusable until it has
  its own assigned leaf, so it cannot launch against the default
  login. A confined Plan launch refuses an account directory that
  is the checkout, sits inside it, or is an ancestor of it
  ([0145](decisions/0145-a-plan-turn-is-confined-by-octant.md)).
  Plan stays read-only for the project and checkout. A confined Plan
  Claude launch reads that assigned leaf and writes only its runtime
  folders, plus the launch temporary directory, as the
  [security section](#security-and-authority) states.
  A thread stays on the instance it started with; there is no
  automatic failover, rotation, or load-balancing between accounts. Discovery can find
  installed runtimes and auto-register them. On first run, a detected Claude
  Code or Codex CLI instance is created enabled; every other detected runtime
  is created disabled. Discovery never installs or updates runtimes, never
  toggles an existing instance, and never treats enablement as readiness
  ([decisions/0112-first-run-claude-codex-enablement.md](decisions/0112-first-run-claude-codex-enablement.md)).
- **Provider catalog.** Settings › Provider catalog lists the bundled
  provider-driver packages (`bundledProviderDriverCatalog` in
  `@octant/plugin-host`). Each entry is validated against the public
  `ProviderDriverCatalogEntry` schema, which `@octant/plugin-api` re-exports
  from contracts. An entry is only a driver's manifest. It refuses excess
  properties (no install, trust, enable, credential, or capability claims),
  declared capabilities, contributions, a second component, an entry point
  other than `builtin:provider-driver/<kind>`, and any source other than
  `bundled`. Outside drivers need their own design before the schema admits
  them; third-party provider-driver plugins are parked until after the
  technical preview. The catalog repeats installed and trusted from the activation context
  that admits the driver; it never sets them. `resolveProviderCatalogState` in
  `@octant/domain` derives available, enabled, signed in, and ready separately.
  It reads the registry, the last observations, and the last scan, with each
  driver's modes, agent loop, and sandbox (who confines a runtime, held to the
  confinement matrix by `providerProcessConfinement.test.ts`), and picks one next step that acts on the
  configured instance when one exists. Opening the catalog starts nothing. A
  scan, connect, enable, or connection check runs only from its step's button,
  and sign-in, Locate binary, and credentials stay on the runtime's own card.
  Discovery keeps one provider per driver family, as auto-registration does:
  a discovery connect for a driver that already has a provider returns that
  provider instead of creating a second one, and leaves its switch unchanged.
  Ollama is set up as an endpoint, never from the scan.
- **Driver families.** Direct HTTP drivers (OpenAI-compatible, Anthropic-
  compatible, Azure AI Foundry API-key, Ollama), image HTTP profiles
  (OpenAI Image and Gemini native image — never selectable as Chat, Work, or
  Code turn drivers), SDK/RPC drivers (Claude Agent SDK, Codex app-server,
  OpenCode, Pi, and Oh My Pi — whose driver discovers models but refuses
  `acquire`, so its probe reports `unavailable` and it never reaches a
  picker), and ACP-based agent CLIs
  (Kilo, Devin, Mistral Vibe, Kimi Code, Grok Build, Goose, GLM Agent, Gemini CLI,
  GitHub Copilot, Cline, Qwen Code, fx).
  OpenCode's version-selected routes, written session posture, tool-bridge
  registration, event mapping, approvals, and readiness probe are specified in
  [Provider runtimes](design/provider-runtimes.md#opencode). Their boundaries:
  each launch writes its posture into its connection-private configuration,
  and a launch that names no posture denies all; the tool bridge serves one
  session and refuses a call that names another; approvals are answered
  `once`, never `always`; Octant's denies outrank grants saved in OpenCode
  itself; app-managed tools are reported only for the exact release the
  hostile-configuration check covered, and only on macOS; and anything not mapped fails the turn
  closed. fx runs in a per-instance managed
  home because its ACP entrypoint exposes no profile-path variable; see
  [fx-acp-compatibility.md](fx-acp-compatibility.md) and
  [0130](decisions/0130-fx-runs-in-a-managed-home.md). fx is refused in Chat
  and Plan before any process starts, runs its `ask` mode below Full access
  and `code` only on Full access, authenticates only with a broker-held AI
  Gateway API key, and cannot read or write the Project root's `AGENTS.md`,
  `.mcp.json`, `.fx.json`, `.agents`, or `.claude/skills`. Image profiles are
  recorded in [decisions/0055-image-generation-provider-profiles.md](decisions/0055-image-generation-provider-profiles.md).
  Generation itself is a journaled job with adapters for the dedicated image
  kinds `openai-image`, `gemini-native-image`, `bfl-image` (Black Forest Labs),
  and `ideogram-image`, and for an OpenAI-compatible custom image source, a
  bounded generated-image attachment scope, and usage rows attributed as
  `image-generation`. A job uses exactly one profile; a safety refusal ends it
  and is never retried elsewhere; a job found queued or running after a
  restart fails as interrupted and is never resent. Adapters accept only
  inline image bytes, and the journal holds attachment references and a
  prompt hash, never image bytes or prompt text. See
  [decisions/0056-image-generation-jobs-and-adapters.md](decisions/0056-image-generation-jobs-and-adapters.md).
  Image providers reach the job service through the provider-sdk image seam
  (`@octant/provider-sdk/image-generation`): a driver builds one profile's
  adapter from the profile and capability-scoped ports, never from host
  internals. The ports are one provider call the host authenticates with a
  key leased from the profile's key pool (the adapter names only the header,
  and a refused key cools down as for any other call), the bounded
  approved-URL fetch, and the host's generated-image media-type check; size,
  time, and redirect bounds are the host's, with the response bound sized for
  base64 images. The credential goes only over HTTPS to the hosts the driver
  declares in code, or to the origin of a base URL the person configured; the
  host refuses any other URL before it reads the key. Bundled image drivers pass the
  same plugin-host activation ladder as provider drivers but stay out of the
  chat-driver catalog, and a profile whose image driver plugin is disabled
  fails its jobs as unsupported before any provider call. The seam's
  conformance harness proves a driver stops before calling out when cancelled
  or given an empty prompt, records unreachable providers and unexpected
  errors as sanitized failures, and returns only bytes the host's media-type
  check accepted.
  The OpenAI, Gemini, Black Forest Labs, and Ideogram drivers ship in-tree but
  import only `@octant/contracts` and the image seam, as a third-party image
  plugin would; a test fails on any other import. They declare their hosts:
  `api.openai.com`, `generativelanguage.googleapis.com`, `*.bfl.ai` (its
  polling URLs name regional subdomains), and `api.ideogram.ai`. The OpenAI
  and Gemini endpoints stay fixed, with no base URL. The Black Forest Labs and
  Ideogram profiles take an optional
  base URL (HTTPS, or HTTP on loopback), absent meaning the provider's own
  endpoint; setting, moving, or clearing it deletes the stored key first, as
  for any endpoint. The signed-URL exception stays bound to the provider's
  own result: the image is fetched exactly at the URL the provider's
  authenticated response named, without the credential, and a configured
  base URL neither rewrites that URL to the base URL's host nor approves
  any other URL on that host.
  The **Image generator** surface (profile menu, host-wide `image-library`
  scope; see
  [decisions/0081-image-generation-is-its-own-surface.md](decisions/0081-image-generation-is-its-own-surface.md);
  any registered window may use the `image-library` scope, while thread scopes
  keep thread authority and the agent tool generates only into its own thread)
  and an app-managed `octant_create_image` tool invoke that job service
  through `/api/image/` when an enabled image profile exists (a dedicated
  image provider, or a custom image source named in Settings › Image
  generation, which every renderer surface lists alongside them); the composers
  carry no generation action. Agent-generated images preview in the thread by
  opaque attachment id, chain edits through `parentArtifactRef`, export with the thread, and
  never grant Chat filesystem authority.
  **Voice** is an app-managed capability rather than a provider kind: speech
  to text and text to speech each resolve against one enabled OpenAI-compatible
  instance named in Settings › Voice and reuse its base URL, authentication,
  and credential. The host serves `/api/speech/status`, `/api/speech/transcriptions`,
  and `/api/speech/synthesis` behind window authority, sniffs and bounds the
  audio, persists nothing, and reports each direction `ready`, `unconfigured`,
  or `unavailable` with the Settings link that fixes it; see
  [decisions/0084-voice-rides-an-openai-compatible-provider.md](decisions/0084-voice-rides-an-openai-compatible-provider.md).
  Every desktop composer (Chat, Work, Code, the welcome and draft composers) and
  Navigator show a microphone beside the attach control only while
  transcription is `ready`; the clip is recorded by the browser's own encoder,
  the transcript is appended to the draft, and the person still sends. Navigator
  can read replies aloud through the configured synthesis endpoint, or with the
  operating system's voices when none is set. The mobile composer shows a
  disabled microphone labelled unavailable; phone voice input is planned under
  the same decision and not wired.
  The ACP drivers share one
  generic ACP client and protocol layer. Each in-tree vendor is a bundled
  `provider-driver` plugin that reaches the host only through `provider-sdk`;
  ACP vendors configure that shared stack rather than shipping a second runtime.
  Disabled or incompatible driver plugins contribute no models, tools, or
  capabilities. Provider-specific wire payloads never leave the adapter — the
  rest of the system sees only normalized runtime events.
- **Honest capability.** Each driver reports, per mode and per model, whether
  app-managed tools, images, resume, approvals, and subagents are supported.
  The server disables what is unsupported instead of emulating it, and a
  composer reads the same probe before offering an app-managed tool — an
  incapable provider never shows the offer it would refuse on send. Whenever
  the host reports a runtime to a client (the registry snapshot and a
  Connection Check result) it attaches an `integration` derived in
  `@octant/domain/provider-runtime-integration` from the driver kind and that
  observation; drivers never set it and it is not stored. It states three
  facts. **Octant tools** is `available` with its transport, or `unavailable`
  with a reason (`not-confirmed`, `model-verification-required`,
  `runtime-not-confirmed`, `no-transport`). The transport per runtime:
  direct endpoints (OpenAI-compatible, Anthropic-compatible, Azure AI Foundry)
  use `request-tool-calls`; Claude uses `sdk-tool-server`, the in-process tool
  server its Agent SDK connection owns; Codex uses `app-server-dynamic-tools`;
  OpenCode and every ACP driver use `session-mcp-bridge`, a loopback HTTP MCP
  server registered with one session; Pi uses `session-tool-bridge`, a
  loopback bridge its extension calls; Ollama, Oh My Pi, and image profiles
  have none. Each transport is owned by the provider connection, so none writes
  provider MCP or hook configuration ([0006](decisions/0006-acp-agent-drivers.md),
  [0093](decisions/0093-app-owned-tools-use-managed-runtime-transports.md),
  [0121](decisions/0121-provider-owned-cli-runtime-and-updates.md)).
  **Activity** reuses the fleet `activitySource` vocabulary: `session` with the
  event kinds the live session reports, or `none` when no session runs here.
  **Resume** is `precise` for a provider-owned conversation whose driver
  resumes its session, `best-effort` for a host-owned conversation whose
  history Octant plans again from the journal, and `none` otherwise. Settings ›
  Providers & Models shows the three facts on each runtime card, and the
  composers offer neither `@Browser` nor `@Computer` for a selection whose
  runtime does not carry Octant's tools. Bounded
  provider subprocesses run under a deny-default profile: Seatbelt via
  `sandbox-exec` on macOS, Bubblewrap (`bwrap`) on Linux. Missing the backend
  selected for the host platform fails closed as incompatible.
- **Credentials.** API keys live in the host credential store — macOS Keychain
  on macOS, freedesktop Secret Service on Linux — and are reached only
  through the host's loopback credential broker by opaque UUID reference.
  The desktop saves a key from its own renderer; a host without the desktop
  app takes it only from the host-local `octant provider key` command, as
  [security and authority](#security-and-authority) states.
  A provider instance holds one stored value: a plain key, or a JSON pool of
  labelled keys in list order with one active key ([`apiKeyPool.ts`](../packages/host-runtime/src/apiKeyPool.ts)).
  A request sends the active key first, then the others in list order.
  Labels may reach the renderer; secrets may not, and only the host reads the
  pool and chooses the key. A quota, credit, or spend refusal cools that key for
  an hour, and a rate limit for a minute or the provider's `Retry-After`; the next
  attempt uses the next key. A refusal for a bad key never cools a key. Cooldowns
  are host memory and are not journaled.
  Provider OAuth has two postures ([0111](decisions/0111-host-driven-provider-oauth.md)).
  **Delegated** (`delegated-oauth`, including CLI `subscription`): login stays
  on the provider's own runtime; Octant never stores, refreshes, or journals
  those tokens. The account profile names the sign-in command; Octant never
  reads, stores, or injects that provider's credentials, including Claude
  OAuth tokens. A leftover helper-token envelope is deleted on upgrade,
  also for an account that was removed before the upgrade.
  **Host-driven** (`subscription-oauth`, direct HTTP drivers):
  the host runs a generic authorization-code PKCE runner and a device-code
  runner from a provider descriptor (endpoints, scopes, and a public client
  id). Direct endpoint drivers accept a `subscription-oauth` credential
  pointer from the broker and refresh through the host service per request.
  A missing or expired grant is `unauthenticated`, and a binding mismatch is
  `incompatible`; neither claims capabilities the endpoint has not shown.
  PKCE binds a one-shot loopback redirect on a random port, checks state
  and the code verifier, and times out. Device-code polling waits with backoff
  until consent, denial, or expiry. Refresh and access material stay in the
  0054 broker as opaque refs — never journaled, logged, exported, or
  renderer-visible. The raw credential resolve path refuses that material, so
  a refresh token is not handed out as an API key. Refresh runs in the broker.
  A revoked, expired, or reused refresh token becomes a typed sign-in-again
  state. An API-key path stays available beside every sign-in. The host-driven
  runner speaks vendor dialects: OpenRouter exchanges the code for an API key;
  the ChatGPT plan dialect registers the host as a user-defined agent on first
  sign-in (placeholder client id, agent name hint, stable `ext_agent_host_id`
  bound by the server), stores the issued `oaiapp_…` client id from the
  callback, validates the identity token against the issuer's JWKS, and
  revokes the refresh token at the issuer on sign-out. The plan route's
  request profile is enforced before send and its `subscription_sharing_*`
  error codes map to user-facing states. The effective
  authority rule is in [security and authority](#security-and-authority); the
  historical record remains Proposed. Secrets
  Octant holds for an integration use the same host credential path: the host
  keeps an opaque reference; plugins, the renderer, the journal, and diagnostics
  never receive raw token material. Broker URLs and tokens are stripped from
  every child environment. Linear is the first bundled Integration plugin, enabled by default:
  it contributes a Settings card through `settings.section`, connects with
  authorization-code + PKCE, and stores access and refresh tokens only in that
  host credential service. Connect opens a short-lived loopback listener on
  `127.0.0.1:52693` (`/oauth/linear/callback`, fallbacks 52694 and 52695) for
  the consent redirect, then closes it. Connect fails closed when the public
  client id (`OCTANT_LINEAR_OAUTH_CLIENT_ID`) is unset.

### Context and usage accounting

Context usage is a circular used-versus-available meter on
the active thread's composer; opening it shows an authoritative breakdown
popover without a further provider call, and Inspect context opens the
composition inspector for pin, exclude, and rebuild. Each of those commands
(`update-context-overrides` and `rebuild-context-plan` on `/api/context/commands`)
is refused `unauthorized`, before it is journaled, unless the subject is the
context subject of a chat, work, or code thread the calling local window can
open (the rule that lets it read the thread's kept images and Browser captures);
a paired device never reaches the route. Inspect (`POST /api/context/inspect`)
follows open in the same way: it answers a local window only for the context
subject of a chat, work, or code thread that window can open, or for a
`project` subject naming a Project it can open. A window can open a Project by
the rule that decides which of its threads it can open: a Chat Project only
while it is the window's Chat context, any active Work Project, and a Code
Project the Code Project access rule admits (the window's own bound Project).
A paired device is admitted to inspect as a `project.overview.read` and judged
by the same rules under its own device scope, so it reaches only what its
overview reads already cover: threads in active Work and Code Projects and
those Projects themselves. It holds no Chat context, so it inspects no Chat
thread or Chat Project. Every other subject, including one that does not exist
or names no thread or Project, is refused `unauthorized` (403, "Context subject
is not available to this window.") before the harness is read, in the same
words whether or not the subject exists. Inspecting a subject the caller may
read that has no context plan yet is a successful empty answer, not a failed
request. New context plans retain
model and service limit provenance and inspection metadata in the journal-backed
plan projection. Inspection restores those saved facts after a host restart
without querying the provider; saved observation timestamps remain unchanged.
Older plans without inspection metadata remain unavailable until a new turn
establishes it. Work includes native instructions, Browser guidance, and tool
definitions in its planned input, checks available provider-reported context bounds
before dispatch, and reconciles reported usage with the dispatched plan. Maximum
output is optional: an unknown limit stays unavailable rather than being inferred
from a response reservation. Emergency admission budgets are explicitly marked as
conservative fallbacks. A matching runtime window from the same provider, model,
and request shape is retained across restart and participates in subsequent
planning; it replaces emergency estimates while conflicting model facts retain
the more conservative bound. The Chat emergency window is 256,000 tokens: large
enough that an ordinary thread is sent whole, small enough to remain an
estimate. A limit whose source is `conservative-fallback` is never the model's
window (`hasKnownContextWindow` in the domain policy says so). The composer meter
then shows the fill alone, with no fraction, percentage, free space, or full
ring; the context inspector names the number as an estimate; and the native
harness's `context-remaining` tool refuses rather than hand the model an
estimate of its own room. A window the provider's own usage report names still
takes precedence.

A model's window is found without asking the person
(`resolveModelContextWindow` in `@octant/domain/model-context-window`). The
first source that names one wins, except that a learned window below the
reported one takes precedence: a window the person typed into the model's
details (`user-supplied`, "Set by you"); the provider's own model metadata
(`provider-discovery`, "Reported"); a window learned from the endpoint's own
refusals (`observed-evidence`, "Learned"), which also wins over a larger
reported figure because the endpoint refused above it; and the built-in model
profile catalogue (`reviewed-catalog`, "Profile"). Nothing naming one leaves the
labelled estimate above ("Estimate"). The labels appear only as the inspector's
limit source and as the placeholder of the optional override; nothing prompts
for a window. The profile catalogue ships with the app, is never fetched, and
lists only families whose windows their providers publish, each with its
reference. The opt-in reviewed model manifest (`OCTANT_REVIEWED_MODEL_MANIFEST=1`)
keeps its existing role as Chat's last fallback before the estimate and shares
the `reviewed-catalog` source, so it is also labelled "Profile". Profiles match on a normalized name (case, separators, a routing
prefix, a `:` tag, a release date, and `-latest` are ignored; a version is
not), and also on the `model` a direct endpoint names in its responses, so an
Azure AI Foundry or OpenAI-compatible deployment with a name of its own takes
its model's profile from its first completed request. A direct endpoint
(OpenAI-compatible, Azure AI Foundry, Anthropic-compatible) learns from each
request: an overflow refusal that names the limit ("maximum context length is
N tokens", "prompt is too long: X tokens > N maximum", and similar) lowers the
learned window before the harness's shrink-once recovery resends a smaller
request, and a completed request that used more than the learned window raises
it. A refusal that names no limit teaches nothing; the shrink-once recovery
still runs and the person sees at most the normal compaction notice. The
override, the learned window, and the served model are kept per provider
instance and model on the provider's model catalogue, so they survive probes
and restarts; setting the override takes effect on the next request and wins
over a runtime report, and clearing it returns to automatic resolution.

A direct endpoint's model accepts images only when a source says so
(`resolveModelInputModalities` in `@octant/domain/model-context-window`). The
first source that names its input modalities wins: the endpoint's own listing
(OpenRouter's `architecture.input_modalities`, a top-level `input_modalities`
on an OpenAI-style list entry, or the ChatGPT plan listing's
`input_modalities`), which also wins when it says text-only; then the same
profile catalogue, whose families carry an image-input flag only where their
cited model page lists image input, matched on the model id and, when neither
named them, on the `model` the endpoint said it served. Nothing naming
them leaves the model text-only with `imageInput` absent, which reads as
unknown rather than unsupported. Ollama keeps its own `vision` capability
report. The modality gates which models are offered for reading images and
whether app-managed tool results may carry images; composer attachments still
also need the provider's `nativeAttachments`, which direct endpoints do not
claim. There is no per-model image-input override yet.
Provider-managed Code turns also contribute their journaled token reports to the
usage ledger. A runtime that compacts its own session may report where, as
`autoCompactThreshold` on the usage report (tokens of the window the last request
filled); the meter derives its automatic-compaction line from that and from the
report's `contextTokens`, and shows nothing when either is absent. Claude Code is
the only runtime that reports one: the host asks its runtime for the point once,
when the session opens (Claude Code 2.1.287 answers `getContextUsage` with
`autoCompactThreshold` and `isAutoCompactEnabled`, in tokens, for example 167000
of a 200000 window), and the Claude mapper stamps it on every usage report of the
session together with the input the latest request read as `contextTokens`. The
runtime's separate `autocompact_state` message is only sent to remote workers, so
the host does not depend on it. Codex CLI and every other runtime report no
point and stay `unknown`.

**Provider capacity.** One in-memory `ProviderCapacityScheduler` per host admits
every Chat turn, managed child, Automation dispatch, and context compaction
against each provider instance's service limits and its observable concurrency
(two requests at once for Chat turns). Work holds a slot from dispatch until its
owner reports how it ended. A reported end frees the slot at once, whether the
work completed, failed, was cancelled, or timed out, and whether or not the
provider reported usage: usage it did not report stays counted at the estimate
(`ambiguous`) until it is reconciled or newer provider facts replace it. Only
work whose end nobody saw keeps its slot: work running at shutdown, a managed
child whose provider never confirmed it stopped, and a Chat turn the host
abandoned (cancelled, timed out, over its event budget) whose provider refused
the stop, since that request may still be executing. Holding the slot of
every turn that ended without usage leaked it: two failed turns, or two replies
from an endpoint that reports no usage, refused every later turn on that
provider until the host restarted.

Only a capacity answer backs a provider off. When a Chat turn fails on a rate
limit, or on an overloaded endpoint that named a `Retry-After`, the scheduler
refuses all work on that provider for the wait the provider named, at most 60
seconds, or for 10 seconds when it named none. Those are the bounds of a direct
endpoint's own retries, which have already waited by the time a turn fails, so
the backoff only keeps new turns from piling onto the same limit. Facts observed
meanwhile neither shorten nor erase it. A refused request (HTTP 400), a rejected
credential, an unreachable endpoint, and a spent or billing usage limit are not
capacity answers: the turn fails or parks with its own cause and the next turn
runs. A turn the scheduler refuses ends Interrupted with `capacity-unavailable`
and a sentence that names what is full and, when known, how long until it frees
("The provider rate-limited this endpoint. Try this turn again in 15 seconds.").

**What fills a provider-run window.** A usage report may carry
`contextBreakdown` (`ProviderContextBreakdown` in `@octant/contracts`): a closed
set of part kinds (`system-prompt`, `octant-instructions`, `system-tools`,
`octant-tools`, `mcp-tools`, `agents`, `memory-files`, `skills`, `attachments`,
`messages`, `reserved`), each with tokens, an accuracy (`provider-reported`,
`exact-tokenizer`, `model-family-estimate`, `conservative-heuristic`) and an
optional count, plus counts of tools the runtime knows but has not loaded
(`deferred`, no tokens, no share), and `sentContext`, which says whether what
Octant sent inside the prompt is counted. Per runtime:

- Claude Code answers `query.getContextUsage()` with `categories` (name, tokens,
  `isDeferred`), `totalTokens`, `maxTokens`, and lists that give counts
  (`memoryFiles`, `mcpTools` with `isLoaded`, `agents`, `skills.includedSkills`).
  The port asks once per settled turn, attaches the decoded parts to the turn's
  result usage, and stops asking for the session after one unanswered request
  (1.5 s), so a slow runtime delays one turn at most. Category names outside the
  table (for example MCP server instructions) are not parts; their tokens stay
  in the occupancy. Paths and skill names are dropped at the port; only counts
  leave it.
- Codex app-server (`thread/tokenUsage/updated`: `last`/`total` input, cached,
  output and reasoning tokens, plus `modelContextWindow`), OpenCode (per-step
  tokens and the model's `limit.context`) and Pi (assistant `message_end` usage;
  the occupancy is the last message's input, cache and output) report one
  figure and no categories. The ACP driver reports no usage at all, so an ACP
  thread shows no window. Lists of tools, MCP servers, skills or instruction
  files exist in some runtimes but carry no token weight, so they are not parts.

  Pi usage is accumulated from completed assistant messages, not streaming usage
  snapshots. Input totals include uncached, cache-read, and cache-write tokens; context
  occupancy describes the latest model call. Totals reset for each turn, including
  retained native processes. If a completed assistant message omits valid usage,
  the turn remains unknown rather than presenting a partial total. Only provider-reported
  costs are carried on its usage events, and historical turns are not rewritten.

- For a runtime that reported none, the turn runner counts what Octant itself
  registered with the session: the app-managed tool definitions, which travel
  with every request. They are `octant-tools`, `conservative-heuristic` (the
  serialized definition at four characters to a token, floor 16 per tool), and
  are never added when the runtime reported its own categories, so a part is
  never counted twice.

**What Octant sends with each turn.** Octant's instructions (a profile's
instructions, the Browser guidance), skills (a profile's admitted skills and the
skills selected for a turn) and attachments are sent with every turn, inside the
prompt: `renderProviderTurnPrompt` puts the context blocks in the prompt text as
JSON, and attachments travel as the prompt's images. A runtime that keeps its
prompts therefore holds one copy per turn, and a running total is right only
while every copy is accounted for. The adapter, which knows its runtime, says on
each usage report what the runtime does with the prompt (`promptRetention`), and
the turn runner reports `compacted` for the rest of a turn once the adapter's
`context-compacted` event arrives:

| Runtime           | What earlier copies do                                                                                                                                                                                                                                                                                                                                                                                                     | `promptRetention`                                                                         | Source                                                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code       | Each prompt is a user message in the session and is sent with every later request. Compaction keeps a summary and at most the messages the boundary lists as preserved, so what survives is Claude Code's choice. Octant sees compaction as the `compact_boundary` system message (`auto` or `manual`). The runtime's own `getContextUsage` categories win when it answers, so this matters only for reports without them. | `kept`, or `compacted` for the rest of a turn in which a `compact_boundary` arrived       | `SDKCompactBoundaryMessage` (`compact_metadata.preserved_messages`) in `@anthropic-ai/claude-agent-sdk` `sdk.d.ts`                |
| Codex app-server  | Each turn's input is a `userMessage` in the thread and is sent with every later request. Compaction rebuilds the thread from a summary and as many recent user messages as fit in 20,000 tokens, so what survives is Codex's choice. Octant sees compaction as the `contextCompaction` item.                                                                                                                               | `kept`, or `compacted` for the rest of a turn in which a `contextCompaction` item arrived | `build_compacted_history` and `COMPACT_USER_MESSAGE_MAX_TOKENS` in codex-rs `core/src/compact.rs`; the item in `codexProtocol.ts` |
| OpenCode          | Each prompt is a user message sent again with every request. A completed compaction sends the summary and at most a recent tail of messages. Octant sees `session.compacted` (1.x), `session.next.compaction.ended` (2.x) and `session.compaction.ended` (2.0.22).                                                                                                                                                         | `kept`, or `compacted` for the rest of a prompt in which compaction ended                 | `filterCompacted` in opencode `packages/opencode/src/session/message-v2.ts`; the events in `@opencode-ai/sdk`                     |
| Pi                | Each prompt is a session entry sent with every request. A compaction keeps a summary and the entries from `firstKeptEntryId` on. Octant sees `compaction_end`; one without `result` (aborted or failed) changed nothing.                                                                                                                                                                                                   | `kept`, or `compacted` when a `compaction_end` with a `result` arrived during the prompt  | Pi's JSON event stream docs (`packages/coding-agent/docs/json.md`, `compaction_start`/`compaction_end`)                           |
| ACP agents        | Each agent manages its own history; the protocol says nothing about what it keeps or compacts, and the driver reports no usage.                                                                                                                                                                                                                                                                                            | absent                                                                                    | ACP driver (`acpDriver.ts`, usage `unsupported`)                                                                                  |
| Any other adapter | Not determined.                                                                                                                                                                                                                                                                                                                                                                                                            | absent                                                                                    | —                                                                                                                                 |

From that the turn runner builds the parts (`octantWindowBreakdown` in
`apps/server/src/code/codeTurnContext.ts`):

- This turn's copy is estimated as sent: each context block's JSON at four
  characters to a token (floor 16), and each image by area as a provider scales
  it (fitted to 1568 px and about 1.15 megapixels, width × height / 750, at
  most 1,600), or 1,600 when its size cannot be read. Octant ships no tokenizer
  and does not know which model family a runtime routes to, so every figure is
  `conservative-heuristic`; none is labelled exact or model-family.
- What earlier turns of the provider session left comes from the last usage
  report of the prior turn in the journal. A turn that opens a new session
  starts from nothing; a fork whose first turn takes up another thread's session,
  a prior turn with no report, or a report from before this accounting leaves the
  session `history-unknown`.
- While the runtime says `kept` and the session is counted, the parts are the
  carried copies plus this turn's, as `octant-instructions`, `skills` and
  `attachments`. Otherwise the breakdown says `uncounted` with the reason
  (`retention-unknown`, `compacted`, `history-unknown`), the copies stay in
  `Other (provider)`, and the session stays uncounted until it ends. Nothing is
  estimated from a guess about what a runtime kept.
- Thread and file mentions, issue context, a fork's or provider switch's
  handoff and product feedback are part of the turn's own request; they stay in
  `Other (provider)`.

The renderer shows the parts and one remainder, `Other (provider)`, which is the
reported occupancy less the parts and is itself marked estimated when any part
is. When the parts outrun the occupancy (the breakdown follows the reply, the
occupancy precedes it) the window holds what the parts add up to, so the parts
and the remainder always sum to the figure shown. The latest breakdown that was
reported stands while a later turn is still running. Each category has one tone
in the popover's bar and key and on the inspector's entries; Free space and
Reserved have none ([DESIGN.md](../DESIGN.md), the context meter under "Shell and layout").

One operation contributes one request; a later report replaces its
previous totals. Code conversation usage also preserves optional cache-read and cache-write
counters. Codex native-thread totals are normalized to turn usage before recording;
missing cache reports remain unknown. Direct-endpoint (native harness) usage is
normalized from every wire protocol into the same buckets: `inputTokens` is all input,
cached or not, so context math never depends on whether an endpoint caches;
`cacheReadInputTokens` and `cacheWriteInputTokens` are the parts of it read from or
written to the prompt cache; `reasoningTokens` is the part of `outputTokens` spent
thinking. Protocols that already count cached tokens inside their input figure (Chat
Completions `prompt_tokens`, Responses `input_tokens`) are read as they come, and the
protocol that reports uncached input, cache reads, and cache writes as disjoint figures
(Messages) has them summed into `inputTokens`. A figure the endpoint did not report is
absent rather than zero, a turn of several requests reports the sum of the figures its
requests reported, and a report whose cache or reasoning figure exceeds its total is
refused as invalid usage. Unknown fields in a response are ignored; a known field of
the wrong type still fails the turn. The input tokens a request reports also
calibrate the native harness's next size estimate: a model's real bytes-per-token,
measured from the last call, is preferred over a flat four-bytes-per-token guess, so
a filled window is caught before the endpoint has to refuse the request. ACP and Pi resume cursors carry a durable
task binding, and resume supplies the currently allowed tool catalogue without
reconstructing native history. Chat and Work reuse provider-owned sessions across
follow-ups; Chat retries retain that identity and native scratch files. Native
Chat editing refuses where rollback is unavailable, so it cannot replace the
conversation behind the user's back. Resume refuses as `stale-resume` when the
cursor's binding names another provider instance, Octant session, Project
root, mode, or native id, and at most one live or starting process may own a
native session per provider instance, refused before spawn otherwise
([0157](decisions/0157-native-resume-keeps-a-durable-identity.md)). A separate replay checkpoint imports existing Code reports on
upgrade without replaying unrelated purged usage. The provider and model are
those recorded when the turn started, including after a later handoff. These
turns have no Octant planning estimate or variance: APIs omit those fields and
the request-detail table labels them unavailable.

**Child runs.** A managed child run records each turn it sends in the usage
ledger under its own `agent-run` subject. The context planner is not on the
child path, so the turn is journaled as a planless `context.usage-reconciled@1`
(request shape `agent-run-turn`) on a per-run `agent-run-usage` aggregate; the
`agent-run` aggregate's versions belong to its lifecycle commands. The row has
no planning estimate or variance, its usage is accumulated and priced exactly
as a Chat or Work turn's is, and a child turn that reached the provider and
reported nothing is recorded as unreported. A child run belongs to its parent
thread's Project: every Project-scoped usage read (the Usage dashboard, the
Project overview, and Project spend ceilings) resolves it through the parent
and mode on its `agent.run-requested@1` event and the parent thread's current
Project, the same records that place the thread's own rows. The same event
gives the run its parent's mode, so a mode filter or breakdown counts child
usage with its parent thread's.

**Turn speed and full usage, for every provider.** Every runner that watches a
provider's events (Chat, Work, Code) feeds each normalized runtime event to one
pure policy in `@octant/domain` (`turnMetricsPolicy`); no driver measures
anything. A turn is timed from the moment its prompt is sent, not from starting
the provider's session. The wait for a first token ends at the first text or
reasoning delta, and decode speed is the output tokens over the time from that
delta to completion with tool time taken out. Precision is a typed field on
every figure and is never inferred by a surface:

- `exact`: a usage report that names the one model request it covers
  (`requestStartedAt` on the runtime `usage` event) times that request on its
  own, and the time between requests is tool time by construction. Octant
  Harness reports this way. A turn with one report for the whole turn is also
  exact when it ran no tool and made no wait, because it was a single request.
- `approximate`: one report for the whole turn, with tool calls or waits inside
  it (Codex, Claude, Pi, OpenCode). The spans the provider streamed
  (`tool-start` to `tool-success` or `tool-failure`, merged where calls
  overlap; an unanswered `tool-request`, approval or question until the next
  event) are taken out of the window. A span it did not stream stays in, which
  is why the figure is labelled approximate.
- `unavailable`: no output tokens, no streamed text or reasoning to time them
  against, or a window that tool time leaves empty. Every timing figure is then
  absent and a surface hides it. Octant never shows a zero it did not measure.

A turn that made several requests reports its tokens once: the request-scoped
reports are summed and the restated turn total is ignored; a provider that
restates one turn's usage replaces the earlier report. Tool-call-only requests
stream no deltas, so they add to a turn's tokens but not to its decode window.
A retried request's wait counts toward first-token time, never decode time.
Session figures are weighted: total decode tokens over total decode time, so a
long turn weighs more than a short one, and a session is exact only while every
measured turn was. The cache hit rate is `cacheReadInputTokens` over
`inputTokens`, which already counts cache reads and writes; it is hidden when no
cache figure was reported, when nothing was sent, or when the read exceeds the
input (a provider that counts input another way), and a partial hit is never
rounded to a full one.

One `turn-metrics-recorded` frame is journaled on the thread's own aggregate
when each turn ends, whether it completed, failed, was cancelled, or was left
waiting: its full usage (input, output, reasoning, cache read and write, the
provider's own cost), its real start and end, how it stopped, and its timing.
`TurnMetricsStore` folds the frames back after a restart, so session totals are
identical to the live ones, and a thread purge erases them with the thread. The
usage query (`POST /api/usage/query`) returns them as `turnMetrics`: totals
over every matching turn plus the most recent fifty, within the same Project
scope as the ledger rows. The usage page and Settings usage read that field for
per-thread rows and the turn drill-in, and word them with the same module as the
composer line. It is left out when the query filters on a dimension
only the ledger carries (request shape, category, host, quality). A harness
turn record carries the same usage, timing, start and stop reason, and the
session's `usage` and `metrics` totals fold them, so a Code turn on a direct
endpoint no longer records zero tokens. Chat, Work and Code on every provider
journal the frame; the harness additionally keeps its own record.

**Compacting a session on request.** Built so far: the host path for Chat and
Work on a direct endpoint — the `compact-session` command, its receipt,
refusals and journal events, the per-thread `compaction` answer on the
inspector snapshot, the host summary, the outcome on the thread's live stream,
and the server's send block while a compaction runs; the provider seam with the
Codex, Claude Code and Octant Harness adapters; and the server's use of that
seam, so a runtime-owned Chat or Work conversation and a Code thread compact
through their runtime where its adapter claims `sessionCompaction`, with the
same send block on Code turns; and the window: the **Compact session** button in
the context popover and the inspector, its confirm, the running state, the
result line, and the composer's held send, read from a per-thread compaction
state every thread kind answers, Code included; and the Chat, Work and Code turn
runners journal a runtime's own compactions on the same ledger, which, with the
requested ones, now decide when a Code window breakdown stops counting Octant's
per-turn context as held; and the compaction divider on the thread's timeline in
Chat, Work and Code. No compaction, requested or automatic, has been run against a real
runtime yet. **Compact session** replaces
what the model sees from the next turn on with a summary of the earlier
conversation and a recent tail, when the person asks, outside a turn. It never
deletes or rewrites the journal: the thread keeps every message, tool call and
result, and the compaction is itself an event in it.

Who compacts follows who owns the conversation (`conversationOwnership` on the
driver), read from the instance's driver kind rather than from a driver that is
ready now; a Code thread's session is always a runtime's, Octant Harness on a
direct endpoint. Where Octant owns it, the host summarizes with the thread's
own provider and model. Where a runtime owns it, only that runtime can change
what its session sends, so Octant asks the runtime to compact and refuses where
it cannot. Whether it can is the instance's last observed
`sessionCompaction` for the thread's mode: absent or `unsupported` refuses
`runtime-cannot-compact`, `unavailable` refuses `runtime-version-unsupported`,
and an instance the host has not observed yet, or a signed-out one that can
compact, refuses `provider-unavailable`, because it may compact once it is
reachable.

A runtime compaction resumes the session the thread's next turn would resume,
opened as that turn opens it: the same provider instance, session and resume
cursor, in the scratch folder (Chat), the session's working folder in the bound
root (Work), or the checkout resolved under the asking window's authority
(Code), confined as a turn is, with no tools, and under the gated posture
(Plan stays Plan). A thread whose provider, model (unless the provider can
carry the session on to another) or Work binding has moved since its last turn
has no such session and is refused `no-session`, as is a Code session that has
never reported usage, since nothing shows it holds an exchange. The host then
calls the connection's `compact`, records the latest usage the runtime reports
on that session until the run carrying the compaction closes (at most a second
after it answers), and stops the session. A compacted session is left terminal
by its runtime (Claude closes the command, Codex ends the run), and the next
turn resumes it, as every turn does. The receipt's `tokensBefore` is the figure
the runtime reported with the compaction, else the latest usage report's
occupancy (`contextTokens`, or a Code turn's last input on the same session),
else the host plan's estimate. A compaction since that report changed the
window it describes: the figure that compaction reported after stands instead,
and without one the older report is labelled `conservative-heuristic`, an upper
bound. `tokensAfter` is the runtime's figure or `pending`. A Code thread has no
context plan, so its compaction takes no capacity slot and writes no usage
ledger row, as a Code turn takes and writes none; its spend still settles
against the ceilings and its figures are on the receipt. The host never starts
a replacement provider session seeded with its own summary behind the person's
back; that is the existing fork handoff, which stays a separate, explicit
action.

| Thread                                                   | Who compacts             | How                                                                                                                                                                                                                                                                                                                                                                                                                                    | Refuses with                                                  |
| -------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Chat or Work on a direct endpoint (host-planned history) | Host                     | `ContextHarnessService` summarizes the planned conversation before the tail through the existing summary generator (`makeContextSummaryGenerator`, a one-shot session on the thread's provider and model), then commits it as `maintainContext` does today.                                                                                                                                                                            | `nothing-to-compact`                                          |
| Code on Octant Harness (journaled transcript)            | Octant Harness           | The harness connection's `compact` summarizes the transcript turns before the tail with the same endpoint and journals a `compacted` transcript event; later requests are built from the summary and the tail.                                                                                                                                                                                                                         | `nothing-to-compact`, `no-session`                            |
| Codex app-server, any mode                               | Codex                    | `thread/compact/start` with the thread id (codex-cli 0.159.3 and 0.162.1 app-server schemas); the run is observed as a turn carrying the `contextCompaction` item.                                                                                                                                                                                                                                                                     | `runtime-version-unsupported` when the method is not found    |
| Claude Code, any mode                                    | Claude Code              | The runtime's own `/compact`, sent by the port as a user-role input that carries no tools and is not counted as a turn; observed as `system`/`compact_boundary` (`compact_metadata.trigger: "manual"`, `pre_tokens`) and the `status` message's `compact_result`. A resumed session sends its `compacting` status and a `rate_limit_event` before it initializes; the port holds both and delivers them after the initialized message. | `runtime-version-unsupported` when `compact` is not announced |
| OpenCode, any mode                                       | OpenCode                 | `/api/session/:sessionID/compact` (served by OpenCode 2.0.26); observed as `session.compaction.ended`, `session.next.compaction.ended` or `session.compacted`.                                                                                                                                                                                                                                                                         | `runtime-version-unsupported` on a server without the route   |
| Pi and Oh My Pi, any mode                                | Pi                       | Pi's RPC `compact` command (`packages/coding-agent/docs/rpc.md`); observed as `compaction_end`, which changed nothing when it carries no `result`.                                                                                                                                                                                                                                                                                     | `runtime-version-unsupported` when the command is refused     |
| ACP agents                                               | Nobody                   | The protocol has no compaction request.                                                                                                                                                                                                                                                                                                                                                                                                | `runtime-cannot-compact`                                      |
| Any other adapter                                        | Nobody, unless it claims | An adapter compacts only by reporting the capability and implementing the seam below.                                                                                                                                                                                                                                                                                                                                                  | `runtime-cannot-compact`                                      |

The Codex and Claude rows cite the schema and message shapes they were read
from. The Codex adapter claims compaction from codex-cli 0.162.1, the release
whose schema and source (`rust-v0.162.1`) it was read against; an older install
reports `unavailable`. The claim is a floor: a later release is claimed too,
although only 0.162.1 was read, so a later one that drops the request is
refused as too old when asked, but one that changes the order below would go
unnoticed until a smoke run against it. At that tag every compaction path replaces the thread's
history before it completes the `contextCompaction` item and returns every
failure before that replacement, so a completed item is a compaction that
happened, and a run Codex itself reports as failed without one changed nothing;
an interrupted run, a lost runtime or a report Octant could not read may have
changed it. The Claude adapter claims compaction when the runtime announces
`compact` among its commands (Claude Code 2.1.296 does, read through the SDK's
initialization without a model call), and settles a compaction once both the
boundary and a successful `compact_result` are in, on a failed one, or at the
latest on the result that closes the command. The OpenCode and Pi rows come from those runtimes' published API
descriptions and are not probed against a pinned release: OpenCode's route only
admits the request and reports completion on its session events, and Pi answers
its command with the compaction data. Each of those adapters starts by recording
the request, the completion signal, and the refusal for the release it pins,
and reports `sessionCompaction: "unsupported"` until that record exists.

Every runtime also refuses, before anything is journaled, with `turn-running`
(a turn is in flight; compaction never runs inside one), `compaction-running`,
`no-session` (nothing has been sent, so there is no session to compact),
`provider-unavailable` (the instance is disabled, signed out or unreachable, or
the Project's provider policy does not allow it),
`spend-ceiling-reached`, `mode-disabled`, or `remote-client`. The Claude decoder
reads `compact_boundary` with its trigger and token figures, and the `status`
message with its `compact_result`.

The host path picks what to summarize the same way for every planned thread:
the conversation entries before a tail of the most recent exchanges that fit a
quarter of the plan's safe input budget, always keeping the latest exchange.
Pinned entries are never summarized and excluded entries stay excluded.
Material that does not fit one safe summary request — counting the request's
instruction and each excerpt's header — is summarized from the oldest end as
far as it fits, and the rest stays as it was. A requested
compaction skips the reuse economics that automatic maintenance applies
(`not-net-positive`), because the person asked, but still requires the summary
to be smaller than what it replaces. The host path records the context ledger's
aggregate version, and the conversation it summarizes, in the same step that
journals the request, and commits only if the version is unchanged when the
summary returns; a plan journaled before the summary is even requested fails the
compaction without sending anything. A pin or an exclusion edited in
between fails the compaction as `context-changed` with nothing committed, so a
summary planned from the earlier state can never undo that edit; the person can
compact again. Automatic maintenance (`maintainContext`) holds the same
guard: a pin, an exclusion, or a new plan between the ledger read and the
summary's return ends the pass with the typed result `context-changed`, commits
no summary, and leaves the turn on its deterministic reduction.

_Authority._ Compaction is a command on the thread, not a tool call, and the
server checks it before any side effect:

- The caller is a local window that can open the thread. The context-command
  route already refuses `unauthorized` unless the subject is the context
  subject of a thread that window can open, under the rule that lets the window
  read that thread; compaction rides that check. It runs before anything is
  journaled, reserved, or sent, so a window cannot compact another Project's
  thread, send its conversation to a provider, or spend its budget by naming
  its subject. The subject's mode must be enabled.
- It needs no tool approval. It reads only the thread's own conversation, sends
  it to the provider and model the thread already uses, and writes no files and
  runs no commands. The confirm dialog is the person's consent.
- The thread's provider must pass the rule a turn on that thread passes before
  it sends anything. For Work that is the Project's provider policy, judged by
  the same function a Work turn uses (`isProviderAllowedByProjectPolicy`): an
  allow-list that leaves the provider out, or an EU or zero-retention policy it
  does not meet, refuses `provider-unavailable` before a driver is built and
  before anything is journaled, reserved, or sent, and the thread's
  `compaction` status reports the same refusal. A Chat Project is a virtual
  container with no provider policy, so a Chat thread has none to pass.
- It refuses wherever the thread's next turn would be refused for the
  thread's own standing, because a summary nobody can send next is not worth
  paying for:
  - A Work thread is judged by the decision every Work turn passes
    (`decideWorkTurnAuthority`), given the authority a window showing the thread
    now would send: its last turn's, on the Project's current binding, with the
    thread's own folder, provider and model. A Project that is archived, gone,
    or unbound, or a thread that is no longer active, refuses
    `project-unavailable`. A binding that moved since the thread was made
    leaves the thread unable to take a turn, so it has no session to carry on
    and refuses `no-session`, as the runtime path already did.
  - A Chat thread that is not active (archived) refuses `project-unavailable`
    through the check every Chat send, edit, retry and resume makes first. A
    Code thread whose Project is no longer an active Code Project refuses
    `project-unavailable` by the rule a Code turn's Project access applies
    (`hasActiveProject`). Neither has a folder binding to move.
  - Saved model options the model no longer offers refuse
    `model-options-unsupported` in every mode, judged by the same
    `unsupportedModelOptionValues` a turn uses. A Work turn checks the stored
    catalog; Chat and Code turns check a live provider probe, and the
    compaction checks the stored catalog for them too, because reading a
    thread's compaction state must not probe the provider.
  - A harness session that is paused (by the advisor, by the person, or for
    recovery) refuses `thread-paused` in every mode, through the same harness
    admission every Chat, Work and Code turn asks before it starts.
- The summarizer is always the thread's own provider instance and model. The
  command carries no summarizer choice, and the domain's
  `cross-vendor-opt-in-required` refusal stays the guard on the host path.
- Plan mode allows it: compaction changes what the model sees, not what it may
  touch, so a Plan thread stays read-only.
- It never clears taint. A summary of tainted content is tainted content; the
  thread's taint and its single-use approval rule carry over unchanged, and
  remembered approvals are neither added nor removed.
- A paired remote client is refused (`remote-client`): context commands are
  already local-window only (`authenticatedProductRoutes.ts` admits no remote
  POST to `/api/context/commands`), and this design keeps that boundary.
- The request costs tokens. It is reserved through the capacity scheduler as
  Chat maintenance is, recorded in the usage ledger under the thread with request
  shape `context-compaction`, priced, and counted against the Project's spend
  ceilings. It reserves and settles tokens like a turn but is not counted as
  one, and the thread's latest usage leaves it out, because it is a summary
  request, not a reply the window was sized for. Before a host has run a turn
  on the provider since it started, the plan's stored service limits stand in
  for capacity facts, one request at a time.

_Command and receipt._ One new `ContextCommand` kind in
`packages/contracts/src/contextRpc.ts`:

```ts
{
  kind: "compact-session",
  subject: ContextSubjectRef,
  // Chosen by the renderer when the person confirms. Repeating it returns the
  // same compaction rather than compacting twice.
  compactionId: ContextCompactionId,
}
```

The command answers as soon as the request is journaled, with
`{ kind: "compaction-started", compactionId, executor }`, because a runtime's
compaction is a model call that can outlast an HTTP request. When it ends, the
outcome arrives on the thread's live stream as a `compaction-settled` event
carrying the compaction's record: the receipt that
`context.compaction-completed@1` journaled, or the failure that
`context.compaction-failed@1` journaled, with the executor its request named. A
failure rides the stream too, because a
window that disabled send while the compaction ran must learn that it ended
either way. A Chat thread's events stream reads the outcome back from the
journal and sends it only to a subscriber that asks with `compaction=1`, as
`contents=1` is asked for, because a client that decodes frames strictly would
refuse an event it does not know; a Work thread's turn stream carries it as a
frame of its own. The receipt is also on the inspector snapshot as
`latestCompaction`:

- `executor`: `{ kind: "host", providerInstanceId, modelId }`, or
  `{ kind: "runtime", driverKind, providerInstanceId, modelId? }`.
- `trigger`: `requested`, or `automatic` for a runtime's own compaction that
  Octant observed (below).
- `tokensBefore`: the window's occupancy before, with its accuracy: the latest
  usage report's `contextTokens`, a figure the runtime reported with the
  compaction (Claude's `pre_tokens`), or the host plan's estimate.
- `tokensAfter`: the occupancy the runtime or the replanned host request
  reports, or `pending` until the next usage report arrives.
- `tokensFreed`: `{ kind: "measured" | "estimated", tokens, accuracy }`, or
  `{ kind: "unknown", reason: "awaiting-next-report" | "not-reported" }`. It is
  `tokensBefore − tokensAfter`, never negative and never guessed; a
  compaction that freed nothing says so.
- `summary`: `{ visibility: "stored", summaryId, summaryTokens, throughTurnId }`
  on the host path, where the text is the existing `ContextSummaryContent`; or
  `{ visibility: "runtime-only" }` where the runtime keeps the text (Codex's
  item carries none).
- `usage`: the compaction request's own tokens and cost, as reconciled. A
  compaction that fails after the provider reported usage journals that usage
  with the failure, so the ledger and the spend ceilings count what was spent.

Refusals answer the command as the existing `ContextFailure` with a
`compaction-refused` category and one reason from the closed set above.

_Journaling._ All on the subject's `context-ledger` aggregate:

- A requested compaction journals `context.compaction-requested@1` (compaction
  id, subject, executor, the requesting principal's kind), then exactly one of
  `context.compaction-completed@1` (the receipt) or
  `context.compaction-failed@1` (compaction id, reason, whether the session may
  have changed).
- An automatic compaction has no command and no requester, so it has no
  `requested` event. The turn runner journals one
  `context.compaction-completed@1` with `trigger: "automatic"` under the
  `system` actor. Its compaction id is derived by the host from the thread, the
  turn, and the position of that compaction among the turn's compactions, so
  the same runtime notification seen again after a recovery maps to the same id
  and is journaled once. The turn is the provider send that saw it: the Chat
  attempt (a retry is a new one), the Work turn, or the Code operation. A
  notification delivered twice within one turn carries the same event sequence
  and counts once. Its `tokensBefore` is the runtime's own figure, else the
  turn's latest usage report (only an upper bound once an earlier compaction in
  the turn came after it), else the session's occupancy read as a requested
  compaction reads it; a compaction with no figure at all is not journaled,
  because a receipt never guesses. Its `usage` is `unreported`: the runtime's
  summary request rode inside the turn, whose own usage reports carry it. A
  child run's compaction is not journaled, because a child's session is not the
  thread's window and no reader shows it. The request-then-terminal pairing, and
  the interrupted-request rule below, apply to requested compactions only.
- The host path also appends `context.manifest-created@1`,
  `context.summary-created@1` and `context.plan-created@1` as `#commitSummary`
  does today; the summary text stays subject content, outside the journal, where
  a thread purge erases it.
- A thread purge erases the thread's compaction events and keeps the rest of
  its ledger as host accounting. The surviving ledger events are renumbered
  contiguously in the same transaction, as journal compaction does, because the
  store verifier treats a per-aggregate version gap as corruption. Checkpoints
  that had passed the deleted events are pinned back to the journal head,
  because a checkpoint past the head is the same kind of corruption.
- Octant Harness appends `native-harness-transcript-compacted@1` to
  `native-harness-transcript`: the summary, how many of the transcript's turns
  it stands for, and how many turns had run when it was made. It summarizes
  the turns before the latest one, as many of the oldest as fit one request to
  the session's own endpoint with no tools, and nothing is journaled unless the
  summary came back. Earlier messages stay in the aggregate; resume and replay
  build requests from the summary and the turns after it, and a later
  compaction supersedes an earlier one. A fork copies the latest compaction
  made before the turn it was forked at, rewritten for the fork's folder and
  secrets like the messages, so the fork reads what its source read then. Only
  a Code connection offers `compact`: Chat and Work send the host's planned
  history.
- The thread's timeline shows a compaction divider from the completed event.
  Everything above it stays visible, searchable and exported. The compaction
  state read carries every completed receipt, oldest first
  (`completedCompactions`), and the window draws one quiet labelled rule per
  receipt, in the muted text and rule colours with no accent, in Chat, Work and
  Code alike. It sits before the first row that ended after the compaction
  completed, so a requested compaction falls between two turns and a runtime's
  own sits ahead of the reply it happened in (Work rows carry a time only on
  the person's messages, so there it falls before the next message of theirs).
  A compaction older than the loaded history is not drawn until that history
  loads. Each pane asks the host about its own thread, so a split workspace
  shows every pane its own dividers, active or not, and no pane draws another
  thread's; a pane asks again when its rows change.
- A completed compaction marks a runtime's session `compacted`, so the window
  breakdown goes `uncounted` with that reason under the existing rule. Within
  a turn, the runner that sees `context-compacted` reports the turn's later
  usage as `compacted`. Across turns, a Code turn that resumes a session stops
  carrying the previous turn's counted copies when the ledger records a
  compaction after that turn's last usage report in journal order (not by the
  events' clocks, which can tie): a completed one, or a failed one that may
  have changed the session. That check comes first: a runtime whose last report
  of a turn is its own breakdown (Claude Code) carries no `sentContext`, and the
  journaled compaction still makes the next turn `uncounted` / `compacted`
  rather than `history-unknown`. A runtime's automatic compaction inside a turn
  lands before that turn's closing usage report, and the runner marks that
  report `compacted` (a runtime-owned breakdown gets the field added) when the
  turn had Octant-sent copies to uncount or the runtime reported its own
  categories, so the next turn carries it. When neither the session nor the turn holds any such copy,
  the breakdown stays `counted` with no sent parts, because nothing is left to
  uncount.
- A request with no terminal event when the host starts is closed as
  `context.compaction-failed@1` with `interrupted`; for a runtime executor the
  session may have changed, and the next usage report shows what it holds.

_Provider seam._ The extension is plugin-shaped: the server reaches a runtime
only through `@octant/provider-sdk`, never by sending `/compact` text or a
Codex RPC itself.

- `ProviderCapabilities` gains `sessionCompaction`, one of `supported`,
  `unsupported` or `unavailable` for each of `chat`, `work` and `code`; absent
  means unsupported in every mode. A connection acquired for a mode whose
  sessions the runtime cannot compact has no `compact`. The direct endpoints
  claim `code` only, because Octant Harness keeps a Code session's transcript
  and the host plans Chat and Work history.
- `ProviderConnection` gains an optional
  `compact({ sessionId, compactionId })`, which resolves when the runtime
  reports the compaction ended, with
  `{ kind: "compacted", tokensBefore?, tokensAfter? }`,
  `{ kind: "refused", reason }` (`runtime-version-unsupported`, `no-session`,
  `turn-running` or `nothing-to-compact`, all decided before the runtime is
  asked anything) or
  `{ kind: "failed", message, sessionMayHaveChanged }`. A failure says
  `sessionMayHaveChanged: false` only when the adapter can attest it, as Pi's
  `compaction_end` without a `result` does, a Codex run that reports its own
  failure before completing its compaction item does, and an Octant Harness
  summary that never came back does. An adapter that cannot tell says `true`:
  Claude reports a failed compaction only as `compact_result: "failed"`, with
  no word on the session's state, so a failed Claude compaction is recorded as
  one that may have changed the session. A connection without `compact` cannot
  compact. Octant Harness implements it over its transcript.
- One normalized runtime event, `context-compacted`
  (`trigger: "requested" | "automatic"`, optional token figures), is emitted by
  each adapter that observes a compaction: the Codex item when it completes,
  Claude's `compact_boundary` (`requested` only while the connection's
  `compact` waits on it; a `/compact` the person typed into the session is the
  runtime's own, `automatic`), Octant Harness
  once its marker is journaled, and, as `automatic`, the OpenCode events and
  Pi's `compaction_end` with a `result`, which those adapters already read to
  tell a compacted window. They claim no requested compaction until their rows
  are probed. OpenCode may announce one compaction under more than one of its
  names, so its adapter reports the first since the latest usage report. A
  Code turn leaves the event out of the turn's own events. It replaces the
  per-driver `windowCompacted` flags as the source of
  `promptRetention: "compacted"`: an adapter's usage reports say only whether
  the runtime keeps each prompt, and the turn runner journals the compaction,
  so a runtime's automatic compactions get the same receipt. Provider payloads
  stop at the adapter.
- The provider-sdk conformance harness checks that a driver claiming
  `sessionCompaction` implements `compact`, emits `context-compacted` with
  `requested` before it resolves, and leaves the session resumable, and that a
  driver without `compact` does not claim the capability
  (`runSessionCompactionConformance`, per mode; the lifecycle harness also
  refuses a claim the acquired connection cannot honor). A claim of
  `unavailable` must refuse as `runtime-version-unsupported`. A connection
  refuses a turn while its compaction is pending: Codex would queue the turn
  behind the compaction and read the compaction's report as the turn's, and
  Claude would take the `/compact` result as the turn's reply. A fixture that
  can hold its runtime's compaction open has the harness check it.

The host path for Chat and Work on a direct endpoint does not use the
connection's `compact`: their history is the host's, so `ContextHarnessService`
compacts the plan, and the next turn's fresh session receives it.

_UI._ The server says per thread whether compaction is offered
(`compaction: { status: "available" } | { status: "refused", reason }` on the
context answer), and the renderer never decides it. A Code thread has no
context plan, so its inspector read answers `not-planned`; the window instead
reads `GET /api/context/compaction?aggregateType=…&aggregateId=…`, which answers
every thread kind with the same `compaction` decision `compact-session` makes,
the thread's `latestCompaction`, and, only while compaction is offered, the
`executor` that would compact, so the confirm can name where the conversation
goes before the person agrees. It authenticates the window and answers only one
that can open the thread, as the command does; a paired device is passed
through and refused `remote-client`. The window reads it when the thread opens,
when its mode's navigation feed moves (turns starting and ending), and every
1.5 seconds while a compaction runs, because the Work and Code streams do not
carry the outcome to the meter; it asks the inspector again once a compaction it
watched has ended.

- The context popover's footer gets a secondary **Compact session** button
  beside its existing action. The inspector gets the same button beside
  Rebuild, and its `compact-range` remedy runs the same command, labelled
  Compact session; choosing a range is not offered.
- A permanent refusal (`runtime-cannot-compact`,
  `runtime-version-unsupported`, and `remote-client`, which no window on a
  paired device can change) hides the button, and the inspector leaves the
  `compact-range` remedy out; every other refusal (`turn-running`,
  `compaction-running`, `provider-unavailable`, `no-session`,
  `nothing-to-compact`, `spend-ceiling-reached`, `mode-disabled`,
  `project-unavailable`, `model-options-unsupported`, `thread-paused`) disables
  it with the reason as its tooltip and its accessible description.
- The confirm uses the shared alert recipe. Title: "Compact this session?" Body:
  "The earlier conversation is replaced by a summary. From the next message the
  model sees the summary and the most recent messages. The full history stays in
  this thread. This sends the conversation to {provider} · {model} and uses
  tokens." For a runtime executor it adds "{Runtime} writes the summary; Octant
  can't show it." Actions: **Compact** and Cancel.
- While it runs, the popover reads "Compacting…", the composer's send is
  disabled with "Compacting session" as the reason, and no new turn starts.
  The server enforces the last part, not the window: a Chat send, edit, retry,
  resume or delivered subagent result is refused `waiting`, a Work turn
  `stale`, and a Code turn `waiting`, with "This session is being compacted.
  Send again when it finishes." A subagent result, and a usage-limit
  continuation the person opted into, wait the compaction out instead of being
  spent: each is offered again as soon as the compaction ends. A Code turn
  refused `waiting` defers the result or continuation on that refusal, even
  when the compaction has already ended by the time the refusal arrives. A
  message queued on the thread waits too: the queue reads the thread as busy
  while it compacts, as it does while a turn runs. The two cannot
  interleave the other way either: a turn or a resumed attempt counts as
  running for compaction from the moment it is queued (a Code turn: from the
  moment it passes the compaction check) until it is accepted or launched,
  because it reads the conversation it plans from, or the session it resumes,
  while it is prepared (a Chat turn journals its plan before its attempt), so a
  compaction can neither be planned over nor commit a summary the turn never
  read, and a runtime is never asked to compact a session a turn is resuming.
  The held send points to the "Compacting session" note as its description.
  If the compaction-state read fails while a compaction runs, the window keeps
  the running answer and asks again, more slowly each time; after five failed
  reads in a row (a host that went away, or a window that lost the thread) it
  stops holding send and reads "Compaction state unknown: the host stopped
  answering. It may still be compacting, and refuses a send until it ends."
- The result line, in the popover and the inspector (and on the
  timeline divider): "Compacted · 41.2K freed · summary by Codex", "Compacted ·
  freed amount shows after the next reply · summary by Codex", "Compacted ·
  freed amount not reported · summary by Codex", "Compacted · nothing freed ·
  summary by Codex", or "Couldn't compact: {reason}." A runtime's own
  compaction reads "Compacted automatically by Codex · 41.2K freed", "Compacted
  automatically by Codex · nothing freed", or, when the runtime reported no
  amount, "Compacted automatically by Codex": nothing revisits that receipt, so
  the line promises no later figure. A completed line names
  who wrote the summary and ends without a full stop; a failure is a sentence
  and ends with one, and one that may have changed the session adds "The
  session may have changed; the next reply shows what it holds." A refused
  request reads "Couldn't compact: {reason}." until the server offers
  compaction again. It is
  announced through the meter's live region, only for a compaction the window
  watched end, so a result already there when the thread opens is shown, not
  announced.

_Failures._

| What happens                                                                                                       | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A turn is running, or another compaction is                                                                        | Refused before anything is journaled; the same `compactionId` returns the compaction already under way.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| The runtime reports failure (Pi with no `result`, Claude `failed`)                                                 | `failed` (`runtime-failed`), carrying the adapter's `sessionMayHaveChanged`. Unchanged (Pi) reads as nothing changed and the person can retry; may-have-changed (Claude today) says so, and the next usage report settles it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| The host summary request fails                                                                                     | `failed` (`summary-failed`); nothing changes, and the person can retry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| The host summary is not smaller than what it replaces                                                              | `failed` (`summary-not-smaller`); nothing changes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| A pin, an exclusion, or the thread's provider or model changes while the host summary is being written             | `failed` (`context-changed`); nothing is committed, and the person can compact again. A provider or model change is journaled on the thread, so the context ledger's version is not the only guard.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| The request times out                                                                                              | `failed` (`timed-out`). A host summary call is cancelled on the existing maintenance timeout (30 seconds) and nothing changes. A runtime compaction gets the inactivity bound a Code turn has (five minutes), because it is a model call over the whole session that streams nothing until it ends. It is then interrupted and the session stopped: Codex runs the compaction as a turn of its own in an app-server other sessions share and keeps running it after a stop, so only its `interrupt` ends it before a later turn would queue behind it; Claude and Octant Harness refuse an interrupt with no turn in flight, and the stop ends theirs. It is recorded as one that may have changed the session. |
| The runtime refuses after the request was journaled (its install changed, Octant Harness finds nothing to compact) | `failed` (`runtime-failed`); the adapter decided before asking, so nothing changed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| The session cannot be opened (the checkout or folder is gone, the window lost access to it, the resume fails)      | `failed` (`subject-unavailable`); the runtime was never asked, so nothing changed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| The runtime lacks the request (older Codex, OpenCode, Pi, Claude)                                                  | Refused `runtime-version-unsupported`, and the capability reports `unavailable` for that install.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| The provider is disabled, signed out or over a spend ceiling                                                       | Refused `provider-unavailable` or `spend-ceiling-reached`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| The thread's mode is disabled while compacting                                                                     | A runtime that reports success has changed its session, so the compaction is journaled `completed` and the thread stays unusable until the mode returns. Only an interrupted or unknown outcome is `failed` (`subject-unavailable`), marked as one that may have changed the session. A host summary that has not been committed is dropped and recorded `failed`.                                                                                                                                                                                                                                                                                                                                              |
| The thread is deleted while compacting                                                                             | The result is discarded and the request ends `failed` (`subject-unavailable`), because an ordinary delete keeps the ledger until a purge and a request left open would read as running. Usage the provider reported is still journaled, because the request was spent; the thread's purge erases the compaction and keeps that usage.                                                                                                                                                                                                                                                                                                                                                                           |
| The host restarts mid-compaction                                                                                   | Recorded as `failed` (`interrupted`); for a runtime the line says it may have compacted, and the next usage report settles it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

### Stop reasons

A completed runtime event may carry an optional stop reason. `max-tokens` means
the reply was cut off because the output limit was reached. `content-filter`
means the provider stopped the reply on a content filter. The field is absent
when the runtime did not say why the turn ended; absence is not a normal
finish guessed into a reason.

Chat Completions maps `finish_reason` `length` to `max-tokens` and
`content_filter` to `content-filter`. The Responses protocol maps
`incomplete_details.reason` `max_output_tokens` and `content_filter` the same
way. The Messages protocol maps `stop_reason` `max_tokens`, and `refusal`
(its safety classifier stopping the reply) to `content-filter`; an ACP prompt
result's `refusal` names the agent declining to continue, not a filter, so it
leaves the field absent. Claude's result
`stop_reason`, Pi's assistant `stopReason` of `length`, OpenCode's step
`finish` of `length`, and an ACP prompt result that names one of those
strings, map when the protocol reports them. A local runtime's `done_reason`
of `length` maps the same way. Codex's turn status does not say the output
was cut off, so its completed event leaves the field absent.

A turn record's stop reason is `max-tokens` when the completed event carried
that reason. The per-turn detail says "Cut off at the output limit". The
transcript shows a quiet note with Continue, which drafts a follow-up into
the composer and sends nothing until the person does.

The ACP and RPC mappers (Devin, Kimi, Grok, Copilot, Mistral Vibe, Oh My Pi)
report no usage today: the prompt result is read only for its stop reason, and
the capability is declared `unsupported`, so their turns are recorded as
unreported and no cache figure is invented. A driver declares usage
`unsupported` only when it never reports usage for that instance, because a
spend ceiling leaves such a provider's unreported turns out (below); one
response without usage is not that evidence, so a runtime observed per turn
(the local Ollama runtime, a compatible endpoint) keeps its earlier value
instead. Pi accumulates usage, including cache reads and
writes, from completed assistant messages. OpenCode reports input apart from
cache reads and writes, so its mapper adds them into `inputTokens` like the
Claude and Pi mappers do; that follows OpenCode's own token accounting and has
not been checked against a live OpenCode run.

Native Chat, Work, and Code resume acknowledgements may omit an unchanged resume
cursor. The host retains the already-admitted cursor in that case and persists a
replacement when one is returned. A changed session identity or an initial native
session without a recoverable cursor still fails closed; no transcript replay or
replacement conversation repairs the missing identity. A follow-up on another model of
the same provider instance resumes the same native session only when the driver
reports the `modelSwitch` capability; the resume carries the thread's current
model and the turn records it on the session. Claude resumes only a session
whose identity (provider instance, Octant session, SDK session, Project root,
authentication) this host recorded; the identity is journaled
(`claude-resume-identity`), so a host restart keeps an existing thread
resumable and compactable. A removed identity or a removed provider stays
refused as `stale-resume` after a restart. A reconfigured provider keeps its
identities, as it did within one host lifetime; the resume checks (instance,
authentication, Project root, account directory history) still decide. A
thread purge erases the identity of the session the thread recorded. Codex restates the model and its
reasoning effort on each turn, and Claude resumes the SDK session under the new
model. Another model on any other driver still fails closed. In Code, a
change of provider instance starts a new session with a provider-switch
handoff (below); in Chat and Work it still fails closed. A started Code
thread's model picker offers its own provider's models only where its next
turn will accept them, and every other provider. Work and Chat also refuse
a follow-up that switches between provider-owned and host-owned conversation
history; switching adapters cannot implicitly replace an existing native task.
A Chat branch (`branch-chat-thread`, also behind a Chat checkpoint's restore)
refuses as `unsupported` before creating anything when the source's provider,
or the provider of the last completed attempt it would carry, owns its
conversation, or when that attempt's provider can no longer be resolved: the
native session already holds the source's later turns, and a copied attempt
has no resume cursor of its own, so the branch could only refuse its first
message. Host-owned conversations branch as before, because the
branch's next turn is planned again from its own journaled copy. The Chat
transcript omits Fork, Branch from here, and Restore from here on a turn the
host would refuse this way, reading each listed provider's kind through the
shared `providerKeepsConversation` policy; a provider the picker does not
list is left to the host, so the renderer never hides a branch it would accept.
Work also refuses when the previous driver is unavailable and its conversation
ownership cannot be established.

**Provider-switch handoff (Code).** A Code turn whose last recorded session
belongs to another provider instance on the same checkout starts a new session
on the thread's current provider; it never resumes or names the previous
session to the new provider. The turn carries a disclosed text handoff built by
the same selector that admits a child's parent context
(`admittedParentCodeContext`, purpose `provider-switch`): the thread's own
accepted prompts and completed replies, at most 24 blocks of 4,000 characters
including the summary block, each attributed to its provider and model, with
the thread's taint and every omission counted (earlier messages, purged or
oversized bodies, empty bodies, unfinished replies, attachments, truncation).
Reasoning, tool bodies and attachments are never read. The switching turn's
own prompt is excluded from the selection because it is sent as the prompt.
The host checks that what the selector returned is this thread's in this
Project before using it.

The handoff is journaled on the turn's operation as `context-handoff-attached`
when the new session is ready and before the prompt is sent: the previous and
new provider, model and session, the counts and taint, a content-store
reference to the exact blocks sent, and fixed `nativeSessionTransferred` and
`hiddenReasoningTransferred` values of `false`. A start recovered after a
restart reads that record back instead of selecting again, so it sends the
handoff first disclosed and journals no second one; a recovery after the new
session was recorded sends the journaled handoff again with the prompt, since
the provider may never have received it. A selection that changed since the
record refuses. The conversation page carries a summary of the record on the
turn (`handoff`), and the transcript shows what was handed over and that hidden
reasoning, tool activity and the previous session did not transfer. While the thread's selection names a provider other than the one its session
is on (the provider of its last finished reply, or of a later switching turn
whose handoff was journaled, which happens only once the new session is
ready), the composer says the next message starts a new session with a
handoff.

**Fork handoff (Code).** A fork's first session (no session recorded on the
fork yet) carries the source's conversation through the fork point, never
past it. When the fork's provider instance and model can take up the
source's own session there (today only the Octant Harness, `seedCodeForkHarnessSession`,
below), the fork resumes that copy and is sent no text. Otherwise, including
every fork onto a provider instance other than the one that wrote the fork
point, it reads the source through the same selector (purpose `fork`,
bounded `throughOperationId`): the source's accepted prompts and completed
replies up to and including the named turn, with the same bounds,
attribution, taint and omission counts. The named turn must be found or the
read refuses (`source-point-unavailable`); a whole-thread read refuses when
the thread moved during the read, but a read through a fork point covers only
settled turns, so the source running a later turn does not refuse it. The
host re-reads the source's record, authorizes the sending window against the
source's Project, and requires the source to be in the fork's Project before
reading, then checks that what came back is that thread's.

Either way the turn journals `context-handoff-attached` before the prompt is
sent, with the fork origin and the fork's provider and model: reason `fork`
with the counts, taint and a content reference to the exact blocks sent, and
fixed `false` native-session and hidden-reasoning values; or reason
`fork-native-session` with `nativeSessionTransferred: true` and no content.
A recovered start reads that record back like a provider switch's: a text
record is sent again without reading the source, and a native record whose
copy cannot be taken up again refuses rather than sending text it did not
disclose. The handoff is given once: a later turn has its own session. A first
turn that can neither resume nor build the text handoff refuses with a named
reason (the source unreadable to this window, in another Project, removed, its
fork point gone, nothing readable left, history beyond the bounded scan, or a
handoff that could not be saved). The conversation page carries the summary
as the turn's `handoff`, and the transcript says what carried over and that
the source's later replies (and, for text, its session, hidden reasoning and
tool activity) did not. Other runtimes that can fork a session natively
(Claude, Codex) still use the text handoff until a driver seam reports a
fork-at-point capability.

**A fork that later switches providers (Code).** A forked thread's
provider-switch handoff also carries the conversation the fork inherited,
whichever way its first turn received it: the selector (`inherited`) reads the
source through the fork point first, then the fork's own turns, into one window
under the same 24-block bound. The oldest inherited messages are the first left
out, counted in `earlierMessages`; the fork's own newest turns are kept.
Inherited messages are labelled as forked-conversation excerpts and name the
source thread, the summary says the thread is a fork, and the summary metadata
attributes both reads with their own taint. The host authorizes the sending
window against the source's Project and requires the source to be in the
fork's Project before reading it, exactly as for a fork's first turn, then
checks that what came back is that source's. A source that is unreadable,
removed, moved to another Project, missing its fork point, changed during the
read, or with no readable message among those the budget kept refuses the switch with a named reason that says the source is the
cause; it is never silently dropped, because the transcript shows the inherited
turns and the new provider must not answer as if it had seen them. The
journaled `provider-switch` record gains `inherited` (the fork origin, how many
carried messages came from the source, and the source's taint); its
top-level `messages` and `omissions` cover both reads and its top-level taint
stays the thread's own. A recovered start reads the record back as for any
switch, refusing if the thread's fork origin no longer matches it. The source
read covers only the source's own turns: a fork of a fork does not also carry
what its source inherited.

**Merge-back (Code).** A person can merge a fork's conversation back into
the thread it was forked from with the `merge-code-fork-context` command,
naming one of the fork's finished turns. It is an explicit action on the fork
and approval-free, because it only adds context: nothing runs, no model
summarises anything, and the fork's file changes reach the source only through
Git review (the existing worktree merge-back). The host authorizes the window
against the fork and the source, requires both in one Project, and reads the
fork's own turns through the same selector (purpose `fork-merge-back`), after
the fork's previous merge back (`afterOperationId`, which must be found) or
from the fork point, through the named turn, with the same bounds,
attribution, taint and omission counts. The fork's inherited copy of the
source is never sent back. The result is journaled on the source as
`fork-context-merged`, under an operation of its own, with a content reference
to the exact blocks and fixed `false` native-session and hidden-reasoning
values. Merges are deduplicated by fork and end turn: a merge through the
fork's last merged turn is refused (`already-merged`), and one with no new
readable turn is refused (`nothing-new`); the check and the append run without
yielding, so two merges cannot both pass. At most 64 merges may wait for the
source's next turn (`merges-pending` beyond that), so the bounded journal read
that finds waiting merges always holds them all. Outside content the fork took in
taints the source (`external-content`, label `fork-merge-back`) before the
merge is appended. Refusals are values on the command result
(`fork-context-merge`): unsupported, not a fork, source unavailable or
unauthorized, another Project, a missing or unfinished end turn, already
merged, nothing new, too many merges waiting, an unreadable fork, or a merge that could not be saved.

The source's next turn carries the oldest merges no turn has carried yet, at
most two (`MAX_CODE_FORK_MERGE_BACKS_PER_TURN`; later ones wait), after any
provider-switch or fork handoff and before the turn's own context, and
journals one `fork-context-delivered` per merge on its operation before the
prompt is sent, beside the handoff. Merges are carried in order, so the newest
delivered record says which merges are still pending. A recovered start reads
its own delivered records back instead of choosing again; a merge whose text
cannot be read refuses the turn rather than dropping it. The conversation page
carries the summaries as the turn's `forkMergeBacks`, and the transcript says
how many messages came from a fork, what was left out, and that hidden
reasoning, tool activity and file changes did not transfer.

A switch that cannot hand over refuses before the new provider is acquired,
naming why: no host selector, an unavailable or foreign thread or Project
(for a fork, its own or the inherited source's),
no recorded or readable conversation (for example every body purged), a
conversation that changed during the read, an inconsistent page, a history
beyond the bounded scan, or a journaled handoff that can no longer be read or
saved. A model change within a provider that cannot carry its session, and a
change of checkout, still refuse as before.

Optional Project and
thread spend ceilings (0060) are host owner policy over four dimensions:
tokens, turns, total agent run time, and money per window (for example two
hours a day, or $25 a month, for a Project). The server refuses a
provider-consuming turn at admission when remaining reserved token capacity
cannot cover a declared per-turn bound, when the turn count is used up, when
settled plus in-flight run time has reached the budget, or when settled money
spend has reached the budget, and the composer and Environment name the
exhausted dimension and a recovery. Token spend is the existing `UsageRecord`
ledger, never imported provider history. Token and money spend include child
runs: a thread ceiling counts its own runs, and a Project ceiling counts every
run whose parent thread belongs to the Project now, whichever thread started
it, at admission and in the Project overview. The Project a run's routing
receipt named at delegation does not count, so a thread moved to another
Project takes its children's spend with it. A child run is admitted against
its parent thread's ceiling and that thread's Project ceiling; a Chat child's
workspace names no Project, so its route's Project is used. Turns and run time come from journaled
`spend.turn-recorded@1` facts, one per admitted turn or child run, charged its
actual admitted-to-settled time; a turn still in flight counts its elapsed time,
and a turn a host exit interrupted records nothing.

A money budget is whole US cents (`costBudgetUsdCents`); a raise must be
strictly above the current budget and cannot add money to a ceiling that has
none, as for the other dimensions. Spend is the sum of the window's
`UsageRecord` costs in integer micro-dollars, floored to whole cents. Each
reconciled request records its cost from the provider runtime's own figure
(`costUsd` on the normalized `usage` event) as `provider-recorded`: Claude Code
(`total_cost_usd`), OpenCode, Pi, and an OpenAI-compatible endpoint that reports
`usage.cost` (OpenRouter; a BYOK `cost` is only OpenRouter's fee and is not
used). Without a provider figure, a model in the checked-in standard-rate price
table (`packages/domain/src/localUsagePricing.ts`, the same table and rule the
composer's cost line uses) is recorded as an `api-estimate`. On a subscription
plan both are API-rate equivalents, not the bill: Claude Code reports
`total_cost_usd` at API rates on a Claude plan too. The cost is fixed when the
usage is journaled: Chat, Work, and child runs carry it in the usage
reconciliation, and Code carries it in the turn's `usage` operation frame
(`cost`). Projections read the journaled cost and never price, so a rebuild
reproduces the ledger exactly: a later price-table revision does not re-price
history, and usage journaled before it carried a cost stays unpriced.

A turn's usage is accumulated as the runtime contract defines it
(`accumulateTurnUsage`): reports that name their request add up, a whole-turn
report replaces them, and the sum has a cost only when every request in it
reported one. The Claude mapper reports the turn so far after each model call,
summed by message id. Every turn that reached the provider leaves exactly one
ledger row however it ended — completed, failed, cancelled, or interrupted —
and Work keeps usage the provider reports after a cancel. A turn that reached
the provider and reported nothing (an ACP agent in Code reports no usage) is
recorded as unreported and unpriced; whether token and money ceilings refuse
after it depends on its provider (below). A turn refused or failed before the
provider leaves no row. A Code turn
reaches the provider once its `provider-session-ready` frame is journaled,
just before the prompt is sent, or when it completes. Any unpriced row in the
window — a model with no price, a provider that reports no cost, an unreported
turn of a provider that can report usage, and usage recorded before the ledger
carried cost — makes the money ceiling refuse `unknown-spend` rather than count
that usage as free. That refusal
offers clearing the ceiling, waiting out a Project's calendar window, Usage,
or pausing; a raise cannot price the usage, so it is not offered. Turns from
before this behaviour that left no ledger row at all, including every child
run's, are not counted.

A provider that never reports usage is not counted against a token or money
ceiling. The host decides by provider, not by row: a ledger row's
`provider_instance_id` names the instance, and the instance's runtime
capability as the host observes it now (`ProviderRuntimeRegistry`, the same
observation that gates app-managed tools and model switches) decides whether
its unreported rows count. Only `usage: "unsupported"` leaves them out: the ACP
mappers and Oh My Pi declare it because they never emit usage. A provider that
can report usage keeps the rule above, so its failed, cancelled, or
interrupted turn that reported nothing still refuses `unknown-spend`; counting
it as nothing would make an interrupted turn free. An instance that no longer
exists, is disabled, has not been probed since the host started, or declares
`unavailable` counts the same way: an unknown capability fails closed. Rows
written before this rule are read the same way, so a thread with unreported
turns from an ACP agent is no longer stuck. The rule reads the capability at
evaluation time for every row in the window, so a runtime that starts
reporting usage makes its earlier unreported rows count again (refusing until
they leave the window or the ceiling is cleared), and a driver must never
downgrade to `unsupported` because one response lacked usage. Excluded rows add
no tokens and no cost; the provider's reported rows, if any, still count, and
every other provider's spend in the same thread or Project is counted and
enforced. Turns and run time count every provider. The reading
(`SpendCeilingRemaining.notMeasuredProviders`) names each excluded instance
with rows in the window, and the thread Usage panel and Project overview show
it as **Not measured**, so a person is not led to read the ceiling as covering
it. A model with no known price, or usage journaled before the ledger carried
cost, is a different case and still makes a money ceiling refuse
`unknown-spend` as described above.

Money is checked between turns, like turns and run time, not reserved like
tokens. A provider reports cost only when a turn settles and no per-turn price
bound exists for every provider, so reserving would need a second, invented
bound; instead admission refuses once settled spend reaches the budget, a turn
already running finishes and may end over it, and concurrent turns admitted
while money remained can each add their cost. The Usage panel and Project
overview say so wherever a money budget is in force.

### Native harness

Direct-endpoint providers (`openai-compatible`, `anthropic-compatible`,
`azure-foundry`; `ollama` joins once its driver runs the tool loop) run under the
native harness in `apps/server/src/harness`:

- **Loop.** `createNativeHarnessConnection` is the harness's agent loop and
  the `ProviderConnection` every direct-endpoint driver hands out. Each driver
  supplies only a `NativeHarnessTransport` (one request over its wire
  protocol, its size bounds, and what a response teaches the registry); the
  loop owns the conversation. Instructions blocks become the system prompt
  (plus one sorted line per Octant tool on offer), so the prefix stays
  byte-stable. A step's calls go out as `tool-request` events and the turn
  runner executes them through its tool set; once every call is answered the
  results return in one message in call order. A request that outgrows the
  endpoint is shrunk in the request only — older tool results first, then
  whole earlier exchanges behind a note — and refused if the latest message
  alone does not fit. The lead has no tool to read a cut exchange back: the
  note tells it that its task list and the files on disk still reflect that
  work, and the journal keeps the full conversation for people, replay, and
  export. A journal lookup tool was specified once but never wired to a store,
  so it only ever reported itself unavailable and was removed; the note names
  no turn or sequence the model could ask for, and Chat and Work start a fresh
  session each turn, so a lookup needs those handles and a thread-scoped read
  of the rebuilt history before it can return. When the endpoint still rejects a request as too large,
  the loop recognises the refusal as a filled context window (OpenAI's
  `context_length_exceeded`, Anthropic's "prompt is too long", or the 400 or
  413 shape from an OpenAI-compatible host), shrinks it one further ladder
  step, and sends it once more; a second refusal stands. That step always
  changes the refused request, which may itself have been reduced already: a
  result already omitted or a note already in front is skipped, and when
  nothing is left to leave out the refusal stands. The size estimate
  prefers the input tokens the last call reported over a flat
  four-bytes-per-token guess. A tool call that names no offered tool, reuses a
  call id, or carries arguments that are not JSON is answered with an error
  result instead of failing the turn, so the model can correct itself; the
  arguments the model sent are never replaced by an empty object. A handful of
  such correction steps is the most a turn takes, so a model that will not
  correct itself fails rather than loop; the well-formed calls of that last
  step are answered as not run, so the conversation stays valid for the next
  send. An unknown stream event type is
  ignored and logged, never fatal.
- **Durable conversation.** `JournalNativeHarnessTranscriptStore` journals
  each step as it happens (`native-harness-transcript`, one aggregate per
  session): the user message once the request is known to fit, each reply,
  and each tool call the moment it settles. Sessions therefore report
  `resume: supported` and return a resume cursor, which is how a Code thread
  continues the same conversation on its next turn. `start` under an existing
  id begins a new generation. A resume first closes any call the process
  stopped in the middle of with a journaled interrupted result that says
  whether the tool only reads (`replay: "safe"`, call it again) or may have
  taken effect (`replay: "unsafe"`, check before repeating); nothing is
  silently re-run. A cancel (`interrupt`) ends only the turn in flight: the
  session and its conversation stay live, so the next `send` continues it
  without a resume or a journal rebuild, and a cancel during a tool step first
  closes the calls its runner never answered with the same interrupted results
  a resume would write. Only `stop` releases the session. Chat and Work still
  rebuild their history on the host and
  start a fresh session each turn.
- **Forks.** A Code fork on a harness model starts its first session from a
  copy of the source's transcript through the fork point
  (`seedCodeForkHarnessSession`), resumed like any other: the lead keeps its
  own messages, tool calls, and results instead of a text summary. A turn
  begins with the one user message `send` journals for it, and the copy is cut
  at the turn after the named one; the copy refuses — and the fork reads the
  journaled text handoff instead (see "Fork handoff (Code)") — unless the
  copy's binding is the fork's provider instance and model, the turn is
  still admitted, and the transcript holds exactly the turns the
  source ran on that session, the named turn finished, and its last step
  settled. Copied paths under the source's checkout are rewritten to the
  fork's worktree, and the secret values the fork's turn resolved are
  replaced with `[REDACTED]`. The copy's `opened` event names its source
  session and how many turns it inherited, so a fork of a fork counts its own
  turns correctly and the ancestry survives replay. The source's transcript is
  never touched. App state is not copied: a fork starts with no goal, plan,
  task list, steering notes, questions, or remembered approvals, because each
  of those is keyed to the thread that owns it, and it never inherits running
  state or access.
- **Task list.** `todo-write` replaces the lead's own task list, which is not
  a thread plan. It is journaled on the harness session as a
  `native-harness-tasks-replaced` frame (a list rewritten unchanged adds
  none), rebuilt on replay, and carried in the session view as `tasks`, so
  the web card, the phone panel, and the terminal show each item as pending,
  in progress, or done in every mode. It never proposes, revises, or advances
  a thread plan and raises no plan review, because the plan's approval policy
  guards what a person has agreed to run and a lead's working notes would
  otherwise be refused at their first step. The person-approved plan and its
  policy are unchanged, and the two lists stay separate.
- **Tools.** `createNativeHarnessTools` composes the nine working tools and
  the harness reads as one `AppManagedToolSet`, trimmed by mode through the
  closed tool catalog (`harness-*` capability ids). `web-fetch` and
  `web-search` are offered only where the host has them (`web-search` needs a
  configured SearXNG endpoint). A Chat thread gets them only while its
  research is on, because research is its grant to reach the web; Work and
  Code need no such grant, and a child gets them only with network authority.
  `context-remaining` and `second-opinion` are offered to the lead in every
  mode and reach no file, shell, or network of the thread: `context-remaining`
  reads the thread's own capacity snapshot, and `second-opinion` sends only
  the lead's written question to the `advisor` slot's model as a one-shot,
  tool-less request, so it answers nothing while that slot is empty. A thread
  that has taken in outside content cannot send it (`second-opinion-tainted`),
  the rule `delegate` follows. A child is offered neither.
  A tool that was not offered refuses as `tool-unavailable` if the model calls
  it anyway. Every call decodes its
  arguments, wraps a `ToolActionRequest` under the thread's current authority,
  and passes `ToolCallAuthorityService.authorize` before any port runs. The
  thread's authority comes from the same resolver the browser tools use, in
  every mode: a Chat thread holds it with or without a Project; a Work or Code
  thread holds it only on its Project's current binding. When none resolves,
  every call refuses as `tool-authority-stale` with a message the model
  relays to the person; nothing renews it except the thread becoming usable
  again. Files go through `NativeHarnessFileSystem` (confined to the root, symlinks
  resolved, edits require a prior read); `bash` writes the command to a
  script in its own subdirectory of `harness/scripts` and runs it through the
  same confined owned-process-group port as repository tests (Seatbelt on
  macOS, the bubblewrap sandbox on Linux), so a timeout or cancel ends the
  whole tree. That port refuses a shell as a test command's `argv[0]`, so a
  test argv stays literal; the harness's only way to a shell is its separate
  script entry point, which the two harness ports alone enable and which runs
  exactly `/bin/sh` with one regular-file script. The script directory lies
  outside every root a confined launch may write, and each launch may read
  only its own script's subdirectory, so no command can swap the script
  another thread is about to run; web fetches
  refuse private destinations, and connect through a `lookup` that checks
  every address the name resolves to at the moment the socket opens, so a
  name cannot pass the check and then resolve somewhere private.
- **Egress and hostile content.** Inference and tool egress are separate
  paths. A direct-endpoint request goes from the server process to the
  configured base URL only, carries the credential, and refuses any redirect
  without following it. The stored key belongs to the base URL it was entered
  for: changing an OpenAI-compatible, Anthropic-compatible, or Azure AI Foundry
  endpoint's base URL deletes its stored key before the change is journaled,
  and refuses the change if the key cannot be deleted, so the person enters a
  key again for the new server. Changing only other settings keeps the key.
  `web-fetch` sends no credential and no model-chosen header, method, or body
  (its arguments are a URL and a size), so a public
  inference host sees an anonymous GET and a local one (Ollama, LM Studio) is a
  private destination it refuses. Private means loopback, unspecified, RFC 1918,
  CGNAT, link-local (including cloud metadata), multicast, and reserved IPv4,
  plus the IETF protocol assignments `192.0.0.0/24`, the 6to4 and 6a44 relay
  anycast block `192.88.99.0/24`, benchmarking `198.18.0.0/15`, and the three
  documentation blocks; in IPv6 all of `::/64`
  other than IPv4-mapped, `100::/64` and `100:0:0:1::/64`, the IETF protocol
  assignments `2001::/23` other than Teredo, documentation `2001:db8::/32`
  and `3fff::/20`, segment-routing `5f00::/16`, unique-local, link-local
  `fe80::/10`, site-local, and multicast. That is every block the IANA
  special-purpose registries mark not globally reachable; the two IETF
  protocol-assignment blocks and the relay anycast block are refused whole,
  including their reachable anycast addresses, which answer from the nearest
  server. An IPv6 address is
  judged by its value rather than its spelling, and mapped, NAT64
  (`64:ff9b::/96`), 6to4, and Teredo (server and client) addresses by the IPv4
  address they carry. Every redirect hop is checked
  again, and a scheme other than `http`/`https`, credentials in the URL, or a
  sixth redirect refuses. A harness child without network authority is offered
  no web tool, and its `bash` runs on a shell whose Seatbelt profile has no
  network rule and its own writable work directory, so it shares no writable
  state with a networked command; the lead and a child with network
  authority use the ordinary one. The tool process environment carries only `PATH`, `HOME`, the temporary
  and locale variables, and what the harness sets, never a provider
  credential. Only a harness tool result that brings in outside content taints
  the thread: `web-fetch`, `web-search`, and a `delegate` `collect` that
  returns a finished child's reply (it may relay what the child fetched). A
  child's reply delivered to its parent as a new turn taints the parent the
  same way, journaled before the turn is admitted; a delivery whose taint
  cannot be recorded waits. Local `read`, `grep`, `glob`, `bash`,
  `edit`, `write`, and `goal-check` results do not, so local work keeps its
  ordinary approvals; the catalog's `resultTaintsThread` marks each tool and
  `nativeHarnessResultTaintsThread` decides, failing closed for a name it does
  not know. A command under OS-level `allow` egress (Full access, or a host
  composed without the proxied shell) keeps today's posture and
  its output does not taint: the host cannot see what such a command received,
  so this is a stated exception to the thread-taint rule, recorded in the
  [threat model](security/security-architecture-threat-model.md), and standing
  approvals stay active after it. Under the `proxied` level
  a launch taints when it received bytes from an outside host, as the
  [egress rules](#harness-tool-egress-rules) describe. Once tainted, `bash`, `edit`,
  `write`, `goal-check`, and `web-fetch` need a person's confirmation for every
  call even under Full access, and refuse when no approval surface exists;
  `web-fetch` is included because a GET can carry data out in its URL. That
  confirmation is single-use: a remembered "always" approval stops covering
  its class the moment the thread is tainted, and an "always" answered then
  covers only that call, so surfaces offer no "for this session" choice
  (`singleUse` on the approval, which then also names the sources that marked
  the thread; [Persistence](#persistence), Untrusted-content taint). A person's clear ends this until the next
  result that taints ([Persistence](#persistence), Clearing taint).
  `web-search` does not ask under taint: it
  reaches only the search endpoint the person configured, so the tool-call
  policy instead refuses a tainted thread's query that looks like it carries
  data, under every posture and before any request leaves, with a named
  reason such as `search-query-refused-under-taint: contains a URL`. The
  patterns that count as carrying data (length, URLs, email addresses, hex
  runs, escaped bytes, base64, and high-entropy tokens) are specified in
  [Search queries on a tainted thread](design/search-query-taint.md). `searchQueryRefusalUnderTaint` in
  `packages/domain/src/untrustedContentPolicy.ts` decides; untainted threads
  are unchanged. Residual risk: a short plain-word query can still carry a few
  words, but only to the endpoint the person chose. Revisit if a default
  hosted third-party search provider ships. A tool the thread was not offered
  refuses as `tool-unavailable` without reaching policy or a person. The harness has no
  per-host network rules, rule expiry, or learn mode yet: a tool process gets the
  thread's OS-level `none` or `allow`. The approved design for them, with its pure
  decision, event schemas, host proxy, grants, and learn mode built but no command routed through the proxy yet, is
  [Harness tool egress rules](#harness-tool-egress-rules). `nativeHarnessEgress.hostile.test.ts` holds the
  adversarial proofs; `nativeHarnessShell.test.ts` runs both shells under real
  Seatbelt and shows only the networked one reaching a loopback listener.
- **Tool verification.** A routine Check connection runs no generating
  request, so an OpenAI-compatible, Anthropic-compatible, or Azure AI Foundry
  endpoint offers a model Octant's tools only after a person proved that model
  calls one. The `verify-model-tools` command sends one forced
  `octant_capability_echo` request through the same sender a turn uses, for one
  model; an Anthropic-compatible endpoint sends it in its own wire shape, with
  `tool_choice` `any`. A model that calls the tool joins
  `verifiedToolModelIds` on the observed state, which the journal persists with
  the catalog and a configuration change clears; a model that answers in text
  leaves it out, and a transport failure (authentication, timeout) is reported
  rather than recorded as "unsupported". Admission, the AgentRun transport
  check, and the Chat preflight read that set per model, so verifying one model
  never offers tools to its siblings; the only tool an unverified model is
  admitted with is that echo. A tool call in a real turn widens nothing either:
  the provider-level `appManagedTools` flag of an OpenAI-compatible,
  Anthropic-compatible, or Foundry profile stays "unsupported", because a tool
  call proves only the model that made it. The command accepts only the models
  the endpoint lists or the profile configures, and only a Foundry profile's
  configured deployments, because its catalogue lists base models that are not
  deployments. Ollama has no verify action until its driver runs the tool
  loop. The model picker marks an unverified model "Chat only" with a "Verify
  tools" action (in Chat, on the selected model), and Settings → Octant
  Harness says the same for a slot's chosen model.
- **Goals.** A thread goal may carry up to twelve acceptance criteria
  (`ThreadGoalCriterion`), each with an optional check command; one without a
  command is confirmed by a person. `NativeHarnessTurnObserver` puts an open
  goal — objective, each criterion's status, budget left — in front of every
  harness turn as per-turn content after the stable instructions. The `goal`
  tool reads it and lets the lead write criteria once, only while the goal has
  none; a person revises them afterwards. `goal-check` (Code, policed exactly
  as `bash`, approval naming the command) runs a criterion's own check — the
  command comes from the goal, never the call, is at most 200 characters so
  the approval shows it whole, and is fixed when approval is asked; a check
  changed while the approval was open runs nothing — and records the observed
  outcome with `record-thread-goal-check` as `test` evidence, met only on a
  zero exit. When the last criterion is met the goal completes on that
  evidence (0025); a model saying it is done completes nothing. A goal loop
  treats a goal with criteria as complete only when all are met, and a round
  whose own checks completed the goal takes no further spend.
- **Routing.** `NativeHarnessRoutingStore` journals a host default and
  Project overrides of slot tables; `resolveNativeHarnessRoute` in
  `@octant/domain` is the pure resolver; `NativeHarnessRouter` adds cooldowns
  and a per-slot circuit breaker. Child runs take their model from the role's
  slot through `admitAgentRunControlRequest`, the one path that starts a
  subagent. The lead is the exception: it runs on the model its thread chose,
  and the `default` slot decides only where it continues once that model has
  failed (below).
- **Endpoint failures.** Each direct-endpoint transport sends through
  `sendWithEndpointRetry`, one policy for both wire protocols. Retryable are
  HTTP 408, 429, 500, 502, 503, 504, and 529 (classified `unavailable` or
  `rate-limited`, with a provider's `Retry-After` carried on the failure), a
  refused or reset connection, an idle stream, a stream that closes before its
  terminal event, and a completion with no text and no tool call. A request goes
  out at most five times, waiting 0.5 s doubling to 10 s with about a tenth of
  jitter; `Retry-After` replaces the wait, capped at a minute. A request is
  retried only while nothing of it has streamed (text or reasoning); tool calls
  reach the loop only with the settled response, so they never count as output.
  Each retry is a `retrying` runtime event emitted before its wait. The thread's
  working indicator, the terminal footer, and the phone session panel show
  "Provider busy, retrying 2/5 in 4 s" and count the wait down, in ordinary
  text rather than a warning, until the next text, reasoning, or tool call
  arrives or the turn settles; a failed or cancelled attempt keeps no retry line. The turn's
  detail counts those same events. What a
  failed attempt billed is added to the usage of the attempts after it. A
  cancel ends a wait at once and stays `interrupted`. The stream idle limit is
  120 s and restarts on any byte, so keep-alive comments and reasoning deltas
  count. A spent allowance (`usageLimit` other than `temporary`), a rejected
  credential, and a malformed event are never retried. A refusal that names a
  filled context window (OpenAI's `context_length_exceeded`, Anthropic's
  "prompt is too long", or a 400 or 413 shape) is classified as context
  overflow, which the retry policy never sends again as-is: the loop shrinks
  the request and retries it once (above). Transports reject with
  the typed `ProviderFailure` (`runProviderEffect`), not the Effect runtime's
  wrapper, because the category is what these rules decide on.
- **Lead fallback.** When a request's retries are spent, the loop asks its
  `NativeHarnessLeadFallback` once per model it has not yet run on this turn.
  `NativeHarnessLeadFallbackService` reports the failure to
  `NativeHarnessRouter.reportFailure` (the model sits out its cooldown and the
  slot's breaker counts it), resolves the `lead` job again under the running
  turn's Project (a Project's table may only narrow the host's; turns of
  different Projects that would pick different models get no fallback), journals
  that decision on the thread's harness session, and opens the next model's
  endpoint through the `NativeHarnessEndpointRegistry` that every direct-endpoint
  driver fills as it is built. The target may belong to another provider
  instance; it must be a harness endpoint and must admit the turn's input, or
  the fallback is refused. The turn continues on it for its remaining steps and
  the next turn starts on the thread's own model. With no other ready model the
  turn fails with the endpoint's own failure and the typed refusal (`slot-empty`,
  `no-eligible-candidate`, `circuit-open`, `no-other-model`, `not-routed`,
  `refused`) in its message and, for the first three, in the journaled
  `unroutable` decision. A failure that was not retried, or that happened after
  output streamed, never moves the turn.
- **Session.** `NativeHarnessSessionStore` journals one session per thread:
  routing decisions, turn records, context reductions, advisor interventions,
  the steering notes a person typed (queued, handed to the lead inside a tool
  result, dropped at the turn's end — so a restart keeps an undelivered one).
  A client mints each note's id, and a queue of an id among the thread's
  last 64 notes — even one delivered or taken since — lands nothing new, so a
  retried steer is not a second note. Notes left when the turn ends become
  the next prompt through `take`, which removes every queued note and returns
  them to exactly one caller, so two clients watching the same turn end
  cannot both send them. A person redirects running work only through these
  ordered notes and through goal revisions checked against the goal's
  version (a stale one is refused, never merged); Side Chat is a separate
  read-only Chat and can do neither. A turn's start is journaled
  (`native-harness-turn-started`) and closed by its completed record or a
  `native-harness-turn-settled` frame, which every mode's turn path writes
  however the turn ended. A person's pause drains: the running turn and the
  helpers it started finish, while the next turn, a new `delegate`, and the
  thread's goal loop are refused or paused. Replay keeps whatever status the
  journal last set — a completed turn never clears a pause. A session whose
  replayed journal still holds an open turn or a pending approval or
  question is `recovery-required` after a restart: it admits nothing, and
  only a resume clears it, after the host checks the lead's provider instance
  is present and enabled, a Code thread's checkout has been confirmed
  available since the restart (a restart leaves every checkout waiting until a
  window's bootstrap revalidates it), and a Work Project's folder still exists
  at the path it was bound to (`not-ready` names what is missing). That resume journals the lost turn as
  `lost-in-restart` and the dead approvals and questions as expired, so the
  next restart does not raise the recovery again. Also journaled:
  the questions a lead asked with how each was
  settled, and — on each turn record — the last calls the lead made (tool,
  what it asked for, ok/refused/failed, duration), noted live on the session
  while the turn runs and journaled with the record when it ends. `NativeHarnessQuestionStore` blocks an `ask-user` call until an
  answer arrives from any surface (`POST /api/native-harness/sessions/:thread/questions`,
  or the Code thread's own inline question path), or until the turn is
  interrupted or ten minutes pass. `NativeHarnessApprovalStore` likewise
  blocks a tool call that needs a person until a decision arrives
  (`POST /api/native-harness/sessions/:thread/approvals`), the turn is
  interrupted, or ten minutes pass. For both, expiry ends the call (as
  `question-expired`, or as a denied call) and is journaled as `expired`, the
  same way whether the timer or the clock caught it: the host checks the
  clock whenever a question or approval is asked, answered, or listed
  (including a read of the session view), so one whose timer fired late (a
  busy host, a machine that slept) is never still shown as pending,
  answerable, or holding a slot. A Code thread's inline copy of a question is
  withdrawn whenever the question settles, however it settled. At most 32
  questions and 32 approvals wait at once across the whole host, the cap MCP
  and browser tool approvals use; one
  past it is refused at once as `question-too-many-waiting` or
  `approval-too-many-waiting`, journals nothing, and tells the lead nobody
  was asked. `NativeHarnessTurnObserver` puts the stable
  instructions block in front of every harness turn, records the completed
  reply, and asks the `advisor` slot for a review. An advisor with no model of
  its own is off: unlike other jobs, its unconfigured slot does not fall back
  to `default`, because the review costs a request on every turn and runs only
  once someone chooses it. The session view still
  carries the thread's follow-up suggestions for the surfaces that read it,
  joined in from their own store (below).
- **Terminal.** `octant agent` in `packages/cli` is the same thread on a
  terminal: `agentThread.ts` is the mode-neutral thread port (Chat, Work,
  and Code adapters over the modes' own routes, plus creation), `agentHost.ts`
  the harness calls, `agentTuiModel.ts` the pure presentation (transcript,
  footer, palette projected from `@octant/theme` tokens), and `agentTui.ts`
  the OpenTUI screen, loaded only when stdout is a terminal and `--plain` or
  `--json` was not asked for. The terminal registers a window authority with
  a renderer identity, like the desktop renderer, and `agentWindow.ts` opens
  the Project and then the thread in that window before driving it, because
  Code checkouts, goals, and harness approvals are authorized against what a
  window has open. `agentLiveFeed.ts` follows the thread's own live feed
  under that same window capability — the Chat events stream, the Work
  turn stream, or back-to-back replays of the running Code operation's
  events — and only uses it as a wake-up: every redraw still reads the
  thread through the mode's routes, so the stream never becomes a second
  source of truth. Harness questions and approvals have no stream and are
  picked up by a one-second fallback read. A Browser site ask is not a
  harness approval, so `agentSiteApprovals.ts` reads it on the same tick
  from the route the app's thread view uses: `/api/browser/approvals` for
  Work, and for Code the `/api/pending-requests` approvals that carry
  `browserOrigin` (answered with `answer-provider-approval`). A Code
  approval without `browserOrigin` is a provider's own tool approval and is
  never offered as a site ask. A terminal whose stdin has ended denies the
  ask instead of leaving the turn waiting.
- **Surfaces.** `/api/native-harness/routing` and
  `/api/native-harness/sessions/:threadId` serve the web, desktop, phone, and
  `octant agent` / `octant harness` from one `NativeHarnessSessionView`.

- **Parity checklist.** The 2026-10-16 parity run found Harness leads that
  could not record task progress, were offered `second-opinion` and
  `context-remaining` in only some modes, raised no attention for a pending
  approval, and trapped terminal keyboard focus, none of which the Claude and
  Codex paths did. A Harness lead counts as at parity with those first-class
  runtimes only while every item below holds in Chat, Work, and Code. Each
  release's acceptance runs this checklist, and a release does not claim
  Harness parity while any item is open.
  1. **Offered tools.** Always offered: `todo-write`, `context-remaining`,
     and `second-opinion` in every mode; `read`, `grep`, `glob`, `edit`, and
     `write` in Work and Code; `bash` and `goal-check` in Code only. Offered
     when the host supplies the port: `delegate`, `ask-user`, and `goal`
     (every mode), and `web-fetch` and `web-search` (Work and Code; Chat only
     while its research is on, and `web-search` only with a search
     endpoint). `nativeHarnessComposition.test.ts` pins the full set per
     mode with every port supplied, the reduced set without them, and that
     `server.ts` still supplies each port.
  2. **Approval attention.** A pending approval raises the same attention as
     a pending question: the thread's state, the Inbox, and the sidebar mark,
     and it shows inline in the thread. Not yet pinned by a test.
  3. **Task list.** `todo-write` records pending, in-progress, and done
     without a plan approval. Not yet pinned at the offered-set level beyond
     item 1; the progress states are covered by `nativeHarnessTodo.test.ts`.
  4. **One session everywhere.** The same session state is visible in web,
     terminal, and phone.
  5. **Terminal focus escape.** A keyboard user can leave the terminal pane
     with a documented chord, and the pane says so. Not yet pinned; pinned
     when the terminal focus escape lands, in the existing xterm tests.

Follow-up suggestions are every provider's, not the harness's
(`apps/server/src/followUps`). Every Chat, Work, and Code turn, on any
provider, carries one fixed instructions block that lets the model end a reply
with up to three suggestions in an `octant-follow-ups` fenced block.
`ThreadFollowUpSuggestionStore` journals the latest reply's set per thread
(`thread-follow-up-suggestions`), retires it when a later reply suggests
nothing, and replays sets a harness session journaled earlier. The shared
message parser leaves the block out of the reply a person reads.
`/api/follow-up-suggestions/:threadId` reads the set, previews what one
suggestion would create — a new thread in the same mode and Project, or a
worktree only for a Code thread in a Project — and activates it with an
explicit confirmation, refusing a repeat before anything is created. A
confirmed follow-up is created by `createFollowUp` through the mode's ordinary
creation command on the confirming window, on the model that suggested it; the
prompt is never sent on the person's behalf. The web shows the set as chips at
the top of the composer of each local thread pane.

Side tasks are the mid-turn counterpart (`apps/server/src/sideTasks`). On any
provider that runs app-managed tools, every Chat, Work, and Code turn's tool
set includes `octant_offer_side_task`; Work and Code turns also carry browser
and computer use. The
model offers out-of-scope work it noticed (title, one-sentence reason,
standalone prompt, and in a Code thread in a Project a worktree or the current
checkout). The call only journals the offer (`thread-side-tasks`, at most five
open per thread) and returns at once; it grants nothing. `/api/side-tasks/:threadId`
lists offers and starts or dismisses one. Starting is the person's
confirmation: the host creates the thread through `createFollowUp` on the
offering model, marks the offer started, and sends the prompt as the first
message through the mode's ordinary turn command on the confirming window
(`send-chat-turn`, `start-work-thread-turn`, or staged evidence plus
`start-provider-turn`); a Code thread still starts approval-gated. This is the
one place a prompt is sent for the person, and only on their click. If the
message does not go out, the thread stays and the prompt waits in its
composer. The web shows open offers as cards above the chips.

### Harness tool egress rules

**Status: design approved by the maintainer on 2026-10-13. All four
delivery phases are in: the rule model and decision (`decideToolEgress` and
`decideToolEgressGrant` in `packages/domain/src/toolEgressPolicy.ts`), the
event and wire schemas (`packages/contracts/src/toolEgress.ts`), the host proxy
(`apps/server/src/harness/nativeHarnessEgressProxy.ts`, which reads request
heads and ClientHellos in `nativeHarnessEgressWire.ts`), the grants,
learn-mode proposals, rules lists, journal records, and recovery
(`nativeHarnessEgressRules.ts`, served by `nativeHarnessEgressRoutes.ts`, shown
in a Code thread's Agents tab as Network access), and the confinement wiring:
the `proxied` level in the Seatbelt builder (`process/seatbeltProfile.ts`) and
the bubblewrap capsule with its forwarder (`process/linuxConfinement.ts`,
`process/proxiedNetworkEgress.ts`), chosen per command by the harness
composition (`nativeHarnessComposition.ts`) and launched by
`nativeHarnessShell.ts`, and the tainted thread's command confirmation that
grants `call` rules (`nativeHarnessApprovals.ts`).** What is not yet verified or wired is listed under
**Phase 4 settled** below. The design's approval replaces the "no local egress
proxy in this release" decision in the
[threat model](security/security-architecture-threat-model.md#approved-decisions-henrik-2026-08-12)
for native-harness tool processes only.

**Outcome.** A command the harness runs for a thread reaches exactly the
destination hosts and ports a person allowed for that thread, until the
allowance expires, and nothing else. A refused connection can become a
proposal the person sees, never a rule by itself.

**Where it applies.** The harness `bash` tool and the repository test runs a
harness thread starts, on a thread whose tool egress resolves
`provider-endpoints-only` (Code approval-gated and auto-accept-edits). Under
this design that policy materializes as a new third OS level, `proxied`,
instead of `allow`, so the name finally means what it says for tools: the
command reaches only what a rule names. `none` (Plan, Work, Chat, a child
without network authority) is unchanged and runs no proxy. Full access and an
explicit network approval (`unrestricted`) keep OS `allow`. `web-fetch` and
`web-search` run in the server process, not in a confined command, and keep
their own rules above; they neither use nor consult egress rules. Provider
runtimes that run their own tools inside their own process (Claude Agent SDK,
Codex, OpenCode, ACP, Pi) are out of scope: their inference and tool traffic
share one process, so a proxy could not tell them apart, and 0132's
provider-endpoints-only exception still materializes as `allow` for them.
Saying so is the honest boundary; routing those runtimes through the proxy
with provider-endpoint rules is a separate follow-up.

**Enforcement point.** A forward proxy owned by the server process, one
listener per confined launch:

- **Listener.** Before a `proxied` launch the host binds a fresh listener on
  `127.0.0.1` at an OS-chosen port (macOS) or a fresh Unix socket in a `0700`
  per-launch directory under the host's data directory (Linux), and mints a
  256-bit launch token. The listener carries the launch's identity — thread,
  Project, tool call, and parent thread for a child — so every decision and
  audit record names the call that made the connection. It closes when the
  launch's process group ends. A per-launch listener rather than one shared
  port means a confined process cannot borrow another launch's identity, and a
  call-scoped rule needs no extra bookkeeping.
- **Protocol.** HTTP `CONNECT host:port` tunnels, and absolute-form plain
  `http://` requests, which the proxy forwards in origin form with
  `Proxy-Authorization` and hop-by-hop headers removed. A proxied plain
  connection carries exactly one request: the proxy forwards its head and the
  content its `Content-Length` or `chunked` framing declares, drops anything
  after it, and shuts a connection whose content does not frame. A second
  plain request on the same proxied connection would otherwise reach the
  origin undecided, under whatever `Host` it named, which a shared front end
  routes on. The rule covers absolute-form requests only: bytes inside a
  `CONNECT` tunnel are opaque, so plain HTTP a client sends through a tunnel
  (Node, for one, tunnels `http://` through `CONNECT`) can carry further
  requests with any `Host` to the tunnel's destination. That is a residual
  risk alongside fronting inside TLS and Encrypted Client Hello below. The one
  header the proxy writes is `Connection: close` in place of the client's
  own, so the client opens a new connection for its next request. Every request must carry
  `Proxy-Authorization: Basic` with user `octant` and the launch token; a
  missing or wrong token gets `407` and is recorded under one fixed entry
  (host `invalid`, port 0), never the host it named, because anyone on the
  machine can send such a request. A client that asks
  without credentials first and answers the `407` (Git's default) leaves one
  `token` refusal per connection it opens that way. A head the proxy cannot
  read one way only (a repeated `Host`, `Content-Length`, `Transfer-Encoding`,
  or `Proxy-Authorization`; both framing headers; a `Transfer-Encoding` other
  than `chunked`, or any `Transfer-Encoding` on HTTP/1.0; a folded line; a line break that is not CRLF; a
  `Connection` option naming `Host` or a framing header; a `Host` that names
  another host than the target; an origin-form or `https://` target) gets
  `400` before any decision and is not a decision record, because it names no
  destination the proxy accepted as one. A head must arrive within 10 seconds
  and 32 KiB. The proxy does not terminate TLS, inspect bodies, add
  credentials, or follow redirects; a redirect is the client's next request,
  checked like any other. When the first bytes of a `CONNECT` tunnel are a TLS
  ClientHello with a server name, that name must equal the `CONNECT` host or
  the tunnel closes (`sni-mismatch`). That stops a client naming an allowed
  host to the proxy and a different one to a shared front end; fronting by a
  Host header inside TLS, plain requests inside a tunnel (above), and
  Encrypted Client Hello remain a residual risk stated in the approval copy
  for wildcard and CDN-hosted rules.
- **Decision order per request.** Token, then destination syntax (an IP
  literal, a port outside 1–65535, or a name that is not a valid DNS name
  refuses), then the rule match, then resolution, then the private-destination
  check on every resolved address, then connect. A refusal at any step answers
  `403` with a one-line reason the command's output shows, such as
  `octant-egress-refused: no-rule registry.npmjs.org:443`.
- **DNS and rebinding.** The confined process does no resolution: proxy-aware
  clients send the name in `CONNECT`, and the OS rules below leave it no
  resolver to ask, which also closes DNS as an exfiltration channel. The proxy
  resolves the name itself with the same all-addresses lookup `web-fetch` uses,
  refuses when any answer is private, and connects to the address it checked,
  so a name cannot pass the check and then resolve somewhere else. Each
  `CONNECT` resolves afresh; the proxy keeps no cache of its own.
- **Private and loopback refusals.** The proxy refuses any destination that
  resolves to an address `isPrivateAddress` (in `nativeHarnessWebFetch.ts`)
  classifies as private, under every rule, including a wildcard rule whose
  subdomain resolves privately. This is what keeps the proxy from being a path
  to the Octant server's own API, the remote listener, a local inference
  endpoint, a LAN service, or cloud metadata. A rule cannot name an IP literal,
  `localhost`, or a single-label name. There is no private-destination
  exception in this design.
- **Forcing traffic through it on macOS.** The Seatbelt profile for `proxied`
  replaces `(allow network*)` with one rule,
  `(allow network-outbound (remote ip "localhost:<port>"))`, keeping the trust
  daemon lookups and public trust material `allow` already opens (TLS still
  runs in the client). It opens no `mDNSResponder` socket or DNS service
  lookup, no other loopback port, no inbound rule, and no UDP. Seatbelt's
  remote-address filter accepts only `*` or `localhost` as the host, which is
  why the allowlist cannot live in the profile itself.
- **Forcing traffic through it on Linux.** The bubblewrap capsule keeps
  `--unshare-all` without `--share-net`, so it has a private network
  namespace whose only interface is loopback, binds the per-launch socket
  directory read-only, and does not bind `/run/systemd/resolve`. An
  Octant-owned forwarder starts first inside the capsule, listens on
  `127.0.0.1` at a fixed port in that private namespace, relays each accepted
  connection byte-for-byte to the Unix socket, then runs the command and exits
  with it. The forwarder holds no policy; the token and every decision stay
  with the host proxy.
- **Environment.** The launch environment adds `HTTPS_PROXY`, `HTTP_PROXY`,
  and `ALL_PROXY` (and their lowercase forms) set to
  `http://octant:<token>@127.0.0.1:<port>`, empty `NO_PROXY`/`no_proxy`, and
  `NODE_USE_ENV_PROXY=1`. The environment is advisory: a client that ignores
  it reaches nothing, because the OS rules deny direct egress. SSH remotes,
  raw TCP, UDP, and HTTP/3 fail under `proxied`; HTTPS Git remotes, npm, pip,
  cargo, Go, and curl honour the variables. The token is visible to the
  command itself and may appear in its output; it is worthless once the launch
  ends and is never journaled or logged by the host.

**Rule model.**

- **Shape.** A rule names one destination host — an exact name or
  `*.suffix`, which matches subdomains but not the suffix itself and needs at
  least two labels after the wildcard — and one port (default 443). Names are
  compared in lowercase IDNA ASCII form without a trailing dot. A rule has an
  id, a scope, an absolute `expiresAt`, the principal who granted it, and the
  approval it came from. At most 64 live rules per thread and per Project.
- **Scope.** `call` (one launch; ends with it), `thread`, or `project` (every
  `proxied` launch of every thread in that Code Project). A child with network
  authority uses its parent's live rules and holds none of its own, so it is
  never wider than its parent, and a parent's revocation or expiry reaches it
  at once; a child without network authority stays `none`. Taint reaches it
  the same way: a child's launch is checked against its parent's taint as well
  as its own, and when either thread is tainted the standing rules are
  suspended for that launch, so the single-use confirmation described under
  Taint below is asked on the parent's thread, where the child's proposals
  already surface. Rules are local to
  the host that granted them: they are never exported, synced, or replicated,
  and a paired device sees them only as the host reports them.
- **Expiry.** Every rule expires; there is no permanent rule. Thread rules
  offer `call`, 1 hour, 8 hours (the default), and 7 days; Project rules
  offer 7 days (the default) and 30 days. The proxy compares `now` against
  `expiresAt` on every new request and on every chunk relayed through an open
  tunnel, so a rule is dead at `expiresAt` whatever a timer or a sleeping
  machine did, and its tunnels close then. Revocation closes them at once.
  Expiry is derived from the stored timestamp rather than journaled as its own
  event, so replay reaches the same answer with no clock-dependent record.
  The host keeps an expired rule in memory for 24 hours after it first sees
  the rule expired, during which a request it would have matched is refused
  `expired`; after that a sweep (at most one a minute, run when rules are
  read) drops it, and the same request is refused `no-rule`. Learn mode
  proposes both alike, and neither changes when the rule stopped allowing
  anything. The 24 hours and the minute run on the host's suspend-aware
  uptime, not the wall clock: a clock set forward cannot drop a rule that is
  live again once the clock is corrected, and a clock set back does not stop
  the sweeps.
- **Who grants.** Rules arise only from answering a `network-access` approval
  — a learn-mode proposal or a person adding a rule in the thread's rules
  list — never from a model tool call, a tool result, a reviewer, or
  configuration a repository ships. Thread and call rules may be granted by
  anyone who may already answer that thread's approvals, a paired device
  included under its existing clamps. Project rules need the person at a local
  window whose workspace holds the Project, like remembered Full access. The
  planned reviewer (0110) may answer a per-call `network-access` prompt on a
  thread that is not tainted. Its answer produces `call` rules for that one
  launch and nothing wider, journaled as `thread.egress-rule-granted@1` with
  the reviewer as the granting principal; it cannot grant a thread or Project
  rule. A tainted thread's single-use confirmation needs a person, so the
  reviewer cannot answer it.
- **Taint.** Taint suspends standing rules, matching the rule that a
  remembered "always" approval stops covering its class once a thread is
  tainted. On a tainted thread every `bash` call already needs a single-use
  confirmation; that prompt lists the hosts the thread's thread and Project
  rules name, preselected, and the person confirms the set this call may
  reach. What is confirmed becomes `call` rules for that launch only. Thread
  and Project rules are neither applied nor grantable from a tainted thread,
  so an injected command cannot inherit a host allowed before the injection,
  and an allowed host that accepts anonymous or attacker-supplied writes
  cannot carry data out without a person seeing that host for that command.
- **Output taints.** Bytes a command receives from an outside host are
  untrusted content, so every `proxied` launch that received any, a `bash`
  call or a repository test run alike, taints the thread, consistent with the
  rule that a harness result bringing in
  outside content taints. The proxy counts bytes received per launch, from
  every allowed destination, including entries beyond the summary's 64-entry
  cap, and the launch summary carries that total. The server appends the
  thread's taint event from the total, before the tool result returns to the
  model and in the same step as the summary; when the taint cannot be
  recorded the call reports `unavailable`, so the model never reads output
  the journal has not marked. The two events are on different aggregates and
  a server can exit between them, so the summary is the durable fact: at
  startup, any summarized launch whose total is above zero and whose thread
  carries no taint event taints that thread before a turn is admitted. A
  refused request, and a launch that received
  nothing, do not taint. The taint is the thread-lifetime one and never
  clears, so a package install or a clone taints the thread and later `bash`
  calls need the single-use confirmation above; that is the accepted cost of
  letting a command read from the network.

**Learn mode.** A per-thread setting, on by default for `proxied` threads.
With it on, a request the proxy refuses for `no-rule` or `expired` records a
proposal — host, port, the launch that asked, and a count — and still
refuses: the connection fails, the command sees the refusal, and nothing waits
on the person. When the call ends, the thread's open proposals surface as one
`network-access` request listing each host with a scope and expiry choice;
granting creates the rules and the model may retry. Proposals are a separate
record the proxy's decision function never reads, so no number of attempts,
and no proposal left unanswered, grants anything. Refusals for a private
destination, an IP literal, a token, or an SNI mismatch are not proposable.
Proposals are bounded at 16 distinct hosts per launch and 64 open per thread;
beyond that refusals are counted, not proposed. A proposal from a tainted
thread is marked and can only be granted as a `call` rule on the next
confirmed call. A child's proposals surface on its parent's thread with the
child named, and granting them grants the parent. With learn mode off, the
refusal reaches the command's output and nothing is proposed. The setting is
`thread.egress-learn-mode-set@1` on the thread's `thread-egress` aggregate, and
a person who may answer the thread's approvals switches it. A launch's
proposals are raised in one append when it ends; a host and port already open
on the thread is not proposed again, and a rule granted for a proposal's host
and port, or a decline, closes it. A proposal that cannot be recorded is a
suggestion lost, never a grant.

**Audit journal.** On the thread's own `thread-egress` aggregate unless noted,
not on the thread aggregate; payloads carry host,
port, scope, `expiresAt`, rule and launch identity, the server-resolved
principal, and the thread's taint at the time, never a token, URL path, header,
or body:

- `thread.egress-rule-granted@1`, `thread.egress-rule-revoked@1`, and on the
  Project's `project-egress` aggregate `project.egress-rule-granted@1` and
  `project.egress-rule-revoked@1`. A grant is journal-first: a rule whose event
  cannot be appended is not in force.
- `thread.egress-proposal-raised@1` and `thread.egress-proposal-declined@1`.
- `thread.egress-launch-started@1` before a `proxied` launch's listener
  accepts a connection: launch identity and time. When it cannot be appended
  the launch refuses before the command runs.
- `thread.egress-decisions-recorded@1` while the launch runs: each distinct
  host and port first decided, or whose counts changed, with its decision,
  reason, request count, and bytes each way. The proxy flushes a batch once 16
  entries are first decided, and every changed entry every 5 seconds, so a
  crash loses at most that tail of decisions and counts, never more. A launch
  names at most 24 allowed and 28 refused destinations; past those a decision
  still counts, under one overflow entry (host `overflow.invalid`, port 0) for
  allowed and one per refusal reason, so its records hold at most 64 entries,
  its summary is never truncated, and it writes at most four batches beyond
  one per 5 seconds however many requests it makes. When a batch cannot be
  appended, or its append has not answered within 10 seconds, the proxy
  refuses new requests for that launch (`audit-unavailable`) and keeps
  existing tunnels until they end. A launch start or summary append that has
  not answered within 10 seconds counts as not appended.
- `thread.egress-launch-summarized@1` when the launch ends: the final totals,
  including the bytes received that taint the thread, a count of request heads
  refused as unreadable or too large (they name no destination, so they appear
  nowhere else), and each distinct host and port, at most 64 entries with a `truncated` flag. It is appended before
  the tool result returns to the model; when it cannot be, the call reports
  `unavailable`, so the model never acts on egress the journal does not hold.
- `thread.egress-launch-incomplete@1`, appended at startup for every launch
  that has a start event and no summary, because the server exited first.
  Its record holds what the batches captured and says the tail is unknown.
  Because the bytes received are then unknown too, recovery taints the thread.
  The recorded batches cannot show that a launch ended, so recovery taints for
  every incomplete launch rather than guessing from them. Recovery also taints
  the thread for a launch that was summarized with bytes received but whose
  taint event is missing. A launch's taint is recorded under its own content
  reference (`tool-egress-launch:<launch id>`), and recovery reads the journal
  for that event, not the taint projection, so a mark a person cleared
  afterwards stays cleared. Until a launch's mark is written, the host treats
  its thread as tainted for every egress decision and grant.
- `thread.egress-learn-mode-set@1`: learn mode on or off, and the person who
  switched it.

**Rules phase 3 settled.** The design left these open; each keeps authority
where it was or narrows it:

- _Where a `call` rule comes from._ A `call` rule names a launch id, so it can
  be granted only for a launch that has one: the reviewer's per-call answer
  and the tainted thread's single-use confirmation, both of which phase 4
  wires to the `bash` prompt. The proposal card and the rules list offer the
  thread lifetimes (1 hour, 8 hours, 7 days) and the Project lifetimes. A
  `call` rule leaves the lists and stops counting toward the 64-rule limit when
  its launch is summarized or marked incomplete; its expiry, at most 8 hours
  after it is granted, bounds a launch that never ends.
- _Which proposals count as tainted._ A proposal is marked tainted when the
  thread it surfaces on or the launch's own thread is tainted, so a child that
  took in outside bytes on a clean parent proposes as tainted; the launch's
  taint is recorded before its proposals are raised. A launch whose summary
  cannot be recorded has an unknown byte count, so it taints its thread as
  recovery would, and its proposals are tainted too. When a tainted launch asks
  for a host that already has an open clean proposal, a tainted proposal
  replaces it. The host remembers every host and port a tainted launch asked
  for, per thread and per Project, after the proposal is declined or answered
  with a `call` rule, and refuses a thread rule (exact or a wildcard covering
  it) on that thread and a Project rule anywhere in that Project, whatever the
  answering surface sends.
- _One answer, two aggregates._ An answer that grants thread and Project rules
  appends to `thread-egress` and `project-egress` in one journal transaction,
  so it lands all or nothing; when it cannot, the answer reports
  `unavailable` and nothing it asked for is in force.
- _Unreadable revocations._ A revocation that no longer decodes still revokes:
  replay drops its rule when the rule id can be read, and otherwise stops
  applying every rule on that aggregate and refuses new grants there.
- _Who reaches the surface._ The rules lists and answers are served at
  `/api/native-harness/egress/threads/<thread id>` with the same thread check
  as the harness session's approvals. Like those approvals the route is not in
  the paired-device catalogue today, so a paired device reaches it only once it
  may answer the thread's approvals; the server takes the principal from the
  authenticated request and refuses a Project rule from a paired device either
  way.
- _Purge._ A thread purge erases the thread's `thread-egress` aggregate. Project
  rules are the Project's: a thread purge leaves `project-egress` in place,
  including the id of the thread a rule was granted from, and a Project erase
  removes it and drops the host's live copy of those rules at once. A child's
  proposals live on its parent's aggregate, so purging the child leaves its
  opaque thread id, tool call id, and the hosts it asked for in the parent's
  proposal records until the parent is purged.
- _What phase 4 inherits._ A launch's taint lands when `finish()` runs, not
  when its first bytes arrive, so another launch of the same thread running at
  the same time is not suspended mid-run by it. A rule granted while a launch
  runs reaches that launch at its next request, even if that launch has
  already fetched outside content its thread is not yet marked for.
- _What a restart reads._ Startup rebuilds the store in journal order from
  the rule, proposal, learn-mode, launch start, summary, and incomplete
  records, and from the launch marks (`tool-egress-launch:` references) among
  the threads' outside-content records. It reads decision batches only for
  launches still open, the ones recovery summarizes, and takes each
  `thread-egress` aggregate's version from the journal. The rows it leaves
  out cannot change a rule, a taint, a clamp, or what recovery writes, so the
  journal skips them in SQL and never decodes them. A test compares this with
  a replay of every row on seeded journals, unreadable revocations included.
  Measured on a journal of 2,000 settled launches (37,162 rows, about 24,000 of
  them decision batches), startup went from 2.7 s to 0.25 s.
- _Where the lists show._ A Code thread's Agents tab shows Network access once
  its commands run through these rules, or once the thread holds a rule or a
  proposal. When its commands do not run through them under its current
  access (Full access, Plan), the card says so, so nobody mistakes a rule for
  a restriction that runs.

**Phase 4 settled.** Each keeps authority where it was or narrows it:

- _The switch._ The harness composition chooses a command's network when the
  command runs, from the posture the thread holds then: approval-gated and
  auto-accept-edits run on `proxied`, Full access on `allow`, and Plan or a
  posture that cannot be read on `none`. A child with network authority is
  clamped to its parent's posture at that moment and runs under its parent's
  rules; a child without it stays `none`. The server composes the proxied
  shell on macOS and Linux; a host composed without it (the switch off) keeps
  every networked command on `allow`, as before the rules existed, and the
  rules card says commands do not go through them. `proxied` never falls back
  to `allow`: a launch whose listener cannot bind or whose start cannot be
  journaled never runs its command, and a command whose summary or taint
  cannot be recorded returns `unavailable` without its output.
- _Which commands._ `bash` and `goal-check`, the two harness tools that run a
  command. Each run is one launch named by its authorized call. The Code
  terminal, Git, and provider runtimes are unchanged.
- _Proxy variables._ The launch adds the proxy variables after the
  environment check, which refuses lowercase names from any caller, so only
  these values fill them. An offline port refuses a proxied launch outright,
  so the `none` shell can never gain a route out.
- _The Linux forwarder._ The host's own JavaScript runtime runs it (as Node
  under Electron) from the launch's `0700` socket directory, bound read-only
  together with the runtime's directory, so no command can rewrite it. It
  listens on `127.0.0.1:3128` in the private namespace and exits 125 without
  running the command when it cannot listen. A proxied capsule refuses a
  process-deny filter, because the forwarder starts the command.
- _What is unverified._ The Linux native probes have not run: no CI job has
  `bwrap`, and the hostile suite's native cases run only on macOS or on a
  Linux host with `/usr/bin/bwrap`. The forwarder's relay and exit behaviour
  run on every host as plain Node. The bubblewrap arguments are checked as
  strings.
- _The tainted thread's command confirmation._ When a lead's `bash` or
  `goal-check` on a tainted Code thread will run on `proxied`, its single-use
  approval lists the hosts the thread's live thread and Project rules name,
  preselected, then the thread's open proposals, unticked, at most 192 entries
  and none of them a `call` rule; an aggregate whose revocations cannot be read
  offers neither its rules nor, for the thread's, its proposals, as nothing can
  be granted there. The person answers with the listed hosts
  they keep; the host canonicalizes each like a rule host and refuses the
  whole answer (`host-not-offered`) when one was not listed, or when hosts
  come with "always" or a denial. Approving with no hosts, as a surface that
  shows none does, lets the command reach none. The answering principal comes
  from the authenticated request. The confirmed hosts are held under the
  call's own id until its command starts; the launch's start is journaled
  first, then they are granted as `call` rules naming that launch and the
  approval, before the command runs. A grant that cannot be appended, or would
  pass the 64-rule limit, ends the launch and the command reports
  `unavailable`. The rules retire when the launch is summarized, so the next
  command lists the same hosts afresh and reaches nothing it was not given. A
  confirmation whose command never runs on `proxied` (the posture changed
  meanwhile, or a check stopped first) is dropped and grants nothing.
- _A child's command confirmation._ A networked Code child's `bash` or
  `goal-check` that will run on `proxied`, clamped to its parent's posture,
  while the parent or the child is tainted asks on the parent's thread the
  same way: single-use, naming the child, and listing the parent's hosts
  (the parent's thread and Project rules and the parent's open proposals). The
  child adds nothing to that list and holds no rules of its own. What the
  person ticks is granted as `call` rules on the parent's aggregate naming the
  child's launch, so the parent's next command and the child's next command
  reach none of it. A child whose authority lapses while the person answers
  gets `cancelled`, and its confirmation grants nothing.
- _The terminal._ `octant agent` shows the list with the host's preselection
  ticked. Line mode takes `y` (the ticked hosts), `y 1,3` (exactly those), or
  `y none`, and a number the list lacks refuses the call; the full-screen panel
  toggles a host by its number and sends the ticked ones on `y`. The panel
  cannot scroll, so it shows eight hosts a page (`>` and `<` turn it) with the
  ticked count and the numbers of ticked hosts on other pages, and its answer
  line stays on screen. Both send
  hosts only with an approval of a command that listed them.
- _What is not wired._ A child admitted with Full access whose parent has
  since narrowed to a posture that clamps it to `proxied` runs its commands
  unasked, so on a tainted parent they reach no host. A tainted proposal shows on the card and cannot
  be granted there; the command confirmation is where it is granted. The
  reviewer that may answer a per-call `network-access` prompt is not built.
  Each fails closed.

**Failure modes.** Each fails closed:

| Failure                                                        | Result                                                                     |
| -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Listener cannot bind, or the forwarder cannot start            | The launch refuses before the command runs; it never falls back to `allow` |
| Rule projection unreadable                                     | Empty rule set; every request refuses                                      |
| Resolution fails or times out                                  | That request refuses (`resolve-failed`)                                    |
| Rule expires or is revoked during a tunnel                     | The tunnel closes                                                          |
| Server exits or restarts                                       | Confined process groups die with it; listeners do not outlive the host     |
| Client ignores the proxy variables                             | Its direct connection is denied by the OS rules                            |
| Concurrency limit reached (128 tunnels, 16 pending per launch) | Further requests refuse (`limit`)                                          |
| Grant or launch summary cannot be journaled                    | The rule is not in force; the call reports `unavailable`                   |
| Launch start cannot be journaled                               | The launch refuses before the command runs                                 |
| Decision batch cannot be journaled                             | New requests refuse (`audit-unavailable`); open tunnels run to their end   |
| Server exits mid-launch                                        | Recovery marks the launch incomplete and taints the thread                 |
| Server exits after the summary and before the taint event      | Recovery taints the thread from the summary's bytes received               |

**Inference stays separate.** Harness inference leaves from the server
process to the configured base URL with the credential, as today; it never
passes through the proxy, and the proxy has no access to the credential
broker. The inference host is not implicitly allowed for tools: a rule naming
it lets a command make anonymous requests there and nothing more, and a local
inference endpoint is private, so the proxy refuses it under any rule.

**Linux parity.** Linux enforces the same rules through the private network
namespace and the forwarder described above, with the same proxy, decisions,
and journal. The difference is mechanical: a Unix socket replaces the loopback
port at the host side. A Linux host that cannot start the capsule or the
forwarder refuses the launch, as a missing `bwrap` already does.

**Performance.** Per launch: one listener bind and one token, well under a
millisecond beside the existing confinement start. Per request: one
resolution (served by the system resolver's cache), a linear match over at
most 128 rules, and a first-chunk peek for the server name. The data path is
a socket pipe with no inspection, so throughput is bound by loopback. The
phase 2 benchmark sets the budget: a clone and a package install against a
local fixture origin within 10% of the direct path. It runs on demand as
`bun run egress-proxy:benchmark` in `apps/server`, not in the default suite,
because a wall-clock budget is not a stable CI check.

**Delivery phases.** Each phase lands as its own PR with the hostile cases
for what it adds in `nativeHarnessEgress.hostile.test.ts`, extending the
proofs that suite already holds:

1. **Rule model and decision (domain, contracts).** A pure
   `decideToolEgress` in `packages/domain` and the event schemas. Accepted
   when truth-table tests show: a rule allows only its own thread or
   Project; a wildcard matches subdomains and not the apex; an IP literal and
   a single-label name refuse; `now >= expiresAt` refuses; taint suspends
   thread and Project rules and leaves `call` rules; a child sees exactly its
   parent's live rules; the decision takes no proposal input.
2. **Host proxy.** The listener, token, `CONNECT` and plain-HTTP paths,
   resolution with pinning, private refusal, server-name check, limits, and
   batched decision records, launch summary, and bytes-received count, tested against fixture origins through an injected
   resolver. Accepted when integration tests show: an allowed host connects;
   an unruled host, a rule for another thread, an expired rule, a missing or
   forged token, a private answer, a name that is public then private, an IP
   literal, the Octant server's port, and a mismatched server name all refuse
   with their reason and a summary entry; a tunnel closes when its rule
   expires or is revoked; and the benchmark budget holds.
3. **Grants, expiry, learn mode.** The `network-access` grant flow,
   learn-mode proposals, the thread and Project rules lists with revoke, and
   the journal events, run against phase 2 launches with fixture origins so
   commands are not yet on the proxy. Accepted when server integration tests
   show: learn mode refuses and proposes but never connects, however often it
   is asked; an unanswered or declined proposal grants nothing; a paired
   device cannot grant a Project rule; a tainted thread can grant only `call`
   rules and its standing rules stop applying; a grant that cannot be
   journaled is not in force; output received through the proxy taints the
   thread before the result returns, for a test run as for `bash`; a child of
   a tainted parent cannot use the parent's standing rules; a reviewer's
   answer yields only `call` rules and cannot answer a tainted thread; a crash
   mid-launch loses at most one decision batch and recovery marks the launch
   incomplete; a crash between the summary and the taint event still leaves
   the thread tainted after restart; and rendered QA
   covers the proposal card and the rules lists.
4. **Confinement wiring and the switch.** The `proxied` OS level in the
   Seatbelt builder and the bubblewrap capsule with its forwarder, and the
   harness ports that launch with it. This phase is what changes Code harness
   commands on approval-gated and auto-accept-edits threads from open network
   to ruled network, and it lands only
   after phases 2 and 3 are in, so no release has those commands on `proxied`
   without a way to grant a host; until it lands they stay on `allow`, and
   the user guide changes with it. Accepted when native probes under real
   Seatbelt on macOS and real `bwrap` on Linux, run for an approval-gated
   thread and for an auto-accept-edits thread, show: a direct connection to a
   public fixture fails; a name lookup fails; another loopback listener is
   unreachable; the proxy is reachable and an allowed host works; a client
   that ignores the proxy variables fails; and a launch whose listener cannot
   bind never runs. It also shows end to end that a refused install proposes a
   host, the person grants it, and the retry succeeds.
5. **Escape-suite gate.** An `egress-rule-bypass` fixture row in the threat
   model's escape suite drives phases 1–4 end to end, and the layer-3 native
   probes join the pre-release check.

## Extensions and skills

`@octant/plugin-host` is the pure model: normalized component kinds
(`skill-instructions`, `mcp-server`, `mcp-tool`, `mcp-prompt`, `mcp-resource`,
`hook`, `app`, `agent`, `apple-development-adapter`, `board`, `integration`,
`ui-surface`, `appearance-pack`, `preview-viewer`, `provider-driver`), composer addressing
(`@plugin`, `@plugin/component`, `$skill`), and the activation ladder. The
manifest and component schemas themselves (`ExtensionPackageManifest`,
component kinds, declared capabilities, and renderer contribution points)
live in `@octant/contracts/extensions`; `@octant/plugin-api` re-exports the
subset a plugin author needs as a narrower, named surface. Unknown
contribution points are rejected. The renderer contribution registry resolves
`sidebar.destination`, `settings.section`, `workspace.tab`, `thread.pane`,
`preview.viewer`, `appearance.preset`, and `board.view` from the effective
first-party catalog; it never decides availability. `apps/server/src/extensions`
owns the runtime: package store, inspector, marketplaces (skills.sh, npm,
curated catalog, npm Agent Plugins), Agent Plugins ingestion, supervisor, MCP
session manager, and skill discovery.

**Activation ladder.** `resolveExtensionActivation` resolves each component to
an effective state with a structured reason. A component is active only when
the package is installed, its source is trusted, the plugin master switch and
the component switch are enabled, compatibility passes, and host, mode,
Project, thread, and provider policy allow it. Any other state — `not-installed`,
`untrusted`, `quarantined`, `plugin-disabled`, `component-disabled`,
`incompatible`, `mode-prohibited`, `project-prohibited`, `thread-prohibited`,
`host-prohibited`, `stale-catalog-epoch`, `broken`, `draining` — contributes no
prompt, schema, tool, route, model, or capability.

- Executable components are quarantined until explicitly reviewed and then run
  in supervised, sandboxed processes with a ready handshake, bounded output,
  durable process receipts, and drain-then-stop on disable.
  On macOS the deny-default Seatbelt profile reads the system roots, the
  component's own roots, and its runtime's install: the executable's folder
  and, for a Homebrew runtime, `<prefix>/Cellar`, `<prefix>/opt`, and
  `<prefix>/etc/openssl@3`, never the rest of the prefix. It also grants
  `/` and metadata of every parent folder of those roots, because a runtime
  such as node will not start without them. Metadata names a folder; it does
  not read its contents.
- Skills are discovered only from valid `.agents/skills/` and `.claude/skills/`
  packages between the working directory and the Project or repository root
  (the closed `PROJECT_SKILL_ROOTS` allow-list), plus the user-global
  `~/.agents/skills/`. The home folder's own `.claude` is never read, even when
  the host's Project-less fallback root is the home folder. A symlinked skills
  folder, or one that resolves outside the bound root, is ignored. Every root
  enters the same activation ladder (indexed disabled, then reviewed, then
  enabled; a discovered skill is never trusted or active because of where it
  was found) with its own `sourceRef`, so same-named skills across roots are
  two skills and neither wins silently.
  Only one same-named skill is on where a thread can see it. Turning one on
  turns off every same-named skill that shares a thread with it: built-in and
  user-global skills, the same Project's root skills, and a thread's own. It
  never changes another Project's skill, and another Project's skill is never
  shown as given way. Every reconcile of the skill service (start-up, a
  thread's working-directory change, each resolution of a turn's selected
  extensions, Settings' reconcile) turns off both of any two same-named skills
  that are on and share a thread, and lists the collision for the person to
  choose. That normalises an activation file written before this rule. It also
  fires when a skill whose stored "on" was briefly not discovered (an archived
  worktree, a branch switch, a missing root) comes back after another
  same-named skill was turned on: both stay off, a user-global or built-in one
  for every Project, until the person chooses again. The rule fails safe;
  between reconciles the catalog shows neither as effective. A collision is
  listed only where one thread would see several sources without exactly one
  in use. Installed marketplace skills are switched with their package, not
  here.
  A runtime that loads Project skill folders by itself is denied each such
  folder in the OS profile (`forbiddenRootEntries`, read and write, in every
  posture including Full access) unless a switch of its own is proven to turn
  that loading off. Grok Build is handled by its own folder trust instead
  (see the table below). Codex is the exception: it has no Octant OS profile and no
  switch, so before every `thread/start` and `thread/resume`, in every mode,
  the driver lists Codex's skills at the Project root (`skills/list` with
  `forceReload`) and sends a `skills.config` rule with the thread that
  disables each Project skill by its `SKILL.md` path, and each package Codex
  reported it could not load, which carries a path but no scope. A path, not a
  name, because a name rule would also disable a user skill of that name.
  Every scope other than `user`, `system`, and `admin` counts as the
  Project's, so a scope a later release adds is disabled too. A thread whose
  skills cannot be listed does not start. Older releases were read at their
  source tags. Codex loads Project skills by itself from 0.66.0
  (`.codex/skills` at the repository root, on by default from 0.79.0;
  `.agents/skills` from 0.94.0), and reads `skills.config` rules from a
  thread's `config` only from 0.108.0. Before that they came from the user's
  own config file alone. So a release from 0.66.0 up to 0.108.0 refuses every
  thread and asks for an update. A release older than 0.66.0 loads no Project
  skill: when it answers `skills/list` with method-not-found, the thread runs
  without rules. The rules hold for the thread as started or resumed: Codex
  still lists those skills, as disabled, and a skill created in the Project
  during a thread is enabled from the next turn until the thread is resumed.
  Codex also loads the user's own `~/.agents/skills` and `$CODEX_HOME/skills`
  (`scope: user`) by itself; those are not handled. Measured against codex-cli
  0.162.1, nothing stops the discovery itself: the app-server ignores
  `features.skip_host_skill_discovery`, `project_root_markers = []` still
  scans the Project root, and a `skills.config` rule matches one skill's exact
  name or `SKILL.md` path, never a folder. Only the skill folder is
  denied; the folder around it (`.claude`, `.github`, `.grok`, and so on)
  stays readable, because it holds the runtime's own settings or the
  Project's other content. fx and Kimi Code deny all of `.agents`. Because the
  deny covers writing as well as reading, a Code agent's own `git` commands on
  these runtimes warn about tracked files in a denied folder, and a
  `git checkout`, rebase, or pull across commits that touch such a folder
  fails with a misleading "local changes would be overwritten" error. No data
  is lost, and Octant's own server-side Git is unaffected. That is the
  accepted cost of keeping unreviewed skills out of the runtime; fx and Kimi
  Code have had it for `.agents` all along. The deny covers the Project root
  only. Copilot and Devin also walk upward from the
  session folder (the Project root) to the repository root, Copilot to the
  home folder when there is none, so when a Project is a subfolder of a
  repository a skill folder above the Project root is not covered. No switch
  closes that: Copilot's `enableConfigDiscovery` is a session option its ACP
  server never sets and no flag or variable reaches, and Devin has none.
  Grok walks upward too, but its folder trust covers every level. Below Full access the profile hides such a folder only when
  it lies inside the home folder. On Linux a deny path the Project does not
  have is skipped in every posture, because Bubblewrap would create it as a
  mount point (an empty folder, or a failed start on a read-only root); a
  denied folder that appears mid-session is therefore not masked until the
  runtime restarts, while macOS Seatbelt `subpath` denies cover a missing
  path.

  | Runtime                       | Project skill folders it loads by itself                                                                                                                                            | How                                                                                                                                                                                                                                                          |
  | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | GitHub Copilot (ACP)          | `.agents/skills`, `.claude/skills`, `.github/skills`: the ACP session never sets `enableConfigDiscovery`, which defaults on (`copilot skill list`, CLI 1.0.90)                      | Denied (`forbiddenRootEntries`); no flag or variable turns discovery off in ACP                                                                                                                                                                              |
  | Grok Build (ACP)              | In a trusted folder: `.agents/skills`, `.agents/commands`, `.claude/skills`, `.claude/commands`, `.cursor/skills`, `.grok/skills`, `.grok/commands` (`grok inspect --json`, 1.0.50) | Its trust list is hidden, so no folder is trusted and none loads (`grok inspect --json` lists none). `GROK_CLAUDE_SKILLS_ENABLED=false` and `GROK_CURSOR_SKILLS_ENABLED=false` are not relied on: inspect still listed those folders' packages with them set |
  | Devin (ACP)                   | `.agents/skills`, `.cognition/skills`, `.devin/skills`, and `.github/skills` unless switched off (`devin skills list`, 3000.10.27 and 3000.11.3)                                    | `read_config_from` sets every source false, `copilot` included, which removes `.github/skills`; the other three are denied, since no source turns them off                                                                                                   |
  | fx (ACP)                      | Merges workspace skill roots by itself                                                                                                                                              | Denied: `.agents` and `.claude/skills`, with `AGENTS.md`, `.mcp.json`, `.fx.json`                                                                                                                                                                            |
  | Goose (ACP)                   | `.agents/skills`, `.claude/skills`, `.goose/skills`, per its documentation (not installed here)                                                                                     | Denied; no documented switch                                                                                                                                                                                                                                 |
  | Cline (ACP)                   | `.agents/skills`, `.claude/skills`, `.cline/skills`, `.clinerules/skills`, per its documentation and source (not installed here)                                                    | Denied; only a per-skill toggle is documented                                                                                                                                                                                                                |
  | Gemini CLI (ACP)              | `.agents/skills`, `.gemini/skills` once the folder is trusted, per its documentation and source (not installed here)                                                                | Denied; no documented variable or flag                                                                                                                                                                                                                       |
  | Qwen Code (ACP)               | `.agents/skills`, `.qwen/skills`, per its source (not installed here)                                                                                                               | Denied; only bare mode skips them                                                                                                                                                                                                                            |
  | GLM Agent (ACP)               | `.claude/skills`, advertised as commands and put into the message when `/name` is typed, per its README (not installed here)                                                        | Denied                                                                                                                                                                                                                                                       |
  | Kimi Code (ACP)               | `.agents/skills`, `.kimi-code/skills` (0.38 bundle)                                                                                                                                 | Denied: `.agents` and `.kimi-code`                                                                                                                                                                                                                           |
  | Claude (Agent SDK)            | None: switched off                                                                                                                                                                  | `settingSources: []`, `skills: []`                                                                                                                                                                                                                           |
  | OpenCode (server and ACP)     | None: switched off                                                                                                                                                                  | `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1`, `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`, project config off, `skill` permission denied                                                                                                                                 |
  | Kilo (ACP)                    | None: switched off                                                                                                                                                                  | `KILO_DISABLE_EXTERNAL_SKILLS=1`, `KILO_DISABLE_PROJECT_CONFIG=1`, `KILO_PURE=1`                                                                                                                                                                             |
  | Mistral Vibe (ACP)            | None: switched off                                                                                                                                                                  | `VIBE_SKILL_PATHS="[]"`, `VIBE_DISABLED_SKILLS='["*"]'`, `VIBE_INCLUDE_PROJECT_CONTEXT="false"`                                                                                                                                                              |
  | Pi, Oh My Pi                  | None: switched off                                                                                                                                                                  | `--no-skills`                                                                                                                                                                                                                                                |
  | Codex                         | `.agents/skills`, in the Project and up to the repository root (app-server `skills/list`, 0.162.1); not `.claude/skills`                                                            | Disabled by path at each thread start and resume; refused if unlisted. Still listed, as disabled; one made mid-thread stays on until resume                                                                                                                  |
  | Direct HTTP and image drivers | None: no runtime of their own                                                                                                                                                       | n/a                                                                                                                                                                                                                                                          |

  The same rule covers the code a runtime starts from a Project by itself:
  MCP servers from a Project config file, hook scripts, plugins, language
  servers, and agent files that can declare MCP servers. None of it passes
  Octant's review, trust, and enable steps, so each runtime either runs with
  a switch of its own that is proven to turn the loading off, or is denied
  the specific file or folder in the OS profile, as for skills. A runtime's
  own switch is preferred, because a deny also blocks writes and the agent's
  `git` across commits that touch the entry. Session MCP servers Octant
  passes in `session/new` are unaffected: Copilot, Devin, Kimi Code, Mistral
  Vibe, and OpenCode still reached them with their Project entries off. Instruction and rule files
  (`AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`,
  `.clinerules`, `.goosehints`, and the like) stay readable: they are text
  the runtime adds to its own context, not code, and they get no authority
  from Octant. Two runtimes do not read them: fx, whose root `AGENTS.md` deny
  predates this rule, and Grok Build, which loads no Project instructions in
  the untrusted folder Octant gives it.

  | Runtime            | Project code it loads by itself                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
  | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | GitHub Copilot     | In a folder trusted in the person's Copilot profile: the MCP servers in `.mcp.json` (else `.github/mcp.json`), started at `session/new` (1.0.90); hooks in `.github/hooks` and the repository settings files, which can also enable plugins; `.github/extensions`; `mcp-servers` in `.github/agents` files. Language servers from `.github/lsp.json`, listed even untrusted. The repository settings also come from `.claude/settings.json` and `.claude/settings.local.json`: a marketplace declared in either was listed (`copilot plugin marketplace list`)                               | Denied: those ten entries. No flag or variable turns them off in ACP                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
  | Grok Build         | In a folder trusted in Grok's own list, at the root and up to the repository root: hooks (`.grok/hooks`, `.claude/settings.json`), repo-local MCP and LSP servers, plugins in `.grok/plugins` and `.claude/plugins`, skills, commands, instructions (1.0.50)                                                                                                                                                                                                                                                                                                                                 | `trusted_folders.toml` in the reused `GROK_HOME` is denied (`hostDeniedEntries`), so every folder is untrusted: `grok inspect --json` lists no hooks, skills, or instructions and shows the plugins disabled; `grok mcp doctor` does not start the repo-local servers. `GROK_FOLDER_TRUST=1` is a guard, because `[folder_trust] enabled = false` in the person's `config.toml` or `GROK_FOLDER_TRUST=0` turns the gate off and the probe folder counted as trusted again. `agent --no-leader stdio`, because `[cli] use_leader` hands the session to a shared leader process outside the sandbox. The person's interactive trust is untouched. No Project entry is denied                                                                                                                                                                                                                                                                                                                                                                       |
  | Devin              | The MCP servers in `.devin/config.json`, `.devin/mcp_config.json`, `.devin/mcp_config.local.json` and the hooks in `.devin/config.json` and `.devin/hooks.json`, with Octant's managed config and `--respect-workspace-trust` (`devin acp`, 3000.11.3)                                                                                                                                                                                                                                                                                                                                       | Denied: those files, plus `.devin/config.local.json` and `.devin/hooks.v1.json`. The managed config's empty `mcpServers` and `hooks` do not override them. `.devin/plans` stays writable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
  | Kimi Code          | In a workspace trusted in Kimi: the MCP servers in `.mcp.json` at the repository root, started at `session/new` (0.38.0); `.kimi-code/mcp.json`                                                                                                                                                                                                                                                                                                                                                                                                                                              | Denied: `.mcp.json` (new) and all of `.kimi-code`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
  | Mistral Vibe       | In a folder trusted in the person's Vibe profile: MCP servers in `.vibe/config.toml` and Python tools in `.vibe/tools`, both loaded despite `VIBE_MCP_SERVERS` and `VIBE_TOOL_PATHS` (2.26.0); `.vibe/hooks.toml`, `.vibe/plugins`, `.vibe/agents`                                                                                                                                                                                                                                                                                                                                           | Denied: those five entries. Hiding Vibe's trust list instead stops it starting: it rewrites a list it cannot read and exits when that fails                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
  | OpenCode (ACP)     | `mcp` servers in `opencode.json` and plugin modules in `.opencode/plugin`, despite `OPENCODE_PURE` (2.0.27)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Switched off: `OPENCODE_DISABLE_PROJECT_CONFIG=1`, after which neither loaded (the server driver already set it)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
  | Cline              | JS and TS plugin modules in `.cline/plugins`, hook scripts in `.cline/hooks` and `.clinerules/hooks`, with no trust step (source on `main`, 3.0.71; not installed here)                                                                                                                                                                                                                                                                                                                                                                                                                      | Denied: those three folders. No switch reaches an ACP launch; the source skips an unreadable folder. `CLINE_SESSION_BACKEND_MODE=local` keeps the session in the confined process rather than a running Cline hub daemon, which would sit outside these denies                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
  | Goose              | Plugins in `.agents/plugins`, enabled when found, with the hooks and `.mcp.json` servers they carry (source, 1.48.0 and 1.54.0; not installed here)                                                                                                                                                                                                                                                                                                                                                                                                                                          | Denied: `.agents/plugins`. Only a per-plugin switch exists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
  | Kilo               | The MCP servers in `.kilocode/mcp.json` and `.kilo/mcp.json`, read on every start even with `KILO_DISABLE_PROJECT_CONFIG` (source on `main`; not installed here)                                                                                                                                                                                                                                                                                                                                                                                                                             | Denied: those two files; the source skips one it cannot read. `KILO_DISABLE_PROJECT_CONFIG` and `KILO_PURE` cover its other Project config and plugins                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
  | fx                 | The Project `.mcp.json`, admitted only for servers approved in fx's own home settings, which the managed home leaves empty (source)                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Unchanged: `.mcp.json`, `.fx.json`, `AGENTS.md` denied                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
  | GLM Agent          | None: only the ACP session's MCP servers; `.claude/commands` are prompt text put into a message when the person types `/name` (source, 1.15.0; not installed here)                                                                                                                                                                                                                                                                                                                                                                                                                           | Nothing to deny                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
  | Gemini CLI         | `mcpServers`, `hooks`, and tool discovery commands in `.gemini/settings.json`, `mcpServers` in `.gemini/agents` files, and extensions in `.gemini/extensions`, in a folder it counts as trusted. Its folder trust is off by default (documentation), so unless the person turned `security.folderTrust.enabled` on in Gemini every folder counts as trusted; an untrusted folder starts no MCP server at all, Octant's own included. It reads the Project settings from the session folder only, with no walk to a parent folder or the repository root (source, 0.64.0; not installed here) | **Refused, not denied.** Denying `.gemini/settings.json` fails Gemini's settings loader (`existsSync`, then `readFileSync`, and a read error is a fatal configuration error), and with it `session/new`, in every Project that has one. So `refusesProject` fails the start before the process launches, with category `incompatible`, when the Project root holds `.gemini/settings.json`, or a non-empty `.gemini/agents` or `.gemini/extensions`; the message names the entry and says to remove or rename it or use another provider. Decision of 2026-10-14, replacing an earlier one to let it load them. Only the Project root is checked, because the settings are not read from parents; a Chat (managed home) and a Project that is the home folder are exempt. A file created after a session started is not seen until that runtime restarts. Ending the refusal needs an upstream switch that skips Project settings, or a trust gate Octant controls (forcing the folder trust on in a managed settings file), neither proven here |
  | Qwen Code          | `hooks` in `.qwen/settings.json`, `.qwen/agents` hooks, extensions in `.qwen/extensions`, and in Full access the unapproved `mcpServers` of `.qwen/settings.json` and `.mcp.json`. Its folder trust is off by default, so every folder counts as trusted. It reads the Project settings from the session folder only (source, 0.25.1; not installed here)                                                                                                                                                                                                                                    | **Refused, not denied.** Same settings loader as Gemini, so a denied settings file fails `session/new` in every Project that has one. `refusesProject` fails the start before the process launches, with category `incompatible`, when the Project root holds `.qwen/settings.json`, `.mcp.json`, or a non-empty `.qwen/agents` or `.qwen/extensions`, naming the entry and saying to remove or rename it or use another provider. Decision of 2026-10-14, replacing an earlier one to let it load them. Same exemptions and mid-session limit as Gemini. `--safe-mode` would turn these off and keep session MCP servers per its source, which would end the refusal, but is unproven here                                                                                                                                                                                                                                                                                                                                                      |
  | Claude (Agent SDK) | None                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `settingSources: []`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

  Gemini CLI and Qwen Code are the exception to a deny: their settings loaders
  fail on a file they cannot read, so Octant refuses to start either one in a
  Project that holds the entries in their rows, before the process launches
  (`refusesProject` on the profile, checked beside the mode refusal). Every
  other Project starts as before. The refusal is a start failure, not a
  capability change: the runtime still reports what it can do, and the failure
  says why. Their rows name what would end the refusal.

  Three gaps remain open. Folders above the Project root: Copilot, Devin,
  Kimi Code (`.mcp.json` at the repository root), and Mistral Vibe look
  upward, and a root deny does not reach a parent folder; Grok's trust rule
  covers every level. The runtime's own profile: Octant reuses the person's
  Copilot, Grok, Kimi, Vibe, Cline data, Goose, Gemini, Qwen, OpenCode, and
  Kilo profiles for sign-in, so MCP servers, hooks, and plugins the person set
  up there (for example `~/.copilot/mcp-config.json` and installed plugins,
  `~/.grok/config.toml` and `~/.grok/plugins`, Kimi's `config.toml` hooks,
  Cline's MCP settings file, Goose's `extensions`) still load; Kimi's
  `mcp.json`, `skills`, `plugins`, and `hooks` are the denied exception.
  Closing either needs a per-runtime switch or a profile that holds only the
  sign-in. On Linux a denied file appears as an empty file rather than a
  missing one, which a runtime may refuse to parse, and a deny path that does
  not exist is skipped. So when the person has no Grok `trusted_folders.toml`,
  an agent could create one in the writable `GROK_HOME` during a session.
  With folder trust forced on, that file cannot switch the gate off, but an
  entry in it could trust a folder for a later session of the same process
  until the next launch hides it.

  Where a skill is found decides who sees it, in the catalog, the palette, the
  turn resolver, presets, Code profile admission, and Canvas refresh. A skill
  below the Project root belongs to the one thread whose working directory
  reaches it (`scope`). A skill at a Work or Code Project root belongs to that
  Project (`projectScope`): every thread and new-task draft of the Project
  shares it, and no other Project sees it. Chat matches no Project scope,
  because a Chat Project has no folder. User-global and bundled skills carry
  neither and reach every thread. A Project scope is its own field, not a
  `scope` without a thread, so a client that predates it drops the field
  rather than refusing the snapshot; the host still filters every turn.

- Marketplace network is on user action: curated catalog search is in-memory;
  inspect/install fetches the pinned GitHub tree; standalone skill search
  queries skills.sh and npm with the typed text; Agent Plugins search queries
  npm with the publisher-adopted `agent-plugin` / `agent-plugins` keywords,
  validates every candidate at listing time (bounded tarball bytes, canonical
  root `plugin.json` `$schema`, unsafe-path and link rejection), lists the real
  identity and digest, and resolves exactly the listed `name@version` from
  cache. A candidate that fails validation is not listed. Opening Settings does
  not fetch a catalog.
- A structured mention cannot install, trust, enable, or elevate anything.
- A selected MCP server component reaches Chat, Work, and Code turns through
  the provider's app-managed tool transport. The host resolves the selection
  against the thread's own mode scope, connects the supervised session for
  that scope, offers only the selected tools, and refuses the turn when the
  provider or model cannot carry Octant's tools. Every call waits for an
  approval in the turn's window, shown in the open thread, unless a
  remembered approval covers it (next item). Who may answer:
  - A local window answers its own turns' prompts, and any prompt raised by
    a host-owned turn or by a paired device's turn on a thread that window
    may drive (bound to the Project the prompt recorded).
  - A paired device answers only the prompts its own turns raised, approve
    once or deny, and only while the thread is still active and bound in
    that Project (a Chat thread: still active and in the same Chat Project,
    or still in none). It never sees or answers a local window's, another
    device's, or the host's prompt. `/api/extensions/tool-approvals` is
    forwarded to paired devices as `extension.tool-call.answer-once`; the
    approval service, not the route policy, applies these rules.
  - A prompt raised by a device that is no longer paired (revoked, or past
    its registration's deadline even before the expiry is reconciled) goes
    to nobody else and runs out.

  At most 32 of those approvals
  wait at once across the whole host; the cap is shared by every thread and
  window, not counted per thread. A call past that cap is denied immediately
  with the refusal a declined call already uses, and answering or expiry
  frees the slot. An unanswered approval expires after five minutes and the
  call is denied; the host checks that against the clock whenever approvals
  are listed, answered, or requested, so a prompt whose timer fired late (a
  busy host, a machine that slept) cannot still be approved or hold a slot.
  An MCP
  server's launch command starts the server, not a shell the model holds, so
  a stdio server is declared `mcp`, not `shell`, whichever package format
  carried it.

- **Remembered MCP tool approvals.** A person may answer a tool's prompt with
  "always allow in this Project". That journals a grant for that one tool in
  that one Project (`extension.tool-grant-recorded@1` on the Project's
  `extension-tool-grant` aggregate), never for the whole server. The grant
  binds the Project, extension, package, component, and MCP tool name, the
  package version and digest, and a SHA-256 of the tool's name, description,
  and input schema as its server listed them at connect; the provider-facing
  tool name is not part of it, because that name embeds the thread. A later
  call in any thread of the Project that matches all of it runs unasked,
  under the calling turn's own authority and only while the component is
  effective and selected on that send. Any mismatch asks again, so a package
  update or a changed listing is a new question
  (`decideExtensionToolGrant` in `@octant/domain`). The payloads hold
  identifiers and digests, never a call's arguments or result.
  - A grant grows only through that answer from the local window whose own
    turn raised the prompt. No route, command, manifest field, structured
    reference, tool call, model output, paired device, or host-owned turn (a
    routine, a goal loop, a usage-limit resume, a child-run delivery) can
    create one. A host-owned turn in the Project may use one, but the prompt
    it raises is approved once and is never remembered, even when a person
    at a local window answers it: nobody chose to send that turn. A paired
    device's turn is treated the same way: it may use a grant, and its prompt
    is approved once, whether the device or a local window answers.
    Remembering is an answer at the machine, and the person who sent that
    turn is not at it.
  - A thread with no Project and a Plan turn are asked for every call, and
    the answer covers that call alone. An answer that asks to be remembered
    where it cannot be is refused and the call keeps waiting.
  - On a thread that has taken in outside content, a grant holds only for a
    stdio server, which Octant launches with no network and writes limited to
    its plugin data. A network (HTTP) server's tool asks for every call there
    and the answer is single use, because its arguments can carry out what
    the thread has read. Every MCP result taints its thread, so a network
    tool's grant spares the prompt only until that thread's first tool result.
  - Disabling the plugin or component, archiving the Project, or switching a
    mode off leaves grants stored and unused. Uninstall, withdrawn source
    trust, and rollback revoke them (`extension.tool-grant-revoked@1`), so
    installing or trusting the package again restores nothing. The
    revocation is a second append after the lifecycle commit, so a grant also
    stops standing when its extension's latest uninstall, rollback, or trust
    withdrawal is later in the journal than the grant, whether or not the
    host stopped before appending the revocation; Settings does not list it
    and a call asks again. A person
    revokes one through the local-only `/api/extensions/tool-grants`, which
    lists and revokes and has no request that adds a grant. Settings › Data &
    privacy lists them by Project with Revoke, and the prompt offers "always
    allow" only to a client on a loopback host.
  - This covers only the tools Octant itself calls. An MCP server that a
    provider runtime starts from the person's own configuration (for example
    a Codex Work or Code thread using `~/.codex/config.toml`) is called
    inside that runtime, is never seen by Octant, and stays under the
    runtime's own approvals.
- Core capabilities (browser/computer use, tests, Apple validation, approvals,
  memory, subagents) are app-managed and provider-neutral; no core capability
  depends on an optional extension. Computer use is destination-shaped: the
  host reports whether a screen exists, and an adapter performs
  observe/execute/cleanup. A host with no destination reports the capability
  absent and refuses actions as a value rather than throwing. See
  [decisions/0053-computer-use-destinations.md](decisions/0053-computer-use-destinations.md).

**Canvas export.** A destination plugin contributes an export target through
`@octant/plugin-api`. The contribution names the formats it accepts. The host
offers it only when the package is installed, trusted, enabled, and effective;
a disabled or uninstalled target is omitted, not listed as refused. The server
renders the Canvas to Markdown or HTML, shows an approval card with that
payload and the destination, and calls the target only after approval. The
call returns a receipt (a link, a path, or a remote id) or a typed refusal.
Each completed export is a `canvas.export@1` journal event and is rebuilt by
replay. When the destination was called but the journal could not take the
record, the answer is `unrecorded` and carries the destination's outcome; it is
never reported as a failed export. PDF and PNG are named formats the seam can carry later; this host does
not render them. A target that passed activation is still reported honestly as
`not-connected`, `ready`, or `refused`. A local target may describe the exact
file it would write, and the card then names that path: approving a card that
names an existing file is the confirmation to replace it, and a call without
that confirmation writes a numbered copy beside the file instead of over it.
The rendered Markdown, HTML, and the artifact preview SVG read numbers through
the shared Canvas formatter and draw marks to the shared chart specifications
and the shared squarified treemap layout, so an exported reading matches the
screen rather than growing a second reading.

The folder destination ships in-tree on that same port, so it is offered,
approved, and journaled exactly as a plugin's contribution is. Its folder comes
from the host folder browser — a renderer sends a candidate the host listed, and
the host resolves the path — and is remembered per Project, with a host-wide
folder for a thread filed nowhere, in a `canvas.export-folder-changed@1` journal
frame rebuilt on restart. A folder must be inside the person's home unless the
standing access-outside-project approval exists, the same rule the artifact
mirror's global folder follows. Writes are confined to the chosen folder and are
atomic: a temporary file is renamed into place, so a reader never sees a
half-written export. The folder is stored by its real path, and a write whose
folder no longer resolves to that path — because it or a folder above it was
replaced by a link after it was chosen — is refused rather than followed. The
user guide's exporting page (`apps/docs/guide/export.md`) states the same rules
for a person.

The GitHub Gist destination ships in-tree on the same port. It reuses the GitHub
connection Octant already resolved through the `gh` command — the host-managed
credential, never a token read by this code — so a host with no usable
connection reports `not-connected` and one whose credential is stored in plain
text reports `refused`, the same states the other GitHub capabilities report.
The connection state is read on demand, when an export lists or prepares its
destinations, and kept until Octant's own GitHub commands report a change; a
state that cannot offer the gist is read again on the next listing. No GitHub
call happens at host start. A GitHub refusal other than a rejected credential
(for example a connection without the `gist` scope) is reported as declined, not
as GitHub being unreachable. A remote destination can describe more than a file:
`describeDestination` names the account the export acts as and the audience the
result will have, and a destination's own note, which the approval card shows
verbatim. The person chooses `secret` or `public` on the card, the choice
travels back through the `canvas-export-decision` request into `exportDocument`,
and the card states plainly that a public result is visible to anyone. A gist is
Markdown only and one file named from the Canvas title with a `.md` extension;
the rendered document passes the same secret-and-path filter every exported
document does, and one that fails it is refused rather than published. The
receipt is the gist URL and its id, journaled in `canvas.export@1` like any
other destination's.

**Computer use plugin.** The bundled Computer component is selected through
`@Computer` in Chat, Work, and Code. The server validates the structured
selection and supplies `octant_computer` through the provider's existing
app-managed tool transport. The capability binds to one send: a turn whose
message carried no selection still registers the name, as a refusal-only
definition that tells the agent to ask for @Computer again rather than a
provider-side unknown-tool failure. The public plugin capability is bound to one
task, window, provider, model, and access posture. Each application needs a
five-minute approval; stop, cancellation, changed authority, or disable revokes
control. Observations carry window and element identities, with screenshots
for image-capable models. Application content remains untrusted.

Computer observations verify that the requested window still belongs to the
current application process before requesting its accessibility state or pixels.
A vanished window returns a window-unavailable refusal directing the caller to
list current windows; stale IDs are never silently retargeted.

On Apple Silicon macOS, Electron main owns the official CuaDriver SDK and its
private embedded child. The authenticated loopback broker is available only
to Octant's host process; its credentials never enter provider children.
Settings exposes plugin enablement, macOS permission setup, the driver version,
and update controls. The app bundles a pinned, publisher-verified driver. The
driver runs under Octant's macOS permissions, so it checks upstream daily only
when the person turns automatic updates on in Settings › Computer use; it is
off by default, a saved choice is kept, and a manual Check for updates still
works. Verified updates stage privately, activate
only while idle, and retain the previous version if startup fails. The driver
never uses a standalone CuaDriver installation. Plan refuses computer-use
control. See
[decisions/0113-computer-use-plugin-and-driver-updates.md](decisions/0113-computer-use-plugin-and-driver-updates.md).

**Managed device tools.** The iOS Simulator and Android emulator panes ride
upstream streaming tools (`serve-sim`, `serve-avd`) that Octant vendors as
pinned, integrity-verified npm releases. Electron main runs them under the
desktop runtime, never a system Node, and each launch receives only an
allowlisted environment, never provider keys, tokens, broker credentials, or
other `OCTANT_*` values. They run unconfined under Octant's signed identity.
Automatic updates check the npm registry only when the person turns them on in
Settings › Device tools (off by default), and never run an upstream installer
or lifecycle script. OpenCode's managed copy rides the same channel. Packaging,
signing, staging, resolution, and the streaming attach and fallbacks are
specified in [Device workbench](design/device-workbench.md#managed-device-tools).

### Plugin boundaries and remaining extraction

The approved design bounds a feature's reach through public, provider-neutral
ports. New providers and tools use `@octant/provider-sdk`, `@octant/plugin-api`,
and `@octant/plugin-host`; they do not gain direct access to host internals.
Integration and board modules receive typed, capability-scoped ports, without raw
filesystem, shell, or credential handles. OAuth access and refresh tokens remain
in the host credential service; plugin state contains only opaque references.
Plugin projections are namespaced by package id and remain rebuildable.

These are the current extraction boundaries; eligibility is not a claim that the
feature is already an independently packaged plugin:

| Surface                                                               | Boundary to preserve                                                                                                           |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Thread boards                                                         | Separable projection and UI; Work/Code status policy stays host-owned and Chat has no board                                    |
| GitHub and Linear                                                     | Integration ports and contributed views; no direct host-service wiring                                                         |
| Canvas and preview viewers                                            | Scoped artifact contracts, renderer modules, and registered viewers                                                            |
| Zen, backgrounds, theme presets                                       | Appearance contributions and their scoped state                                                                                |
| Usage, diagnostics, Navigator, automations UI                         | Scoped reads/actions and independent presentation; underlying authority stays in the host                                      |
| Browser/computer use, agent hierarchy, remote/mobile, Apple workbench | Only presentation and optional adapters are extraction candidates; core capability, lifecycle, and security remain app-managed |
| Marketplace and plugin registry                                       | Stay in the host because they admit and activate other components                                                              |
| Provider drivers                                                      | Bundled vendor plugins through provider-sdk; generic ACP transport and honest-capability enforcement stay host-owned           |
| Image adapters (OpenAI, Gemini, BFL, Ideogram)                        | All four extracted behind the provider-sdk image seam and bundled in-tree; image jobs stay host-owned                          |

The schema API, renderer contribution registry, vendor driver admission,
Integration port, and plugin-module Settings/sidebar seams exist. The API is a
curated re-export of contracts, preserving the contracts package's dependency
direction. Some Settings rows remain host-compiled. Linear uses the Integration
port as a bundled plugin; extracting the remaining GitHub and board packages
and packaging remaining appearance/viewer assets is unfinished work, tracked in
Linear rather than inferred from archive status.

Preserve the extraction sequence: establish a provider-neutral port and renderer
seam before moving a feature behind them; keep extraction separate from unrelated
fixes; move remaining GitHub/board packages before the remaining appearance/viewer
packaging. Changing host mode policy is a separate explicit design change, not a
permission supplied by an integration plugin. The Integration kind stays Code-mode
safe until that policy changes. Plugin disable preserves data and selections,
drains running executables, and removes effective contributions; deleting
credentials requires its own explicit confirmation.

The rationale and original migration account remain in
[0001](decisions/0001-plugin-architecture.md). This section owns the current
boundary and approved direction; the archived proposal's status is not a delivery
gate. The connector marketplace hold remains in force.

## Security and authority

The full threat model lives in the security documentation; the load-bearing
mechanisms are:

- **Local authority needs the bridge secret.** Nothing reachable on loopback
  grants window authority by itself. Electron and the CLI present the desktop
  bridge secret, which only the host's OS user can read from the owner-only
  runtime directory; a browser presents a one-time launch token minted with
  that secret and bound to its origin. Another OS user, an `ssh -L` forward,
  or a proxy that rewrites `Host` reaches the listener but gets no capability
  (the local client context under [Process topology](#process-topology) has
  the flow).
  Paired remote clients keep their own device-session path, unchanged.
- **Server-side tool-call policy.** A tool call from a model is a petition, not
  a grant. Every call resolves through the closed tool catalog, the mode's
  capability matrix, the thread's elevation state, and the actor's authority
  before anything executes. Tool results and external content are data with
  provenance, never instructions.
  Every Project check inside a Code turn's tool call is judged on the turn's
  window as it stands when the call runs (its persisted Project binding, and
  only while the window is still live), never on the admission of the
  request that started the turn, whether that request has ended or is still
  open. A closed window's turn keeps running but its tool calls reach no
  Project until the same window registers again, as a reopened primary
  window does; a renderer reload keeps the window live. A paired device's
  scope holds no binding, so its wider in-request reach never carries into
  those checks, and the routine host scope passes for any active Code Project
  as before.
  **A turn keeps its checkout.** A Code turn acts on the checkout it was
  started on until the turn ends. Starting the turn checks the window's
  Project binding once; the turn then captures the checkout root, the
  checkout's and Project's identity, and the confinement it runs under (the
  terminal sandbox and its writable roots). Every tool that acts on that
  captured checkout runs on the capture and does not look at the window's
  binding again: the ACP client's file read and write and terminal tools, the
  native harness's file tools, and the provider's own built-in tools. A window
  moved to another Project, a window that closes, and a turn a paired device
  started therefore do not cut a running turn off from its own checkout, and
  a call never lands on the window's new binding. Two reasons: a provider
  runtime's built-in tools cannot be cut mid-turn and act on the checkout
  anyway, so the same rule for Octant's tools keeps one behavior whichever
  tool the provider reaches for; and a turn started from a phone has no
  window binding to hold it against and must keep working. Stopping the turn
  is how the person ends its reach.
  What still applies to every call of Octant's own tools: the thread's live
  execution policy (the turn's requested ceiling, clamped by the thread's
  current grant, so a thread put in Plan mode mid-turn refuses writes and
  process launches on the next call, and a Plan turn is read-only throughout),
  the turn's confinement, path containment inside the captured root, and the
  approvals the posture requires. A provider's own built-in tools run under
  the posture and sandbox the turn was launched with and do not reread the
  thread's grant mid-turn, so lowering it takes effect on them with the next
  turn or when the person stops the turn. The next turn on the thread checks the window's binding again, so
  after a rebind or a window close it starts on the new binding or is refused,
  as any new turn is.
  The two rules fit because they judge different things. The captured checkout
  covers what the turn does to its own checkout. The window's standing
  authority covers an app-managed tool that reaches a Project-scoped service
  on the window's behalf, such as reading, writing to, or stopping a terminal
  the window holds, the planner board, a device-effect approval, or a sibling
  thread's transcript: those hold nothing the turn captured, so they follow
  the window's binding and liveness when the call runs, as above. A rebind
  or a closed window can therefore stop a turn's window-held terminal or board
  calls while its file and process tools on the checkout keep working until
  the turn ends.
  Other work a request defers still loses that request's admission when
  dispatch completes.
- **Approvals.** Independent categories — project file writes, shell commands,
  network access, external application observation or control, destructive
  actions, credential access, access outside the bound root, privilege or
  sandbox changes. Grants are scoped and journaled; a remembered approval of
  one MCP tool in one Project follows the rules in
  [Extensions and skills](#extensions-and-skills). Code starts approval-gated;
  Plan mode is read-only; auto-accept-edits waives only project file writes;
  a Work thread takes its access from Settings › Work when it is created —
  ask-first (the default) or auto-accept-edits — and keeps it; the host sets
  it, not the renderer, and a goal-loop round uses it only when the loop's own
  ceiling allows auto-accept-edits too. A goal-loop round runs as the host,
  under the same per-process host scope a
  [routine](#modes-chat-work-and-code) runs under, never through a window: it
  runs with no window open, an open window lends it neither identity nor
  Project binding, its turn is journaled as the host's `system` actor, and the
  ordinary Work turn path still rechecks the thread, its active Work Project,
  and the round's authority. A loop pauses while Work is turned off, since no
  window stands in for the mode switch, and a round's turn rechecks the switch
  at admission, so turning Work off while a round is being prepared refuses
  it. An approval a round raises is
  offered the way a routine's is, to the local windows bound to its Project.
  A goal-loop round marks a checkpoint before it starts when its thread has
  one to mark; a Work folder has none, because a checkpoint anchors a Chat
  turn or a Code operation, a Work turn's record of what changed in its folder
  names paths without their contents, and Work holds no Git. A round without
  a checkpoint runs only when its effective authority is approval-gated, so a
  person approves every write, and its recorded round carries no checkpoint
  id. Under auto-accept-edits, and under Plan (a Work round has no read-only
  path, so it would still write what a person approves), the loop pauses as
  `checkpoint-unavailable` and says so in its panel. A checkpoint that fails to mark reads as none.
  Nothing else about a Work turn widens:
  it stays confined to the Project root, and providers without an auto-accept
  path keep asking;
  Full access is a remembered, per-Project decision. The host records that
  decision with `octant project access <name> full-access` (journaled
  `project.code-access-changed@1`); a thread that asks for Full access for
  the Project's default then starts without a per-thread native
  confirmation, and an existing thread can be raised to it the same way,
  while session-only Full access still needs one. `octant agent` sends that
  same request for a Code thread exactly when the Project's bootstrap says it
  remembers Full access, and approval-gated otherwise; the host's check is
  the only grant, so it refuses the request once the Project stops
  remembering, and the terminal has no way to ask for more. A composer
  turn may
  request a narrower posture; the server clamps it to the thread's grant
  and records the posture the turn ran under. A Code thread's `autoApprove`
  flag lets a compatible harness's own reviewer answer the prompts Octant
  would otherwise surface. It says who answers, not what is permitted:
  categories, the sandbox, egress, and credential reach stay Octant's. It is
  effective only on approval-gated or auto-accept-edits, only when the
  provider reports `harnessAutoReview: "supported"`, and only while the thread
  has not ingested untrusted content (unknown taint counts as ingested); it is
  set with the posture through `change-code-thread-access` and clamped and
  inherited with it. Claude runs `permissionMode: "auto"` with Octant's
  callbacks still registered. Codex sends `approvalsReviewer: "auto_review"`
  on approval-gated only (`codexExecutionSettings`): both prompting postures
  run Codex `read-only`, so an in-root patch edit escalates, and Codex's
  reviewer is thread-wide and keeps those requests from the host, so on
  auto-accept-edits it would answer — and could deny — the edit the posture
  waives. The waiver outranks the delegation, so a Codex auto-accept-edits
  thread with `autoApprove` still asks the person about commands and network.
  Octant never classifies a command as in-root-only from its text instead:
  Codex reports `commandActions` as `unknown` for a plain `> file` redirect.
  One provider-owned exception is accepted: on OpenCode 2.x, approval-gated
  honours permission grants the person saved in OpenCode itself for the same
  repository, so such an action runs without an Octant prompt. Octant's
  denies still win, and Octant never writes such a grant; the
  [OpenCode runtime specification](design/provider-runtimes.md#opencode) states the details.
  The access picker also offers "Lower thread" to durably return a thread to
  approval-gated and revoke a session-only Full-access grant for that window
  without confirmation.
  On a host with no native confirmation surface — a headless Linux station
  has none — session-only Full access cannot be raised from any client: the
  access picker refuses the raise and names the remembered route, so Full
  access arrives only through the host's recorded
  `octant project access <name> full-access` decision. The desktop-owned
  challenge invariant is preserved by not offering the grant the challenge
  cannot guard.
  The native harness may swap a configured reviewer onto eligible shell
  and network prompts when a host setting is on
  (`docs/decisions/0110`); that planned path does not yet run.
  Three provider tool requests denied in one Code turn end it as
  interrupted, with the reason journaled, so a provider cannot loop a
  person's refusals.
- **Pending requests across modes.** `GET /api/pending-requests` returns every
  approval, question, and turn decision (next item) the calling window can
  answer, oldest waiting first,
  at most 128 with a `truncated` flag. It adds no authority: each mode lists
  only what its existing answer command would admit for that window. Work uses
  the Work request service's Project check (an active Work Project) and lists a
  request only on a thread the window's Work thread list holds; Code passes each
  request through the scope `answer-provider-approval` and
  `answer-provider-input` pass first (thread and checkout identity, the window's
  bound Code Project, an available checkout, an active thread); Chat lists a
  question on an active, listed thread filed under no Project or an active Chat
  Project. A disabled Chat or Work mode is not asked. Each item carries the
  handle its mode's existing answer command takes; there is no new answer route.
  Only requests a live turn in this host can deliver are listed: a Code or Chat
  request journaled by a turn that died with the process is left out, because
  answering it settles the turn interrupted. Excluded: Chat approvals (Chat
  declines every provider approval), hidden Side Chats, Work browser tool approvals
  (`/api/browser/approvals`), Computer Use approvals, extension tool approvals,
  and a lead native-harness session approval (a request with no `source`); a
  native-harness question raised on a Code turn is a Code question and is
  listed. A child agent's approval or question (`source` set) is listed as a
  `child-approval` or `child-question` row on a Work or Code parent: it carries
  the parent thread, the child's run, role, task (at most 200 characters, with
  a Work parent's task redacted of paths and URLs as its request text is),
  provider, and model, and the request text, but no options and no answer
  handle, so the read adds no answer route. It is listed only while a waiter in
  this host can still settle it and the session view still holds the pending
  item (a restart, an expiry, a decision, or an eviction past the view's 50
  entries removes it), and only for a window bound to the parent's project,
  the same binding that lets that window open the thread. The menu bar's own
  window binds no Project, so its fleet read asks those persisted windows and
  still lists the parent once. The harness session
  route also requires the thread to be the open surface; the list does not,
  because the row is how a person finds a request on a thread they are not
  looking at. Answering still goes through that route after the row opens the
  thread. A disabled parent mode is not listed. A Chat child is never listed because Chat has no Agents tab to
  review it in. An approval a child raises still covers that request only and
  never offers a remembered grant. A Code turn's Browser site ask
  is a Code approval and is listed with `browserOrigin`, the site it waits to
  open, which a provider's own approval never carries. Text keeps
  each mode's own bounds and sanitization. The read is local-window only: its
  path is outside every prefix the remote listener forwards, the remote action
  classifier names no action for it, and the route refuses a paired device's
  principal. Freshness rides the Machine change feed: a child agent's approval or
  question asked or settled publishes `work-navigation` and `code-navigation`
  (a lead's own request publishes nothing new),
  a Work request's
  transitions and a Chat attempt's question are journaled, a Code request's ask,
  answer, and turn end are journaled stream events, and a Code browser-origin
  approval that expires or is abandoned — which journals nothing — publishes
  `code-navigation` itself.
- **Fleet activity.** `GET /api/fleet-activity` returns the threads that need
  the calling window's person and the threads that are running, needs you
  first, at most 64 with a `truncated` flag, each naming its mode, title,
  Project name, and `activitySource` (`journal`, `session`, or the reserved
  `screen`, which can never say needs you). It composes the pending-requests
  read, the Code requests and decisions each local window with a persisted Code
  binding could answer, the subagent waits each persisted local window bound to
  the parent's project could open, and each mode's own navigation run state,
  and adds no authority or state.
  It is local-window only under the same rules as pending requests: outside
  every forwarded prefix, no remote action, and a paired device's principal is
  refused. The [desktop menu bar](#desktop-menu-bar) is its reader.
- **Turn decisions.** A Work or Code turn that cannot continue without the
  person's choice ends its reply with one closing `octant-decision` block: an
  ask (one line, at most 110 characters) and one to four options (at most 60
  characters each), exactly one recommended. Every Work and Code turn on every
  provider is asked for the block by one fixed instruction beside the
  follow-up one; Chat is not. The host reads it with the pure domain parser
  (`parseTurnDecision`) from the normalized reply alone — a Code turn's message
  content in journal order, a Work turn's `response` — so nothing a provider
  adapter emits outside that text can raise one, and a missing, mid-reply, or
  malformed block raises nothing. The pending-requests read lists it as a third
  kind, `decision`, under the same local-window rule and the same per-mode
  reach (Code: the window's Code thread list; Work: an active Work Project and
  the window's Work thread list), oldest first from the turn's end. A decision
  is derived on read from the latest provider turn and the thread's rest state,
  so replay rebuilds it and nothing new is journaled: it is open only while
  that turn is the thread's latest and `completed`, and the thread is not
  archived, completed, or snoozed. A newer turn (so one per thread), a turn
  that was interrupted or failed (including one that died with the process),
  or putting the thread away closes it; a snooze that ends shows it again. Its
  answer is the thread's ordinary next turn through `start-provider-turn` or
  `start-work-thread-turn`, with the option's words as the prompt and the
  authority the composer has; there is no answer route, and an option performs
  no host action. On the board an open decision files the thread under Waiting
  with `decision-pending` (after recovering and a live request's
  `awaiting-input`, before an interrupted turn); Done still requires the
  delivery target to be satisfied, and a decision blocks neither completing nor
  snoozing.
- **Fail-closed refusals name a recovery.** A refusal that fails closed on
  authority must name a recovery a person can perform: a user action, a
  restart, or elapsed time. A posture none of those can clear is not an
  acceptable resting state. Recovery is a deliberate act by the machine's
  owner, never a widening of the automatic admission rule, and the refusal
  says what clears it where the person is, not only in a log. "Sign in with
  the account command in Settings." is the shape.
- **Sandbox.** Git, terminals, test runners, extension executables, and every
  provider `--version` read launch through one shared confinement port
  (`ProcessConfinementPort`), and so do provider runtimes except where the
  confinement matrix below says a runtime is unwrapped. On macOS that is
  `sandbox-exec` with deny-default Seatbelt profiles; on Linux it is Bubblewrap
  (`bwrap`) with private `/tmp`, bound roots, and no unconfined fallback,
  recorded in [decisions/0057-linux-confinement-bubblewrap.md](decisions/0057-linux-confinement-bubblewrap.md).
  The child runs `--unshare-all`, regains the network only when egress
  resolves to `allow`, dies with its parent, and gets a new session except for
  interactive terminals. The synthetic root is read-only, deny paths are
  covered by empty read-only tmpfs mounts, and a launch carrying Seatbelt
  `extraRules` is refused as `incompatible`.
  Plan and Chat also load a seccomp filter that denies process-creating
  fork/clone (while allowing `clone` with `CLONE_THREAD` for pthreads) and
  `execveat` after start, because Bubblewrap cannot block the first `execve`
  ([decisions/0068-linux-plan-process-deny.md](decisions/0068-linux-plan-process-deny.md)).
  A launch that needs that filter fails closed as `incompatible` on a CPU
  other than x64 or arm64 or without an executable `/bin/sh`.
  Sensitive system roots remain denied even where runtime compatibility
  requires a broad file-read rule; each launch's exact roots are re-allowed
  after those denials. On macOS every launch, in both egress modes, can read
  the public TLS files under the `/private` denial: `openssl.cnf`,
  `x509v3.cnf`, `cert.pem`, and `certs/` in `/private/etc/ssl`. Without them,
  LibreSSL in `/usr/bin/curl` and `/usr/bin/openssl` exits before opening a
  socket. The directory itself is not granted, so OpenSSL's default key
  directory `/etc/ssl/private` stays denied. An offline launch still fails
  at the socket. Path checks alone are never the boundary. Confined
  reads open a handle and verify identity against what containment resolved.
  Missing the platform-selected backend (`sandbox-exec` on macOS, `bwrap` on
  Linux) fails closed. A provider runtime that makes its own API call resolves
  provider-endpoints-only on every posture below Full access, Plan included, a
  scoped exception to 0009 recorded in
  [decisions/0132-provider-runtimes-reach-provider-endpoints.md](decisions/0132-provider-runtimes-reach-provider-endpoints.md)
  and extended by
  [decisions/0145-a-plan-turn-is-confined-by-octant.md](decisions/0145-a-plan-turn-is-confined-by-octant.md):
  the process producing a plan still has to ask the model for it, while the
  tools that thread reaches keep `none`. Seatbelt and Bubblewrap cannot express
  a host allowlist, so `provider-endpoints-only` materializes as plain OS
  network `allow` for the runtime process (`materializeOsNetworkEgress`): the
  runtime, Plan included, can reach any host. The endpoint restriction the name
  promises holds only for Octant-brokered tools (browser origin allowlists,
  research backends) and for native-harness commands, which run on `proxied`
  under the [harness tool egress rules](#harness-tool-egress-rules)
  (`materializeHarnessToolNetwork`). The persisted value keeps its name for
  journal compatibility.
  A provider runtime launch is wrapped when the process carries exactly one
  thread's authority. The state below, which `providerProcessConfinement.test.ts`
  pins against this table, is the accepted one: provider runtimes keep their
  own sandboxes (Codex in every posture, Claude outside Plan) and closing that
  gap is not an open goal. Octant says so rather than promising a boundary it
  does not draw; a runtime that can be wrapped without losing what it needs is
  taken as its own change. Full access never gets the deny-default
  profile. The one wrapper it can get is deny-only: an ACP profile with
  extension or host-auth paths to deny (Kimi, for example) launches Full access
  under an allow-default `sandbox-exec` profile or a Bubblewrap host-root bind
  that denies only those paths (`makeAcpConfinementLive`). That wrapper
  confines nothing else. On Linux a deny path that does not exist is skipped,
  because Bubblewrap would create it in the person's own Project (see
  [Extensions and skills](#extensions-and-skills)).

  | Runtime (module)                                                          | Plan                            | Approval-gated, auto-accept-edits                   | OS egress below Full access                      | Plan's read-only enforced by                                                                                                                                                                                                               |
  | ------------------------------------------------------------------------- | ------------------------------- | --------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | ACP, OpenCode, Pi (`acpProcess.ts`, `openCodeProcess.ts`, `piProcess.ts`) | Wrapped                         | Wrapped                                             | `allow`                                          | Octant sandbox: no root write, no exec or fork                                                                                                                                                                                             |
  | Claude Agent SDK (`claudeProcess.ts`)                                     | Wrapped; Chat children run here | Unwrapped; runtime's own sandbox, project root only | `allow` on Plan; not limited by Octant otherwise | Octant sandbox: project and checkout read-only; write only `sessions/` and this session's own transcript and folder; on macOS exec only zsh and listed read-only tools, which get no network and write only the launch temporary directory |
  | Codex app-server (`codexProcess.ts`)                                      | Unwrapped                       | Unwrapped                                           | Not limited by Octant                            | Codex's own `read-only` sandbox                                                                                                                                                                                                            |
  | Oh My Pi (`ohMyPiProcess.ts`), readiness probe only                       | Unwrapped                       | Unwrapped                                           | Not limited by Octant                            | No turn runs                                                                                                                                                                                                                               |

  Codex is unwrapped because its app-server is leased once per provider
  instance: `providerRuntimeRegistry` keys runtimes by `instanceId`, so one
  process carries every thread on that instance, each choosing its own root
  and `sandbox` at `thread/start`. No profile is exact for all of them, and one
  wide enough for all of them is not a boundary. Keying the lease by the
  thread's root and execution policy, as an OpenCode connection is, would
  change that, and nothing requires it. Claude's unwrapped postures rest on
  the runtime's own sandbox for the same reason: its sign-in and tools need
  reach that a deny-default profile would have to re-grant.
  `providerProcessConfinement.test.ts` refuses a new module that launches
  without the shared builder unless it is named here. The ACP/OpenCode/Pi row has one
  carve-out from "no exec or fork". On macOS, an OpenCode 2 Chat, Plan or Work
  launch may fork and may exec exactly `/usr/bin/false`, which is its Git
  stand-in (described below). Oh My Pi's probe is a held gap, not
  an exception. Octant-owned tools those threads reach stay confined either
  way. A runtime's own built-in tools (Codex's shell, Claude's Bash on the
  postures that write) run under that runtime's sandbox, not Octant's.
  A runtime's own built-in web search or page fetch appends
  `thread.external-content-ingested@1` where its adapter can observe it
  ([Persistence](#persistence), Provider runtimes' own web tools, lists which
  calls are observable), but the gate that mark applies to Octant's computer-use,
  MCP, and native-harness calls does not cover a tool the runtime executes
  itself. That boundary is accepted: the mark gates Octant's own tools only,
  and Claude's and Codex's built-in tools run under the runtime's own sandbox
  and approvals.
  A confined Claude Plan launch reads the assigned leaf of that account's
  state directory (`~/.claude` or `~/.claude-accounts/<instanceId>`) and
  writes only `sessions/` and its own session in `projects/`: the
  transcript `projects/<checkout>/<session>.jsonl` and the session's folder
  `projects/<checkout>/<session>/` (subagent transcripts, saved tool
  results), plus the launch temporary directory. `<session>` is the UUID
  Octant opens the session under (`--session-id`) or resumes
  (`--resume`); a launch whose arguments name neither gets no transcript.
  `<checkout>` is the runtime's own name for the canonical working
  directory: every character outside `[a-zA-Z0-9]` becomes `-`, and a name
  over 200 characters is cut there and gains a hash of the full path (read
  from Claude Code 2.1.300). That name is not unique (`/tmp/team-project`
  and `/tmp/team/project` share one), so the grant is the session and not
  the folder: other sessions' transcripts, in this folder or another, and
  every `memory/` folder, which a later session reads as instructions, stay
  read-only. Octant creates `sessions/` and the session's folder before the
  launch, but not the transcript, because the runtime refuses a new
  session id whose transcript already exists. Seatbelt grants the
  transcript path before it exists. Bubblewrap binds only what exists, so
  on Linux a new session's transcript is refused and a resumed one's is
  written. Measured unconfined with Claude Code 2.1.300 and a refused API
  key (no model call), a new session wrote only its transcript in that
  folder, and a resume appended to the same file in place. Measured on macOS 27 with Claude Code 2.1.299, one Plan turn
  wrote session records in `sessions/`, its transcript as
  `projects/<checkout>/<session>.jsonl`, and
  `.claude.json` (with a lock, a temporary file and a copy in `backups/`)
  and `.last-cleanup` at the top of the leaf. The top-level writes are
  refused, and the runtime carries on without them: a second measured
  Plan turn under the earlier grant of all of `projects/` answered and
  completed while its
  `.claude.json` lock and temporary file and its `.last-cleanup` were
  denied, its transcript landed in `projects/`, and the sandbox refused
  nothing else that the first turn had been allowed. No real turn has run
  yet under the narrower session grant. That keeps a Plan
  launch from writing what a later session outside this sandbox would
  load: `settings.json` and its hooks, `.claude.json` and its per-project
  MCP servers, `skills/`, `plugins/`, `agents/`, `commands/`, and any
  `memory/` folder. An
  earlier smoke test planted a `SessionStart` hook in `settings.json` from a
  Plan launch that was allowed to run Git. A subscription login kept in a
  file rather than the macOS Keychain, as on Linux, is the one file also
  writable, `.credentials.json` in the secure-storage directory, so the
  runtime can save a refreshed login (maintainer decision, 2026-10-14).
  The cost is that a Plan launch there could replace the stored login. An
  API-key launch and a macOS launch get no such file.
  The checkout must not be the leaf or a granted folder, sit inside
  one, or be an ancestor of one, so Plan cannot reopen the project
  through the account grant.
  A confined Claude launch on a subscription account signs in with the
  unmodified CLI, which on macOS reads its login by running
  `/usr/bin/security` against the login keychain. Measured on macOS 27.0.1
  with Claude Code 2.1.296, that read needs four things and nothing else:
  exec of exactly `/usr/bin/security`, `process-fork`, read of the one file
  `~/Library/Keychains/login.keychain-db`, and the two security-server
  lookups. With any one missing the runtime is signed out, so the launch
  takes all four, as Seatbelt `extraRules` and the fork switch, the same
  way an OpenCode launch may exec `/usr/bin/false`. No Keychain write and
  no other file in that folder is granted, and `/bin/sh` stays refused,
  which keeps hooks out. The cost: the confined runtime may fork, may run
  `security`, which returns any keychain item that trusts that tool, and
  may read the encrypted login keychain file. The driver refuses a file
  tool that names that folder, and the profile refuses both `security` and
  that file to every process but the runtime (and the file to `security`),
  so the grant serves the runtime's sign-in read and not the model. A
  launch on an API key takes none of it.
  Linux keeps the login in
  a file inside the account directory, which the launch already holds, and
  Seatbelt rules do not apply there.
  A Code Plan turn on macOS may run read-only commands through the Bash
  tool (`claudePlanRunsCommands`, `planCommandRules`). Only a launch that
  offers the Bash tool gets the grants below; a Chat or Work Plan launch
  and the readiness probes keep no fork and no exec but their own. The
  launch may fork,
  and may exec exactly these programs, by literal and resolved path:
  `/bin/zsh` (pinned as the tool's shell through `CLAUDE_CODE_SHELL`;
  without bash or zsh the tool refuses to start), `cat`, `ls`, `realpath`,
  `awk`, `basename`, `cut`, `diff`, `dirname`, `file`, `find`, `grep`,
  `head`, `sed`, `sort`, `stat`, `tail`, `tr`, `uniq`, `wc` and `xargs`
  from `/bin` and `/usr/bin`, and the first `git` and `rg` on the launch's
  `PATH`. A program on `PATH` that resolves into the checkout or a folder
  the launch may write is not listed. `/usr/bin/git` is a developer-tools
  shim that, measured on macOS 27.0.1 under this profile, failed every call
  (it reads `/var/select/developer_dir` under the `/private` denial and
  then starts `xcodebuild`), so the shim is not listed: the real Git of the
  active developer folder is, and a `git` link to it in the launch's
  temporary directory goes first on `PATH`. Everything else stays refused,
  `/bin/sh` and `/bin/bash` included, so a Git command a repository
  configures with arguments (`core.fsmonitor`, `core.pager`, a textconv, a
  `!` alias), which Git starts through `/bin/sh -c`, cannot start, and a
  configured program in the checkout cannot either. The shell also starts
  with Git's system and global files skipped, the fsmonitor off, the
  per-user ignore and attributes files at `/dev/null`, no optional index
  lock, `cat` as pager and no credential prompt; the model can set that
  environment aside, and the profile still holds. A Seatbelt rule's
  `process-path` names the program asking (measured on macOS 27.0.1), and
  the profile uses that to keep the runtime's reach with the runtime:
  only the runtime's own program has network, so the shell and what it
  starts reach no host (`git ls-remote git://…` and zsh's `ztcp` are
  refused); only `sandbox-exec` and the runtime may start the runtime's
  program, so a shell cannot start a second runtime with that network and
  an endpoint of its choosing. Writes are the runtime's too: a
  command writes only the launch's temporary directory, where the Bash
  tool keeps its output. `git log --output=` into the account's
  `settings.json`, `.claude.json`, `skills/`, `plugins/`, any `memory/`
  folder, another session's transcript or another checkout's folder, or
  into the checkout and its `.git/hooks`, is refused, and so is the same
  command into this session's own transcript or `sessions/`: those grants
  serve the runtime, and a command that rewrote the transcript could put
  words in the person's mouth for a later turn that resumes it with
  write access. Measured on
  macOS 27.0.1 with Claude Code 2.1.300, the real runtime under this
  profile, driven by a local scripted Messages endpoint with a fake
  key, ran `git log`, `git diff`, `git status`, `rg`, `ls`, `cat`, `grep`
  and `find` in the checkout, and every refusal above held. A Plan turn
  has no approvals, so a Plan command runs unasked: the profile, not a
  person, keeps it read-only. The account's state directories, which hold
  every session's transcript from every checkout, are the runtime's to read
  and refused to a command. What a command can still do: read whatever
  else the launch may read, checkout secrets and files outside the home
  folder included, into the model's context (which goes only to the
  provider), and write the launch's temporary
  directory, which is removed when the runtime exits. On Linux the Plan
  launch keeps its fork-denying seccomp filter, and Plan offers no Bash
  tool there. Before a confined launch starts, the
  `claude auth status` check that readiness uses runs inside that launch's
  sandbox: a sign-in the sandbox cannot read refuses the turn with the step
  that fixes it, instead of failing after the turn has started. Octant
  never reads, stores, or injects Claude OAuth tokens; a leftover
  helper-token envelope is deleted on upgrade, and the account form says
  to revoke it with Anthropic. A
  bound root a launch may not write is denied in the profile, so a checkout under that launch's own temporary directory is not
  writable through it. The `--version` read every family and the discovery
  scan perform before a runtime starts is wrapped too, with no root, no home, no network and one
  throwaway scratch directory it may write, per
  [decisions/0146-a-version-read-launches-confined.md](decisions/0146-a-version-read-launches-confined.md).
  Its environment is an allowlist (path, locale, user, terminal, time zone,
  its scratch directory, and the family's guards), so provider credentials
  and config-home variables are dropped; its process group is killed when the
  read settles. Credential-reading readiness probes are not version reads and
  still run unconfined: Claude's `auth status --json` and discovery's
  `authProbeArgs` read the person's own sign-in state, a standing gap like
  Oh My Pi's probe.
  OpenCode 2 runs `git rev-parse` at startup to resolve its project, and the
  Chat, Plan, and Work jail denies fork and exec outright. Rather than widen
  the jail to a real Git binary, a macOS 2.x launch gets a private stand-in: a
  `<TMPDIR>/git-standin-*/bin/git` symlink to `/usr/bin/false` placed first on
  the child's PATH, with `allowProcessFork` and exactly one exec grant,
  `(allow process-exec (literal "/usr/bin/false"))`. The spawn succeeds and
  git exits non-zero, which OpenCode reads as "not a git project" and serves
  the directory anyway. No real git, no shell, and no other exec becomes
  possible; OpenCode 1.x and Code mode are unchanged. The readiness probe
  attests at a directory with a `.git` marker under the Chat/Plan
  confinement and fails closed — listing-only, no turns — if a future
  OpenCode treats the failing git as fatal. Linux confinement cannot express
  that one exec without also allowing fork, which is the hole the Plan jail
  exists to close, so a 2.x Chat, Plan, or Work launch on Linux keeps fork
  and exec denied. The probe fails closed and the runtime stays listing-only
  there until Linux confinement can express the narrow per-path exec grant.
  Discovery re-allowances — a runtime asking whether a path exists and what it
  resolves to, not to read it — follow one rule. Each names an exact literal
  node, never a subpath, so entries inside it stay denied; a subpath grant is
  admissible only for a system-owned tree with no user content (the Simulator
  cryptex mount under `/private/var/run`). The verb is the weakest measured to
  work: `file-read-metadata` by default, `file-read-data` on a directory node
  only where metadata was measured insufficient, never on a file whose contents
  are not needed. The set is closed: only nodes the runtime actually probes and
  that exist are granted. Each rides the launch that needs it (`extraRules` or
  an explicit input flag), never the shared profile default, and is emitted
  after the denials because Seatbelt applies the last matching rule. OpenCode
  2's tool-home probe (`openCodeDiscoveryRules`) is the shape: literal
  metadata and read-data on `~/.claude` and `~/.agents`, metadata on
  `~/.claude.json`, while `~/.claude/settings.json` stays unreadable and
  unprobed homes such as `~/.codex` stay denied. Reading a person's
  configuration content or reaching outside the bound root is not discovery.
  A denial in this class usually surfaces as an empty result with exit 0, not
  an error, so a fix is proven from the runtime's own output, not its exit code.
  Confined Git reads no configuration from the person's home: every launch sets
  `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`, and a commit takes
  its author from the host's recorded identity when the checkout names none. In a
  linked worktree it may read the metadata its own worktree names — the
  `gitdir` the bound root's `.git` file points at and that directory's
  `commondir` — and nothing else outside the bound root
  (`gitLinkedWorktreeMetadataPaths`). Because the `.git` file is writable by
  anyone who can write the checkout, the grant requires Git's reciprocal
  record: the `gitdir` sits in a `worktrees` directory, its `gitdir` file
  points back at this marker, and its `commondir` resolves to the main
  repository's `.git`. On macOS each ancestor of the two paths gets literal
  `file-read-metadata` only, for Git's component-by-component walk, plus
  literal reads of the two xcode-select links the `/usr/bin/git` shim needs;
  on Linux the same paths are bound, and only when they exist. Write on that
  metadata is off by default and requested per launch (`writable`), only by a
  mutation launch whose policy in force is not Plan: the rules are appended
  last and would otherwise outrank the launch's own read-only posture.
  Observation stays read-only for every caller; mergeability runs
  `merge-tree --write-tree` against a quarantined object directory that reads
  the real objects through an alternate. A launch names every directory it
  writes outside the bound root, since on Linux an unnamed one under the
  private tmpfs does not exist for the confined process.
  Toolchain commands the Android workbench issues keep their own deliberate
  carve-out: `~/.android` — the AVD store, adb keys, and emulator lock files —
  plus a non-empty `ANDROID_AVD_HOME` when configured are bound read-write even
  under the private-home deny, because `emulator -list-avds` exits 0 with an
  empty list when it cannot reach the store and the pane would report no
  devices forever. An empty `ANDROID_AVD_HOME` is treated as unset rather than
  forwarded, since a non-absolute grant path would make the confinement
  builder refuse every Android command.
  The Apple `test` action stays confined too, and splits so the extra reach
  touches only the phase that needs it: `build-for-testing` runs under the
  ordinary profile, which keeps the project's Run Script phases away from the
  widened reach, while `test-without-building` carries a closed set of
  per-launch grants through `extraRules`, never the shared profile default:
  literal `file-read*` on `~/Library/Developer/Xcode/SDKToSimulatorIndexMapping.plist`;
  literal `file-read-metadata` on `/private`, `/private/var`, and
  `/private/var/tmp`; `file-read* file-write*` over
  `^/private/var/tmp/com\.apple\.launchd\.[^/]+(/.*)?$`, the per-boot launchd
  session socket family; `mach-lookup` on `com.apple.PowerManagement.control`,
  `com.apple.testmanagerd.control`, `com.apple.dt.instruments.dtarbiter.xpc`,
  and `com.apple.dt.instruments.dtsecurity.xpc`; `pseudo-tty` with
  `file-write*`/`file-ioctl` on `/dev/ptmx` and `/dev/ttys<N>`;
  `job-creation`; and untargeted `signal`. No other Apple launch receives any
  of them. Xcode's `IDETestProgressNotification` post stays denied: it is
  cosmetic to a CLI run.
  _Rationale:_ each grant is the weakest spelling that cleared a measured,
  fatal refusal — an empty destination list, an aborted power assertion, an
  unreachable session socket, "Pseudo Terminal Setup Error", a runner that
  could not launch, and hangs at `testmanagerd`, the DT arbiter, and "Testing
  started" — and no single grant unblocks the run alone. `signal` is the
  broadest: the session kills a stale app copy it did not fork, and denying it
  hangs every later session; the launch still cannot read user files, open the
  network, or leave its root. A future xcodebuild refusal is measured and added
  to this list, never to the shared profile.
  Apple builds prepare a private derived-data directory per action and grant
  writes to that directory only for its `xcodebuild` phases. Run installation
  reads its product from the same directory without write access; XCTest
  results also land inside it. Simulator captures remain isolated in their own
  private directory and are writable only by the capture launch.

- **Provider capability matrix ("degraded on").** Claude Code and Codex are the
  first-class providers: the two subscription coding runtimes the product is
  built around. A feature may be built in full for them first. Every other
  provider is listed below with what is weaker, and reports the capability
  `unsupported` or `unavailable` and fails closed where it has no form of it.
  Nothing in code makes the providers match; the conformance harness checks
  that a driver reports its own capabilities honestly, not that drivers agree.
  A feature only some providers have still reaches the others through
  `@octant/provider-sdk` or `@octant/plugin-api`, and no seam is widened for one
  vendor.

  The first token of each cell is what the driver declares in its static
  capability block (`ProviderCapabilitySupport`, or `absent` where the block
  omits an optional capability, which reads as `unsupported`; `varies` where the
  value is computed per install, profile, or model). The words after it say how
  that value is refined once the driver probes or runs. A refinement that
  upgrades a declaration (`unavailable` to `supported` after a reply reports
  usage) is the degraded form: the capability exists but is not promised before
  it is seen.

  | Capability               | Claude Code                                                  | Codex                                                     | OpenCode                                                          | Pi                                                                             | ACP agents                                                                    | Ollama                                                    | Harness endpoints                                                                 | Oh My Pi                              |
  | ------------------------ | ------------------------------------------------------------ | --------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------- |
  | `streaming`              | `supported`                                                  | `supported`                                               | `supported`                                                       | `supported`                                                                    | `supported`                                                                   | `unavailable` until a reply streams                       | `unavailable` until a reply streams; a chat-completions endpoint may answer whole | `supported`                           |
  | `resume`                 | `supported`                                                  | `supported`                                               | `supported`                                                       | `supported`                                                                    | `supported`; `unsupported` when the agent offers neither load nor resume      | `supported` by replaying history Octant holds             | `supported` by replaying history Octant holds                                     | `unsupported`                         |
  | `interruption`           | `supported`                                                  | `supported`                                               | `supported`                                                       | `supported`                                                                    | `supported`                                                                   | `supported`                                               | `supported`                                                                       | `supported`                           |
  | `approvals`              | `supported`                                                  | `supported`                                               | `supported`                                                       | `supported`                                                                    | `supported`                                                                   | `unsupported`                                             | `unsupported`; every Harness tool call passes the server instead                  | `unsupported`                         |
  | `userQuestions`          | `supported`                                                  | `unsupported`                                             | `supported`; `unsupported` on the 2.x route                       | `unsupported`                                                                  | `varies`: `unsupported` on Mistral Vibe and fx                                | `unsupported`                                             | `unsupported`                                                                     | `unsupported`                         |
  | `reasoning`              | `supported`                                                  | `supported`                                               | `supported`                                                       | `supported`                                                                    | `unavailable`; `supported` when the agent reports a reasoning option or model | `varies`: from each model's reported thinking             | `unavailable` until a response carries reasoning                                  | `supported`                           |
  | `usage`                  | `supported`                                                  | `supported`                                               | `supported`                                                       | `supported`                                                                    | `unsupported`; turns are not measured                                         | `unavailable` until a reply reports counts                | `unavailable` until a response reports usage                                      | `unsupported`; turns are not measured |
  | `toolActivity`           | `supported`                                                  | `supported`                                               | `supported`                                                       | `supported`                                                                    | `supported`                                                                   | `varies`: from the models' tool support                   | `unsupported`                                                                     | `unsupported`                         |
  | `fileChanges`            | `supported`                                                  | `supported`                                               | `unsupported`                                                     | `unavailable`                                                                  | `unavailable`                                                                 | `unsupported`                                             | `unsupported`                                                                     | `unavailable`                         |
  | `diffs`                  | `supported`                                                  | `supported`                                               | `supported`                                                       | `unavailable`                                                                  | `unavailable`                                                                 | `unsupported`                                             | `unsupported`                                                                     | `unavailable`                         |
  | `taskProgress`           | `supported`                                                  | `supported`                                               | `supported`                                                       | `unavailable`                                                                  | `supported`                                                                   | `unsupported`                                             | `unsupported`                                                                     | `unavailable`                         |
  | `nativeChildAgents`      | `unsupported`; Octant owns delegation                        | `unsupported`; Octant owns delegation                     | `unsupported`                                                     | `unsupported`                                                                  | `unavailable`                                                                 | `unsupported`                                             | `unsupported`                                                                     | `unsupported`                         |
  | `nativeAttachments`      | `unsupported`                                                | `unsupported`; `supported` when a model takes image input | `unsupported`; `supported` when a model takes non-text input      | `unsupported`                                                                  | `unsupported`                                                                 | `varies`: `supported` when a model takes images           | `unsupported`                                                                     | `unsupported`                         |
  | `nativeWebResearch`      | `unsupported`                                                | `unsupported`                                             | `unsupported`                                                     | `unsupported`                                                                  | `unsupported`                                                                 | `unsupported`                                             | `unsupported`                                                                     | `unsupported`                         |
  | `appManagedTools`        | `supported`                                                  | `supported`                                               | `unsupported`; `supported` on macOS in a verified isolated config | `unsupported`; `supported` once the probe attests the tool bridge on Pi 0.85.1 | `varies`: `supported` on macOS when the agent serves HTTP MCP                 | `unsupported`                                             | `unsupported`; `supported` for each model a person verified                       | `unsupported`                         |
  | `acpClientCapabilities`  | `absent`                                                     | `absent`                                                  | `absent`                                                          | `absent`                                                                       | `supported`                                                                   | `absent`                                                  | `absent`                                                                          | `absent`                              |
  | `modelSwitch`            | `supported`                                                  | `supported`                                               | `absent`; the session stays on its model                          | `absent`; same                                                                 | `absent`; same                                                                | `absent`; Octant replays history, so the model may change | `absent`; Octant replays history, so the model may change                         | `absent`                              |
  | `sessionCompaction.chat` | `supported`; `unavailable` when the install lacks `/compact` | `supported`; `unavailable` before Codex 0.162.1           | `absent`                                                          | `absent`                                                                       | `absent`                                                                      | `absent`; Octant summarizes                               | `unsupported`; Octant summarizes                                                  | `absent`                              |
  | `sessionCompaction.work` | as Chat                                                      | as Chat                                                   | `absent`                                                          | `absent`                                                                       | `absent`                                                                      | `absent`                                                  | `unsupported`; Octant summarizes                                                  | `absent`                              |
  | `sessionCompaction.code` | as Chat                                                      | as Chat                                                   | `absent`                                                          | `absent`                                                                       | `absent`                                                                      | `absent`                                                  | `supported`; Octant Harness compacts its own transcript                           | `absent`                              |
  | `citations`              | `unsupported`                                                | `unsupported`                                             | `unsupported`                                                     | `unsupported`                                                                  | `unsupported`                                                                 | `unsupported`                                             | `unsupported`                                                                     | `unsupported`                         |
  | `harnessAutoReview`      | `supported`                                                  | `supported`                                               | `unsupported`                                                     | `unsupported`                                                                  | `unsupported`                                                                 | `unsupported`                                             | `unsupported`                                                                     | `unsupported`                         |

  Which driver kinds each column covers, and how each may be used in a mode, as
  `providerCatalogCapabilities` in `@octant/domain` holds it. A runtime's Work and
  Code tools reach the models its connection check reports with tool use;
  Harness endpoints reach them only for models a person verified.

  | Column            | Driver kinds                                                                                                     | Chat  | Work              | Code              | Agent loop       |
  | ----------------- | ---------------------------------------------------------------------------------------------------------------- | ----- | ----------------- | ----------------- | ---------------- |
  | Claude Code       | `claude`                                                                                                         | `yes` | `checked-models`  | `checked-models`  | `runtime`        |
  | Codex             | `codex`                                                                                                          | `yes` | `checked-models`  | `checked-models`  | `runtime`        |
  | OpenCode          | `opencode`                                                                                                       | `yes` | `checked-models`  | `checked-models`  | `runtime`        |
  | Pi                | `pi`                                                                                                             | `yes` | `checked-models`  | `checked-models`  | `runtime`        |
  | ACP agents        | `kilo`, `devin`, `mistral-vibe`, `kimi-code`, `grok`, `goose`, `glm`, `gemini`, `copilot`, `cline`, `qwen`, `fx` | `yes` | `checked-models`  | `checked-models`  | `runtime`        |
  | Ollama            | `ollama`                                                                                                         | `yes` | `no`              | `no`              | `replies-only`   |
  | Harness endpoints | `openai-compatible`, `anthropic-compatible`, `azure-foundry`                                                     | `yes` | `verified-models` | `verified-models` | `octant-harness` |
  | Oh My Pi          | `oh-my-pi`                                                                                                       | `no`  | `no`              | `no`              | `none`           |

  The image profiles (`openai-image`, `gemini-native-image`, `bfl-image`,
  `ideogram-image`) are not turn drivers and are not in the matrix.

  Where each provider is weaker than Claude Code and Codex:

  - **Codex** has no user questions, so a question the model would ask is not
    offered. It takes image input only when a model reports it. Compaction
    needs Codex 0.162.1 or newer.
  - **OpenCode** reports no file changes, has no model switch inside a session
    and no runtime compaction, and offers Octant's tools only on macOS in the
    verified isolated configuration. A 2.x runtime whose confined jail cannot
    serve a Git work tree is listing-only: models show, no turn is offered.
  - **Pi** reports no user questions, file changes, diffs, or task progress,
    and offers Octant's tools only after its probe attests the tool bridge on
    the one release that bridge was read against.
  - **ACP agents** do not report usage, so a spend ceiling leaves their turns
    out and says so. They report no file changes or diffs, ask no user
    questions on Mistral Vibe and fx, resume only when the agent offers load or
    resume, and offer Octant's tools only on macOS when the agent serves HTTP
    MCP. fx is also refused in Chat and Plan.
  - **Ollama** is replies only: Chat, no tools, no approvals, no questions, no
    file changes. Streaming, reasoning, usage, and tool activity are claimed
    only after a reply shows them.
  - **Harness endpoints** carry the Octant Harness agent loop. They have no
    provider approvals or questions, claim streaming, reasoning, and usage only
    after a response shows them, and offer Octant's tools per verified model.
    Chat and Work compaction is the host's, not the endpoint's.
  - **Oh My Pi** lists models and starts no session; its driver refuses
    `acquire`, so it never reaches a picker.

  `providerFeatureMatrix.test.ts` pins this section: every
  `ProviderCapabilities` field has a row, every non-image driver kind appears in
  exactly one column, the leading token of each cell equals the value in the
  driver's static capability block, and the mode columns equal
  `providerCatalogCapabilities`. It cannot see a refinement made at probe time
  (the words after the first token), nor the compaction rows, which the drivers
  assign outside the static blocks; the conformance harness covers the
  compaction claim, and the rest is reviewed with the driver.

- **ACP client capabilities.** ACP client filesystem and terminal effects are
  executed by Octant inside the Code confinement, with bounded reads, writes,
  terminal lifetimes, and output. Terminal requests with direct `args` use
  direct argv; requests without `args` run their command line through the
  confined shell. Writes are placed through a confined process, and execution
  posture is re-checked for every write and terminal creation.
  Provider terminal overlays cannot replace `TMPDIR`, `PATH`, or `HOME`.
  They are journaled as app-managed tool events, refused in Plan mode, and
  governed by the thread's execution posture together with provider-approved
  permission; the ACP provider does not gain a second permission prompt or a
  path outside the bound checkout. These capabilities are offered whenever the
  driver reports `acpClientCapabilities`, independently of whether the
  app-managed HTTP MCP bridge was negotiated.
- **Project terminals.** A person may open a terminal for a Code Project with
  no thread. It is the person's shell, not an agent's: no provider, tool call,
  AgentRun, or thread can address it, read its output, or type into it, and
  nothing it prints enters a prompt. Only an active Code Project has one. A
  Work Project has no shell authority, so it has no Project terminal and Work
  never gains a shell this way; Chat has no root. The shell runs at the
  Project's bound root at its current binding revision (the Project's own
  folder, never a thread's managed worktree) through the same confinement a
  Code thread's terminal gets, with its own shell state and no credential
  references. Only the person at a local window whose workspace holds that
  Code Project may start, attach to, type into, resize, or stop it. That is the
  user-initiated terminal the Code policy already lets a local person open in
  an approval-gated thread without a prompt, so it asks for none and reaches no
  further than that thread's terminal. A paired device is refused outright:
  a remote Code terminal is gated as an agent, and a Project terminal has no
  thread to hold that approval. The shell runs under the posture a new thread
  in the Project starts with, approval-gated or Full access where the Project
  remembers it; Plan never applies, because nothing plans in it. The owning
  window, Project, and binding revision are checked before every command, and
  another window cannot attach. Its lifecycle is journaled on its own
  `project-terminal` aggregate (`code.project-terminal-started@1`,
  `code.project-terminal-ended@1`); its output stays in the host's bounded
  in-memory transcript and is never journaled, because it belongs to no
  thread's record. Archiving the Project or relinking its root ends every one of
  its terminals as `authority-revoked` at once, and a command that finds the
  Project inactive or rebound ends the terminal the same way. A host restart
  ends a terminal still recorded as running as `host-restarted`, since its
  process did not survive.
- **Terminal Browser grant.** A person may start a Code thread
  terminal with a Browser grant, so a provider CLI they type there can drive
  that thread's Browser and nothing else. It is off by default, asked for per
  terminal, and honored only from a local window: a paired device, a routine, or
  an agent is refused and no terminal starts. Only an active Code thread has
  one; Work has no shell, and the Project terminal cannot ask. The host mints a
  grant bound to one host run, thread, terminal session, and window, holds it in
  memory only, and starts the terminal with two variables through its brokered
  credential path: the address of a loopback endpoint of that grant's own
  (unguessable path, bearer token, `Host` check) and the token. Calls run as the
  thread through the same Browser tool set a managed turn gets, so the per-action
  policy, origin approval, taint, and Plan refusal are unchanged, no screenshot is
  kept as a thread capture, and the desktop bridge secret is never involved.
  The grant ends when the terminal closes, the person switches it off, the
  thread is completed, archived, or purged, its window loses authority, or the
  host stops; a revoked or unknown grant answers every call `unauthorized`. Issue
  and end are journaled without the token or address. The window switches a
  terminal on with a restart the person confirms, shows the state the host
  reports, and shows the first effect on an origin as a request from the
  terminal, not from the thread's agent. The packaged macOS app ships an
  `octant` that runs only `octant mcp`, with the app's own executable in Node
  mode; a granted terminal, and no other, starts with its folder first on
  `PATH` and may read that folder and the app runtime it starts with, nothing
  more. Detail is in
  [Terminal Browser grant](design/terminal-browser-grant.md).
- **Terminal shell configuration.** On macOS a thread or Project terminal is
  the person's login shell (`-l`), and its read roots add, read-only and only
  where they exist, the shell's rc and login files, the framework trees they
  source, and the tool homes PATH points into, each listed in
  `apps/server/src/code/terminalProcessPort.ts`. The rest of the home stays
  enumerated as denied and writes stay in the bound root and the shell's own
  state directory. A file is named wherever a file is enough. A directory is
  granted only when the tool reads it as a tree: a framework (`~/.oh-my-zsh`,
  `~/.config/fish`) sources files throughout it, and a version manager's shims
  resolve to toolchains elsewhere in its home (`~/.local/share/mise`,
  `~/.asdf`, `~/.pyenv`, `~/.rbenv`, `~/.volta`, `~/.nvm`, `~/.bun`,
  `~/.rustup`), so naming only the shim directory still breaks every command
  behind it. No listed directory is where a tool keeps credentials; a home that
  shares its directory with one is granted by its executable subdirectory
  (`~/.cargo/bin`, never `~/.cargo`), and credential homes such as `~/.ssh`,
  `~/.aws`, and `~/.config/gh` are never listed. Homebrew and other prefixes
  outside the home are already readable. A path a rc sources that is not
  listed fails at the prompt as a permission error rather than widening the
  grant; adding one is a change to the list under this rule. On Linux the
  shell's HOME is its state directory with a minimal rc, so none of this
  applies there.
- **Project browsing contexts.** A person may open a browser for a Work or Code
  Project with no thread, under the same separation: it is the person's
  browser, never an agent's. Its page lives in its own isolated, ephemeral
  context, registered with the browser runtime under an owner id derived from
  the Project (never a thread id), so no thread's surface can attach to it and
  no thread's origin approval carries into it. A separate Project browser
  service owns these contexts; the agent's browser tools resolve contexts only
  through the thread-owned automation service, which never sees them, and the
  runtime is handed only the page action, never an authority. Only the person
  at a local window whose workspace holds that Project for its mode may open,
  read, or close it; a paired device is refused outright, because creating a
  browsing context is already local-only and a Project page has no thread
  whose approval could stand in. It opens only http and https addresses; a
  page on the same site takes a new address in place, and another site starts
  a fresh context whose allowlist is that site. It carries the host's usual
  session ceiling and is not journaled, like a thread's browsing context.
  Archiving the Project, relinking its root, turning its mode off, the window
  moving to another Project, or the window's authority ending closes it. On the desktop app the page is a live native view; elsewhere the
  host drives a headless page and shows its picture.
- **Side Chat reads.** A Side Chat may read its source thread's transcript,
  state, and files; it never inherits the source's Work or Code execution
  authority. The file tools (`octant_side_chat_list_files`,
  `octant_side_chat_search_files` for Code, `octant_side_chat_read_file`)
  are the only tools it gains. Before every call the host checks that the
  sidecar link still exists and that the caller's window can still Open the
  source, and the call then runs through the same host read the Files panel
  uses (Code's checkout listing and search; Work's folder listing and
  confined read), which re-authorizes the window against the source's root. A
  Code read goes through `CodeService.readFile`, the same checkout authority
  and confinement sequence without the desktop file helper that the editor's
  open needs, and Code calls wait briefly while the host is still resolving a
  `waiting` checkout. Paths are relative and confined; results are bounded and recorded as
  external content like other app-managed tool results. There is no write,
  shell, Git, or network tool, and a provider that cannot take app-managed
  tools gets none and is told the files are unreadable. The `#thread`
  dialogue tool is refused for a sidecar, in both directions, before anything
  reaches the target.
- **Subagents.** Child runs receive equal-or-narrower authority, clamped
  server-side; Code children require a verified isolated worktree receipt.
  A managed child, whether driven by Octant's harness or a provider harness,
  receives `octant_canvas` bound to the workspace and Project the host resolved
  for that run. The model cannot name a path. Create and revise succeed only
  inside that scope; another Project or an unresolved checkout is refused, and
  the child run is the author. A Code child's scope is the managed worktree the
  host allocated for that delegation, found through the same receipt lookup that
  allocated it and valid only while that receipt is ready and still names the
  worktree the run was admitted with; a child's worktree is never a journaled
  thread checkout, so none is required. A provider transport that cannot carry
  app-managed tools fails the start with a typed reason rather than dropping
  the tool. Each adapter turns its provider's own subagent feature off, because a child
  the provider starts itself runs outside the journal and the approval path.
- **Canvas design images.** A design frame never loads anything itself. The
  server resolves the images a design declares on every read, through the
  authorized Canvas read and under the version's mode, Project, and thread: a
  Chat Project reaches only images generated in its own threads, and Work and
  Code files pass the Work confinement sequence. Only sniffed raster images
  within the per-image and per-design budgets are returned, the renderer
  inlines them as `data:` images, and the journal holds references only
  ([Canvas HTML frames threat model](security/canvas-html-frames-threat-model.md), F5).
- **Remote clients.** Pairing issues a revocable device key; the private
  listener is HTTPS on a LAN or Tailscale address with a host-owned identity.
  Remote requests are classified fail-closed by an admission policy and route
  classifier. A remote principal can never exceed host, mode, provider, Project,
  or thread authority, cannot mint local receipts, and every remote mutation is
  journaled with its principal. The listener, pairing tickets, pairing
  decisions, and device inventory are administered only over the host's
  loopback administration channel — the desktop bridge secret plus a
  registered window capability — which both Settings → Remote access and the
  `octant listener` / `octant pair` / `octant auth` commands use; the private
  listener forwards none of those routes. A listener enabled there is
  remembered owner-only under the data directory (the boundary that holds the
  host identity key), with a pasted certificate's TLS key or, for a self-made
  certificate, only that it is self-made, and re-enabled when the server
  starts; a server shutdown keeps it and only a local disable forgets it.
  A paired client may click, scroll, and press keys in the host's agent
  browser, but may not navigate it, type into it, or close a tab. Those clicks
  and keys can still follow a link or submit a form within the context's
  approved origins; the host's navigation guards refuse any page outside them,
  so a paired client cannot take the host browser to a new origin.
  - **Host identity on every connection.** Every hello request a client
    makes names a fresh client nonce, 32 random bytes in unpadded base64url:
    `GET /api/remote/hello?clientNonce=…`. The host hello carries the host
    identity public key (DER SubjectPublicKeyInfo, base64url), its fingerprint
    (SHA-256 of those bytes, lowercase hex), that client nonce, an expiry, and
    a signature over the hello. Every client (phone, desktop window reaching
    another host, and the paired browser page) checks that the key hashes to
    the stated fingerprint, that the hello echoes the nonce it just sent, that
    the signature verifies, and that the hello has not expired (allowing two
    minutes of clock skew) before it sends a pairing claim or a challenge
    request. At pairing it records the proven fingerprint with the device
    registration; on every later hello it also requires the proven host id
    and fingerprint to equal that record. The paired browser page claims a
    ticket only through a hello answering a nonce it sent itself.
    - **Signed payload.** A hello answering a client nonce is signed as
      `octant.host-hello.v2`, a newline, then one JSON array of the hello's
      fields in a fixed order (product id, host id, display name, key
      fingerprint, build version, protocol range minimum and maximum, the
      authentication versions as a nested array, security floor, remote
      origin, host nonce, client nonce, expiry). Version 1 joined the fields
      with newlines, and a display name or build version may itself hold a
      newline, so two hellos could join to the same text; the JSON array
      decodes to exactly one hello.
    - **Hello route.** The route accepts no query or exactly one
      `clientNonce` of 22 to 128 base64url characters and refuses anything
      else with 400. A request without a nonce, from a client built before
      client nonces, gets the version 1 hello it verifies, without the field.
      Outcomes:
    - A hello that states the paired fingerprint without proving the key,
      relabels another host's signed hello, or answers another request's
      nonce (a recorded hello replayed) is refused with "This host could not
      prove its identity". An expired hello is refused the same way.
    - A proven hello from a different host id or key is "host identity
      changed".
    - A hello with no key or no client nonce, or a 404 for the hello request
      (a host built before client nonces treats a query on that route as an
      unknown route), comes from a host built before these checks. The client
      refuses it as incompatible and asks to update the host. It never asks
      again without a nonce.
    - No refusal deletes the device key, and neither does a 401 naming the
      device revoked or expired: those answers arrive before the client has
      authenticated the live peer. The key goes only when the person pairs
      again (the new approval replaces the origin's other registrations),
      signs out, or removes the host from the desktop's federated hosts.

    What this does not stop: the client nonce proves the key holder answered
    this hello request, but nothing after the hello is bound to that answer,
    and the client does not check the negotiation record's `hostSignature`.
    Something that can reach the real host while it answers at the paired
    address (a relay that terminates TLS for the listener's name with a
    certificate the client trusts) can pass the live hello through and
    answer or forward the rest. Pinning the listener certificate, in the
    client trust rule and one-step pairing below, is what closes that.
    Anything that answers at the address can still refuse service, for
    example by signing a hello with its own key, answering 404, or answering 401. First contact is trust on first use over TLS.

    Rollout. The client nonce ships with hello verification, in one release.
    Clients built before hello verification send no nonce and keep getting
    version 1 hellos, so updating a host first never locks them out (apart
    from the strict-decode limit below). An updated client refuses a host
    built before client nonces as needing an update and keeps the pairing,
    so the host should be updated with or before its clients.

    Records written before hellos were checked need no migration: the host has
    always stated the SHA-256 of the key's SubjectPublicKeyInfo, so those
    fingerprints already pin the key. Clients that decode the host hello
    strictly (built before host answers ignored unknown fields) refuse a hello
    carrying the key, so a host with this check ships only after paired
    clients run a release that ignores unknown hello fields. The listener's
    `certificateFingerprint` is likewise the SHA-256 of the leaf
    certificate's SubjectPublicKeyInfo, not of its PEM text. It is shown in
    Settings and by `octant listener` for the person to compare, and no
    client pins it.
- **Listener certificate.** The listener serves a certificate and key the
  person pastes exactly as given, or, when enabled with neither (the
  administration route without PEMs, or `octant listener enable` without
  `--cert` and `--key`), a certificate the host makes itself. A pasted
  certificate always wins, and the self-made key then stays unused on disk.
  - **Key and certificate.** The self-made key is its own ECDSA P-256 key, not
    the host identity key, which signs the remote hello and whose rotation
    revokes every device. The certificate is a self-signed X.509 v3 leaf for
    it: SHA-256 signature, a random 128-bit serial, basic constraints not a
    certificate authority, extended key usage server authentication, one
    subject alternative name for the listener's address (an IP entry for an
    address, a DNS entry for a name), valid for one year. An in-tree DER
    writer encodes that one shape, because the platform crypto API makes keys
    but not certificates; its tests read the result with the platform X.509
    reader and complete a TLS handshake against it.
  - **Storage.** The key is `remote/private-listener-tls-key.pem` and the
    certificate `remote/private-listener-tls-cert.pem` under the data
    directory. The directory is narrowed to `0700`. Each file is written to a
    staging file created exclusively, `0600`, without following a link, then
    flushed, renamed over the target, and the directory flushed, so a crash
    leaves the old file or the whole new one. Both files are opened without
    following a link and without blocking, and anything but a regular file is
    refused. The listener's bind and origin are checked before either file is
    touched, so a public or malformed address never makes a key, and a name
    the certificate cannot carry (an IPv6 zone, or a DNS name that is not
    lowercase ASCII labels of 1 to 63 characters) is refused.
  - **Key refusals.** The host refuses a key file that another OS user owns
    or that other users can open: the listener reports failed with
    `tls-key-exposed` and serves nothing, and the file is left as it is. That
    check reads the owner and mode bits only; an access control list that
    lets another user read the file is not detected. A key file reached
    through a link, that is not a regular file, or that is not a P-256 key
    fails as `invalid-tls` and is never overwritten, because a new key would
    silently change the pin. The one exception is an empty, owner-only key
    file, which holds nothing that could have leaked and is what a crash
    before the contents reached the disk can leave: the host makes a new key
    in its place.
  - **Keeping and removing.** Disabling the listener keeps the key. Complete
    data removal deletes the key, the certificate, the remembered listener
    setting, and any staging file a stopped write left beside them, with the
    store, so the listener stays off afterwards; a link in place of one of
    those files is removed as the link, and its target is left alone. The key
    never appears in a route response, the status projection, a log line,
    the journal, a diagnostics read or export, or an error message.
  - **Renewal.** Every enable, restart, and server start checks the
    certificate. One that is missing, unreadable, made for another key or
    address, not yet valid, or within 30 days of its end is replaced by a new
    one for the same key, so renewal and a moved address never change the
    pin. Nothing renews a certificate while the listener keeps running.
  - **Pin and status.** The listener status carries `certificateSource`
    (`self-made` or `pasted`) and, for a self-made certificate, `tlsPin`:
    `sha256-` followed by the unpadded base64url SHA-256 of the certificate's
    DER SubjectPublicKeyInfo. The existing `certificateFingerprint` is the
    lowercase hex of the same hash, shown for comparison, and no client reads
    it as a pin. Only the loopback administration status
    carries the pin; `octant listener status` prints it.
  - **Which apps pin.** The desktop app and the phone app pair with another
    computer from its app pairing code and pin it (below). The phone app's
    web build has no native module that can check a pin, so it refuses a
    code before sending anything. Settings still asks for a certificate and
    key, and `octant listener`'s usage line still names them.
  - **No browser link.** A browser decides whether to trust the listener
    before any Octant page loads and cannot check a certificate the host made
    itself, so Settings offers no browser pairing link for a self-made
    listener and says why; a browser pairs only with a pasted certificate.
  - **Pairing code.** For a self-made listener that is up, Settings → Remote
    access and `octant pair` offer an app pairing code instead:
    `octant-pair-1.` followed by the unpadded base64url of the JSON object
    `{"origin","ticketId","ticketProof","pin"}`, in that key order with no
    whitespace, holding the listener's origin, a pairing ticket's id and
    proof, and its `tlsPin`. It carries no key material, and it has no URL
    scheme, so no operating system hands it to an app that registered one.
    The ticket is an ordinary pairing ticket — five minutes, single use,
    approved on the host — minted for the listener's own network class,
    because the device claims it over the listener; `octant pair --source`
    naming another class is refused, and a pasted-certificate listener keeps
    the browser link and `octant pair`'s bare ticket. A listener whose origin
    or pin no code can carry is refused before a ticket is minted. Settings
    keeps a code only while its ticket is live and the listener it names is
    unchanged: it drops the code when the ticket expires, when the listener
    moves or turns off there, and when a status it re-reads on window focus
    and every five seconds names another origin or pin, as after an
    `octant listener` change.
    Both show the same text as a QR code, dark on light with a four-module
    quiet zone, drawn by `lean-qr` (MIT, no dependencies), the one QR encoder
    Settings and the CLI share: an in-tree encoder would be more code than
    the rest of one-step pairing. Settings shows the code only in the host's
    own window, the only one with the loopback administration bridge.
  - **Reading a code.** A reader accepts only the exact text the builder
    makes, so one ticket has one code. A later code version or a pin
    algorithm other than `sha256` is refused as needing a newer Octant,
    never skipped. A missing, extra, or repeated field, a malformed id,
    proof, or pin, a non-canonical base64url spelling, or an origin that is
    not exactly an HTTPS origin is refused as damaged. The origin's shape is
    matched by pattern before `URL` reads it, and its host is taken from
    that match, because the phone's JavaScript engine ships a `URL` that
    only matches patterns: its `origin` keeps credentials and a second port. An origin the listener
    address classifier does not call private LAN or Tailscale is refused as
    not private: for an address literal that means `10/8`, `172.16/12`,
    `192.168/16`, `100.64/10`, `fc00::/7`, and `fe80::/10`, judged on the
    parsed address, never its text prefix. A name is judged by its spelling
    only, so the reader cannot prove a named origin is private: any
    `*.ts.net` name passes, and public Tailscale Funnel names are `*.ts.net`
    too. The client trust rule below closes that before a client sends
    anything. The builder refuses the same contents, so the host never shows
    a code a client would refuse.
  - **Client trust rule.** The client runtime holds one rule every client
    that reaches another host as a paired device applies; each platform's TLS
    layer gathers the facts and sends no request bytes until the rule
    accepts.
    - **What a client keeps.** Each origin's pairing record (the device key's
      metadata and the client host registry) holds that origin's trust:
      `platform`, or `pinned` with a `sha256-` pin taken only from a pairing
      code. A record from before pins, or for a pasted certificate, holds
      `platform`. A stored trust that cannot be read is never read as a
      weaker one: the device-key record stops resolving, so the device pairs
      again, and the host registry refuses to load. Replacing the device key
      keeps the origin's trust.
    - **Certificate.** A pinned origin passes only when the served leaf
      certificate's SubjectPublicKeyInfo hashes to the pin. That check
      replaces platform chain, name, and date validation and never falls back
      to it, so a certificate a public authority issued for the same name
      does not pass, and the certificate's dates are not checked: anyone
      holding the key can make a fresh certificate, and a device with a wrong
      clock would be locked out. An origin with no pin passes only on
      platform validation, so it never accepts a self-made certificate. A pin
      naming another hash is refused as needing a newer Octant.
    - **Address.** Before connecting, a client resolves the origin's name and
      refuses unless every address it resolves to is an IP address the
      listener address classifier calls private LAN or Tailscale; one public
      answer refuses the whole name. It connects to the judged address, not
      the name, and judges the connected peer address the same way before the
      TLS handshake starts. An IPv4-mapped IPv6 form or a zone is refused, not
      unwrapped, and so is a zero-padded IPv4 address such as `010.0.0.1`,
      which a URL parser and the system resolver read as octal; the listener
      address classifier refuses it everywhere for the same reason.
    - **Staged trust.** An origin's trust may carry a staged next trust and
      the end of its window. Until then either trust passes, and the first
      connection that passes only the staged one makes it current and drops
      the old; after it, only the current trust passes. A window ending more
      than 30 days after the client's now is ignored, since the host never
      announces a longer one. Nothing records a staged trust yet: the host's
      announcement route is planned.
    - **Copy.** A pin mismatch says "This isn't the computer you paired with:
      its security key has changed. Octant stopped before sending anything.
      If its key was replaced on purpose, pair again from that computer."; a
      certificate platform validation refuses says "Octant couldn't verify
      this computer's certificate. Pair with the full pairing code or QR code
      from that computer."; an address outside the private network says
      "This computer's address isn't on a private network or Tailscale, so
      Octant stopped before sending anything."
    - **Node.** The Node implementation, a module the client runtime's
      barrel does not export so browser and phone bundles never load it,
      resolves and judges the address, dials it, judges the peer, and runs
      the handshake with Node's own refusal off, so the rule decides; it
      hands over the socket only when the rule accepts. It requires TLS 1.3,
      because TLS 1.2 renegotiation could present a second certificate after
      the judged one, gives a handshake 10 seconds, and closes the connection
      when the judgement itself fails. For platform trust it also checks the
      certificate names the origin's host or address itself, since an IP
      origin carries no server name. A name that does not resolve, an
      address that does not answer, and a failed handshake come back as a
      failure value, not a refusal, and nothing was sent. Only its tests can replace name
      resolution, dialling, or trust roots. No other client runtime or CLI
      source turns platform validation off or accepts every server name, and
      a test refuses any that does. Its `fetch` sends each request over its
      own judged connection, refuses a URL on any other origin, never follows
      a redirect, and throws the refusal before any request byte. The desktop
      app's main process uses it; no `octant` command connects to another
      host yet.
    - **Pairing from a code.** The client runtime holds the one flow every
      app follows: read the code, ask the platform for a transport held to
      the code's pin (a client without one refuses with "This version of the
      app can't check that computer's own certificate yet…" and sends
      nothing), request a hello with a fresh client nonce over it and verify
      it, then claim the ticket through that hello. The approved device
      records the pinned trust with its key.
    - **Desktop.** The renderer hands main the pasted text and nothing else.
      Main runs the flow above over the Node transport, then records the
      origin's pin in an owner-only file under the app's data
      (`paired-computer-pins.json`, written whole and renamed into place) and
      opens the other computer's own pairing page with the code's ticket in a
      window. Main pins only an origin the listener address classifier calls
      private LAN or Tailscale, and a pin file it cannot read holds no pins.
      That window gets no preload, stays on that origin, opens no other
      window, grants no permission, and uses a session partition only paired
      computers use, whose certificate verification hook accepts a name only
      when the served key matches a pin recorded for it and refuses every
      other name, a certificate a public authority issued included. Chromium
      reports only the name to that hook, so a name is held to every pin
      recorded for it, whatever the port. Opening a paired computer again
      first resolves and judges its address and checks its key over the Node
      transport; Chromium then resolves the name itself, so the pin, not the
      address, is what that window relies on. Settings → Remote access lists
      paired computers with Open and Forget actions. Forget asks first, then
      main closes that origin's windows, drops its pin (so nothing trusts that
      key), and clears the origin's page storage and the session's HTTP and
      authentication caches through one helper, `clearRemotePageStorage`, that
      every unpair path calls. It ends only this app's side: the other
      computer keeps listing the device until it is revoked there.
    - **Phone.** The pairing screen reads a code from the app's own QR
      scanner or its paste field; typing the origin and ticket stays for a
      listener with a pasted certificate. The scanner takes only text that
      starts `octant-pair-1.` and ignores any other QR code; the camera
      permission names that one use. Every request to an origin whose
      pairing record holds a pin, the pairing flow's included, goes through
      the client runtime's exchange fetch over an in-tree native module
      (`apps/mobile/modules/octant-pinned-tls`), never the platform `fetch`;
      a record the phone cannot read refuses the request rather than falling
      back, and an origin without a pin keeps the platform `fetch`, which
      never accepts a self-made certificate. The exchange fetch applies the
      rule in JavaScript: it refuses a URL on another origin, a trust with
      no pin it may accept, and a name with any non-private address before
      the module is called, hands the module only the judged address, the
      server name for a named origin, the accepted pins, and the whole
      HTTP/1.1 request, and frames and reads the reply itself, so native code
      parses nothing the listener sends. The module dials that address,
      requires TLS 1.3, decides the handshake only by whether the leaf's
      SubjectPublicKeyInfo hashes to one of the pins (on iOS in
      Network.framework's verify block, which the platform's transport
      security rules do not govern, so the app needs no arbitrary-loads
      exception; on Android in its own trust manager after checking the
      connected peer is the dialled address), writes the request only after
      the handshake passed, and then hands the reply back one read at a time.
      The reply's body is a stream that delivers bytes as they arrive, so the
      phone's Chat event subscription, an NDJSON stream, streams over a
      pinned connection as it does over the platform `fetch`; aborting the
      request closes the connection. The phone uses
      no WebSocket or other upgraded connection. A head over 64 KiB, or a
      length or chunking that does not add up, fails the response or its
      stream, so a truncated reply never reads as complete. The phone loads
      no image from a paired computer by URL (a browser screenshot arrives as
      a data URL inside a response), so no native image loader reaches a
      pinned host. iOS asks once before the app reaches a private LAN
      address, with the reason "Octant connects to computers you pair with on
      your local network."; no Bonjour service is declared. Android needs no
      permission beyond network access for a private address.
- **Adding a computer in one step.** Partly built: the host certificate,
  pairing code, client trust rule, desktop and phone pinning above, and the
  one-line start. Key rotation is planned in
  [the plan](plans/one-step-pairing.md).
  - **One-line start.** `octant server install --artifact <path> --pair` and
    `octant server start --pair` install and start the service as without
    the flag, then make only the loopback administration calls
    `octant listener` and `octant pair` make, so they add no authority.
    `--hostname`, `--port`, `--cert`, and `--key` are accepted only with
    `--pair`. The address is an up interface's non-loopback, non-link-local
    address the classifier calls Tailscale, else the one private LAN address
    (an interface's IPv4 address names it over its IPv6 one); none, or more
    than one of that kind, is refused with what was found, a public address
    is never chosen, and `--hostname` must itself classify as Tailscale or
    private LAN. The listener is enabled on port 8443 unless `--port` says
    otherwise, with the host's own certificate unless `--cert` and `--key`
    name one, in which case the command prints the browser link instead of a
    pairing code. It then prints the code and QR code, polls the pending
    claims until the ticket's five minutes end, shows the device label, key
    fingerprint, and comparison code, and approves only on a typed `y`
    (`y` or `yes`); any other answer denies the request, and an input that
    ends without an answer leaves it pending for `octant pair approve`. It
    changes no firewall rule and runs no Tailscale command.
- **Provider keys on a host without the desktop app.** The desktop saves an
  endpoint's API key or bearer token over native IPC from its own renderer,
  so a browser client — local or paired — has no way to save one and names
  the host-local command instead. On a host without the desktop app (a
  headless Linux host) the key is entered with the host-local `octant` CLI,
  and only there ([`providerKeyCommand.ts`](../packages/cli/src/providerKeyCommand.ts),
  [`providerCredentialRoutes.ts`](../apps/server/src/providers/providerCredentialRoutes.ts)):
  - **Commands.** `octant provider key set <instance> [--replace] [--stdin]`,
    `octant provider key status <instance>`, and
    `octant provider key remove <instance>`. `<instance>` is an instance id or
    an exact, unique display name; an ambiguous name is refused with the
    candidates. `set` and `status` need an existing instance that uses
    API-key or bearer authentication, so no secret is written for an
    instance that cannot use it.
  - **Entry.** When standard input is a terminal, the key is read from it in
    raw mode with nothing echoed — not even a mask, which would show its
    length — and the prompt on standard error; Ctrl-C or Ctrl-D cancels.
    Without a terminal, the command refuses unless `--stdin` is given, then
    reads standard input to end of file and drops one trailing newline. The
    key is never accepted as an argument, flag value, or environment
    variable, which other processes and shell history can read, and is never
    printed. An empty key or one over the broker's 12 KiB bound is refused
    before anything is sent.
  - **Channel.** The CLI sends the key once, over the loopback administration
    session `octant listener` uses, to host-local routes under
    `/api/desktop/provider-credentials/` (`set`, `status`, `remove`). Before
    anything else, the server requires the desktop bridge secret on every
    request plus a registered window capability, and refuses any request
    carrying an `Origin` header or a non-loopback `Host`. `/api/desktop` is
    local-only, so the private listener never forwards these routes and a
    paired device cannot reach them. The bridge secret lives in the
    owner-only runtime directory, so only processes running as the host's
    user can call these routes, and no browser page can: a browser always
    sends `Origin` and never holds the secret. The server passes the key to
    the credential broker's provider routes, which store it with
    `secret-tool` on standard input. It is never in a process argument, the
    environment, the journal, logs, diagnostics, a provider child, or a
    response; the routes answer only `stored`, `missing`, `removed`, or a
    typed refusal.
  - **Not the browser.** The loopback browser client cannot save a key, even
    on the host itself. The host cannot tell who is behind a loopback
    connection: the local session (`/api/shell/local-session`) is granted to
    any process that can reach `127.0.0.1` and send the listener's own `Origin`,
    including another OS user on the same machine, an SSH port forward from
    another computer, or a proxy that rewrites `Host`. Listener identity
    proves a request is not a paired device's, but not that the person is at
    the host. The listener admits only its own loopback origin, the packaged
    renderer, and the `OCTANT_WEB_URL` development renderer, so a page from
    a dev server on another loopback port, or from another site (the Host
    check also keeps out DNS rebinding), is refused before it can mint a local
    session. That does not separate the people or processes
    that can use an admitted origin, and cross-site scripting in the
    renderer would inherit the window capability. The
    bridge secret binds the CLI to the host's OS user, and nothing a browser
    can present does. A browser stays read-only for credentials and names
    the CLI command: the browser client never stores credentials, and on a
    host without the desktop app a host-local `octant` prompt is the one way
    to save a key.
  - **Store absent or locked.** `octant server run` starts a credential
    broker only when Secret Service (`org.freedesktop.secrets` on the user
    bus) and `/usr/bin/secret-tool` are present at start. Without a broker the
    routes refuse as `credential-store-unavailable`, and the CLI names both
    requirements and says to restart the server after starting the keyring.
    On macOS the Keychain broker and its helper are owned by the desktop app:
    when the desktop runs the host, the same routes store through its broker
    into the Keychain; `octant server run` on a macOS host without it starts
    no broker, the routes refuse as `credential-store-unavailable`, and the
    CLI says to save the key in the desktop app. Octant adds no server-owned
    Keychain path for that case, and nothing else stores the key.
    A locked collection, or one that would need an unlock prompt a headless
    session cannot show, fails the store as unavailable. Nothing is written
    in either case, and there is no fallback to a file, the data directory,
    or an environment variable. A turn that resolves a key from a locked store
    fails with the driver's existing unauthenticated state.
  - **Replace and remove.** `set` on an instance that already has a key
    refuses unless `--replace` is given, so a mistyped name cannot overwrite
    another endpoint's key. Replacing overwrites the entry in place with one
    plain key. An instance whose stored value is a pool of several labelled
    keys (see Credentials under [providers](#providers)) refuses a replace,
    because one key would silently drop the others; the person removes the
    pool and sets one key. A failed store leaves the old key in use, and the
    next connection check or turn resolves the new key without a restart.
    `key remove` clears the key and leaves the instance configured and
    unauthenticated. It also accepts the id of a removed instance, so a key a
    removal left behind can be cleared, because clearing a secret is never a
    widening. The routes run one key change at a time, and a `set` reads the
    instance again after the store: if it was removed, or its version moved
    (a new base URL or authentication from Settings) while the key was being
    written, the key is cleared and the `set` refuses as `not-found` or
    `changed`, so a concurrent change can neither leave an orphaned secret
    nor send a key entered for one endpoint to another.
  - **Remove a provider with its key.** `octant provider remove <instance>`
    removes the instance through the same provider service Settings uses, so
    that service's own refusals (an active session, the implicit owner of an
    account) apply and are reported as `provider-refused`; then it clears the
    key. The provider goes first, so no instance is left without its key; if
    clearing the key then fails the command says so and names
    `octant provider key remove <id>`, and the host clears it at its next start
    (below). It takes the same references and gives the same refusals as
    `key remove` (`not-found`, `ambiguous`, `credential-store-unavailable`,
    `unauthorized`), refuses before touching anything when the credential
    store is unavailable, and does not accept a removed instance's id.
  - **Journal and reconciliation.** Each store, replace, and remove is
    journaled as a `provider-key.recorded@1` request before the store is
    touched and as a `completed` outcome after (`failed` only when a removal with its provider never reached the provider) (Secret Service and
    the journal cannot be updated atomically), on an aggregate per instance
    ([`providerKeyJournal.ts`](../apps/server/src/providers/providerKeyJournal.ts),
    [`providerKeyJournal.ts` contract](../packages/contracts/src/providerKeyJournal.ts)).
    A record holds the instance id, the action (`set`, `remove`,
    `remove-with-provider`), the instance version, the local window id, and the
    outcome, and never the key, its length, prefix, or hash, because a hash of a
    short key can be guessed offline; the schema rejects any other field. A
    request that cannot be journaled refuses the change (`journal-unavailable`)
    before the store is touched; an outcome that cannot be journaled is
    best-effort, and a store error leaves its request unsettled because it
    does not say whether the write committed. At host start, before the routes take a change, every request
    without an outcome is settled: a `set` whose instance is gone or was
    reconfigured since the request has its key cleared, an unchanged instance
    keeps whatever the store holds; a `remove` clears the key; a
    `remove-with-provider` clears it once the instance is gone, and keeps it
    (recorded as abandoned) when the instance is still configured, because the
    provider was never removed. Settling is idempotent and only ever clears, and
    an unreachable store leaves the request for the next start. The authority
    boundary above is unchanged: the new route sits behind the same bridge
    secret, window capability, no-`Origin`, and loopback checks.
- **Artifact replica membership.** Each replica entry carries a detached
  Ed25519 signature from the device signing key the writing host holds for its
  replica instance, in a credential namespace of its own that provider
  credentials cannot reach — not a paired client's device key. There is no
  replica key. The entry names that key, and the instance id is derived from
  it, so a record that fails verification under its own key, names an id
  that is not its key's, or is not the canonical encoding of its entry with
  the canonical base64 text of its signature, is not valid and is journaled as
  unreadable.
  Membership is derived from the valid records a host holds and the founder it
  pinned; an entry counts only when its writer is admitted through a chain of
  signed approvals and acceptances from that founder and the entry sits at or
  before any cut on it and, when a revocation names the slots its writer read
  as the subject's own (`kept`), in every such revocation's kept slots, so a
  slot the revoker did not read as the subject's stays closed to its key. A new computer joins by writing a join request into
  the store, signed over the time it was written; a request older than a day
  is not offered for approval. A member in good standing approves it by name,
  and only the store's own copy of the request can be approved, not a copy a
  caller hands over. A short matching code, compared on both screens, is a
  consistency check that the request, the approving computer's key, and the
  founder are the ones the joining computer means. It is not a secret and not
  a tamper proof: six digits leave room for someone who can write the store
  to search offline for a substituted join request that yields the same
  code. The signatures and the verified approval chain, not the code, make
  the records authoritative. The joining
  computer then signs its acceptance of that one approval, which makes the
  approver its only parent. Revoke writes a signed revocation, and only a
  computer that brought the revoked one in, directly or through others, can
  revoke it. A member leaves by signing a left record with its own key, which
  cuts it just before that record; it then forgets its identity and deletes
  its device key. Store setup, joining, revoking, and leaving happen on the
  host, never from a paired phone. Store credentials live in the host credential store — macOS
  Keychain or freedesktop Secret Service — and are not written into the
  replica. An S3-compatible store is contacted only over authenticated TLS. A
  plaintext endpoint is refused, and store credentials are not sent on it.
  The storage provider can read the synced content: the artifact versions and
  tombstones are plain files. Settings and the user guide
  (`apps/docs/guide/sync-artifacts.md`) say so before sync is turned on.
  Opt-in encryption of replicas is not this rule. A replica import appends
  versions to this journal and adopts nothing else. Membership accepts an
  entry signed by an admitted instance's device signing key, within its cut
  and its kept slots, as authentic. It does not delegate host authority between hosts.
- **Replica store endpoints.** A bucket endpoint must be `https` with no path,
  query, or user info, and must not be link-local — IPv4 `169.254.0.0/16` or
  IPv6 `fe80::/10`, literal or IPv4-mapped — where cloud instance metadata
  answers; the contract refuses it before any request is signed. Loopback and
  private ranges stay allowed, because a self-hosted bucket server such as
  MinIO on the same machine or LAN is a legitimate store. A host name is not
  resolved to check where it points; the endpoint is whatever the person on
  the host typed, and only that person can set it.
- **Hosts never trust each other.** Multi-host views merge read models
  client-side; credentials and mutable authority never cross hosts. Completing
  all-hosts honesty, pairing at scale, and conflict presentation is client
  registry work under
  [decisions/0059-multi-host-federation.md](decisions/0059-multi-host-federation.md),
  not a new trust boundary. Conflicting facts stay under their owning host;
  create and mutation routing name one destination and refuse when that host is
  not routable — they never queue offline work or convert one host's read model
  into authority on another. An all-hosts list keeps every registered host;
  an unreachable host's cached items stay listed as stale and read-only, and
  an authority-bearing mutation is allowed only on a host whose read model is
  ready.
- **Local servers and Running services.** Listener observation is ephemeral,
  scoped to listening sockets of the current user, and never journaled. One
  classifier decides what may be listed at all: a system daemon, another user's
  process, or an interpreter with no project and no editor lineage is omitted
  rather than shown disabled, so no surface can be read as a host process
  inventory. The Code Environment reads it per thread. The start screen's
  Running services reads the same service host-wide (`list-running-services`
  on the same authenticated route; no thread or Project in the command) and
  adds one filter before anything is probed: a listener is published only when
  its working directory sits inside an active Code Project the Project
  bootstrap lists (today every active Code Project on the host, the same set
  the per-thread route resolves against; it does not vary by window), or inside
  the worktree of one thread of such a Project, which a host-written ownership
  receipt vouches for. A listener outside those roots gets no row and no health
  probe. Rows are Octant-owned (a live terminal descendant) or not owned. A
  not-owned row is any other admitted current-user listener in those roots
  whose lineage names no editor; an earlier Octant session, a terminal, Claude
  Code, or Codex could have started it, and Octant cannot tell which, so the
  row and its Stop confirmation say only that Octant does not own it. The same bounded scan, health phase and
  deadline apply, and a scan that cannot finish is a refusal, never an empty
  list. Open and Stop re-observe and re-classify by an opaque id that is not a
  process id and differs from the per-thread id for the same listener. Stop is
  judged under the origin's posture (a server in a Plan thread's own worktree is
  never stoppable; the Project folder is no one thread's, so a server there is
  judged approval-gated even when a Plan thread works in it), a server Octant
  does not own needs the confirmation naming process, folder and port, and a
  paired device may stop only a server Octant owns; the actor comes
  from the request's authenticated principal. A window reads the host it is
  connected to; All Hosts federation does not carry these rows, with one
  exception: a desktop window whose Environments filter is narrowed to one
  connected paired computer reads that computer's Running services over its
  paired session, as that device, and opens its servers only live (below),
  never as one of its own Browser tabs; while that computer is not connected
  the card reads nothing and says so, never this computer's rows.
- **Proxy sessions and server grants.** A paired device asks for a grant to
  open one dev server from its own computer, under a proxy session that is
  separate from its product session. The rules in force:
  - **Proxy session.** Minted at `/api/remote/auth/server-proxy-session` from
    the ordinary device challenge, signed over a proxy transcript that differs
    from the product one only in its label, so neither signature becomes the
    other kind of session. It lives in the host's memory only, travels in its
    own `HttpOnly` cookie scoped to `/api/server-proxy/`, and reaches only the
    routes under that prefix, which are their own route-policy surface: never
    product routes, never forwarded or classified as product actions. A
    product session never reaches a proxy route. Each request carries the same
    signed envelope product routes use, re-reads the device, and spends a
    nonce from the session's own store (16,384 in the retention window). The
    proxy surface has its own concurrency: 64 on the listener and in the route
    policy, 32 per device in the session store, answered 503 with a one-second
    `Retry-After`, apart from the product budget, and a device decides one
    grant request at a time. A device holds at most four proxy sessions (a
    fifth ends its oldest) and the host 64. A session whose device is found
    revoked, expired, or rotated, by a request or by the minute sweep, ends at
    once, as a backstop to the credential hooks. A host restart ends every
    proxy session.
  - **Grant.** `POST /api/server-proxy/grants` names the listing its listener id
    came from. The host gathers every fact itself: the principal, whether the
    device can open the thread (an archived thread counts as unreadable), the
    listener re-observed and re-classified by that id, its ownership and health,
    the thread whose own worktree it runs in, and that thread's posture, and
    decides with the grant policy in its fixed order. A device holds at most 8
    open grants and the host 32, refused `grant-limit` after every other rule.
    The thread is read again just before a grant is minted, and a thread or
    server closed while the request was being decided mints nothing. The same
    session opening the same server again gets the same grant. A
    listing the host could not finish answers 503, never a refusal. A local
    window reaching the route on the loopback listener is answered
    `local-principal` and nothing about the server is read.
  - **Record and revocation.** Each opening (actor: the device) and closing
    (actor: the host) is journaled as `remote-server.grant-opened@1` and
    `remote-server.grant-closed@1` with the grant, device, thread, and port,
    never the endpoint, and an open-grant projection is rebuilt from them. A
    starting host closes every grant still open as `proxy-session-ended`. A
    grant closes when its proxy session ends or expires, when its device is
    revoked, rotated, expired, or signs out (before that credential change
    returns), when the listener is disabled, when its thread is archived or
    purged, and when Octant stops its server. A thread purge erases the grant's
    records with the thread's. Nothing erases a device's records, so a revoked
    device's grant history stays with its revoke.
  - **Relay.** `/api/server-proxy/<grant id>/<path>` relays one request to the
    grant's dev server. Each carries the proxy session's signed envelope, with
    its body (at most 8 MiB, any media type, 413 above) hashed into the proof.
    The proof signs the canonical query (sorted and normalized) while the dev
    server gets the query as the page wrote it; the two differ only in order
    and percent-encoding, which a request carried over TLS with a single-use
    nonce gives no one else a chance to choose. A proxy request whose cookie
    names no live proxy session, or one whose device no longer stands, has at
    most 4 KiB of its body read, 413 above, and one source holds at most four
    such requests at once (429). Before every request, which gets its
    own upstream connection, the host checks again: the grant is open and bound
    to this device, credential generation, and proxy session; Code is on; the
    thread is active and this device can still read it; and the process the
    grant was minted for (pid, untruncated name, and port, from one `lsof`
    narrowed to the port) still holds the port under an Octant terminal, and
    no other process listens where it could answer the loopback address the
    host connects to (a wildcard counts for both families, and an IPv4-mapped
    bind for the IPv4 loopback). The check and the connection are two steps:
    a server that exits and whose port another process binds in that gap
    (milliseconds) receives that one request, and the next request's check
    closes the grant; for an HTTPS dev server the pin refuses it first. The
    host does not confirm the accepting process per connection, since that is
    a host query per request and a socket still waiting to be accepted is not
    yet visible to it. A
    request never relies on a check that began before it arrived; a burst
    shares the running check's successor. A lost check closes the grant
    (`server-stopped`, `server-changed-hands`, `thread-archived`,
    `thread-unreadable`, `code-disabled`) and the request is refused
    `grant-closed`, the same answer as a grant that never existed or belongs
    to another device; a check the host could not make answers 503 and keeps
    the grant. The host connects only to the grant's `127.0.0.1` or `[::1]`
    endpoint, within five seconds or `server-unreachable`, follows no redirect,
    and sends the request's path and query with `Host: localhost:<port>`, an
    `Origin` (admitted only as the listener's own) as the dev server's origin, a
    `Referer` under the grant's path as that path on the dev server (any other
    is dropped), and `Connection: close`. Hop-by-hop headers, `x-octant-`
    headers, fetch metadata, forwarding claims, and cookies named `octant-`
    (after any `__Secure-` or `__Host-` prefix) never cross; the page's other
    cookies and `Authorization` do. The response comes back with hop-by-hop
    headers, `Content-Length`, `x-octant-` headers, `Clear-Site-Data`,
    `Alt-Svc`, and `Set-Cookie` for an `octant-` cookie removed, marked `x-octant-server-proxy: relayed` so the
    device can tell it from the host's own answers, without the listener's
    security headers or response budget, streamed with no size cap and closed
    after five minutes without a byte. An HTTPS dev server's certificate is not
    checked against a trust store; the first one under a grant is pinned for
    its life, and another closes the grant as `server-changed-hands`. Each
    request is registered under its grant before connecting, and holds its
    place in the device's proxy budget until its response ends; closing the
    grant closes the upstream socket and cuts the response before the call
    that closed it returns. `OPTIONS` is not relayed. The listener admits
    bodies up to the relay's 8 MiB; every other route keeps its own budget.
  - **WebSockets.** The relay route is the only one that switches a
    connection: a signed `GET` asking to upgrade to `websocket` takes the same
    checks as any relayed request, then the host opens a WebSocket to the
    grant's endpoint with the same header rules, its own handshake key, the
    page's subprotocol list, and no extension, within the connect bound. Only
    when the dev server answers 101 with the right accept value, no extension,
    and no subprotocol or one the page offered does the page's connection
    switch, answering that subprotocol; a dev server that declines, and any
    upgrade to another protocol, is refused `upgrade-refused` (501). Every
    other route on either listener answers an upgrade request as an ordinary
    one and never switches. After the switch, messages carry no proof of their
    own: each socket is registered under its grant before the host connects,
    and closing the grant for any reason above closes the page's end with 1008
    and the dev server's with 1001 before the call that closed it returns. A
    grant holds at most four sockets and a device sixteen, answered 503 with a
    one-second `Retry-After` past either; a socket does not hold a proxy-budget
    slot once switched. A message is at most 16 MiB in either direction, and a
    larger one closes the socket with 1009 before the host buffers it; writes
    one end does not read close the socket with 1008 past twice that. The host
    answers pings itself and relays whole messages, text or binary, and close
    codes. An open socket counts as use of its proxy session, so the session
    does not idle out under it; its absolute expiry still ends the session,
    the grant, and the socket. The listener's transport (Node or Bun) switches
    a connection only when the route's answer carries an accepted upgrade, so
    an answer that does not is written as plain HTTP and the connection closed.
  - **Forwarder and signer on the device.** Only the desktop app opens a
    page live. Its main process starts a forwarder on the first Open that
    binds `127.0.0.1` and `::1` only, on the port it recorded, else the next
    free one in 47610–47619 (said once; all taken refuses Open with that
    range), and serves each granted server at
    `<port>-<label>.octant.localhost`, `<label>` the first 10 bytes of a
    SHA-256 over the host and thread in base32, so the same server keeps its
    name. It routes by the exact `Host`, refuses an unknown name, and admits a
    request only with that name's secret (a header Octant's browser adds for
    the exact origin only, or an `HttpOnly`, `SameSite=Strict`, host-only
    cookie the default browser gets from a one-time claim token in a URL
    fragment) and, where the browser sends them, `Sec-Fetch-Site`
    `same-origin` or `none` and the page's own `Origin`. It holds no key: for
    each request it sends the method, full proxy path, and body digest (8 MiB
    cap, 413 above) to the Octant window that opened the page, which refuses
    unless the canonical path is under the proxy route of a grant it holds and
    builds and signs the envelope itself; the main process takes back only
    Octant's own headers, from that window only. The window holds its proxy
    session (minted by `issueServerProxySession`, which never clears the
    product session) and its grants in memory. The forwarder reaches the host
    through the listener trust rule with no cookie jar, rewrites the page's
    origin and `Referer` to the listener's and the grant's path, never sends
    the page's secret, and hands the page only a response marked relayed, with
    a `Location` naming the dev server's own origin moved to the name, a
    loopback `Set-Cookie` `Domain` dropped, and HSTS dropped; anything else
    becomes a failure page in the plan's copy. Octant's browser is a sandboxed
    window per name in a persistent partition, with every permission refused,
    kept on the page's origin, and not a Browser tab, so no agent can drive
    it. Removing a host, revoking this device from it, or forgetting a paired
    computer closes that computer's page windows, clears every persistent
    partition for its recorded page names through `clearRemotePageStorage`, and
    forgets the names; a name that could not be cleared stays for a retry. A page's WebSocket upgrade (live reload) takes the same admission,
    secret, and window signature as any request, signed as a `GET` with an
    empty body, and goes to the proxy route through the same listener trust.
    Once the host switches protocols with the accept value for the page's own
    key and no extension, the forwarder answers the page 101 and passes bytes
    through both ways unchanged, so the host's message cap, buffer bound, and
    close codes apply as on any relayed socket; a closed grant, a revoke, or a
    session's end closes it from the host, and closing the host's pages or
    stopping the forwarder closes it here. Any other answer reaches the page as
    the request's failure status, and no frame is sent.
- **Host-driven provider sign-in.** A local principal may start a descriptor-driven
  PKCE or device-code sign-in. The host, not a provider child and not the
  renderer, owns the loopback redirect, the device poll, and refresh. State and
  the code verifier are checked, the redirect is one-shot, and an unanswered
  consent times out. Tokens stay in the credential broker. The journal records
  the terms acknowledgment (who and when) and the public sign-in state, never
  an access token, refresh token, authorization code, or verifier. A remote
  principal cannot acknowledge terms, start the flow, or refresh. Starting a
  sign-in without a recorded acknowledgment of that descriptor's terms is
  refused (`terms-required`). A revoked,
  expired, or reused refresh token is a typed sign-in-again state and drops the
  stored grant. The API-key path remains available beside that sign-in.
  [0111](decisions/0111-host-driven-provider-oauth.md) stays a Proposed
  historical record; this section is the effective rule.
- **Subscription sign-in dialects.** The host OAuth runner also speaks vendor wire
  dialects beside the standard PKCE path: OpenRouter exchanges the code for an
  API key, and the ChatGPT plan dialect registers the host as a user-defined
  agent. Each keeps the host-driven sign-in rule above, and tokens stay in the
  credential broker. In the ChatGPT plan dialect, the identity token is
  validated before a grant is stored, a replaced grant's local material is
  deleted, and a request the plan route's profile cannot express is refused
  before send. The wire details are in
  [Provider runtimes](design/provider-runtimes.md#subscription-sign-in-dialects).
- **Update feed signing keys are per ring.** The desktop updater verifies a
  feed's Ed25519 signature against the compiled-in keys of the ring the signed
  release names, before any other field is believed. Stable trusts only the
  stable key (`OCTANT_UPDATE_PUBLIC_KEY`); preview and candidate trust the
  preview key (`OCTANT_UPDATE_PREVIEW_PUBLIC_KEY`) and the stable key. The
  preview workflow builds unreviewed `main` without an approval gate, so
  anything merged there can read the key it signs with; a shared key would let
  that code sign a `ring: "stable"` feed and make the stable approval
  meaningless. The stable key may sign previews because its holder can already
  sign stable, and it is how installs that predate the preview key reach a
  build that knows it. Those installs read `<ring>/<platform>-<arch>.json`;
  key-aware builds read preview and candidate feeds at
  `<ring>/<platform>-<arch>.preview-key.json`, which is all the preview
  workflow writes. The old name holds a bridge feed that the
  approval-gated `release-preview-bridge.yml` signs once with the stable key,
  pointing at a published build that ships the preview key and reads the new
  name. Nothing overwrites it, so an install offline for any length of time
  still finds a release it can verify. The release wizard mints a ring's key
  only when the app ships none for it: replacing a deployed key strands every
  install that trusts it, and rotation would need a staged overlap. The private
  halves are environment secrets:
  `OCTANT_UPDATE_FEED_PRIVATE_KEY` only in `stable`,
  `OCTANT_UPDATE_FEED_PREVIEW_PRIVATE_KEY` only in `preview`.
  `scripts/sign-update-feed.ts` reads the secret for the ring it signs and
  refuses a key whose public half the app does not trust for that ring, so an
  unset preview public key fails the release job instead of publishing a feed
  no install can verify. The signed ring must still equal the ring the app
  follows. The feed's publish credential is not part of this trust: a writer
  that can replace a feed file can withhold a ring's updates, never install
  something no trusted key signed.

**Proposed, not accepted: Claude sign-in inside Anthropic's terms.** Octant
would not mint, store, or inject a Claude setup or OAuth token. Claude
subscription sign-in would stay in Anthropic's own flow, and confined Claude
launches would sign in from a Claude-owned config directory. Step 0 of the
plan was measured on 12 Oct 2026, and the maintainer chose the Keychain read
it found. The rule is still not in force: it needs Anthropic's Commercial
Terms or an explicit Anthropic exception. Until that is recorded, the rules
in this document describe the build as it ships. The steps, the open questions, and the rejected alternatives live in
[the remediation plan](plans/claude-inside-anthropics-terms.md).

## Package map

| Package                   | Responsibility                                                                                                                                          | Depends on                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `packages/contracts`      | Effect Schema entities, commands, events, RPC and wire contracts; no runtime logic                                                                      | `effect`                                                          |
| `packages/domain`         | Pure policies and state transitions (modes, tool calls, approvals, remote access, boards, canvas, …)                                                    | contracts, theme                                                  |
| `packages/theme`          | Semantic theme schema, presets, backgrounds, typography, importer, contrast                                                                             | contracts                                                         |
| `packages/provider-sdk`   | `ProviderDriver` interface, normalized runtime events, discovery, conformance harnesses                                                                 | contracts, `effect`                                               |
| `packages/plugin-host`    | Extension manifests, component model, activation ladder, addressing, bundled skills and provider-driver plugins, Agent Plugins loader                   | contracts, `yaml`                                                 |
| `packages/plugin-api`     | Public plugin manifest, component, and contribution schemas for third parties (re-exports contracts/extensions)                                         | contracts                                                         |
| `packages/host-runtime`   | Host paths, owner receipts, service lifecycle, credential broker, host OAuth runners, bridge secret, diagnostics, redaction (shared by desktop and CLI) | —                                                                 |
| `packages/client-runtime` | Authenticated transport, per-feature clients, reconnect, remote pairing, host federation registry and merged reads                                      | contracts, domain                                                 |
| `packages/cli`            | `octant` binary: headless server run, service manager, status, `web` launcher, artifact install                                                         | contracts, host-runtime                                           |
| `apps/server`             | Authoritative control plane: routes, services, journal, projections, providers, tools, extensions, remote gateway                                       | contracts, domain, plugin-host, host-runtime, provider-sdk, theme |
| `apps/desktop`            | Electron shell: windows, menus, native credential-store integration, pickers, signed updates, server process lifecycle, packaging                       | contracts, domain, host-runtime                                   |
| `apps/web`                | React renderer for desktop and paired browsers                                                                                                          | client-runtime, contracts, domain, plugin-host, theme             |
| `apps/mobile`             | Expo iOS/Android remote-control client                                                                                                                  | client-runtime, contracts, domain                                 |

Dependencies point inward: no package imports an app, and `contracts` imports
nothing first-party.

## Current Release Boundary

The [Current Release Boundary in `AGENTS.md`](../AGENTS.md#current-release-boundary)
is the one statement of what the first release includes and defers. This
section owns the architectural rules behind it. On macOS, Squirrel.Mac refuses
a replacement that does not satisfy the running app's designated requirement,
so signing, notarization, and update ship as one deliverable.

Desktop is one product on macOS, Linux, and Windows; platform differences are
fail-closed posture, never a second app. The desktop process owns its local
server on every OS. The sequence is the Linux desktop shell, then the Linux
AppImage with its signed feed, then Windows. Windows packaging, installers,
feeds, and packaging CI wait for an explicit maintainer decision after Linux
parity. Windows Work and Code stay unavailable until an approved Windows
confinement design is documented: the confinement port supports only macOS
and Linux and refuses every other platform, so Work and Code fail closed
there. Simulator, the Apple workbench, and vibrancy stay macOS-only.

**Updates** (`apps/desktop/src/appUpdateService.ts`, `appUpdateFeed.ts`,
`packages/domain` `appUpdatePolicy`):

- Trust comes from the feed signature, never the host. Octant verifies an
  Ed25519 signature over the canonical encoding of the feed's `release`
  object (the wrapper's `schemaVersion` is validated, not signed) against a
  public key compiled into the app, then requires the offered release to be strictly newer and to name
  this platform, architecture, and the ring the app asked for. The artifact's
  SHA-256 is inside the signature and the downloaded bytes are hashed before
  anything installs.
- On macOS the platform updater is then handed the verified bytes through a
  loopback feed Octant serves for the install, never the public feed, and
  checks the code signature as an independent second gate. A Linux AppImage
  is not code-signed, so the feed signature and artifact hash are its whole
  trust root: Octant replaces only the image it was launched from (`APPIMAGE`)
  atomically, and refuses a package or archive launch before any request. The
  relaunched image is told which process it replaces
  (`OCTANT_REPLACED_PROCESS_ID`, removed from its environment as it starts) and
  waits, for at most a minute, until that process has exited (on Linux, exited but
  not yet reaped counts) before it asks for
  the single-instance lock, so it never starts a host while the old one is
  still stopping; the old instance keeps its lock until it exits. A platform
  with no signed channel (`supportsSignedDesktopUpdateChannel`:
  macOS and Linux today) refuses with "untrusted-signature".
- Unverifiable is refused, never downgraded: an unparseable feed, unknown key,
  version that is not strictly newer, wrong platform or ring, unreachable
  service, or mismatched artifact yields no install, no override, and a
  refusal naming the check. The exact two-field empty document
  (`"status": "empty"`, schema version 1) means no release in this channel,
  not that the build is current.
- Rings are `stable` (tags), `preview` (scheduled `main` builds), and
  `candidate` (on-demand builds of a chosen ref, so a test install exercises
  the real update path) at `<base>/<ring>/<platform>-<arch>.json`. A build's default ring is read from
  its version; the signed ring field is what separates the streams. The base
  is overridable but must be HTTPS.
- Release notes for an offered update ride inside the signed release (at
  most 4,096 characters) and fail with it; notes for the running build are a
  bundled file read from disk, so What's New never adds a request.
- The person controls application: an update is staged and applied on a
  relaunch they start, and install waits while agents are active (a thread
  parked on an approval or question is still an active agent) or while the
  desktop cannot confirm what the host is running. A provider that is not
  signed in, not installed, or disabled never holds an install back: quitting
  asks on the same terms, because both read the one `workInFlight` reading of
  the host rather than its `attentionRequired` flag, which also marks the menu
  bar for provider readiness. Automatic checks are a setting; the host starts with them
  off until the persisted choice arrives, then checks daily. A check is a
  plain GET carrying only version, platform, and architecture (the ring is in
  the path); it is not a telemetry channel.

Historical rationale: [0034](decisions/0034-signed-updates.md) and
[0058](decisions/0058-cross-platform-desktop.md). 0058's ban on any updater
for an unsigned build predates the Linux AppImage feed; the rule above, where
the signed feed is the trust root for an image that has no platform signing,
is current.

Artifact replicas, when the person turns sync on, go only to a store that
person owns — a synced folder or an S3-compatible bucket. Octant operates no
storage and no relay for them. The storage provider can read the files. That
does not open a hosted relay or an Octant cloud account. See
[0163](decisions/0163-artifact-replicas-in-storage-the-user-owns.md).

The start gates for the connector / OAuth marketplace and full LSP /
extension host / debugger holds are in
[release-boundary holds](release-boundary-holds.md). Neither hold is opened by
plugin work, a first-party Integration, or Monaco and external-editor handoff.

## Development loop

```sh
bun install --frozen-lockfile
bun run dev        # Vite renderer + Electron with hot reload; server spawned from source
bun run verify     # paths:check, wiring:check, decisions:check, fmt:check, lint, typecheck, test, build
```

- `bun run dev` starts Vite for `apps/web` and launches Electron against it.
  Renderer edits hot-reload; server edits apply on the next relaunch. On
  startup the dev script rebuilds `apps/desktop/dist/main.mjs` whenever
  `apps/desktop/src` is newer, so `apps/desktop/src` edits need only a
  restart of `bun run dev` rather than a manual
  `bun run --cwd apps/desktop build`.
- A headless Linux station: `octant server run`, then `octant web` (or
  `octant web --dev` for Vite), run as the OS user that started the host so
  it can read the bridge secret and mint the browser's launch link. Linux requires `bubblewrap` and Git 2.36 or
  newer; without `bubblewrap`, Work and Code fail closed. Stored provider
  credentials also need an unlocked freedesktop Secret Service session and
  the `secret-tool` client; without them the host still runs Chat, Work, and
  Code but reports its secret store unavailable. ADE and other boot-managed hosts should run
  `scripts/ade/start-secret-service-session.sh` on each start so the session
  bus and keyring are live (never a snapshotted socket path alone). The start
  script writes `~/.config/octant-host/session.env`; when `start` and
  `server run` are separate processes, source that file in the server-launch
  shell before the host — start-script exports do not cross the subprocess
  boundary. Until a Cloud Agent Saved environment executes the `start` hook,
  run the script manually and source `session.env` the same way. Provider
  CLIs are ordinary host binaries: install one to a user-writable path such
  as `~/.local/bin` and point the provider instance at that absolute path.
- `octant web --dev` changes only the renderer: it starts Vite and attaches it
  to the canonical Machine host. Browser QA and Electron share the same store,
  Projects, threads, and live journal. Destructive tests use an explicit
  `OCTANT_DATA_DIR`; development mode never creates an implicit profile. The
  Vite page is not the host, so the tab remembers the `serverUrl` it was
  launched with (per renderer origin, in tab session storage, judged again like
  a typed address); a reload or in-tab navigation that loses the query keeps
  its Machine instead of reading the Vite origin as one.
- `bun run package:desktop` packages the peer Machine for the build host:
  `out/Octant.app` on Apple Silicon macOS, or an unsigned
  `out/Octant-<version>-linux-x64.AppImage` on x64 Linux (with
  `out/Octant-linux-x64/` kept for inspection). Linux packages skip Darwin
  helpers. A dogfood AppImage is not code-signed. An AppImage launch checks
  the signed `<base>/<ring>/linux-x64.json` feed, verifies the signature and
  hash before use, replaces the image atomically (write beside, fsync,
  rename), and relaunches; the new build starts after the old one has stopped.
  A bad signature, a non-writable location, or a
  launch that is not that image fails closed, and the reason is shown in
  Settings. Windows stays out. Override with
  `OCTANT_PACKAGE_TARGET=darwin-arm64|linux-x64` on a matching host only.
- Focused checks: `bun run --filter <package> test|typecheck`; the store can be
  inspected with `bun run --cwd apps/server db:verify`.
- Formatting is `oxfmt`, linting is `oxlint`; Turbo runs the per-package
  scripts. Always run `git diff --check` before opening a PR.
