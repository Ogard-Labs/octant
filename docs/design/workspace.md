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

The window is mode-first: a persistent left sidebar with the Work and Code
selector (Work presents the Chat and Work domains together; see
[architecture](../architecture.md#modes-chat-work-and-code)), optional count tiles, mode-aware destinations, Projects and
threads, and settings (the sidebar's anatomy is in [DESIGN.md](../../DESIGN.md#shell-and-layout)); an
integrated borderless top chrome; a central workspace; and an optional right
dock. Mode changes alter content, authority, default composition, and density,
never the navigation grammar. See [decisions/0015-workspace-shell-model.md](../decisions/0015-workspace-shell-model.md).

Projects opens its searchable directory in the main workspace. Selecting a Project
replaces that directory with the Project overview; Projects in primary navigation
returns to the directory. Neither view adds a second sidebar. Other destinations
replace the directory while preserving the underlying Project selection.

The Add folder browser reads one directory at a time from the confined home root.
Because a filesystem call on a cloud-synced or network-mounted entry can block
indefinitely, the host checks a few entries at a time, bounds each entry's checks
and the whole listing, and lists an entry it cannot verify within the budget as a
plain folder. Such an entry carries only its unresolved name: binding it, or
choosing it as an export folder, measures the path again and refuses it when that
fails, stalls, or resolves outside the root. The client's request budget also
covers reading the response body. A browse that fails returns an explicit
failure the picker shows with Retry, and Retry re-issues the same folder and
search rather than restarting at the root.

The Project tree places each active thread under its listed Project or under
**No project**, never both. No project is a collapsible folder row following
the Projects with no horizontal divider or separate section heading. It is
absent when empty and does not create a Project or filesystem authority.
Sidebar search reveals matches inside collapsed groups and restores their
collapse state when cleared. The Activity feed is an alternative view of the
same threads; it is not shown as a duplicate list beneath the Project tree.

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

The **Review page** lists the threads the sidebar's To review count counts, by
the same predicate (`isWaitingForReview`: unread, not working, not on a shelf),
so the tile's number and the page's rows never disagree. Rows run oldest
first, by the host's reported finish time where it has one. The detail panel
reads the thread's last reply, the Code board's check facts, an Octant-run
check after the last turn where one exists, and the checkout's diff; Chat rows
show the reply only. Work navigation projects no unread flag, so Work threads
never count toward To review and never list here; the page's Work wiring
(send-back refuses and points at the thread's composer) waits for that flag. Complete, Snooze and send-back go through each
mode's existing commands and show the host's refusal in one line; mark-seen
moves the read cursor. Its single-key commands are page-scoped keybindings: they
may be a bare key because only the focused page dispatches them, and the
window-level listeners never run them. The page holds no pull-request action
and no destructive one. The To review tile, Code's **Review N changes** tile and
the command palette open it.

A thread stopped on a provider usage limit that disclosed a reset can also be
hidden until that reset — a distinct command whose wake time the host derives
from the journaled limit fact, never from the caller, and refuses when no such
stop exists or its reset is unknown or already past. `snooze.origin` records
who parked the thread: absent means a person's ordinary snooze, `usage-limit`
means the host's. The choice is independent of the durable resume opt-in —
hiding authorizes no provider turn, and a dispatched recovery lifts only the
snooze the host set, never one the person set.

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
Thread titles appear once in the title row. A thread pane's title row is its
drag handle: an environment mark (a small neutral tile holding a laptop glyph
when the thread runs on this computer, a cloud glyph and the host's name when
it runs on another host), the title, a quiet chip naming the Project, and for
Code a second chip naming the branch. The chips keep their width (each capped at a fixed character count, not a share of the header) and the title truncates first (it shrinks much faster than the chips, with no fixed floor so a narrow pane keeps its status pill), so a long title never squeezes a chip to one letter and a short title never clips a chip beside empty space;
the Project chip is omitted without a Project and the branch chip without a
branch. While the host projects the thread as executing, a "Running" pill with
a spinner follows them; it carries no elapsed time because the host does not
report when the turn began. A surface that is not a thread shows no
environment mark.
At phone width (680px and below) the title row drops both chips so the title
stays readable; the composer's context strip below the thread names the
Project and branch there.
The model stays in the composer, not the title row. The tile holds its glyph
so a later per-environment icon can replace it in place. Tab
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

## Start-screen cards

Under the composer, every start screen carries a card area: Chat, Work, and
Code, in each variant a mode has, including the Chat screen that also lists the
threads to continue. It is the same area with the same stored setting on all of
them; Chat has no folder tiles. The area is a **Customize** control on the
right, then cards in a grid (two columns, one at phone width). The composer paints first; the area mounts on the frame after the
first commit, and each card begins its reads only then, so a start screen never
waits on a card. A card that is off or unavailable is never mounted and reads
nothing.

The cards come from a small renderer registry (`apps/web/src/home`). A card is a
value: `id`, `title`, `icon`, `defaultOn`, `available`, an optional
`hideWhenEmpty`, one `emptyLabel`, and a `useContent` hook returning `loading`
or `ready` with a count and a body. The shell builds the list and hands it to the
frame, which knows nothing about any card: a new card is a new definition, with
no change to the frame, Customize, or the stored setting. `available: false`
(no GitHub connection, insecure token storage, no client in this window) hides
the card and leaves it out of Customize rather than showing it broken;
`hideWhenEmpty` drops the card from the grid while it has nothing to say. A
card that is empty otherwise shows one quiet line and never fake rows. A lone
card spans the row.

Customize is a small panel: one switch per available card, a drag handle, and up
and down buttons for the keyboard, with each change stored at once, and **Reset
to default**. The choice is the `homeCards` shell setting: `order` (card ids in
the requested order; cards it does not name follow in registry order) and
`visibility` (an entry only where the person moved away from a card's default,
so a card shipped later arrives with its own default). Ids are an open
vocabulary: an id the registry does not know is ignored, and adding a card never
changes the contract. A store from before the cards decodes to the defaults.

**Working now** follows Needs you, on by default, never unavailable. It lists
the threads executing now (the navigation rows the host projects as `working`,
the sidebar's Running rule, so a snoozed or completed row is never listed) and
the agent runs in progress from the AgentRun projection, most recently moved
first. Work lists its Chat and Work threads together and Code its Code threads,
as the sidebar's Running count does. A row shows the provider mark, the title, a
step line, and a time. The step line is the most live thing the host knows, in
this order: the running turn's own step (`Command: bun run test`, in monospace,
or "Waiting for approval" / "Waiting for your answer" in plain text), the
board's activity line on Code, the task of the agent run working in the thread,
how far its plan has come, or the Project name when the host said nothing. A
turn the host reports a start time for says how long it has run ("Running
12m"), as does an agent run; a thread whose host reports none (an older host)
says when it last moved ("Active 4m ago"). The time is read at minute
resolution from the shell's once-a-minute clock. A host name appears only when the window is
reading a host that is not this computer. A run reports under the running thread
it belongs to rather than as a second row, and is its own row only when its
thread is resting. At most five rows show, then **+N more**, which opens the
Running view (the Board; Chat's Running tile opens Activity). A row opens its
thread. The card reads what the window's controllers already hold; the run list
is one read when the card mounts and again when the thread lists change, so it
adds no timer, and a window sees only what its own authority returns. The turn
start and step ride on the same navigation rows as the executing flag (see
[Architecture: persistence](../architecture.md#persistence), fast thread
reads), so a remote window sees them for exactly the threads it can already
list.

**Needs you** is the card before Working now, on by default. It lists the
approvals and questions a provider is waiting on, from one host list of every
approval and question this window can answer across Chat, Work, and Code and
across Projects, oldest waiting first. Work's start screen shows Chat and Work
requests, Code's shows Code's. A row (`PendingRequestRow`, reused by other
surfaces) shows the provider mark when the shell knows the thread's provider and
its mode's glyph when it does not, the thread title (which opens the thread),
the Project, how long it has waited (minute resolution from the shell's
once-a-minute clock), and the text clamped to two lines. An approval offers
**Approve** and **Deny**. A question offers one numbered button per choice (the
matching number key picks it while the row has focus) and **Reply…**, which
opens the thread so the answer is typed in its composer; a question without
choices offers Reply… alone. At most five rows show, then **+N more**, which
opens the Inbox. The card is hidden while nothing waits, and unavailable where
this window has no reader (a remote window).

The card holds no authority. An answer goes through the mode's own command with
the handle the host listed: `resolve-work-request`, `answer-provider-approval`,
`answer-provider-input` (the response is kept as evidence first, with a fresh
operation id), or `answer-chat-turn-question`, the same calls the open thread
makes. After an answer the card re-reads and the row leaves with the next read.
A refused answer (a stale version, a turn that ended, a turn that cannot take
it, such as one in Plan mode, an unreachable host) shows one quiet line in the
row saying why, and then the card re-reads; a row the host no longer lists stays
until the next read or the next minute so the line can be seen. A Code answer
counts as refused when the host says `operation-failed` or reports the turn
`failed` or `interrupted`; the command palette reads Code answers the same way.
The card reads the list when it mounts, on the navigation topics named below,
and when the shell settings or the window workspace change (neither has a feed
topic). Signals that arrive while a read is in flight become one more read once
it lands, so a streaming reply does not start a host read per delta.

**Pull requests** is the next card, on by default, and only on a Code start
screen. It is hidden — and left out of Customize — unless the Pull requests
destination is offered and its read is allowed: no connection, insecure token
storage, or a missing pull-request capability hides it, the same gate that
refuses that destination's read. It lists open pull requests across every Code
Project the window can access, from the cached Project pull-request snapshot.
Opening the card reads that cached snapshot and does not poll; the existing
per-Project refresh cadence, and an explicit refresh on the Pull requests
workspace, are what move the list. Two groups: **Waiting on your review**
(a review was requested from the signed-in person) and **Yours** (authored by
that person). A pull request that is both is listed once, under waiting.
Anything that is neither is left out. A row shows the title, a short
repository and number (`repo#12`), and the words for checks (passed, failed,
running, none) and review (approved, changes requested, in review, draft). A
draft says draft rather than a decision. At most six rows show, then **+N
more**, which opens Pull requests. A row opens that pull request's existing
review for its Project. The read is one query of the window's authorized
snapshot, so a remote window sees only the Projects it was granted.

**Needs you** surfaces (a start-screen card, answering from Board cards, the
command palette) read one host list of the approvals and
questions this window can answer, across Chat, Work, and Code and across
Projects, oldest waiting first. Each item names its mode, Project, thread and
title, kind, text, options where the mode has them, and when it was asked, and
carries the handle that mode's own answer command takes, so a surface answers
in place through the commands the open thread already uses. The list is re-read
on the Machine change feed's Chat, Work, and Code navigation topics and never
on a timer; an answered or ended request is gone from the next read. It is read
at a local window only, so a remote window has no Needs you source. What it
includes and leaves out is in
[Architecture: pending requests across modes](../architecture.md#security-and-authority).

The command palette opens on a **Needs you** group when this window can read
that list. It has one row per waiting thread, titled with the thread and
detailed with its mode, what it waits on, and how long, and Enter opens the
thread. Each approval also gets **Approve** and **Deny** commands, so typing
"approve" finds them; they answer through the mode's own command
(`resolve-work-request`, `answer-provider-approval`) without opening the thread,
and a refusal shows as a notice. A question's choices are not listed, so its row
opens the thread. The palette reads the list each time it opens and never on a
timer. With nothing waiting, or at a remote window, the group is absent, and the
composer `/` list never carries it.

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
or a valid launchable tool. An available empty dock opens on a thread overview (running threads and a thread card with its facts and
changes; see [DESIGN.md](../../DESIGN.md#shell-and-layout))
above a grid of tool tiles; an open dock shows a tool strip. Direct tools are Side Chat, Browser, Files,
Document, Canvas, artifact-gated Plan, conditional Delivery, Review, Terminal,
Tests, iOS Simulator, and Android emulator, as mode and capability allow. Side
Chat is a Chat conversation about the pane's thread: it reads that thread's
conversation, current state, files, and subagent results, and changes none of
them ([authority](../architecture.md#security-and-authority)). Its notice says
what the source offers once the host names the source's mode. Document shows the
Markdown or text file the Code thread's turn most recently wrote, read through
the host-authorized file open; the renderer offers a written document, or a
Canvas the thread's agent authored in Work or Code and did not ask to show
inline, in the dock once per document, never after the person closed its tab,
and never by moving focus. Every Canvas a thread wrote appears at the end of
the turn that wrote it, on the reply's card face. One the agent asked to show
inline is drawn there read-only, within a fixed height that fades out instead
of scrolling, and is never offered in the dock, because it is already in front
of the person; any other is a single row (a live miniature, its title, one
line of facts) that opens it. The inline frame holds **Show as card**, a fold
the window remembers. In Work and Code it also holds **Open in sidebar**, which
opens the same Canvas in the dock tool, and a row opens it there too. Chat has
no dock, so there the frame holds **Open Canvas**, and the frame and a row open
the Canvas as a content tab. An
agent-authored Canvas belongs to the thread's own scope as the host resolves
it: the active Chat Project, the Work thread's confined root, or the Code
thread's checkout; a thread whose binding the host cannot resolve is refused
rather than given an assumed scope. Hand off (`POST
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
thread as a context-aware dock tab opened from the dock tab strip or Add tool. Its
Subagents row counts the active thread's server-authored child AgentRuns
(working, to review, done) and opens into the full list, working and finished;
a row opens that subagent in the Agents dock, where reading, steering, and every
other AgentRun control stay. A compact, collapsible Subagents card sits above
the composer in normal layout, as wide as the message surface. Its head counts each
state (failed, waiting, to review, working, done) and keeps failures, waits and
unreviewed results first while collapsed; a result the parent already received is
done, not to review. While a Chat thread's host connection is lost it dims and
withholds Stop without repeating the connection notice; expansion previews up to three active or
unresolved children. Rows open the corresponding detail in Agents, and View all
keeps completed history reachable. Provider-observed children carry an explicit
observation-only label and no managed controls. Task-plan progress remains a
separate disclosure. See
[DESIGN.md](../../DESIGN.md#welcome-and-composer).
The Agents dock is a list and a page, and it shows and controls subagents
without starting them: only the thread's agent starts one, through the Octant
Harness `delegate` tool, and collects its result. The list has one title, then
Working and Finished sections of one-button rows —
status icon, task, and state, role, model, and age in words — with finished
rows newest first and an unreviewed result marked "Needs review" unless the
parent already received it. A row opens
that subagent's page in place of the list, with a back control: its task as
the title, a status line, and a small transcript that starts with the task as
the brief, then the replies as rendered Markdown and status events as quiet
lines, live while it runs. When the live read is unavailable or gone after
completion, the retained final reply stands in; when neither exists the page
says so. Mark reviewed, Steer, Retry, Resume, and Cancel sit in one bar pinned
under the transcript. A run parked on a provider usage limit that disclosed
its reset additionally shows the limit and offers Resume at reset — the same
journaled per-record opt-in a thread's own limit stop takes — and Stop
scheduled resume while it is armed; the row never presents that wait as a
finished or failed run. A thread with none says subagents appear when the agent
hands off part of its work, or that they are turned off in Settings. The workspace-rail Agents Center is that same
hierarchy across modes; on a wide window it can draw the current query as a
forest of parent threads and the runs they launched, and Graph can save that forest as a Canvas diagram document for the parent thread. The Agents dock shows the host's bounded, process-local child conversation read: entries are
cursor-readable and byte- and count-bounded, with explicit complete, stale, and
unavailable states. Provider-native live transcripts remain unavailable unless
their normalized provider capability supplies an equivalent host-authorized
read; a host-retained final reply stays readable after completion. See
[decisions/0050-bounded-live-child-conversation.md](../decisions/0050-bounded-live-child-conversation.md).

Saved child-generation file comparisons open in the existing Review tool from
Agents result history. The selection carries the parent, managed child and
generation, never a filesystem path or the parent's live checkout. Changing the
active thread clears that selection. Saved comparisons use the normal read-only
diff renderer, expose capture/truncation facts, and offer a return to the thread's
ordinary Review views.

## Boards and integrations

Work and Code have server-authoritative thread boards
(Ready / In progress / Waiting / Done) that cannot be dragged between columns;
Chat has no board. Code also has a Project-scoped Pull requests workspace that
lists active open and draft pull requests from authorized connected Code
Projects. The same cached read backs the right dock's Pull requests tool and
each Code thread's Environment group, scoped to the active Code thread's
Project. The list is a cached read of a
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
bundled Linear plugin (enabled by default) as `sidebar.destination` `linear-issues`, Code mode
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

Under the composer of every thread, in Chat, Work, and Code and for every provider, a
quiet stats line states what the thread used: input and output tokens, the cache
hit, output speed, time to first token, and cost. It reads the host's recorded
turns and is worded by one shared module in `packages/domain`
(`turnMetricsDisplay.ts`), which the composer, the usage page, the Octant Harness
session card, the terminal footer, and the phone's session panel all call, so
the rules cannot drift. A figure the provider did not report, or whose denominator is zero, is
absent; a provider that reported no usage shows no line. A cache hit is never
rounded up to a whole; an approximate speed carries a tilde and a tooltip that it
is per turn and includes some tool time; a cost says "est." unless the provider
reported it and is absent when the model has no price. Clicking the line, or
**Turn details** in the context meter's popover, opens one turn at a time (tokens,
timing, retries, cost). The usage page's per-thread rows and the turn drill-in
under each row call this same module, so a thread shows the same cache, speed,
first-token, and cost figures there as under its composer. Those columns are
left out when no row can state them. The rows read `turnMetrics` on the existing
usage query; they do not add a second accounting path. A reading of one thread
uses that thread's totals. A reading that mixes threads and has scrolled past
the latest turns says those rows cover only the turns still listed. The line is on by default; `showThreadStats` in the shell
settings is the one shared preference, set from the eye button on the line, the
switch in the context meter's popover, and Settings › Appearance › Reading. Off hides
only the line; the details stay reachable.

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
