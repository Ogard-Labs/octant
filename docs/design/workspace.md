# Workspace behavior

This is the current specification for workspace navigation, pane contents, and
tool presentation. [Architecture](../architecture.md) owns server, provider,
persistence, and authority boundaries; [DESIGN.md](../../DESIGN.md) owns appearance.
Update this specification with an approved behavior change, following the
[design workflow](README.md#changing-the-design).

Historical links explain rationale; their old status or placement rules do not
override this specification. The specification describes existing behavior.
Unfinished plugin extraction and other proposals are separate from these rules.

## Navigation and Projects

The window is mode-first: a persistent left sidebar with the Chat, Work, and
Code selector, mode-aware destinations, Projects and threads, and settings; an
integrated borderless top chrome; a central workspace; and an optional right
dock. Mode changes alter content, authority, default composition, and density,
never the navigation grammar. See [decisions/0015-workspace-shell-model.md](../decisions/0015-workspace-shell-model.md).

Projects opens its searchable directory in the main workspace. Selecting a Project
replaces that directory with the Project overview; Projects in primary navigation
returns to the directory. Neither view adds a second sidebar. Other destinations
replace the directory while preserving the underlying Project selection.

Chat, Work, and Code keep the active mode's sidebar current with projection-only
navigation reads (`GET /api/chat/navigation`, `GET /api/work/navigation`,
`GET /api/code/navigation`). Work bootstrap still validates Project roots, while
the Work navigation read uses only active Work Project and thread projections plus
in-process runtime state. Code bootstrap still observes waiting checkouts on the filesystem so a restart can
recover them; available and unavailable checkouts are not re-probed, and the
sidebar timer never walks the checkout tree. Inactive modes and hidden windows
pause those refreshes so background ticks do not contend with the next
interaction.

## Thread visibility and completion

A Chat, Work, or Code thread has two resting states beside archive, both fields
on the thread aggregate rather than lifecycle values: **completed**
(`completedAt`, manual only, refused by each mode's service while a turn runs
or the thread waits on the person) and **snoozed** (`snooze.until`, an overlay
that hides the row until the wake time and wakes it early when the agent needs
the person or a turn that was running at snooze time ends). The sidebar files
both in collapsed shelves below the Project groups and derives snooze
visibility from the clock; no host timer wakes a snooze. The Work and Code
boards leave out completed threads until they are reopened. A person sending a
thread a turn reopens or wakes it on the server. One host sweep archives
completed threads of every mode once their completion is older than the
`completedThreadArchiveAfterDays` shell setting (default seven days, `null`
for never), re-deciding against each mode's authoritative record and
journaling the ordinary thread update as the `system` actor. It archives only;
see [decisions/0088-completed-and-snoozed-threads.md](../decisions/0088-completed-and-snoozed-threads.md).

## Panes and content navigation

The central workspace is one persistent recursive
split tree. A leaf holds exactly one surface — a thread, a draft, a Project
overview, a utility surface, or a mode welcome. A pane retains renderer-session
navigation tabs for conversations, files, previews, and canvases; selecting a
tab reopens that surface through the authoritative command path. Image creation
and revision occupy pane-owned tabs whose drafts remain mounted while switching
back to the conversation. Opening the same content selects its existing entry; closing active content
selects its neighbor. A refused host open does not activate a successful tab.
References are cleared when the pane or its authority context changes; reload
restores only the authoritative visible surface. Closing image creation stops
observation, while only Cancel job cancels generation on the host. Editor drafts
remain in the thread draft store; approval requests keep their explicit controls.
Thread titles appear once in the title row. Project context remains in the drag
handle tooltip and in the Work composer's attached project/folder strip. Tab
geometry and close-control presentation are shared with dock tools under
[Content tabs](../../DESIGN.md#content-tabs).

These tabs add no persisted layout or authority; see
[decision 0156](../decisions/0156-content-opens-beside-the-conversation.md).
Several same-authority threads can be pinned or dropped into
that tree; pointer activity and keyboard input give exactly one pane a visible
accessible active state. Completed layout operations go through
server-authoritative workspace commands. One visible tree belongs to one
authority context (host, mode, Project, and bound root); a cross-Project,
cross-mode, or cross-host placement is refused or offered in a new window.

## Tool lifecycles

Thread utilities live in the Right Utility Dock outside the split tree.
The shell loads each tool through `dockModuleRegistry`; modules under
`apps/web/src/dockModules` receive only declared inputs and contain render
failures. Review owns local Working tree and Git History views. History reads
through `GitHistoryReader` and the authenticated Code checkout-read boundary;
its Git subprocesses are network-denied and its data is an ephemeral read,
not a second journal. Pages anchor to immutable Git tips, and commit details
compare immutable object IDs with an explicit parent for merges.
The top-right control reveals the dock only when the active pane has a bound thread
or a valid launchable tool. An available empty dock shows a compact launcher;
an open dock shows a tool strip. Direct tools are Side Chat, Browser, Files,
Document, Canvas, artifact-gated Plan, conditional Delivery, Review, Terminal,
Tests, iOS Simulator, and Android emulator, as mode and capability allow. Document shows the
Markdown or text file the Code thread's turn most recently wrote, read through
the host-authorized file open; the renderer offers a written document (or a
Chat-authored Canvas) in the dock once per document, never after the person
closed its tab, and never by moving focus. Hand off (`POST
/api/threads/hand-off`) starts from the thread export cut, asks the thread's
own provider for a six-section hand-off document in one tool-free request,
keeps it as a Canvas of the thread, and opens that Canvas in the dock; a
running turn, an unready provider, or a thread outside a Project is refused as
an ordinary answer (see
[decisions/0080-hand-off-writes-a-canvas-from-the-export-cut.md](../decisions/0080-hand-off-writes-a-canvas-from-the-export-cut.md)). The dock follows the active
pane's thread and Project, restores that subject's open tools, and presents an
explicit unavailable state when the newly active pane cannot describe the
selected tool — never the previous pane's content. Hiding a Browser or Terminal
tool does not stop its server-owned lifecycle. The iOS Simulator and Android emulator are separate device destinations. An
agent's device open raises the relevant in-app pane once per request. Live,
unavailable, booting, interrupted, and stale states stay explicit; closing a pane
does not shut down its device. Allow input is the explicit destination approval;
clicking the screen or a key button cannot grant it. The host owns observation,
input, and evidence safety under the [device transport contract](../architecture.md#device-transport-and-evidence).
Dock visibility and responsive presentation follow [DESIGN.md](../../DESIGN.md#shell-and-layout).
Environment belongs to a
thread as a context-aware dock tab opened from the dock tab strip or Add tool. It may
summarize the active thread's server-authored child AgentRuns, including their
lifecycle, resolved model, and retained final result; full AgentRun control
stays in the Agents dock. The thread's live subagents (working, or finished
and awaiting review) also show as a tray in its composer, whose rows open the
Agents dock on that subagent; see [DESIGN.md](../../DESIGN.md#welcome-and-composer).
The Agents dock is a list and a page. The list has one title with a New
control that reveals the New subagent form (open by default only when the
thread has none), then Working and Finished sections of one-button rows —
status icon, task, and state, role, model, and age in words — with finished
rows newest first and an unreviewed result marked "Needs review". A row opens
that subagent's page in place of the list, with a back control: its task as
the title, a status line, and a small transcript that starts with the task as
the brief, then the replies as rendered Markdown and status events as quiet
lines, live while it runs. When the live read is unavailable or gone after
completion, the retained final reply stands in; when neither exists the page
says so. Mark reviewed, Steer, Retry, Resume, and Cancel sit in one bar pinned
under the transcript. What the host resolved for a new subagent folds under a
single line naming its model and workspace, in plain access words rather than
ids or policy keys. The workspace-rail Agents Center is that same
hierarchy across modes; on a wide window it can draw the current query as a
forest of parent threads and the runs they launched, and Graph can save that forest as a Canvas diagram document for the parent thread. Environment may show a compact read-only preview of
the host's bounded, process-local child conversation read: entries are
cursor-readable and byte- and count-bounded, with explicit complete, stale, and
unavailable states. Provider-native live transcripts remain unavailable unless
their normalized provider capability supplies an equivalent host-authorized
read; a host-retained final reply stays readable after completion. See
[decisions/0050-bounded-live-child-conversation.md](../decisions/0050-bounded-live-child-conversation.md).

## Boards and integrations

Work and Code have server-authoritative thread boards
(Ready / In progress / Waiting / Done) that cannot be dragged between columns;
Chat has no board. Code also has a Project-scoped Pull requests workspace that
lists active open and draft pull requests from authorized connected Code
Projects. The same cached read backs the right dock's Pull requests tool,
scoped to the active Code thread's Project. The list is a cached read of a
private host-local snapshot: opening it, navigating, and ordinary board
queries do not call GitHub. GitHub is reached
only by an explicit Refresh all or per-Project refresh, or — for Projects that
opted in — by a bounded background refresh cadence, all through the installed
authenticated `gh` CLI. The cadence is a journaled per-Project setting, off by
default, floored at 30 seconds with a conservative default interval, backs off
on failure without advancing its per-Project sync position, skips re-observing
cached merged/closed identities, and stops with an honest `unavailable` state
when `gh` is missing or unauthenticated. Independent repository reads run
concurrently, results reconcile in stable Project order, and every refresh path
remains within preview bounds. The journal never stores that cache and never
sees a per-poll event; it stores only the user's opt-in toggle and exact PR
identities already produced by Code operations. The bounded list cache survives
host restart and is cleared when GitHub authority is revoked (see
[decisions/0064-pull-request-observation-cadence.md](../decisions/0064-pull-request-observation-cadence.md)
and
[decisions/0076-pull-request-snapshot-survives-restart.md](../decisions/0076-pull-request-snapshot-survives-restart.md)).

**GitHub issue browser.** The first-party GitHub plugin contributes a second
`sidebar.destination` (`github-issues`) that opens a host-scoped, read-only
issue browser. The sidebar row is shown only when the contribution is present,
its action is wired, and the authentication snapshot reports `issues-read`
available. Catalogue reads stay on the existing `githubCatalogue` union over
`/api/github/catalogue/reads`: `kind: "issues"` includes optional
server-composed search, and `kind: "issue"` returns a bounded detail. The
browser renders title, body, and comments as plain text; links stay inert full
URLs.

Create-from-issue is implemented. The composer `Create from…` Issues tab
attaches only `{ owner, name, number }` to the draft. At creation the server
reauthorizes `issues-read`, frames redacted issue text through
`apps/server/src/context/externalContentFraming.ts`, and appends
`thread.external-content-ingested@1`. Refusal fails creation visibly. The
resulting thread is ordinary Chat, Work, or Code with no GitHub write-back.
Disabled GitHub, missing capability, and unauthorized or rate-limited states
fail closed. See
[security/github-repository-onboarding-threat-model.md](../security/github-repository-onboarding-threat-model.md).

**GitHub repository onboarding.** The managed clone flow turns one confirmed GitHub repository
into one ordinary Code Project: the composer's Project menu offers "New Project from GitHub
repository" against the host's managed repository inventory, and the Create Project dialog offers
a Folder | GitHub source switch whose GitHub side clones into a parent folder the person chooses
through a host-issued binding receipt (native picker or host folder browser, so a headless host is
served the same way) plus one folder-name segment. Repositories come from the searchable catalogue
of what the signed-in `gh` account can reach, or from a pasted link or `owner/name` the renderer
reduces to owner/name for a fresh server-side `gh api repos/<owner>/<name>` resolution — no clone
URL is ever a client input. The clone stages on the same filesystem as its destination, verifies
the staged object's GitHub node identity and origin before any working tree is materialized,
promotes atomically without overwriting, and only then issues the one-time binding receipt the
Project is created from; everything is journaled, cancels cleanly, quarantines instead of
deleting, and reconciles after restart without re-running work.

Code also has a host-scoped Linear issues workspace contributed by the
bundled-off Linear plugin as `sidebar.destination` `linear-issues`, Code mode
only. The sidebar row is shown only when that contribution is effective, its
action is wired, and the Linear authentication snapshot reports `list-issues`
available. Browse goes through the Integration port (`list-issues`,
`get-issue`, `list-issue-filters`) over Linear GraphQL with bounded page size
and description bytes. Issue bodies are a live projection, not Octant source of
truth; credentials and raw API payloads never enter prompts or tool output.
Open in Linear is an external `linear.app` URL. Disabled, untrusted,
unauthorized, expired, or rate-limited Linear contributes no sidebar item,
catalogue rows, or thread context. Chat/Work browse and Linear writes are not
this surface.

Composer `Create from…` also exposes a Linear tab when the Settings-owned
connection reports `list-issues` available and the Linear plugin is effective.
Selecting a row attaches only `{ id }`. At creation the server reauthorizes
through the Integration port, frames redacted issue text
(`identifier`, status, description, comments, links) via
`externalContentFraming.ts`, and appends `thread.external-content-ingested@1`.
Refusal fails creation visibly. No Linear write-back path exists.

## Context and usage

The circular composer meter opens the host's attributed context breakdown without
another provider call. Inspect context opens the composition inspector; before a
plan exists it is a successful empty view. Saved observations retain their original
time after restart. Unknown limits and measurements remain unavailable, and
fallback estimates are labeled explicitly. Spend ceilings are host-owner policy;
the composer and Environment explain an admission refusal and its recovery.
[Context and usage accounting](../architecture.md#context-and-usage-accounting)
owns budget enforcement, provenance, native-session identity, and journal rules.

Project overviews retain loaded content during same-Project refreshes
on the same client connection. Changing Project or client clears retained
content; disconnect and authorization failures remain explicit unavailable
states. Project memory lives on every mode's Project Overview. Navigator is one host-owned conversation opened
as an app-wide popover from the bottom-left profile and Settings control, and
opening it never changes the active Project or thread. Zen is a separate
presentation aggregate inside the same window, not a split-tree tab and not a
fourth authority mode. Zen's Add terminal offers the window's Code Project as
"This Project" ahead of the Code threads that can open one; choosing it starts
a Project terminal and pins a card that names the Project and the terminal,
never a thread. The card is a window onto the shell and grants nothing: a card
naming a terminal this window does not own is refused. Authority, lifecycle,
and the journal record follow the
[Project terminal rule](../architecture.md#security-and-authority). Add browser
likewise offers the window's Work or Code Project as "This Project": the dock
names the Project, never a thread, and shows that Project's own page under the
Project browsing context rule in the same section.

## Local-server ownership

Local-server stop authority recognizes live terminal descendants by a host process
snapshot and the tracked shell's process identity. An exited shell, a reused PID,
or missing ownership evidence leaves the listener classified as a leftover and
requires confirmation. Editor provenance labels alone never grant stop authority.

## Verification

- Navigation, Projects, mode boundaries, and content opening: `apps/web/src/App.test.tsx`
  and `apps/web/src/shell/ShellFrame.test.tsx`.
- Pane ownership and layout authority: the workspace policies in `packages/domain/src`
  and shell commands in `apps/server/src`; extend the closest behavior test.
- Content references and retained image drafts: `apps/web/src/shell` and its
  navigation tests; verify refused opens and pane/context changes.
- Dock and device changes: the relevant dock-module tests plus host permission
  negatives and native/device verification where the lifecycle changes.
- Render changed interactions at the affected window sizes, including keyboard
  navigation and unavailable states. A documentation-only consolidation needs
  consistency and link checks; it is not evidence of fresh rendered QA.
