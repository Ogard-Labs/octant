# Workspace behavior

This is the current specification for workspace navigation, pane contents, and
tool presentation. [Architecture](../architecture.md) owns server, provider,
persistence, and authority boundaries; [DESIGN.md](../../DESIGN.md) owns appearance.
Update this specification with an approved behavior change, following the
[design workflow](README.md#changing-the-design).

Historical links explain rationale; their old status or placement rules do not
override this specification. The specification describes existing behavior.
Unfinished plugin extraction and other proposals are separate from these rules.

## Provider cloud jobs

An existing local Code thread offers a separate **Provider cloud sessions**
disclosure in its [info panel](#thread-info). This is an explicit remote job, not a thread mode,
checkout relocation or fallback for local tools. The person chooses an enabled
endpoint/model, edits bounded task text, reviews it and approves sending that
exact text for remote execution and possible model/sandbox charges. Changing
the input, endpoint, model or thread clears review and consent. No files or
history are attached automatically. The local thread remains usable normally.

Saved receipts show last-observed status/time and escaped, bounded, untrusted
provider text. **Refresh saved sessions** reads local state; **Check remote
status** queries only that job; **Request cancellation** is explicitly a
request, never a completion claim. An uncertain create is not automatically
retried. Before a distinct reviewed submission the person can acknowledge exact
prior unknown jobs, with a warning that earlier work may still run and bill.
Unknown receipts and usage remain. Stale responses from another endpoint or
thread cannot repopulate the new context. Account, spend and lifetime rules
remain owned by [Architecture: provider cloud jobs](../architecture.md#provider-cloud-jobs).

## Continuing after a restart

Status: Done (2026-10-28). Approved by a maintainer on 2026-10-28.

A conversation whose turn was cut off by a host restart shows a notice above
its composer: "Octant restarted before this turn finished. Review any changes
before continuing." Its **Resume** button explicitly submits one continuation
in the same thread. Completed turns, deliberate stops, and a lost renderer
connection alone do not show it. A turn a restart cut off continues by
itself, once, as the host, unless its thread is held: Continue after restart is
off in Settings or for the thread, its last effect is uncertain (a push or pull
request step whose outcome is unknown, or a tool call that may change something
and has no record of finishing, which the notice names by its tool), or its provider
cannot resume it. Only a held thread shows this notice (maintainer request,
2026-11-12; [Continuing a turn a restart cut off](decisions.md#continuing-a-turn-a-restart-cut-off)).

The server tracks turn start and settlement for every provider through the
existing session journal; routing and advisor behavior remain provider-specific.
Resume checks current window/thread authority, provider availability, and the
Project or checkout before expiring dead approvals/questions. It queues a
host-written request to inspect saved progress and continue the unfinished
request, using the ordinary mode admission and native-session restoration.
Neither the composer draft nor its attachment selections change.

The persisted queue identity is derived from the interrupted session's recovery
identity, so concurrent windows, repeated clicks, and a lost response cannot
queue a second continuation. Existing unrelated queued messages need no review
first: the continuation is queued ahead of them and they stay queued. The
message queue holds for changed authority, uncertain delivery, the person's own
cancel, and a Work thread's Done mark. After an ordinary provider failure or a
clean restart it continues by itself once, and a second failure in a row holds
it. A paired device may queue (maintainer request, 2026-11-12;
[Architecture: persistence](../architecture.md#persistence) owns the queue).
Built: the queue passes one turn its mode recorded as failed and lifts the hold
of one restart that cut nothing of it, and a paired device queues on a thread
it may already send to; Resume queues the continuation ahead of the messages
already waiting, with no review of them. A queue the person paused stays
paused, with the continuation waiting first. A refused recovery leaves the notice
and an actionable reason. A continuation already queued is visible in the
ordinary message queue, including any later admission refusal. A tool may have
taken effect before the crash without recording its result; Resume is not an
exact-operation replay and cannot promise to undo or deduplicate those effects.

Both implementation slices are complete: server bookkeeping and durable
continuation, then the shared conversation notice. Store replay, session-route,
message-queue, Chat lifecycle, and conversation-card tests cover recovery,
settlement, duplicate requests, authority refusals, and dead approvals/questions.
Rendered checks at 1000px and 390px confirm the notice, actionable refusal,
single-click continuation, and preservation of the composer draft.

## Thread info

What is true about a thread but is not part of its conversation has one home:
a quiet button named **Thread info** at the leading edge of the row under the
follow-up composer. Where the surface names the thread's Project in that row
(Work), the Project's own control is the button: its icon in the leading cell,
then its name, with "Review required" after the name while a row waits, so the
row has one control where it had a name and an icon. Elsewhere it is a small
icon after the Project (or in the leading cell). Its name is its tooltip and
its accessible name. It opens one menu above the row from its leading edge,
drawn as every other menu the row opens: the same edge, corner and
4px inset, 288px wide and never wider than the line, with rows 30px tall that
answer the pointer across their whole width. A row is its name leading, and at
the trailing edge its current value in muted ink and its arrow. The level in
force heads the menu, its name over where it came from ("Matches your
default"), and a hairline closes that group. A row that opens in place
(**Access details**, **Credential commands**, **Provider cloud sessions**)
turns its arrow and puts its content under it; the access report is a list of
facts, each name leading and its value trailing, and the menu widens to 440px
while it is open. As a padded card of loose text links the panel read as a
piece of a web page. Its rows are, in order and each only where it applies:
the access level in force and where it came from (Work and Code) with its
**Access details**, **Reply detail**, how the thread delivers documents
(Code), **Provider tools** (a key provider's own setup for this thread),
**Credential commands** (Code), **Provider cloud sessions** (Code, local
host), and **Continue elsewhere**. A choice made once for the thread lives
here, not in the composer's row: the row holds what a person changes
from one message to the next (the model, the approval mode) and had grown to
eleven controls, several of them bare glyphs. Nothing else about
the thread is drawn on the thread page outside the transcript and the
composer; these rows had each been added to the page on their own, at four
places, two of them outside the reading column.

The rows stay mounted while the card is closed, so a read or a review in one
of them does not restart when it opens. A row that waits for the person (a
credential command awaiting review) writes "Review required" on the button in
the warning ink, the one thing the button says in words. A control elsewhere that leads to a row (the access shortcut)
opens the card. Escape or a press outside closes it and returns focus to the
button; a dialog or menu a row opened does not count as outside, and Escape
inside one closes only that. While a move holds the thread and its composer
gives way to the held bar, the button stays above the bar: a held thread takes
no message, but its level and a pending review are still the person's to read
and answer.

## Continue elsewhere

An existing Chat, Work or Code conversation offers **Continue elsewhere** in its
[info panel](#thread-info). Provider requests retain their established placement. The flow names the execution host and the screen controlling it,
the source provider and the authoritative current destination. Choosing another
provider uses the same provider/model command as its composer picker and sends
nothing. Task state, the checkout and pending feedback remain on the execution
host. The next turn uses the ordinary handoff and original-input checks described
in the [architecture](../architecture.md#stop-reasons).

The person may explicitly choose **Text only: omit files and images** for the
next continuation. The choice is scoped to this endpoint and task, survives a
reload with its unsent draft, travels in a queued message and resets after
admission. Missing or unsupported originals refuse a preserving send; a text-only
send records its omissions. A receiving thread's **Original inputs** disclosure
reads the manifest admitted for that exact turn, attempt or operation, separately
from the task briefing and agent reports. Unavailable or purged manifests remain
unavailable; the renderer never substitutes a later input.

A local window can read its existing paired-screen inventory and configured,
browser-verifiable private listener. Copying a task link for a paired screen
carries only mode and thread identity. After normal paired authentication, that
screen selects the same host's existing task through ordinary read paths; it
creates no thread, session, checkout or writer and sends no message. The receipt
states that unsent drafts and local view state stay on their source screen,
while host-held inputs, task state and pending feedback stay with the task. A
paired browser can copy its already authenticated origin's task link. A missing
browser-verifiable listener offers the existing paired app's task selection
instead; opening the flow never pairs a device or enables a listener. Changing
screens never moves execution. Moving a thread to another of the person's
computers is its own owner-signed act, started from the thread's Environment
tool (its Computer card), under
[Hub and spokes: moving a thread](hub-and-spokes.md#moving-a-thread-to-another-member).

## Navigation and Projects

The window is mode-first: a persistent left sidebar headed by the Work and
Code icon buttons (Work presents the Chat and Work domains together; see
[architecture](../architecture.md#modes-chat-work-and-code)), optional count tiles, mode-aware destinations, Projects and
threads, and settings (the sidebar's anatomy is in [Sidebar](#sidebar)); an
integrated borderless top chrome; a central workspace; and an optional right
dock. Mode changes alter content, authority, default composition, and density,
never the navigation grammar.

**Home** leads the places: first in the icon rail, above Inbox, and among the
sidebar's own actions when no rail stands beside it. It closes any reader and
puts the active pane back on its mode's start screen (Code Home in Code), and
it is current while that start screen shows. The `home` keybinding
(Mod+Shift+H by default) does the same. A New task draft shares the start
screen's composer scope, so its unsent text comes back with it. Before Home,
the start screen had no way back once a person left it.

Projects opens its searchable directory in the main workspace. Selecting a Project
replaces that directory with the Project overview; Projects in primary navigation
returns to the directory. Neither view adds a second sidebar. Other destinations
replace the directory while preserving the underlying Project selection.

**Pinning Projects to the rail.** A Project can be pinned to the icon rail from
its row menu in the sidebar (Pin to rail, then Unpin from rail) or unpinned from
the context menu of its tile (the context-menu key or Shift+F10 opens it from the
keyboard). A pinned Project is a tile under the destinations, after the rail's
divider, in the order it was pinned, in the rail beside the sidebar and in the
collapsed rail; it shows the Project's icon or its initial, is named in the
label beside the rail, and is current while that Project is the open one.
Opening it is the same action as opening the Project in the sidebar. In the
collapsed rail the pinned Projects lead and the automatic list fills what is
left of six Project tiles without repeating a pinned one; the rail draws no more
than six pinned tiles, so a long list of pins never pushes Settings or the usage
rings out of the window; once six Projects are pinned, Pin to rail in another
Project's menu is disabled with the reason "The rail holds 6 Projects" and
Unpin from rail stays available, and pins saved beyond six are kept, and the Projects page still lists every Project. Pins
are the shell setting `sidebarPinnedProjects`, a list of Project ids saved the
way the sidebar destinations are; a store saved before pins decodes to none, and
a pin for a Project that no longer exists draws nothing and is dropped the next
time pins are saved, but only once the Project list is loaded and complete; a save
made while it loads keeps every other pin, and two quick pin actions both land. The More menu does not list pins: it holds only the
destinations the rail does not show.

**Project icons.** A Project shows its own icon wherever Projects are listed:
the sidebar's Project rows, the icon rail's Project tiles, the Projects
directory, the Project options in the composer's Project picker and in the move
dialog, the Project chip on a thread row, the Work overview's Project line, the
Inbox's Project group headings, and the Continue cards on Code Home. The icon is
the favicon or app icon in the Project's folder. The host finds it, because the
renderer never reads disk: it tries a short fixed list of well-known relative
paths (`favicon.*`, `public/`, `static/`, `app/`, `src/app/`, `assets/` and
`docs/public/` variants, then `icon.*` and `logo.svg`) and the first valid file
wins, with no directory walk and no pattern search. A file is used only when its
no component of its path below the Project's folder is a symbolic link (the
open is anchored to the folder and refuses a link at any depth, so an icon
reached through a link, even one inside the folder, is not used; platforms
without such an open find no icon), it is a regular file of at most 256 KB, and its first bytes agree with
its extension (PNG and ICO signatures; an SVG must open as an SVG document). The
host serves it on the authenticated Project API at `GET /api/projects/{id}/icon`
with `nosniff`, a content security policy that forbids script, and an ETag, and
answers a plain 404 when there is none. The renderer draws it as an `<img>` at
the row's own icon size (a step of the [icon scale](../../DESIGN.md#icons)) with a small radius; it never
inlines SVG markup. The picture is fetched once per Project per session, not
per render or per navigation poll. The row's letter tile or folder glyph shows
while it loads, when the Project has none, and when the image fails. A Project's
colour still shows in its overview and menus but not on a row that shows an
icon. A thread with no Project keeps the folder glyph and asks for nothing, and
many rows in one Project share the one request. Nothing is fetched from a
network, and a thread's authority does not change: the host shows the person
their own files.
The icon source belongs to the window's current host and credential. Replacing
either or unmounting its provider cancels pending icon requests and revokes its
object URLs; a late answer cannot retain a blob after that lifetime ends.

The Project overview is one reading column in the 880px measure, starting
below the title band. The header sits on the page: the Project tile at 40px
(the colour picker), the name as the editable title with the kind ("Code
Project") as its subtitle, and the actions at the right edge, New thread in
the neutral secondary paint beside the ghost Relink folder and Archive
Project. Everything else reads on cards in the Settings section recipe: one
card for the Project's folders (the main folder first, labelled Main directory
or Main repository, in mono, read from home as `~/…` with the full path on
hover and for screen readers, and its availability on the first row; then
each extra folder as an Extra folder row with Remove; then one line saying
extra folders get the main folder's access while checkouts and Git stay in
the main folder (a terminal or saved action can start in any folder), and **Add folder…**, which opens the native folder
picker on desktop and the host folder browser elsewhere; then what the
binding grants), then labelled groups. A refused folder (the home folder or
above it, a system or credential folder, one inside or around another folder
of the Project) shows the host's reason on the card. A thread's environment
panel lists the Project's extra folders read-only, under the main folder, and
shows nothing when there are none. The Files tool lists the extra folders'
files after the main folder's, each file by its own name with its folder's
full path beside the size (in Code, each extra folder is a tree of its own beneath the checkout's, headed by its last component, and its files open in the editor), and the Overview's folder list adds each extra
folder's top level labelled with the folder's name. Rules for what an extra folder grants are
in [Architecture: Projects with several folders](../architecture.md#projects-with-several-folders). Threads are rows
in one card: the title alone on its line, then the state chip, the approval
posture as quiet text (it is a standing setting, not a state or a control, so
it takes no chip), and facts on one line beneath it, then Details. A Work
Project's thread list takes the same labelled card. Settings
rows split into **Context** (Memory, Design system on a Work or Code Project ([Project design systems](design-systems.md#the-design-system-panel)), Brand kit, Canvases) and **Access and
limits** (Provider access, Guardrail level, Developer tools on a Work
Project, Disposable desktop, Status file, Spend ceiling); a group with no
rows is not drawn. **Guardrail level** shows the level the Project's threads
start at and where it came from, changeable in one click, and is the same row
in Work and Code. **Developer tools** is the Work Project's switch for
showing developer surfaces (Git panels, pull request and review surfaces,
issue-tracker integrations, the worktree and checkout pickers, and the
Project terminal), off by default, set only by a person. Its row says it
changes what the Project shows, not what its threads may do: a Work thread
has the same shell, Git, and tools as a Code thread at the same level either
way ([Modes](../architecture.md#modes-chat-work-and-code)). Built today it
shows the Project terminal and Project actions. On a server Work Project its
existing Settings → Permissions → Servers row instead offers the same default-off
presentation choice for saved actions and the person's Project terminal.
Only this window's bound Work Project offers **Open terminal** in that row;
the shell has Full remote SSH access and closes when the panel or that
presentation closes. Saved action authority remains separate. No general
tools pane is enabled ([Server Projects](server-projects.md#threads)).
Code Projects have no such row, since Code always shows them. Over an application ground the cards keep the
opaque card step even under Glass, and the header's text takes the start
screen's page-colour glow: set straight on the ground, the overview's rows
read through the ground's letters (October 2026).
Work's sidebar lists Chat and Work Projects only, with Work Projects bound to a
folder on a registered server beside them under **On your servers**
([Server Projects](server-projects.md)). When it has none and Code
has at least one, the empty Projects line says the Projects are in Code and
offers Switch to Code; a host with no Projects in any mode keeps "No Projects
yet."

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
**No Project**, never both. No Project is a collapsible folder row following
the Projects with no horizontal divider or separate section heading. It is
absent when empty and does not create a Project or filesystem authority.
Sidebar search reveals matches inside collapsed groups and restores their
collapse state when cleared. Status and the Activity feed are alternative views
of the same threads; neither is shown as a duplicate list beneath the Project
tree. **Status** is each mode's default until a person picks another
arrangement, and each mode keeps its own pick (a pick made before Status
existed is kept). It lists the threads flat under counted headings in the
order a person acts on them: **Pinned**, **Needs input** (waiting on an
approval or an answer), **Ready for review** (a finished turn nobody has
looked at), **Working**, and **Idle** (everything else), newest first within
each. A thread appears once, under the first heading that holds it. Each
heading is a fold button (`aria-expanded`) with its count and a chevron;
folded, it keeps the count and still shows the thread the workspace has open,
and a search shows every match. The window remembers each mode's folded
headings across a reload, as session storage, so other windows keep their own.
A mode with no threads at all shows a short first-run note in Status and the
Activity feed instead of an empty list: "No threads yet" in the secondary ink, then
"Start one from the composer. Your threads gather here." A search or filter
that matched nothing keeps its own message, which says nothing was deleted.

Chat, Work, and Code keep the active mode's sidebar current with projection-only
navigation reads ([routes](host-reads-and-commands.md#sidebar-navigation-reads)).
Work bootstrap still validates Project roots, while
the Work navigation read uses only active Work Project and thread projections plus
in-process runtime state. Code bootstrap still observes waiting checkouts on the filesystem so a restart can
recover them; available and unavailable checkouts are not re-probed, and the
sidebar timer never walks the checkout tree. Inactive modes and hidden windows
pause those refreshes so background ticks do not contend with the next
interaction.

### Reply detail in the thread in front

The `reply-detail-cycle` keybinding (Mod+Shift+D by default) and the palette's
Reply detail commands act on the thread in the active pane, setting that
thread's own level, and only while that thread is on screen: a page or Settings
covering the workspace leaves no thread in front. The palette also sets the
default. The levels, the thread
menu, and where the levels are kept are owned by
[DESIGN.md: Transcript](thread-view.md#transcript).

### Jump to the next waiting thread

The `next-waiting-thread` keybinding (Mod+Shift+J by default) and the palette
command **Jump to the next thread that needs you** open the next thread waiting
on the person. The renderer reads the attention signals the sidebar and Inbox
already render and adds no host read. Each thread counts once, at its strongest
reason, in this order: approval, question, finished turn not yet looked at;
within a reason, in the order the signals are listed. The jump goes to the entry
after the open thread and wraps from the last to the first; when the open thread
is not waiting it goes to the first, and when nothing waits it does nothing and
the command is absent from the palette. A failed turn is not in the order: the
thread listing reports no failure, and a status is never inferred from silence.
A due follow-up is a reminder, not a waiting thread, and is left out. The
Status arrangement's **Needs input** and **Ready for review** headings are the
list-side counterpart, so no second priority group is added to the Projects tree.

### Coordinators

[Coordinator threads](coordinator-threads.md) own the role; this section owns
where a coordinator and its workers appear. Built; rendered against mocked threads, not yet on the desktop app.

- **Sidebar.** A Code Project with coordinators shows a **Coordinators**
  section at the top of its Project tree, above its other threads. Each
  coordinator row has the coordinator mark in place of the thread icon and a
  fold button (`aria-expanded`) that shows or hides its workers beneath it.
  Folded, the row reports how many of its workers are working and how many need
  input, through the [sidebar status policy](#sidebar-thread-status), so a
  folded coordinator never hides a request. Its open workers are listed only
  under it, never again among the Project's other threads; finished workers
  follow the ordinary completion and put-away rules. The window remembers each
  coordinator's fold state as session storage. The Project's designated planner
  is listed among its coordinators.
- **Status arrangement.** Coordinators are listed under **Pinned**. Workers
  keep their ordinary headings, with their coordinator's name as secondary text
  on the row.
- **Board.** A coordinator is never a board card: the host's board read
  leaves it out, the designated planner included. Each card carries its
  worker's coordinator id from the host and names that coordinator. The board's
  Filters popover has a **Coordinator** choice, shown when the window has
  coordinators, that asks the host for one coordinator's workers.
- **Menus.** A Code Project's sidebar menu has **New coordinator**, which
  opens the ordinary Code draft under a "New coordinator" heading and makes the
  thread a coordinator once its creation is confirmed, before the first
  message is sent. Under the heading the draft has **Workers start at** (this
  thread's level or lower, or always at one named level, Full access included)
  and three number fields for the coordinator's bounds (wakes an hour, rounds,
  worker starts an hour), each empty for its default
  ([Coordinator threads: Bounds](coordinator-threads.md#bounds)). A Code thread's row menu has **Make coordinator**, a submenu
  with the same worker-level choice, or **Stop
  coordinating** on a coordinator (never on a worker); on a coordinator
  **Coordinator limits…**, which opens a dialog with the three bounds and
  Save; the **Wake when a message
  arrives** checkbox, on a worker the **Wake for coordinator** checkbox, and
  the **Continue after restart** checkbox, on until a person turns it off for
  that thread ([Architecture: Persistence](../architecture.md#persistence)).
  A Chat or Work thread's row menu carries the same **Continue after restart**
  checkbox, and a Work thread's the **Wake when a message arrives** checkbox.
  The same items appear in a Code thread pane's header menu (right-click the
  header), above Close pane, through the same handlers. On the designated
  planner the role item is left out, since its role follows the designation.
  Settings › Code › Coordinators holds **Starting workers** and **Open workers
  per coordinator**, and a Code Project's overview holds its own **Starting
  workers** choice (Use Settings, Start without asking, Propose for approval)
  after the Project planner section.
- **Agents dock.** A coordinator's Agents dock has a **Workers** section under
  its own subagents: one row per worker in the window's thread list, with the
  provider's mark, the title, the thread's state in words (Working, Needs
  attention, Done, Idle), and how many subagents it handed off and how many of
  them are working. A row opens the worker. In Graph, each worker's subagents
  are drawn under its row as the same cards and arrows a thread's own graph
  uses, and a card there opens the worker, since its subagents' pages and
  controls are the worker's. The List and Graph switch is offered when the
  coordinator or any worker has subagents. When the coordinator has more workers
  than the host reads, the section says subagents are shown for the most
  recently changed workers only, since an older worker's row cannot otherwise
  tell "not read" from "handed off nothing". When the host refuses the read, the
  rows stay and the section says the workers' subagents cannot be read here
  ([Coordinator threads: Seeing workers' subagents](coordinator-threads.md#seeing-workers-subagents)).
- **Requests.** A coordinator's composer lists its workers' pending approvals
  and questions in the same bounded region as its child runs' requests, each
  naming its worker, with an Open worker action. The rows come from the
  window's pending-requests read filtered to the coordinator's workers in the
  window's thread list, one request at a time with a choice between them; a
  finished turn's decision is not listed there.
- **Proposals.** A coordinator's pending proposals show as cards above its
  composer (title, intent, **Review and approve**, **Decline**), beside the
  routine and memory proposal prompts, sharing the Project planner section's
  read, review dialog, and one-decision-at-a-time guard. The review starts on
  the requested provider, model, and level and offers no mode above that level.
  A paired browser's Code workspace and the phone's Code thread screen show the
  same cards and decide them as a window does (maintainer decision, 2026-11-12;
  not built yet: today they are read-only there, with "Approve at a window on
  this computer" and no decision).
- **Owner devices.** The owner access recovery screen (phone, and a browser's
  owner section) shows a chosen Code thread's **Wake when a message arrives**
  and, on a worker, **Wake for coordinator**, each change under its own fresh
  unlock; the coordinator role is never there.
- **Needs you.** A worker's row in Needs you and the Inbox shows "via" its
  coordinator beside the worker's title, from the window's thread list.

### Sidebar thread status

The sidebar speaks about what a thread is doing now with one vocabulary, in
descending strength: `working` (Working), `attention` (Needs attention), `woke`
(Snooze ended), and `unread` (New activity). `@octant/contracts`
(`SidebarThreadStatus`) declares the legal set because a saved Project View
persists it; `@octant/domain` (`sidebarThreadStatusPolicy`) owns the order,
labels, roll-up, and comparison, and its label record is typed over the
contract's union so a word cannot be added without a rank. A thread row, a
Project heading, a filter, and a sort all resolve through that policy, so they
cannot rank the same facts differently.

- Nothing to report is the absence of a status (`undefined`), not a word: no
  "Idle" mark, filter value, or sort rank exists. The Status arrangement's
  **Idle** heading only gathers the threads with no status; it is not one of
  the words, and its headings are phrased as what the person does next rather
  than as the status labels.
- Only facts the sidebar already carries are statuses. A failed run or blocked
  check is not inferred from silence; adding a status is a wire change that
  requires the sidebar to carry the fact first. This vocabulary answers what is
  happening now and is narrower than the board's delivery states.
- A folded Project reports its strongest status and how many threads reached
  it, each thread counted once at its own strongest status. The report is the
  mark its rows wear, appears only while the threads are hidden, yields its
  width to the row's hover controls rather than widening the row, and obeys
  the Status row property.
- A saved view's status filter keeps a thread whose strongest status is
  selected. An empty or absent list means every status; a saved word this build
  does not know is dropped rather than refusing the view, and dropping every
  word means no constraint.
- Ordering by status puts the Project with the strongest status first, then
  more threads at that status, then recency, then name. Quiet Projects follow
  every reporting Project in that same recency-then-name order.

The filter and the ordering live in the Project View menu of both visible
modes, Work and Code, each with its own set of saved views.

## Thread visibility and completion

A Chat, Work, or Code thread has two resting states beside archive, both fields
on the thread aggregate rather than lifecycle values: **completed**, which
every client and the user guide call **Put away** (`completedAt`, manual only,
refused by each mode's service while a turn runs or the thread waits on the
person) and **snoozed** (`snooze.until`, an overlay
that hides the row until the wake time and wakes it early when the agent needs
the person or a turn that was running at snooze time ends). The sidebar files
both in collapsed shelves below the Project groups and derives snooze
visibility from the clock; no host timer wakes a snooze. The Work and Code
boards leave out completed threads until they are reopened. A person sending a
thread a turn reopens or wakes it on the server. One host sweep archives
completed threads of every mode once their completion is older than the
`completedThreadArchiveAfterDays` shell setting (default seven days, `null`
for never), re-deciding against each mode's authoritative record and
journaling the ordinary thread update as the `system` actor. It archives only.

**Put away** is the only name people see for this state, beside the board's
Done: the sidebar shelf, the row-menu action, the Review page action, the
Settings rows and the host's refusal sentences all use it. It is a name only.
The stored `completedAt` field, the `complete-*-thread` commands, the
`completedThreadArchiveAfterDays` setting and the `thread-completed` end reason
keep their names, and it is a different state from a Work thread marked Done.
The sidebar's **Done today** tile keeps its name and opens the Put away shelf;
the shelf's `data-shelf` value stays `completed`, separate from its label.

The **Review page** lists the threads the sidebar's To review count counts, by
the same predicate (`isWaitingForReview`: unread, not working, not on a shelf),
so the tile's number and the page's rows never disagree. A Code thread's
checkout diff remembers Unified or Side by side in this window; Settings ›
Code supplies the default only while that thread has no stored choice. Rows run oldest
first, by the host's reported finish time where it has one. The detail panel
reads the thread's last reply, the Code board's check facts, an Octant-run
check after the last turn where one exists, and the checkout's diff; Chat rows
show the reply only. A thread whose finished turn asked a decision shows the
ask and its options (the Needs you row, embedded) above the full reply; its
number keys pick an option while the row has focus, and the option is sent as
the thread's next turn. Work navigation projects no unread flag, so Work threads
never count toward To review and never list here; the page's Work wiring
(send-back refuses and points at the thread's composer) waits for that flag. Put away, Snooze and send-back go through each
mode's existing commands and show the host's refusal in one line; mark-seen
moves the read cursor. Its single-key commands are page-scoped keybindings: they
may be a bare key because only the focused page dispatches them, and the
window-level listeners never run them. Focus left on the window's body is not
the page; when the control holding focus leaves with its thread, the page takes
focus back so its keys keep working. The page holds no pull-request action
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

### Deferring a pending question or decision

Home, Inbox and Review let a person defer an answerable Chat, Work or Code
question, or a Work or Code decision, using the existing future-time presets. The condensed row stays in
the attention list and its count, after active requests, with **Bring back now**
and a link to the thread. The shell clock restores its answers when the time
arrives. Thread visibility, the original questionnaire and draft answers do not
change. Deferring never answers a question, grants approval or resumes a turn.

The local host rechecks window access and the current pending request before
journaling an opaque request key and wake time. The key of a question binds the exact request,
choices and authority context; a changed, answered or cancelled request does
not transfer its deferral to another question. The key of a decision names the
turn that asked it, so a later turn's decision starts undeferred. Preferences replay after restart
and invalidate navigation reads in other windows. Execution approvals
and find-only lead/subagent questions cannot be deferred. Find-only questions
need a stable answer identity before this control can apply to them.

## Panes and content navigation

The central workspace is one persistent recursive
split tree. A leaf holds exactly one surface — a thread, a draft, a Project
overview, a utility surface, or a mode welcome. A pane retains navigation references for conversations, files, previews, and canvases; selecting a
tab reopens that surface through the authoritative command path. Image creation
and revision occupy pane-owned tabs whose drafts remain mounted while switching
back to the conversation. Opening the same content selects its existing entry; closing active content
selects its neighbor. A refused host open does not activate a successful tab.
Kept references and their order are saved in device-local storage per execution
endpoint and client window, with exact host/mode/Project/root context and pane
identity. Reload restores those references only when the current authorized
workspace has the same context and pane. The authoritative workspace alone
chooses the visible surface and selected tab; restoring references never opens
another surface, starts a process, sends a draft or reapplies an approval.
Temporary single-click thread previews are omitted, closed references stay
closed, and selecting a missing or revoked reference shows the ordinary host
refusal without opening a substitute. A pane/context change drops old references.
Storage is bounded to 128 references per pane, 64 panes and 512 KiB on read;
malformed or unavailable storage falls back to the current visible surface. Closing image creation stops
observation, while only Cancel job cancels generation on the host. Editor cursor/scroll state is restored only for the same thread, checkout, file
identity and digest. Review retains its selected file and scroll for the exact
captured diff; an absent selected file stays explicit rather than retargeting.
Transcript offsets require the same first loaded row and viewport width. These
presentation references share the endpoint/window/context boundary, retain at
most 64 entries and 128 KiB, and write no document text, native process identity,
approval or authority. They never take focus or perform a host operation during
restore. Composer drafts retain their existing durable storage. Editor drafts use the local recovery store described under [File editing](#file-editing); approval requests keep their explicit controls.
Thread titles appear once in the title row, and the row shows the thread's
current title: a pane stores the title the thread had when it opened, so the
shell reads the title from the navigation rows instead, and a rename made in
any window reaches every open pane. A thread pane's title row is its
drag handle. Its text starts on the left edge of the thread's text column
below (see Alignment in the design system), so the title reads one line down
into the transcript: a breadcrumb (the Project in meta text, a slash, and the
title), then the environment mark (a small neutral tile holding a laptop glyph
when the thread runs on this computer, a cloud glyph and the host's name when
it runs on another host) and the pull-request chip. With content tabs open the
mark leads the tabs as before. The Project keeps its width (capped at a fixed character count,
not a share of the header) and the title truncates first (it shrinks much
faster, with no fixed floor so a narrow pane keeps its status chip); without a
Project the breadcrumb is the title alone. A header narrower than 520px (a
pane in a split) drops the Project step too and names it in the title's
tooltip, so the title is read whole instead of both steps being cut. The branch is not repeated here: it
is in the line under the composer, beside the thread it runs. While the host projects the thread as executing, a "Running" chip (a neutral wash, not the theme's tint) with
a spinner follows them; it carries no elapsed time because the host does not
report when the turn began. A thread whose turn is parked on the agent's own
approval, or on a question the turn asked, is not running: the chip reads
"Needs you", with no spinner, until someone decides or answers. A surface that is not a thread shows no environment mark.
With content tabs open the bar holds the drag handle and the tabs alone: the
Project and the Running or Needs you chip leave it. A Project name ahead of
the tabs read as one more tab, so it moves into the handle's tooltip ("Project
· Drag to move or split"), and the line under the composer still names it; each tab
carries its own thread's state, a spinner in place of its provider mark while
it runs and a small warning dot after its title while it waits on the person.
At phone width (680px and below) the title row drops both chips so the title
stays readable; the line under the composer names the
Project and branch there.
The model stays in the composer, not the title row. The tile holds its glyph
so a later per-environment icon can replace it in place. Tab
geometry and close-control presentation are shared with dock tools under
[Content tabs](#content-tabs).

These tabs add no persisted layout or authority.

**Opening into tabs.** A single click on a sidebar thread opens it in the
active pane in place: it takes over the pane's open tab unless that tab was
kept, so browsing threads does not grow the tab row. A double click keeps the
thread as a tab of its own, and so does a later double click on its tab; a
kept tab stays when another thread opens in the pane, which then opens beside
it as a new tab. A tab opened from anywhere else (a link, a search result, a
drop) is kept.

A thread row drags out of the sidebar the same way from either arrangement,
Status or the Project tree. Chat and Work threads share that list but not a
layout, so a row is dragged as the kind of thread it is, and a row of the
other mode dropped on a pane opens the way its click does, the window
following it to that mode, where the host would refuse to place it.

**Moving tabs and showing them side by side.** A tab drags the way a pane's
title row does, through the same drop rules: dropped on another pane's edge it
splits that pane and opens there, dropped on a pane's centre it opens in that
pane, and any tab of a pane that holds more than one may split its own pane,
so a tab dragged to its pane's right edge lands beside the thread the pane
shows. The pane's open tab does so too: the pane first shows the neighbour a
close would show, then the tab is placed. (Carried with its pane, the open tab
had no drop target anywhere in the pane it was in, and dropped on another pane
it took the whole pane, its other tabs with it.) A pane's only tab moves its
pane, as the title row does. A tab that moved out of a pane leaves that pane's
tab row. ⌘-click (Ctrl-click off Apple
platforms) adds a tab to a selection or takes it out; Shift-click selects the
run of tabs from the open one to the clicked one; a plain click clears the
selection and opens the tab. Selected tabs carry a wash between the plain and
the open one, and their names say "selected" to assistive technology. Two to
four selected tabs dragged onto a pane, at its centre or an edge, or **Show
side by side** from a tab's context menu, lay out in that pane: two side by
side, three in equal columns, four as a 2×2 grid, in tab order. More than four
keeps the first four and says the rest stayed as tabs. With no selection,
**Show side by side** puts the right-clicked tab beside the open one. The
layout is made of ordinary split commands, so closing or resizing a pane
afterwards works as for any split, and a placement the window's authority
refuses (another Project, mode, or host) is refused with the usual message.
Several same-authority threads can be pinned or dropped into
that tree; pointer activity and keyboard input make exactly one pane active,
and the pane's drag handle (its title row) alone marks it visually, with no
other border, fill, or badge. The pane region carries `aria-current` and its
accessible name for assistive technology. Increased-contrast mode also fills
the active pane, as a contrast fallback and the one exception to the handle
alone. The older plan's separately "marked active pane" is superseded. Completed layout operations go through
server-authoritative workspace commands. One visible tree belongs to one
authority context (host, mode, Project, and bound root); a cross-Project,
cross-mode, or cross-host placement is refused or offered in a new window.

Dragging a sidebar thread onto a Chat, Work, or Code composer attaches that
thread as context. The drop uses the same mention path as typing `#` and
choosing a thread: the host decides whether this window can Open it, the
chip is a bounded reference, and the draft is not sent. The source thread
is not moved or opened. While the pointer is over the composer, the
composer itself is the drop target, not the pane behind it. The row menu's
**Attach as context** does the same thing for the composer that has focus,
or the only composer when one is open. Dropping the composer's own thread,
a thread already attached, something that is not a thread, or a thread this
window cannot Open leaves the draft unchanged and says so without reading
the thread. Image and file drops, and dropping a thread on a pane rather
than its composer, stay pane and attachment behaviour.

### Find in a thread, and a new thread from a selection

⌘/Ctrl+F in an open Chat, Work, or Code thread opens a find bar pinned to the
top of the transcript. It matches text in every row, including rows the
transcript has not mounted, shows "n of m" (or "No matches"), highlights the
matches, and steps with Enter and Shift+Enter or the arrows. Escape or the close
button dismisses it. The shortcut does nothing while focus is in the code editor
or a terminal, which have their own find, and it acts only in the thread the
person is in. This is separate from Thread Search, which looks across threads.

Opening Find keeps the transcript virtualized. On the first nonempty query,
a cancellable pass indexes rendered text in batches of at most 32 additional
rows, yielding between batches and showing Searching until the index is ready.
This preserves inline formatting, block boundaries and closed-disclosure rules
without a second interpretation of message markup. The index retains text,
never detached DOM ranges, and subsequent queries reuse it. Changed rows refresh
in rotating batches so streamed updates cannot repeatedly restart indexing at
the beginning; known matches remain usable while refreshed text arrives.
Closing Find releases the index. Disclosure visibility changes refresh the
row's indexed text. Disclosures initially open at High detail do not pin an
indexing row; explicit disclosure choices and focus retain their normal pins.
Navigation mounts only the current matching
row in addition to the ordinary viewport. This trades incremental first-search
latency for responsive input and bounded mounted content in long histories.

In a Work or Code thread, selecting text inside one assistant reply offers
"New thread from selection" as a small action under the reply and in the
reply's right-click menu. It opens the new-thread draft in the same Project and
mode with the selection prefilled as a Markdown block quote. It is a draft
only: nothing is sent until the person sends it, and the new thread has exactly
the authority a new thread in that Project has. A Project that is archived or
unknown opens nothing. Chat keeps its own "Add to chat" quote chips.

## File editing

Work's Files previews offer Edit for plain text and Source for Markdown. The
person may switch Markdown between Preview, Source and Split; switching views
keeps the editor model and its undo history. Wide layouts place source and
preview beside each other, and narrow layouts stack independently usable
regions. Code keeps its file editor and adds a file breadcrumb and a Problems
list whose rows reveal the reported range in the current file.

Work edits apply only to existing ordinary files, including files in an
approved extra folder. Saved artifact versions, attachments, PDFs, office
formats and images retain their viewers and external handoffs. Text source is
loaded in full through an independently authorized source route; preview chunks
may be normalized or truncated and are never editable source. A local window
may manually save inside the current Work Project at its existing access level;
this human action grants no agent write, shell or Code authority. Plan refuses
editing. The source route is not admitted for paired-device principals.

Work source editing accepts regular, single-link UTF-8 files up to 5 MiB,
preserves BOM and line endings, and rejects binary or invalid text. The host
resolves the opaque target inside the current main or extra folder on every
request, opens through the existing confinement proof, and checks authority,
root, physical file identity and source revision before writing through that
same descriptor. The host serializes source reads and saves by physical file
identity across windows and Project aliases, reading the baseline again after
the preceding operation completes; concurrent stale saves return a conflict.
It never creates a missing source. Saves flush the descriptor;
an I/O failure can leave a partial write and its outcome is never retried
implicitly. This is a human file save, not a new artifact version or a multi-file
transaction. Code retains its existing file-helper save path.

Both editors share Commands, Find, Replace, Format, Go to line and Editor
settings. Preferences cover wrapping, indentation, spaces or tabs, visible
whitespace, minimap and opt-in format on save. Settings stay on the person's
client. A Code file additionally exposes the language-server outline and
selection-to-agent review. Language capabilities and launch authority remain
owned by [Language services](language-services.md).

Unsaved text is kept locally on the client, separately from pane references,
messages and the host journal. Code recovery keys include the endpoint, checkout
and file identity; Work recovery uses the authorized host, Project and a stable
opaque key for the physical root and file path, so temporary listing tokens do
not lose a draft on host restart. A recovered draft retains its original source
revision. A newer disk version requires comparison and an explicit choice to
keep the draft against that version or discard it; Save never silently adopts
a newer baseline. Failed local storage keeps edits in memory with a warning to
save before closing. That warning stays visible while any draft remains
unpersisted, even when its baseline or another draft was stored successfully.
Saving or discarding removes that file's recovery copy.
Opening source is authorized before a recovery copy is shown.

Code's content search offers literal, case-insensitive replacement in its
listed matching files. The person prepares and reviews before/after text for
at most 16 files, 256 KiB per file and 1 MiB of combined preview text. Incomplete
search results are explicitly labelled. Preparation refuses unsaved editor
drafts; application checks them again before any save and before each file.
Saves use the reviewed physical identity and digest and stop at the first
conflict or failure. Earlier successful files remain. Plan may prepare a review
but cannot save it. Nothing runs a language-server command or writes without the
ordinary authoritative file-save route.

Send selection to agent quotes the exact selected text, path and line range in
the current conversation draft; only the person sends it. The editor retains
that selection's complete draft baseline. The person may load the latest
completed same-thread/same-checkout agent reply when it contains exactly one
fenced code block, or paste a proposed replacement. Preview replacement shows a
comparison. Apply replacement to draft is allowed only while the complete draft
still equals the captured baseline and the editor is writable; it writes no
file. Save remains the explicit disk write.

## Start-screen cards

Every start screen shows one question and its composer. **New task**, in
every mode, stops there, with the composer docked at the foot of the page.
**Code Home**, where Code lands with nothing chosen, adds Code's prompt
suggestions, one card area, and Code's agent home under the composer. No
start screen has tabs or action tiles. These are the rules; each card's rows,
wording, and reads are specified in [Start screen](start-screen.md).

- **Paint order.** The composer paints first. The card area mounts on the frame
  after the first commit and each card begins its reads only then, so a start
  screen never waits on a card. A card that is off or unavailable is never
  mounted and reads nothing.
- **Cards, in default order.** Needs you, Working now, Running services, Pull
  requests, CI failures, and Computers, each on by default, on Code Home only.
- **Unavailable is hidden.** A card this window cannot read is hidden and left
  out of Customize rather than shown broken: Needs you without a
  pending-request reader (a remote window); Pull requests and CI failures
  without a GitHub connection, with insecure token storage, or without the
  pull-request capability (the gate that refuses the Pull requests
  destination's read). Working now is never unavailable.
- **Empty states.** Needs you and CI failures leave the grid while they have
  nothing to show. Computers leaves the grid while the only computer is this
  one and no agent is running on it (or while that count is still landing, so
  the gauges do not flash). It comes back when a second computer is connected
  or an agent is running. Working now leaves the grid while nothing runs. Pull requests
  says "Nothing is waiting on you." only after a successful read that a refresh
  has carried to every connected Project; otherwise it says it could not read or
  has not checked yet. Running services says it could not check rather than that
  nothing runs. Any other empty card shows one quiet line, never fake rows. A
  lone card spans the row.
- **Row limits.** Needs you and Working now show at most five rows, then **+N
  more** (Needs you opens the Inbox, Working now the Running view); Running
  services five, then **+N more
  listening**; Pull requests six, then **+N more** (Pull requests); CI failures
  five, most recently failed first; Computers four, then **+N more**.
- **Reads.** A card reads only what the window's own authority returns. Needs
  you and Working now read on mount and on change signals and add no timer;
  signals that arrive during a read become one more read once it lands. Pull
  requests and CI failures read the cached pull-request snapshot once on mount
  and never poll; only an explicit refresh or a Project's opt-in cadence moves
  that snapshot. Running services (every five seconds) and Computers (about
  every ten) poll only while mounted and the window is visible.
- **No authority.** Answers, Open, Stop, and Start a fix go through the commands
  and confirmations the open thread or Environment already uses. An option is
  words sent as the thread's next turn, never an action. Start a fix opens a
  draft and never sends.
- **Customize.** One switch, drag handle, and up and down buttons per available
  card, each change stored at once in the `homeCards` shell setting, and
  **Reset to default**. An id the registry does not know is ignored, and a card
  shipped later arrives with its own default.
- **Needs you elsewhere.** Board cards, the command palette, the Inbox, and the
  Review page read the same host list and answer in place through the same
  commands. The desktop menu bar lists the same waiting threads but only opens
  a thread; it answers nothing. See
  [Needs you across surfaces](start-screen.md#needs-you-across-surfaces).

### Inbox page

The Inbox opens as a few raised cards in one readable column, not as sections
under rules.

- **Title line.** "Inbox" as a display title (`--oct-text-2xl` at the strong weight, a modifier on the page title), and on
  its baseline, in the meta ink, one sentence of state in the person's locale:
  today's date and what waits ("Nothing is waiting on you.", "1 thread is
  waiting on you.", "3 threads are waiting on you."), with the urgent count when
  there is one. There is no greeting by time of day and no separate count line.
  Refresh is a quiet icon button with a tooltip at the trailing edge.
- **One column.** The content keeps a measure of 980px, left-aligned under the
  title's inset; a wide window leaves ground, it does not stretch the cards.
- **Cards.** **Needs you** is the left card and **GitHub**, **Linear** and
  **Plan usage** stack to its right at about three to two (the list is the wider column), in one column when the
  page's own width (a container query, not the window's) is under 720px. Each
  card's label sits inside it at the top in the meta ink. The Needs you filters
  (All, Urgent, Decide, Stuck, Finished, with counts) are quiet chips at the
  trailing edge of that label row and filter only that card. An empty Needs you
  says what will show up there in one sentence, with Open the Board as a quiet
  text button beside it. Loading, empty and failed GitHub and Linear are one
  sentence in their card.
- **Plan usage** lists each provider account that reports a plan window: its
  name, the share left on the plan usage meter and, where the reading carries
  it, when the window resets. It reads the host observation the composer and the
  rail already hold, adds no request, and is absent while no account reports a
  window.
- **Rows** in every card carry no rule between them; the row under the pointer
  takes the quiet hover fill with the row radius. Screen readers meet the title,
  the state sentence, Needs you, GitHub, Linear, then Plan usage.

## Tool lifecycles

In current Code Review, **Select Git hunks** opens separate **Index → Working
tree** and **HEAD → Index** comparisons. The selected unified hunk shows its
file and both line ranges before Stage, Unstage or Reverse. Selection always
uses exact whitespace, independently of the ordinary diff's display preference.
Reversal asks confirmation and changes only selected unstaged hunks; its
confirmation does not bypass ordinary approvals. Plan may inspect these
comparisons but cannot mutate. Unsupported binary, rename, conflict or
unavailable bytes are explicit. After applying, Review rereads the index and
working tree. Stale selections require a new comparison; captured run and Git
History views do not offer mutations. The authority, native preflight and writer
rules are in [Architecture: Code](../architecture.md#modes-chat-work-and-code).

Thread utilities live in the Right Utility Dock outside the split tree. The dock
shows one open tool, or several together as tiles (at most two columns of three;
[Tool tiles](#tool-tiles) owns the geometry and the tool
buttons' menu). One tool at a time meant choosing between a simulator and the page it
was testing, so a thread keeps, beside its open tools and the selected one, which
tools are shown. A shown tile is live and stays mounted while it is shown;
a tool that is open but not shown is not mounted, as a hidden tab never was.
Each tile resolves its own availability against the active pane, and the dock
still never shows another pane's content. All Browser tabs are pages of one
Browser tool and share one tile. The layout is window-local presentation in
local storage: it grants nothing, starts nothing, and the bottom panel never
has one. Each tile has one bar, 32px: the tool's name (the Browser's bar is its page row),
then the tool's own controls (navigation as words, actions as icons, status as
text; they fold into a named view menu and then a More menu before the name is
cut), with an Arrange menu (Move left, right, up and down where the caps allow, Show
alone, Hide from view, and for the Browser and Terminal Minimise to card) and Close at its
trailing edge; a tool that is open but not shown is marked on its button in the title band's
tool row (a minimised tool is not a tile: its card stands for it, and its button says so).
Stacked, a page showed four bars and named the tool
three times. Every tile is a square pane that shares its edges with its neighbours and
with the stage: no gap and no corner, one 1px line between two panes
([DESIGN.md](../../DESIGN.md#depth-and-material) owns the material), and one
under the title band along the top. The divider's hit area is 8px wide,
centred on that line; it is empty at rest, shows the strong border while hovered
and the meta ink while grabbed, and keeps no accent line after a click. At 960px and below the dock is a
sheet over the page (a floating container with its own 12px corner) that holds
one tool, so its tile is the same square pane with no neighbour: a tile is square
and flat at every width, and no width gives one a corner, a rim or a gap. Columns stand side by side only when the tile area can give each 280px and
otherwise stack. The thread keeps 440px beside two columns (560px beside one,
from a 1100px window up), because at 560px two tools could never stand side by
side in a 1440px window: with the sidebar open a second column widens the dock to
about 620px, about 306px per column. Stacked columns stay resizable. A tool the bottom panel takes, or one
that becomes unavailable, loses its tile and returns as a tab. Opening a dock tool leaves the bottom panel open; only a tool the panel
already shows leaves it for the dock.
The shell loads each tool through `dockModuleRegistry`; modules under
`apps/web/src/dockModules` receive only declared inputs and contain render
failures. Review owns local Working tree and Git History views. History reads
through `GitHistoryReader` and the authenticated Code checkout-read boundary;
its Git subprocesses are network-denied and its data is an ephemeral read,
not a second journal. Pages anchor to immutable Git tips, and commit details
compare immutable object IDs with an explicit parent for merges.
Review also owns Local commits: the commits on the thread's branch that its
upstream does not have, or that its base branch does not have when it has no
upstream, each opening to its own diff. The host picks the comparison and
names it in the view; it never fetches. A listing holds the newest 100
commits and says when older ones are not shown. **Ignore whitespace** is one
per-person choice, kept in the browser profile and followed by every mounted view, that the Working tree and
commit diffs apply by asking Git for `-w`. It changes only the diff text: the
changed-path list, line totals and checkout state token are unchanged.
Local review findings belong to the Code thread and checkout that supplied the
comparison. A completed turn's changed-file row opens that file in Review only
when its recorded checkout is still the thread's binding. Older receipts that
did not record a checkout say so; a rebind never retargets their files. Review
shows its current captured comparison for an unversioned receipt. A receipt with a
retained turn capture opens that exact version instead; it never substitutes
today’s Working tree for missing captured evidence.
Changed-file receipts and Review cover the checkout only, not extra Project folders.

A running local Code turn can publish versioned comparisons from the durable
working-tree checkpoint recorded when it started. Each capture names its turn,
checkout, starting tree, captured tree, immutable journal cursor, version and
capture time. These are checkout observations that can include another person’s
or agent’s writes, never proof of exclusive authorship. Relevant normalized file
edit/diff events and admitted app-managed terminal write completion or timeout
request captures; text tokens, generic tool progress and passive metadata reads
do not. Bursts coalesce for 500 ms, background captures start at most once per
five seconds, and one in-flight capture owns a twenty-second deadline. Explicit
**Capture now** requests one bounded current comparison of the same live turn.
Every capture rechecks current standing Project access, operation, model,
checkout and writable posture, including after queued native work. The existing
root authority must still resolve the original Project binding, repository and
checkout, including the admitted physical directory identity; replacing a root
under the same IDs cannot authorize fresh capture. Plan can read
retained captures but creates no scratch-index capture. Missing baselines,
server/unreadable checkouts, changed bindings, expired authority and failed
capture have explicit unavailable states; none silently reopens another source.

A capture retains at most the existing 256 KiB diff limit in the bounded,
deduplicating Code evidence store. Binary files, omitted paths and truncated
patches are visible; partial captures cannot anchor a new line finding. The last
valid version remains readable while another capture runs or fails. A delayed
failure notice belongs only to its own capture attempt and cannot supersede a
newer successful version. Final
capture precedes a settled receipt when authority and the original baseline are
still available; otherwise the missing final capture is explained. Temporary
native checkpoint anchors are released even after cancellation. Host close or a
purged/rebound owner permits no late fresh preview or orphaned captured bytes.
These observations create no execution grant or persistent unattended owner.

Captured Review pins the person’s displayed immutable version. Newer and final
versions are announced separately and replace it only when the person chooses
**View newer capture** or **View final capture**, after the bytes’ length, digest
and UTF-8 are validated. File selection and scroll survive refresh/reconnect;
a selected path absent from the chosen version requires a new selection.
Existing notes retain their original capture and never follow the displayed
version silently. The shared whitespace preference is preserved, but this view
labels its bounded display-only behavior **Ignore edge whitespace**: paired
leading/trailing-whitespace-only changes are unhighlighted in unified view and
Monaco ignores trim whitespace. This does not claim full Git `-w` equivalence;
canonical bytes, source line numbers, captured version and note references stay
unchanged. Opening the current file in an editor remains separate from reading
its captured compared regions.

The person selects a real source line on the original or modified side of a
retained Working tree or run diff. The host binds the local finding to its own
comparison evidence, digest, revision and side. Reconstructed hunks identify only
those compared regions, never the full file. A deleted file supports its captured
original lines; binary, missing, purged and uncaptured lines say why a line note
is unavailable. Outdated anchors stay visible on their original revision and are
never moved silently. Legacy findings remain readable with unrecorded comparison
identity labeled explicitly.

Creating or resolving a local note journals review data and grants no execution;
it works in Plan under ordinary thread, checkout and Project access. The person
may select open findings to prepare a bounded correction request in that same
task's editable unsent draft. Existing draft text, caret and extra context are
kept, including while the task is busy. The request names its selected finding
versions and captured anchors and says which files or comments were omitted.
It sends, queues and approves nothing automatically. Ordinary send or queue
delivery revalidates the typed references and records outside-content provenance
before the provider reads; missing or changed provenance refuses actionably.
Editing prose preserves its references. Clearing a damaged reference requires
clearing the imported draft or preparing a truthful replacement, not silently
retaining the excerpt as trusted plain prose.

After a correction, Refresh reads the new comparison and latest recorded checks.
Checks that lack a comparison binding are labeled as such. An agent reply never
resolves a finding: the person inspects the resulting changes and explicitly
resolves or dismisses it.

A pull request opened in Review shows, under its header, an **Automatic
actions** section with two switches: **Merge when ready** and **Auto-fix**.
Each has one status line under its name that says what it is doing now (off,
on and waiting on checks, reviews, or a conflict, merged, turned off by
GitHub; on and watching, waiting while you type or while a turn runs, last
woke the thread and which try, stopped and why). Auto-fix names the linked
thread it wakes, the first linked one; with none linked it stays off and its
hover reason says to link a thread. A refused or unsupported change keeps the
switch where it was and says why in one alert line under the section. The
review re-reads the switches every 20 seconds while open. Turning Merge when
ready on first opens an inline confirmation naming the reviewed head, as Merge
does. Under the switches a **Your actions** section holds the person's own
controls: the pull request's labels (a button removes one) and the
repository's other labels (a button adds one; no free-text label), a comment
box, a reply box on each open review thread, and Close or Reopen pull request.
A comment or reply says it posts under the person's name; a refusal is one
alert line under the section, and, until a paired device uses the same controls
(not built yet), it is told only the desktop window can do it. Rules and limits
are owned by
[Architecture: modes](../architecture.md#modes-chat-work-and-code).
The top-right control reveals the dock only when the active pane has a bound thread
or a valid launchable tool. A new Code task's pane, before its thread exists, keeps
the control but starts with the dock closed, whatever the window's saved choice;
opened there, its title band shows the common tools disabled ("Available once the
task starts") and its body says so. That show or hide belongs to the draft and is
never saved as the window's choice. Once that start screen has a Project, the dock's body holds the
Project's quick tools (Terminal and Browser; a server Project's are its
Terminal only); they never stand as a column
beside the start screen ([Start screen: Welcome screen](start-screen.md#welcome-screen)). An available empty dock opens on a stack of fact cards (Environment with
the local window's Remote access switch, Local servers, Context, Changes,
Outputs, Background tasks, Running now; see [Right dock and bottom panel](#right-dock-and-bottom-panel));
its header is an empty band as tall as the title rail, and the tools are opened
from the title band's **tool row**. At 961px and wider the row sits before the
bottom-panel and dock toggles: one
icon button for each of Environment, Terminal, Review, Browser, and Files, in that order,
then **More tools**, a menu of every other tool the thread can use, grouped as the
launcher groups them, each a checked item while that tool is shown, and after the
tools the pull requests the thread is already about under "Relevant to this thread". A button is present
only where the thread can use the tool. Pressing one opens the tool as a tile beside the
focused one (alone when the dock is empty) and widens and shows the dock; pressing it
again closes the tool (the Browser closes every page), except that a pressed Browser or Terminal button
minimises its tool to a card on the dock's shelf instead (see **Minimised tools**), so the page or
shell stays running and in view. A button reads pressed while its
tool is on screen, in the dock or in the bottom panel's front tab while the panel is open, and carries a quiet dot while
the tool is open but not shown (a bottom-panel tool behind the front one included; pressing it brings it forward). When both columns are full a tool that is not shown
is not refused: its press shows it in the focused tile's place, the replaced tool stays
open but hidden, and the button says "Shows in place of <the focused tool>". On a new Code task
before its thread exists the buttons are disabled with "Available once the task starts". A press leaves focus
on the button. The row is one toolbar named "Tools" with one Tab stop and arrow-key
movement, and its width is part of the trailing cluster the pane header reserves.
The five tools with a button of their own (Environment, Terminal, Review, Browser,
Files) have a context menu on that button (right click, the menu key or Shift+F10): Show
below for an open tool that is not on screen, Show alone, Hide from view and the
moves the caps allow for a tile, Minimise to card on Browser and Terminal, New Terminal on Terminal and New Browser page on
Browser, and Close. A minimised tool's button is not pressed, carries the dot, and reads "Minimised to a card"; pressing it restores the tool. Each such button is also the drag source for an open tool: dropped on the dock body, the right third
shows the tool beside, the lower third below, and anywhere else replaces the
focused tile. A tool opened from More tools has neither: it is shown beside the
focused tile (in its place at the caps) and is then arranged, hidden and closed
from its own tile's bar; a tool alone has no bar and is closed by picking it
again in More tools. At 960px and under the dock is a one-tool drawer, the title band is
inert behind it, and the same row stands in the drawer's header; there a press
replaces the tool shown and a tool cannot be dragged. The dock no longer has a tab strip, Add tool, Show another tool,
or quick tools of its own (the bottom panel keeps its tab strip and Add tool). Direct tools are Side Chat, Browser, Files,
Document, Canvas, artifact-gated Plan, conditional Delivery, Review, Terminal,
Tests, Run and debug ([language services](language-services.md#debugger-panel-rules)),
iOS Simulator, Android emulator, Desktop, and Vitals, as mode and capability allow. Chat
admits only the [Agents dock](#subagents) and has no bottom panel. **Vitals**
(Work and Code) shows the load on the host the dock is connected to, local or
remote, from the host-resources read: a CPU history line with the core count,
memory used and total, network in and out, disk throughput, disk space, GPU
utilisation, and **Energy**. The readings are plain rows on the dock's own
surface with a hairline between them, never boxes on a fill of their own, and a
history line appears once it has two samples to join. Each reading is drawn
only when that host reports it; a host with no battery says "No battery", and a figure the host cannot read
is left out rather than drawn as zero. The tool keeps the last five minutes of
samples in the window (nothing is stored), reads about every five seconds only
while it is mounted and the window is visible, never overlaps reads, abandons one
after five seconds, and on a failed read drops its figures and history instead
of showing old ones as current. A window without authority to read the host is
told so. For a thread in a server Project the tool shows the
load on that server, read over the Project's SSH connection by
`GET /api/server-projects/resources` (a local window only; Linux servers only,
and it says so for any other, and stops asking). The tool reads no
host until the server Project catalog has answered, so it never shows this
computer's load under a server thread's name, and a new target starts a new
history. Side
Chat is a Chat conversation about the pane's thread: it reads that thread's
conversation, current state, files, and subagent results, and changes none of
them ([authority](../architecture.md#security-and-authority)). Its notice says
what the source offers once the host names the source's mode. Document shows the
Markdown or text file the Code thread's turn most recently wrote, read through
the host-authorized file open; the renderer offers a written document, or a
Canvas the thread's agent authored in Work or Code that the thread does not
draw inline, in the dock once per document, never after the person closed its tab,
and never by moving focus. Every Canvas a thread wrote appears at the end of
the turn that wrote it, on the reply's card face. One the agent asked to show
inline is drawn there read-only, within a fixed height that fades out instead
of scrolling, and is never offered in the dock, because it is already in front
of the person. One the agent asked to show inline that holds a plan, a mockup,
or a device-size design is a sidebar Canvas, shown as a preview card (the live
miniature across the column, its title and facts beneath) that opens it; any
other is a single row (a live miniature, its title, one line of facts) that
opens it ([Canvas: Presentation](canvas.md#presentation-and-schema-versions)).
The person may expand any Canvas in place,
including one shown as a row: **Expand in thread** on the frame, the card, or the row, or
**Show the whole Canvas** under a faded one. Expanded, the frame grows with
its content up to about the thread viewport instead of fading. The thread
keeps the wheel until the person focuses the region inside the frame (a click
or Tab); then the wheel scrolls only the Canvas, and Escape hands it back. A
board pans by drag and zooms on ctrl/meta wheel, never on a plain wheel. The
drawing in the thread is read-only at every size: it gets no layout, plan,
comment, or action runtime, so nothing drawn there writes a version. The
inline frame holds **Show as card**, a fold the window remembers, and the
window remembers an expansion the same way; **Collapse** returns an inline
Canvas to its faded frame, and **Show as card** returns an expanded row to its
row. In Work and Code the frame also holds **Open in sidebar**, which opens
the same Canvas in the dock tool, and a row opens it there too. Chat has no
Canvas dock tool, so there the frame holds **Open Canvas**, and the frame and a row open
the Canvas as a content tab beside the thread. Editing, comments, and sharing stay there.
A design that runs script is a prototype. Wherever it is drawn, a note under its
header says what it can still send out: on desktop that it runs with no network
connection, and in a browser that its script can still connect to another
computer. Its header
shows a **Running** label and **Stop** while it runs, and **Run again** with
the reason once it stops (stopped responding, loaded another page, or, on
desktop, could not be started in its contained
surface). In the thread it starts only when the person
presses **Run**; the sidebar runs it when it is shown. Octant never moves focus into a running
prototype, however it started; it is in the tab order, so the person reaches it
with Tab or a click. On desktop,
Command-Escape (Control-Escape elsewhere) moves focus from a running prototype
to its Stop. In a browser the Run control says the prototype is not
network-contained. An
agent-authored Canvas belongs to the thread's own scope as the host resolves
it: the active Chat Project, the Work thread's confined root, or the Code
thread's checkout; a thread whose binding the host cannot resolve is refused
rather than given an assumed scope. Hand off
([route](host-reads-and-commands.md#hand-off)) starts from the thread export cut, asks the thread's
own provider for a six-section hand-off document in one tool-free request,
keeps it as a Canvas of the thread, and opens that Canvas in the dock; a
running turn, an unready provider, or a thread outside a Project is refused as
an ordinary answer. The dock follows the active
pane's thread and Project, restores that subject's open tools, and presents an
explicit unavailable state when the newly active pane cannot describe the
selected tool — never the previous pane's content. Hiding a Browser or Terminal
tool does not stop its server-owned lifecycle. Restoring a Terminal tab may
reattach to an existing process, but a saved layout is not permission to start
a new shell. When no process remains, the tab offers **Start terminal**. A
shell a host restart ended reads Interrupted with a **Restart terminal** button
beside it: one click starts a new shell through the ordinary start, checked
against the thread's posture and authority at that moment, with a fresh
terminal and no Browser grant or other permission the ended shell held. Plan
shows no button.
Explicitly opening or selecting the tab in the current window session also
requests a shell. The host still checks the thread's checkout and authority;
Plan cannot start or stop terminals. Restored transcripts never replay commands.
A terminal never traps the keyboard: it sends Tab, Escape and function keys to its shell, so `Mod+Escape` (next control) and `Mod+Shift+Escape` (previous) move focus out without sending anything, the pane names the chord while it has focus, and the rule is recorded in [DESIGN.md](../../DESIGN.md#accessibility). **Minimised tools.** A thread's Browser and Terminal can be minimised into small
live cards on a shelf at the foot of the dock, so a page or a shell can be
watched, and seen to answer, while another tool or only the dock's overview is
in front. A floating preview of the Browser, drawn over the thread, covered the
thread's own text and could not show a shell at all; the cards replace it.
Every Browser page is one Browser tool and every dock Terminal views the
thread's one shell, so minimising either takes the whole tool and leaves one
card, never one for each tab. A minimised tool is an open tab that is in no
tile and is nobody's selected tab; if it was the only tool shown the overview
returns, and with tiles focus moves as it does when a tile is hidden. Choosing
any of its tabs, from a drop, brings the
whole tool back as the focused tile's tool, as any hidden tool comes back; its
card brings it back as a tile of its own (see **A card**). The state, with the
place each minimised tool stood in, is window-local presentation stored with the
thread's open tools; the bottom panel never has one.

- **Ways in.** A tile's **Arrange <tool>** menu offers **Minimise to card** for the
  Browser and the Terminal only, after **Hide from view**. The Browser and
  Terminal buttons in the title band's tool row offer the same item on their
  context menu (right click, the menu key or Shift+F10), after the placements
  and before New Terminal or New Browser page. Pressing a pressed Browser or
  Terminal button minimises it instead of closing it, so the page or shell keeps
  running in view on the shelf; closing stays the tile bar's **Close** and
  **Close <tool>** on the button's menu, and every other tool keeps its rule
  that a press on a pressed button closes it. The tile bar has no button of its
  own for it, so a tile still has one bar and one name. Minimising never closes
  or stops the tool and never sends anything to a page or a shell. Where the
  tile's Arrange menu minimised it, focus goes to the card's expand control,
  since the control it was on has left; it is taken only while focus is still on
  the page body or in the closing menu, so a person who has since moved it keeps
  it where they put it.
- **The button of a minimised tool** is not pressed, carries the open dot, and
  its description reads "Minimised to a card". Pressing it shows the tool
  (see **A card**) and shows the dock when it was closed; it never replaces a
  shown tool unless both columns are full. Its context menu offers New Terminal
  or New Browser page and Close, with no placements, since it has no tile. In
  the drawer (960px and under) no tool is minimised: a press there replaces the
  tool shown, as for any tool, and never minimises.
- **The shelf.** A group named **Minimised tools** at the foot of the dock body,
  under the overview when no tool is shown and under the tiles when tools are
  shown. It takes its natural height and holds at most two cards (Browser,
  Terminal). A card is compact: an 8px inset, a 28px bar (icon, name, Show, Hide
  card, each button a 24px target) over a preview 104px tall, 152px in all.
  Two cards stand side by side, half the width each with an 8px gap, once each can
  have 160px (a dock about 352px wide or wider) and stack below that; one card
  takes the whole width and keeps the 104px preview. Side by side they need 168px
  and stay clear of the cap in any dock 420px tall or taller. The shelf is never
  more than two fifths of the dock and scrolls inside past that, which only a very
  short dock, or two stacked cards in a dock under about 820px tall, reaches; the
  tiles above keep their floors and measure the space that is left. The modal dock
  (960px and below) has no room for it and draws none; the state is kept, and
  there the tool's button reads as any open tool's, so nothing leads nowhere.
- **A card** is one of the dock's cards: the tool's icon, a title, **Show
  <tool>** (expand) and **Hide <tool> card** controls, and a live preview that is
  itself the expand control (named "Show <tool>, live preview"); the preview is
  drawn inert under that one button, so nothing in it can take focus or act.
  Show brings the tool back as a tile of its own (the Browser as the page it
  last showed), focused, and returns the keyboard to the tool's button in the row. It returns to the place it
  was minimised from while that place still exists: the same row of a column it
  shared, or a column of its own again at the same position, when there is room
  under the caps. Otherwise it becomes the last tile: a new column while there is
  room for one, else the end of the last column that has room (the last column
  first, then the other). With nothing shown it is the one
  tool shown. It never takes over a shown tool's tile, so no shown tool remounts;
  only when both columns are full does it take the focused tile's, as choosing
  its tab would. A tool that was the only one shown leaves no place. Hide card removes the card and
  nothing else: the tool goes back to being an ordinary open tool, its button
  reading open but not shown (the dot and "Open"), and no page or shell is closed or stopped (closing a tab with its
  own browser context ends that context, which a card that only previews must
  never do; the floating preview it replaces only hid itself). The keyboard goes
  to the tool's button in the row, else the dock toggle, looked for again as the
  row re-renders so focus never falls to the page. Pressing the button shows the
  tool. Closing the tool stays the tile bar's close and **Close** on its button's
  menu. A card never starts a process, never writes to the journal and never sends input
  to a shell or a page, and it shows nothing the tool could not show this window
  under the same checks. A paired remote window has no dock and gets none of it.
- **The Browser card** shows the page's title, or its host, with the profile's
  name beside it where the page lives in one (a signed-in page acts as the
  person's account) and the page count past one, over a picture of the page
  cropped to the preview from its top left, never stretched. It reads the same host
  snapshot the Browser pane reads (a page that lives in a Browser context of its
  own is read by that context, as the pane reads it, never through the thread's
  current context, which leaves such pages out; a context that is gone or stopped
  makes the preview say "Page not available" instead of holding a skeleton), and asks for a fresh picture only while the
  card is on screen: no card, no request for one. It polls every second while a
  session is live and every five otherwise, backs off while the page does not
  change, and pauses with the window. A stale or missing picture is a neutral
  skeleton with no status prose.
- **The agent's session.** While an agent's Browser session is live and the
  thread's Browser is out of sight, the Browser is a card on the shelf without
  the person minimising it, as long as it has a tab. Out of sight means no pane
  shows the thread's shared Browser and neither the dock (as a shown tile, or as
  its one tool) nor the bottom panel has it as its active tool (a tab bound to one
  link or local server is a page of its own and does not count). A card is only a
  preview, so it is never what "in sight" means: it does not stop the Browser
  being brought forward when the agent hands the page over to sign in, and it
  does not stop a new session opening the Browser tool once, except that a
  session announced while the person has the Browser minimised leaves it
  minimised, its card or the dock toggle's dot being the sign (the sign-in
  hand-over, which the person has to act on, still restores it). That holds only
  where the shelf is drawn: the narrow window's modal dock has neither card nor
  dot, so there a new session opens the Browser like any other tab, which clears
  the minimised flag (a window that grows again shows the Browser as a tool, not
  as a card). Hiding the card,
  or closing the Browser's tab, dismisses it for that session, kept for the life of the page
  because the dock remounts; a later session shows it again. A Browser whose
  session is not live is a card only if the person minimised it. The thread pane
  keeps polling for the session without asking for a picture, and tells the dock.
- **The dock toggle.** The dock is closed on a thread whose agent Browser is live
  and has a tab: its card cannot be seen, so the window's dock toggle carries one
  quiet dot described as "Browser is active". It is a dot, never a count or an
  accent ring, and the modal dock, which draws no shelf, shows none.
- **The Terminal card** shows the shell's current tail, live, in a read-only
  instance of the terminal engine at the smallest type the terminal settings
  allow, filling the preview (the shell's last lines, as many as the 104px preview holds), with no input, no focus and no resize sent to the shell.
  It reads the shell's state and follows the host's live stream, whose first
  frame is the tail, and stops it when the card goes away; it keeps only a few
  KiB of tail, drawn at most once an animation frame and appended to the terminal
  rather than rewritten, with a cut only at a line start, so a chatty shell is
  not redrawn every frame. It respects the stream limits: a host that refuses the
  stream makes the card say "Preview unavailable" and stay usable. A stream that
  ends or is refused, or a shell that starts later, is read again after 5 s,
  doubling to 60 s, up to six tries (the count starts over when frames flow
  again), paused while the window is hidden, and the card says "Preview ended"
  when it gives up. A card belongs to one thread: it starts from nothing for
  another thread's shell and never shows the previous thread's text. A thread
  that cannot have a Terminal gets no Terminal card. It never attaches, because attaching is a
  journaled operation and a card that did so on a timer once wrote thousands of
  entries for one thread; it never starts a shell. A thread with no shell running
  says "No terminal running", and expanding opens the tool, where the person may
  start one. A card that never had a shell to show keeps that plain note when its
  retries run out; only a tail that was followed can say "Preview ended". A card
  that is not following a shell looks once more when it is seen again (the window
  becoming visible, the pointer or the keyboard arriving, or Show), never more than
  once every five seconds and never on a timer: one fresh read, which follows a
  shell that started in the meantime and otherwise changes nothing. An exited or interrupted shell says so in the card's head. Output
  that arrives while the pointer and keyboard are off the card shows a small quiet
  dot named "New output", which goes when the pointer enters, the card takes
  focus, or the tool is restored.

Computer Use keeps its own activity card over the thread, separate from these.

**Browser availability.** While no agent drives the page, the thread's pane and
Project dock show a server-reported availability fact: available (read-only in
Plan), omitted with its specific tool-transport, task-constraint or host-capability
reason and an existing recovery action, or Unknown when disconnected/unreported.
The same policy composes the Browser tool; the renderer never infers permission.
The status is an icon after the address field whose name and tooltip carry the
sentence (drawn only while a page is open, loading, or the agent cannot use the Browser; at rest the sentence is in the
profile icon's tooltip); its recovery action is an item in the toolbar's More menu. Site approvals,
Take over, Hand back and the active-agent indicator retain their existing behavior. This fact is a reading, never a grant. The provider remedy opens the owning
thread's existing provider/model picker. A constraints remedy opens that task's
access report; saved profile constraints cannot be removed by raising its access
level, so the report directs the person to start a task with a permitting profile.
A host-capability omission names the missing host capability and links to the
existing host Settings. Neither recovery grants access by navigation.

**Browser start.** A Browser with no page opens on an empty
address bar, never a placeholder site. In a Code thread it lists the servers the
host reports as openable for the thread's Project, this checkout's first and
then leftovers from elsewhere, leaving out any the host could not reach, the
same reading Local servers shows. It fills the address with the first until the
person types, and choosing one opens it. It reads the servers only while no page
is open. Under them, Recent lists the last eight pages the Browser showed, however
they were reached (address bar, server row, conversation link, or a navigation
inside the page), newest first. It is kept in the renderer's local storage,
which the computer's windows share like a browser's history, and never sent
to the host; a running server's address is not repeated there, and choosing a row
opens it. With neither, the start page invites an address. **Browser profiles.**
A page is Private unless the person picks the Project or Personal profile from
the profile icon after the address field, which names a signed-in profile beside
itself (a Private page stays an icon) and whose menu also signs out of a
stored profile. A puzzle-piece extensions button precedes it when an extension is
enabled in the page's profile: it lists them, opens a popup or options page, and
carries a count while the agent drives the page; the status icon and the
Browser card name a stored profile while the agent drives it. **Take over.**
While a page is open, the toolbar carries a **Take over** icon button after the
address field (in the More menu when the trailing icons do not fit). One click
holds every agent Browser call on the page; the status icon then reads "You have
the page" and **Hand back** replaces Take over. While the agent's own sign-in ask is open,
neither shows. While a remote owner holds the page, **Reclaim locally** is the trailing
button in place of Take over and Hand back, which moves into the More menu. The person's typing and clicking in the page while the agent
acts is delivered, never dropped, and the indicator keeps saying "Agent active".
The rules are in [Browser for agents](browser-agent-tool.md#person-and-agent-together). The Project
browser dock has the same controls. The rules are in
[Browser profiles and extensions](browser-profiles.md). **Project browser tab
strip.** When threads of the Project have live agent pages, the Project browser
dock shows a tab strip under its title: "Your page" for the person's own page,
then one tab per thread's page in front. A tab names the page (its title, else
its host) and the thread that owns it by thread title, with an "Agent active"
mark while that thread's agent drives the page and for 15 seconds after its
last action. Choosing a tab shows that thread's own picture of the page, the one
its Browser card shows, with no address bar and nothing to click, and an
Open thread control that opens the owning thread; choosing "Your page" returns
to the person's browser. No tab action moves a page from one thread to another,
and a thread's agent never sees another thread's page. A paired device sees the
same strip, but a page in a stored profile reads "Signed-in page — open it on
this Mac." with no title, host, or picture. The strip draws nothing when no
thread has a live page. Rationale: the thread Browser pane is bound to one
thread, so it can only ever show that thread's page; the Project browser dock is
the one Browser surface scoped to a Project rather than a thread, and the
person's own page already lives there, so it is where several threads' pages
sit side by side without giving any thread a view of another's. The tabs use
the shared tab rail, which wraps rather than scrolls so no tab hides off the
edge of a narrow dock. **Browser toolbar.** One row under the tile bar: plain back, forward and reload
icons, the address field (the control corner, never a pill) with only the
connection mark inside its start, then trailing icon buttons (status, Take over,
extensions, profile) and a More menu; the exact rules are in [Design system](../../DESIGN.md). **Browser captures.** The Browser pane toolbar has a
Screenshot item in its More menu (a camera icon, with Open in default browser) that keeps the
page's picture with the thread, and, in a Work or Code thread's Browser, a
**Draw on page** item (a pen-line icon after it) that keeps the same capture,
shows it still in place of the page, and floats a drawing bar ("Drawing tools":
Select, Pen, Box, Arrow, Text, one ink control, one stroke toggle, Undo, Redo,
Delete, then **Add to chat** and **Discard drawing**) over its bottom centre; **Add to chat** puts the
marked-up picture in that thread's composer as an ordinary image and sends
nothing, and a thread that kept screenshots shows a
_Browser captures_ strip in its transcript beside the generated images, and a
thread with Browser steps also shows a folded _Browser proof_ panel there: the
agent's steps as a numbered list with each capture under the step that took it.
An agent's recording sits in the strip and the panel like a screenshot, still,
with a play mark and its length, and plays when the person opens it.
The rules are in [Browser captures](browser-captures.md),
[Marking up a capture](browser-captures.md#marking-up-a-capture) and
[Proof](browser-captures.md#proof). The iOS Simulator and Android emulator are separate device destinations. An
agent's device open raises the relevant in-app pane once per request. Both use
one device-first pane that adapts to its container's width: a toolbar (device
switcher, OS and state in words, Back on Android, Home, Screenshot, Lock when
wide, and More with Type text, Switch device, Diagnostics, Stop live view, and
Shut down), at most one line under it (error, then, on the Android emulator, a note
that an approval is waiting for the person's answer, then the notice that the live view is
off or lost, then approval, then typing, then any other notice, so Resume or
Reconnect never waits on an input grant; one sentence and at most one fix,
such as Repair input after the host refuses input as disconnected), and the device on a stage with an original
silhouette whose screen is the only input region; the row under the device says
where keys go while the screen has focus and otherwise, quietly, how the picture
arrives (Android's live stream or snapshots and why). The pane offers only
actions the host supports and hides the rest rather than disabling them. When
more than one device is running and neither the person nor an agent chose one,
the pane asks which to show; a person's choice holds until the next agent open.
Setup, nothing running, booting, live, live view lost, interrupted, and stale
states stay explicit; closing a pane does not shut down its device. Allow input
is the explicit destination approval, asked per destination from that
destination's own grant: the line's Allow opens the native confirmation that
issues the grant, Not now leaves the screen view only, and clicking the screen or
a key button cannot grant it. Toolbar Home, Lock, Back, and Type text share the
ordered input queue with taps and typing. The host owns observation,
input, and evidence safety under the [device transport contract](../architecture.md#device-transport-and-evidence).
**Desktop** is a Code thread's disposable desktops
([Disposable desktops](disposable-desktops.md)), always offered on Code. It
uses the device pane's toolbar, line, and cards. The toolbar names the
provider and, for a provider with placements, where the desktop runs (the
computer its recipe names, or the placement), the state in words with elapsed minutes and the end time (never a
cost), a switch between the thread's two desktops when it has two, **Add 30
minutes** while the recipe maximum allows, and Release, which asks first. The
states are setup (what the thread lacks to start one, in one sentence, or
**Start desktop**), starting, live, not shown (a running desktop this tab is
not showing, with **Show desktop**), interrupted (the view stopped; **Reconnect**),
not shown because the connection could be read on its way (the host refused
the view; the desktop keeps running; **Try again**), ending, still running (release not verified, with the provider and **Retry**),
and ended (why, and **Start a new desktop** when one may start). A tab shows a
screen only after the person starts a desktop in it or presses Show desktop,
Reconnect, or Try again: a restored or reloaded tab never reconnects on its own, and the
host holds no view across a restart. The live screen is a focusable region:
clicks, the wheel, and keys go to the desktop while it has focus, printable
characters cross as typed text, and `Mod+Escape` moves focus out without
sending anything. Closing the tab leaves the desktop running. The host owns
authority, frames, and attribution under the slice 5 rules there.
Dock visibility and responsive presentation follow [Right dock and bottom panel](#right-dock-and-bottom-panel) and [DESIGN.md: Breakpoints](../../DESIGN.md#breakpoints).

### Routines

Every Work and Code thread's Environment has a **Routines** row, because both
ways to create one start there. Its body opens with two actions, **Follow up
later** and **New routine**, and then lists every active and paused routine of
the thread's Project, not only those this thread created, in this order: this
thread's pending follow-ups, then routines created from this thread, then the
rest of the Project's routines (another thread's follow-up among them); within
each group, soonest next run first. The header shows the count. Each entry has
its name, Active or Paused, a small line saying how it relates to the thread
("Follow-up here", "From this thread", "Follow-up in another thread", or
nothing for the rest), the schedule in plain words with the next run (and the
time zone of a weekly one), and **Open in Automation Center**. A follow-up here
has **Change time** and **Cancel**, because a one-time turn is moved or
cancelled rather than paused; every other entry has **Pause** or **Resume**.
These are the ordinary Automation commands. Past five entries the row shows
the first five and **Show all**. A Project with no routines shows only the two
actions. The row reads the Project's whole list, page by page, so a busy
Project cannot push this thread's older routine out of it.

**New routine** opens a small form: a name, the task for each run, and the
Automation Center editor's own schedule fields (once at a time, every N
minutes, or weekly on chosen days at a time in a time zone, prefilled with
weekdays at 9:00 in the person's zone) and missed-run choice. It names no
Project, mode, or profile: the host takes them from the thread, and the form
says each run starts a new thread in this Project with at most this thread's
access, asking before it changes anything.

**Follow up later** opens a small picker with **In 1 hour**, **Tomorrow at
9:00** (the person's local clock), and **Pick a time**, and a short prompt,
prefilled, for what to check. A pending follow-up reads "Follows up tomorrow
at 9:00".

An agent's proposal, a routine or a follow-up, waits as a suggestion chip at
the foot of the thread, in the same card as the reply's suggested tasks (a
routine the agent suggests in a turn running at Full access is not a chip: it
is created paused and shown as the **Created automation** card,
[Architecture: modes](../architecture.md#modes-chat-work-and-code)). It is
labelled "Routine · suggested" or "Follow-up here · suggested" and states the
name, the schedule and its time zone, the first run, the missed-run policy,
what each run does, and the exact prompt. Its one action, **Create routine**
or **Schedule follow-up**, creates it as the person; dismissing the chip
declines, so nothing is created and the agent is told so. The turn a
follow-up sends is shown in the transcript under a "Scheduled follow-up" line
with only its prompt, so a reader can tell it was scheduled and not typed. The
sidebar row shows no mark for a pending follow-up: no existing row mark fits a
scheduled turn, and the Environment row is where it is managed.

An agent's request to pause or archive one of its thread's routines waits in
the same place, labelled "Pause routine · asked by the agent" or "Archive
routine · asked by the agent" ("Cancel follow-up" for a follow-up). It states
the routine's name, what the change does, and the agent's reason in its own
words. Its one action does it as the person; dismissing it leaves the routine
as it was and the agent is told so. In Automation Center's run
history, a run whose agent reported a result shows "Agent reported:" with the
outcome and summary beside the run's own status, in the warning colour for
Needs attention and Did not succeed; the latest-run line carries the outcome.

### Subagents

Environment belongs to a
thread as a context-aware dock tab opened from the title band's tool row. Its
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
keeps completed history reachable. Chat admits Agents as its only dock tool;
opening it does not expose Work or Code tools or the bottom panel. Provider-observed children carry an explicit
observation-only label and no managed controls. Task-plan progress remains a
separate disclosure. See
[Thread view: Subagents in a thread](thread-view.md#subagents-in-a-thread).
The Agents dock is a list and a page, and it shows and controls subagents
without starting them: only the thread's agent starts one, through the Octant
Harness `delegate` tool, and collects its result. The list has one title, then
Working and Finished sections of one-button rows —
status icon, task, and state, role, model, and age in words — with finished
rows newest first and an unreviewed result marked "Needs review" unless the
parent already received it. On a thread with at least one subagent, a List and
Graph switch sits beside the title. **Graph** arranges the same subagents by
what waits for what: a run sits below every run it runs after and below the run
that started it, with an arrow from each run it waits for and a dashed line
from the run that started it, and a row keeps the order its runs were requested
in. A card carries the task, the provider's mark and the model, the effort and
role, and the state in words, which reads "Waiting on N" while the host holds
the run for N unfinished runs; it opens the page a row opens, and Back returns
to the graph. A row of cards wider than the dock scrolls sideways.
Provider-observed children have no such links and stay a list above the graph.
The host names a run another run waits for only when the window may read that
run. A row opens
that subagent's page in place of the list, with a back control: its task as
the title, a status line, the runs it runs after, and a small transcript that starts with the task as
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
hierarchy across modes for the threads this window holds (the thread in each mode's panes, pinned ones included), because the host
authorizes a parent's runs only to a window whose workspace contains that thread on the matching Project (a coordinator's window may also read its workers' runs as facts, without replies or controls: [Coordinator threads](coordinator-threads.md#seeing-workers-subagents)); on a wide window it can draw the current query as a
forest of parent threads and the runs they launched, and Graph can save that forest as a Canvas diagram document for the parent thread. The Agents dock shows the host's bounded, process-local child conversation read: entries are
cursor-readable and byte- and count-bounded, with explicit complete, stale, and
unavailable states. Provider-native live transcripts remain unavailable unless
their normalized provider capability supplies an equivalent host-authorized
read; a host-retained final reply stays readable after completion.

Saved child-generation file comparisons open in the existing Review tool from
Agents result history. The selection carries the parent, managed child and
generation, never a filesystem path or the parent's live checkout. Changing the
active thread clears that selection. Saved comparisons use the normal read-only
diff renderer, expose capture/truncation facts, and offer a return to the thread's
ordinary Review views.

## Boards and integrations

Work and Code have server-authoritative thread boards
(Ready / In progress / Waiting / Done) that cannot be dragged between columns;
Chat has no board. The boards are the bundled Board plugin. Switching it off
is a presentation switch only: the Work and Code board views, the sidebar
Board row, and every other way to open them (the Running tile and cards on the
start screen, the Inbox's Open the Board button, back and forward, keyboard and
command palette) are gone, and a board that is open closes. Running tiles and
cards lead to the Activity list instead, as they do in Chat. Nothing is
deleted, and the host keeps deriving the board data and status policy
([`threadBoardPolicy`](../../packages/domain/src/threadBoardPolicy.ts)) because the
thread rows, the dock overview, the planner board read, the sibling-thread
tools and side tasks read the same projections. Turning the plugin on again
brings the boards back with no migration. A person marks a Work thread Done with **Mark done** in the
add menu under attach, with no confirmation, and the card moves to Done and
stays there until **Reopen** undoes it in one click; a Code thread reaches Done by its objectively satisfied
delivery target, or when a person marks it Done whatever that target says,
which is recorded as the person's override. An agent never marks a thread Done
(maintainer request, 2026-11-12). While a Work task is marked, its composer
says so and carries the Reopen button. A Code thread is marked with **Mark
done** in its row's menus in the sidebar, where **Reopen** takes its place
once it is marked
([Architecture: modes](../architecture.md#modes-chat-work-and-code)). Code also has a Project-scoped Pull requests workspace that
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
host restart and is cleared when GitHub authority is revoked.

**The Pull requests and Issues lists.** The Pull requests page is a dense, calm list in the reading
measure, at most 720px and left-aligned in the page. Its title band carries the
count; at the trailing edge sit a Sort menu, a Filter menu, Repository settings
(only while the list is not grouped) and Refresh, each an icon button with a
tooltip. A row is two lines. Line one is the title at medium weight, cut after
two lines, and at its trailing edge the one thing that needs attention, in
words and as the quiet chip (Draft, Conflicts, Checks failing, Changes
requested, Checks pending, Review pending), or a small check when the pull
request is mergeable and nothing blocks it. Line two is one meta line: a state
glyph coloured by state, the repository's name, the author, the age ("2h",
"5d") and a link mark when a thread is linked, with the number (`#2344`) in
tabular numerals at the trailing edge. The repository's name is the bare name
in a group and `owner/name` on an ungrouped list that spans repositories, in both
lists. Every row, flagged or not, is one tooltip trigger that opens on hover and
on keyboard focus of the whole row, with the status sentence and then
"head → base", and the same text is visually hidden text of the row, so no fact
is pointer-only. A row has no hairline under it, the row under the pointer takes the
control hover fill with the row radius, and clicking it opens the pull request
exactly as before.

Sort offers Recently updated (the default), Least recently updated, Newest,
Oldest and Repository, and a **Group by repository** check item. Newest and
Oldest order by creation time, which the snapshot carries beside each
pull request's last update. Filter offers State (open, draft), Review (needs review, changes
requested, approved), Checks (passing, failing, pending) and **Mine**, which
keeps the pull requests whose author is the signed-in GitHub account
(maintainer request, 2026-11-12). Not built yet: today the snapshot carries no
creation time and the author is not compared with the account, so Newest,
Oldest and Mine are not offered. Sort, grouping and filters are remembered in this window's
local storage, and a filter that is narrowing the list marks its button.
Searching is unchanged and covers the title, author, branches, repository,
number and linked threads.

With grouping on, each repository has a slim header: its name, the count and a
"..." menu. That menu holds what the old Project header held: **Auto-refresh**
and **Agents may merge**, with the same labels and the same setters as before,
then **Agents may comment on pull requests**, which is off until chosen, closes
the menu on one activation as Agents may merge does, and shows no chip, and
Refresh. **Agents may push to the default branch** is not in the menu until an
agent push path to the default branch exists (maintainer decision, 2026-11-12). With grouping off those switches are in the page's **Repository
settings** menu, one group per connected repository, because they act on a
Project and must stay one step from the list; they are never in Filter, which
only narrows what is shown. The permission is readable without opening a menu: where Agents may merge is
on, that repository's group header shows the quiet chip "Agents may merge"
beside the count, and, with grouping off, the Repository settings button carries
the same dot as a narrowing filter and its tooltip names those repositories;
Auto-refresh is not an authority and has no chip, only the check in the menu.
The server still owns every one of these settings, refuses a
device that may not set them, and enforces the merge, comment and
default-branch choices at the act. A
Project that is not on GitHub is not drawn as an empty block: one quiet line at
the foot says how many, with their names in a disclosure. A connected Project
never refreshed is named in one line (flat) or keeps its group with the empty
sentence (grouped). While grouped, every connected repository keeps its header,
menu and chip even when a search or filter leaves it no rows: the count is 0 and
one quiet line says "Nothing matches", so a granted permission is never hidden by
a narrowed list. Choosing Agents may merge closes the menu and returns focus to its
button, so one activation is one change; Auto-refresh stays open because it is not
an authority and its check shows the change. The dock's Pull requests tool uses the same rows in one
flat list with the search and count, and none of the page's menus.

The Issues place draws the same row, so one component serves both lists: the
title, the 12px meta line (state glyph, repository name when the list spans
repositories, author, age, number at the trailing edge), the quiet hover and
the same slim group head. Its list column keeps the 720px measure beside the
detail pane. Its header carries the count and the Sort icon menu (Recently
updated, Least recently updated, Highest number, and Repository and **Group by
repository** only across repositories, since one repository has nothing to group
by); grouping is remembered in the window's local storage. An issue's list read
carries no labels, so the row shows none; they stay in the detail pane. A row's
click, the state toggle, the repository chooser, search and the detail pane's
Start a Code thread are unchanged.

**Answering from a Board card.** A Work or Code card whose thread waits on the
person shows what it asks and the answers, so a column of waiting cards is
cleared without opening threads. The card carries the Needs you row
(`PendingRequestRow`, embedded: the card already names the thread, so the row
keeps the wait, the text clamped to two lines, and the answers): **Approve** and
**Deny**, one numbered button per choice, or **Reply…**, which opens the thread.
The board reads the same host list as the Needs you card (the
[pending-requests read](host-reads-and-commands.md#pending-requests)) once for the whole board, only while the board is mounted, on the same
change-feed, settings, and workspace signals, and never on a timer. A card is
matched to its request by thread and mode. A thread whose live turn waits on an
approval or a question, or on the agent's own harness approval or Work
question, files under
Waiting with the awaiting-input reason, not In progress: the provider session stays open while it waits, so the host
reads the wait from the running turn's open approvals and questions (Code) or
the open request (Work) rather than from the turn's running record. Those are
the requests the pending-requests read lists, so the board read that follows an
answer already files the thread back under In progress. Other work still running beside a parked turn (a
terminal, a child run) keeps the thread In progress. A card with no listed
request is drawn as before. A thread whose latest finished turn closed with a
decision files under Waiting with the decision-pending reason and carries the
decision row; awaiting-input keeps meaning a live request on an open turn, and
a thread with both shows the live request. A decision never moves a thread out
of Done, changes no priority, and completes nothing. A thread with several requests shows the oldest
the host still lists (a refused one it has dropped shows only while nothing
newer waits) and **+N more waiting**, which opens the thread. Answers use each mode's existing command
through the listed handle and hold no new authority. A refused answer shows one
line on the card, and the card does not move: it changes column only when the
host's next board read says so, and the board re-reads when the set of waiting
requests changes (answered here or elsewhere, or newly raised). With Status
grouping the Waiting column lists the oldest waiting request first, then cards
with no listed request in their usual order. The list layout (narrow width, or
Code's List view) carries the same actions in its rows. A window with no
pending-request reader (a remote window) draws cards exactly as before.

While a pointer rests on the board, every card keeps the column and slot it had
when the pointer arrived, so answering one card cannot slide the next card
under the cursor. Only placement is held: each held slot shows the card's newest
content, a card the host no longer lists keeps its slot with its last content,
and a newly listed card joins the end of its column. Leaving the board applies
the host's placement. Touch and keyboard use never hold, because neither hovers.

**GitHub issue browser.** The first-party GitHub plugin contributes a second
`sidebar.destination` (`github-issues`) that opens a host-scoped, read-only
issue browser. The sidebar row is shown only when the contribution is present,
its action is wired, and the authentication snapshot reports `issues-read`
available. Settings status reads update that availability as well as authentication
commands, so completing device sign-in does not require a workspace reload.
Catalogue reads stay on the existing GitHub catalogue read
([route](host-reads-and-commands.md#github-issues)): the issue list includes
optional server-composed search, and an issue returns a bounded detail. The
browser renders title, body, and comments as plain text; links stay inert full
URLs.

Create-from-issue is implemented. The composer `Create from…` Issues tab
attaches only `{ owner, name, number }` to the draft. At creation the server
reauthorizes `issues-read`, frames redacted issue text as external content,
and journals that ingestion
([details](host-reads-and-commands.md#github-issues)). Refusal fails creation visibly. The
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
available. Browse goes through the Integration port
([operations](host-reads-and-commands.md#linear-issues)) with bounded page size
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
(`identifier`, status, description, comments, links) as external content and
journals that ingestion ([details](host-reads-and-commands.md#linear-issues)).
Refusal fails creation visibly. No Linear write-back path exists.

Composer `Create from…` also has a Terminal tab in a Work or Code draft with a
Project, for a local window. It lists the newest Claude Code and Codex sessions
in the Project's canonical bound root and its subfolders. A Code Project also
includes available managed worktrees whose ready ownership receipt matches its
current binding, thread, repository and checkout. Clients supply no source
folder: the server resolves eligible scopes and verifies the session's own
canonical working directory at listing and again at creation. Symlink escapes
and foreign scopes are refused; the picker and imported history name the exact
original working directory.

Selecting a session explicitly chooses a **text handoff**. The server rereads
bounded visible user/assistant words, excludes original inputs, tool activity,
hidden reasoning and injected tool text, marks the new thread with outside
content before it exists, and journals the framed read-only history on that
thread ([details](host-reads-and-commands.md#terminal-sessions)). Its first
admitted turn reads this snapshot once. The receipt and UI distinguish that new
session from native adoption. Native adoption is refused while the adapter
cannot prove historical account binding, runtime compatibility and exclusive
session ownership: a folder, filename or current provider login is not proof of
the account that created an external session. The current adapters cannot
supply that proof and offer only the labeled text handoff. They never resume
an unverified native session or clone its writer. Nothing is uploaded or written
back to the command-line tool's files.

## Context and usage

The circular composer meter opens the host's attributed context breakdown without
another provider call. Inspect context opens the composition inspector; before a
plan exists it is a successful empty view. Saved observations retain their original
time after restart. Unknown limits and measurements remain unavailable, and
fallback estimates are labeled explicitly. Spend ceilings are host-owner policy;
the composer and Environment explain an admission refusal and its recovery.
[Context and usage accounting](../architecture.md#context-and-usage-accounting)
owns budget enforcement, provenance, native-session identity, and journal rules.

At the top of the Thread info panel of every thread, in Chat, Work, and Code and for every
provider, a compact block of figures states what the thread used: its turns, input and output
tokens, thinking tokens when reported, the cache hit, output speed, time to first token, and
cost. They are not under the composer. The provider's account limit windows stand in the row
under the box, right of the thread's context, one bar per window showing the share left
(`composerLimitWindows` in `apps/web/src/context`, read from the context snapshot and
falling back to the Code thread's own report). A provider that reported neither windows
nor usage shows no block. In a split workspace the block shows in the active pane only: the
figures and limits come from one shell-wide scope, so an inactive pane shows no figures rather
than another thread's numbers. It reads the host's recorded
turns and is worded by one shared module in `packages/domain`
(`turnMetricsDisplay.ts`), which the composer, the usage page, the Octant Harness
session card, the terminal footer, and the phone's session panel all call, so
the rules cannot drift. A figure the provider did not report, or whose denominator is zero, is
absent; a provider that reported no usage shows no figures. A cache hit is never
rounded up to a whole; an approximate speed carries a tilde and a tooltip that it
is per turn and includes some tool time; a cost says "est." unless the provider
reported it and is absent when the model has no price. The block's Turn details link, or
**Turn details** in the context meter's popover, opens one turn at a time (tokens,
timing, retries, cost). The usage page's per-thread rows and the turn drill-in
under each row call this same module, so a thread shows the same cache, speed,
first-token, and cost figures there as in its Thread info panel. Those columns are
left out when no row can state them. The rows read `turnMetrics` on the existing
usage query; they do not add a second accounting path. A reading of one thread
uses that thread's totals. A reading that mixes threads and has scrolled past
the latest turns says those rows cover only the turns still listed. There is no hide control and no setting: the stored `showThreadStats` value stays in the shell settings schema so saved settings still decode, and nothing reads it.

Project overviews retain loaded content during same-Project refreshes
on the same client connection. Changing Project or client clears retained
content; disconnect and authorization failures remain explicit unavailable
states. Project memory lives on every mode's Project Overview. Navigator is one host-owned conversation opened
as an app-wide popover from the bottom-left profile and Settings control, and
opening it never changes the active Project or thread. Zen is a separate
presentation aggregate inside the same window, not a split-tree tab and not a
fourth authority mode. Zen is a bundled plugin that is on by default. While it
is off, the Zen keyboard chord does nothing, the profile menu has no Zen row,
the command palette has no Zen entry, no Pin in Zen or Add to Zen action is
offered, the recovery banner is hidden, and a Zen that was open closes back to
the workspace; the host refuses the Zen routes and the assistant gets no Zen
tool. Turning it off deletes no layout, background, focus zone, or event, and
app backgrounds keep working because the built-in background catalog is shared
with them. Zen's Add terminal offers the window's Code Project as
"This Project" ahead of the Code threads that can open one; choosing it starts
a Project terminal and pins a card that names the Project and the terminal,
never a thread. The card is a window onto the shell and grants nothing: a card
naming a terminal this window does not own is refused. A card whose shell a
host restart ended says so, to a window that may still use the Project's
terminals, with a **Restart terminal** button: one click starts a new shell at
the Project's root through the ordinary start and pins it in the ended card's
place; a refused start leaves the card as it was. Authority, lifecycle,
and the journal record follow the
[Project terminal rule](../architecture.md#security-and-authority). A Code
Project's saved actions (Run, Test, Dev) are buttons in the window header, three
inline and the rest under More, and entries in the command palette's Actions
group. More is the header's one menu for this group: it also holds where the
actions run ("Run in") and the task's Worktrees setup, which used to be text
controls of their own in the title bar. Where to run is offered only when there
is an action to run; with none, the header shows Worktrees alone; the Project overview's Actions section edits them and offers suggestions
the person confirms. Choosing one previews its actual folder and branch,
then starts a dedicated run beside the task. A Code thread defaults to its
active checkout; the Project folder and approved extra folders remain explicit
choices. Output, exit status and Stop stay in the action dialog; Open terminal
explicitly opens Zen. A run a host restart ended offers **Review and run
again**, which reads the action's preview afresh; Run action stays the
person's to press. A lost reply is never retried automatically (see
[Project actions](../architecture.md#security-and-authority)). Add browser
likewise offers the window's Work or Code Project as "This Project": the dock
names the Project, never a thread, and shows that Project's own page under the
Project browsing context rule in the same section.

## Project planner

The Code Project overview's **Project planner** section designates an existing
thread of that Project, shows its current proposals and offers versioned
approve/decline decisions. Proposal review keeps the exact intent and Project
fixed while reusing the ordinary provider/model, checkout and access controls.
The final action says **Approve and start described task**; only confirmed
creation sends the intent through the normal first-message path. Refused or
uncertain replies retain the submitted task identity for inspection, with no
automatic retry or provider turn. The host's journaled creation admission and
the window's retained identity prevent another approval across windows, review
close/remount or reload while the outcome is unknown. A fresh pending proposal
or missing task never releases it. Only confirmed creation or a newer host-proven
precreation failure allows progress; an explicit retry reviews that new version.
A disconnect disables decisions until the
current host state has been refreshed. Resulting tasks remain reachable from
approved proposals. See the [Project planner rule](../architecture.md#modes-chat-work-and-code).
The designated planner is a [coordinator](coordinator-threads.md) whose starts
always need approval, and coordinators' proposals appear both here and as a
card in the coordinator's own thread.

## Local-server ownership

Local-server stop authority recognizes live terminal descendants by a host process
snapshot and the tracked shell's process identity. An exited shell, a reused PID,
or missing ownership evidence leaves the listener classified as a leftover and
requires confirmation. Editor provenance labels alone never grant stop authority.
The start screen's Running services card applies the same rule and lists both
kinds, labelling the leftover; it adds no authority of its own.

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

## Inline questionnaires

An agent can ask for related decisions through the app-owned `ask-user` tool
in Chat, Work, and Code. A questionnaire belongs in its originating thread,
with one compact card containing up to four questions. It creates no Canvas.
More than four decisions belong in a Canvas [choice block](canvas.md#choice-block),
which has no question limit; the tool's description tells agents so.
Each question offers one choice or several choices, optional descriptions,
and an optional written alternative. Recommendations are labelled and never
preselected. A person can add a comment alongside their choices by default.
A provider-native form can explicitly omit this field when its protocol cannot
return a comment; the host refuses a supplied comment for that exact ask.

Choosing an option only edits the draft. **Send answers** submits the complete
set once; the host validates question and option identities, required answers,
and selection limits before settling the request. Empty selection is allowed
only when the question explicitly permits zero choices. A submitted answer
from another window settles the same request; a stale or duplicate answer
cannot replace it. Validation and delivery failures keep the draft available.

Unsent questionnaire choices, written alternatives and comments stay in memory
on their source screen while navigating through Home, Inbox or another thread,
and while deferring and bringing back the same request. Another window does
not receive or overwrite them. They are bound to the exact request and question
definition; settlement, cancellation, replacement or recovery invalidates them.
Closing or reloading the app screen drops these drafts. They are never journaled,
exported in diagnostics or submitted by restoration.

Submitted questionnaires collapse into an expandable, readable summary of
the questions, selected labels, written answers, and comment. The journal
keeps the definition and response so the summary survives reopening. Expired,
cancelled, and recovered requests cannot resume a dead provider session.
Answers convey preferences within existing thread authority and never grant
permissions. Credentials continue through the credential request mechanism.

The tool carries a bounded typed `questionnaire` alongside its existing prompt.
For example, `{ "prompt": "Choose the exports", "questionnaire": { "questions":
[{ "id": "formats", "prompt": "Which formats?", "selection": "multiple",
"options": [{ "id": "pdf", "label": "PDF" }, { "id": "md", "label": "Markdown" }] }] } }`.
The existing answer channel carries a versioned JSON response with question
IDs, selected option IDs, optional written alternatives, and a comment. The
tool returns the decoded response to the model. This keeps the existing
authenticated, thread-scoped answer routes and one-use request identity.
Provider-native question formats keep their existing adapter contracts; the
questionnaire capability uses the provider-neutral app tool boundary.

A Code task's **Worktrees** control (in the header's More menu, or alone in the
header when the Project has no saved action) opens its Setup tab beside
that task, including a selector for its child checkouts. It shows the reviewed
command and relative folder, bounded output, exit result, Retry, Cancel and
explicit Skip. The Project overview's Actions list lets the person review and
designate one automatic worktree setup recipe. See the owning
[worktree setup rule](../architecture.md#security-and-authority).

The same dialog's **Child source** tab controls the parent task's source for
future children. **Committed revision** is the default. **Review current edits**
captures a preview with base revision, snapshot identity, tracked changes and
eligible untracked paths; **Use this snapshot** is the separate enabling
choice. It shows the selected source and an actionable stale-source refusal.
Existing children retain their recorded source. The rule belongs to
[Code child workspaces](../architecture.md#modes-chat-work-and-code).

## Presentation

This section is how the workspace's screens look. Shared foundations, components and patterns are in [DESIGN.md](../../DESIGN.md); this section uses them and adds what belongs to one screen or tool.

### Shell grid and tool row

The shell is a CSS grid: sidebar, central workspace, optional right dock, and a
full-width status bar. A horizontal bottom panel is an optional sibling below
the central workspace. The central pane remains the thread, board, Project
overview, or Project-level list. An unsplit conversation uses the title band
for the Project/thread breadcrumb and compact thread strip, so the transcript
does not repeat a second title block. Split panes and utility surfaces retain
their own pane headers and lifecycle controls. Capability-gated toggles for
Open in, bottom panel, and right dock remain window chrome. Several Browsers are one Browser
tool: their pages sit in a row of their own at the top of the Browser, with a +
for a new page, and closing the Browser closes every page.
The Browser's toolbar is one row of plain icon buttons, the address field and
trailing icons, as the Browser toolbar rules above set out. The right dock's tools are opened from a **tool row** at the right of the
title band, before the bottom-panel and dock toggles: icon buttons for
Environment, Terminal, Review, Browser, Files, then a **More tools** menu of
checkbox items for every other tool the thread can use (grouped as the launcher
groups them), then the pull requests the thread is about under "Relevant to this
thread"; each button only where the thread can use the tool. A button is the
shell's icon button with the tool's own icon and its name as a tooltip,
`aria-pressed` while the tool is on screen, a quiet 4px dot while the tool is
open but not shown. At the tile caps a press shows a tool that is not shown in
the focused tile's place and the button says "Shows in place of <the focused
tool>"; on a new Code task the buttons are disabled with "Available once the
task starts". The row is a
toolbar named "Tools" with one Tab stop and arrow-key movement. The dock's own
header is an empty band as tall as the title rail, so its panes start below it
whatever the width; it holds no strip, Add tool, Show another tool or quick
tools (the bottom panel keeps its strip and Add tool). At 960px and under the
dock is a modal drawer over an inert band, so the same row stands in the
drawer's header, a press replaces the one tool shown, and there is no dragging. Zen
remains in the bottom-left identity menu.

### Content tabs

Workspace content and dock tool tabs share a compact 26px recipe for height,
spacing, selected fill and edge, and close controls. A pane's conversation tabs
then become a row of equal soft tabs with the control corner, 28px tall at a shared 196px (never
narrower than 112px), 8px apart: every tab carries a faint wash of the ink, the
hovered one a little more, and the open one the brightest wash with a hairline
edge, so the row reads as a set of open conversations rather than a line of
links with one highlighted. A pane tab's own button spans the whole tab with
the × laid over its end, so the shared keyboard focus edge outlines the whole
tab: drawn on the label alone it boxed the title and left the × outside. A tab whose
thread runs shows a spinner in place of its provider mark; one waiting on the
person ends in a small dot in the warning ink. A tab picked for side by side (Cmd/Ctrl- or
Shift-click) sits a step between the two, with a fainter edge. Dock tool tabs
keep the bare recipe. Close controls retain their
width; inactive controls appear on hover or keyboard focus and stay visible on
touch devices. Thread tabs retain provider marks when enabled. The pane's drag
handle stays quiet: an environment mark (a 20px neutral tile, laptop for this
computer, cloud for another host), the thread title as a navigation name (13px,
regular weight), a chip naming the Project in meta ink, and in Code a second
chip naming the checkout's branch in the mono identifier face — no provider
mark. The two chips shrink before the title does. While the host projects the
thread as executing, a "Running" chip with a small spinner follows the chips.
The host reports that a turn is executing but not when it began, so the chip
names the state and claims no elapsed time. A thread parked on the agent's own
approval, or on a question its turn asked, shows "Needs you" in its place,
without the spinner. See
[Workspace](workspace.md).

Main-pane content opens in a closable tab beside its conversation. Files, previews,
and canvases retain navigation references, and selecting one uses the ordinary
host-authorized open command. Image creation is a pane-owned view that retains
its draft while the user switches back to the conversation. The strip occupies
the existing pane title row rather than adding a second header.

### Sidebar

The app has three server-enforced modes—Chat, Work, and Code—shown as two:
**Work**, which lists Chat and Work threads together and whose new-thread
composer opens with a Chat / In a folder switch in its context tray, and
**Code**. Work reopens on the kind last used. Mode switching is two compact icon buttons at the top of the sidebar, never in the title band, when Work
and Code are both on: a conversation mark for Work and a code mark for Code.
A tooltip names the mode on hover and keyboard focus; the label is clipped
from view and stays the button's accessible name. The active mode carries
`aria-current="page"` and a fill plus hairline, not colour alone. The fill is
the primary text at 12%, one step over the tray's 6%: the selection role drew
as the tray itself (1.01:1 in light). With one
mode enabled the header is a single label and no control. Settings still
offers a dropdown that names the current mode; a host that stored that choice
keeps it. Code and Work keep separate Project View sets. The
sidebar keeps Projects as a first-class destination alongside the active mode's
compact thread list. When Work has no Chat or Work Projects but Code does, the
empty Projects line says "Your Projects are in Code." with a Switch to Code
link; starting a Work Project stays on the section header. Code does not
mirror that hint. The Projects directory and the selected Project overview
occupy the main workspace in turn, following the
[workspace navigation rule](#navigation-and-projects).
The directory provides search and All, Chat, Work, and Code filters. Project
detail is thread-first, with memory, provider access, and canvases in compact
expandable rows below the primary work; its layout is in
[Workspace](#navigation-and-projects). A Work Project other than the default
folder also has a **Status file** row whose switch sits in place of the expand
control: off by default, its copy says what turning it on keeps in the folder. Threads without a listed Project appear once in **No Project**, a collapsible
folder row in the Project tree with the same nested-thread layout as Projects.
It has no horizontal divider or separate section heading and is absent when empty.
It is a navigation group, not a persisted Project. Rows are hairline rails, never cards;
provider marks are fixed-size inline and can be hidden without changing row
height or indentation. What a thread row carries — its Project
attribution, branch, linked pull request, last updated, or status mark — is the
view's own choice, edited in Settings › Sidebar › Thread rows or the
view filter menu's Property visibility submenu; a hidden property is omitted
rather than left as a gap. The Project tree and the Activity feed draw the same
row: the provider mark in the icon column every navigation row uses, the title
alone on its line, and the shown facts on one line beneath it in a fixed order
(Project, pull request, branch, then the age at the end); with no facts shown
the age sits beside the status instead of opening a line of its own. Thread rows
are not indented under their Project, so every row's fill sits the same
distance from both edges of the sidebar. In Code, a Project whose threads run
in two or more checkouts nests them under one heading per checkout, primary
checkouts first: a branch glyph, the branch in a small mono chip, and a quiet
"Primary checkout" or "Worktree" label. The heading is inert text, not a
button, so keyboard focus skips it; its threads take one more step of indent on
their content, never on their fill, and drop the branch fact the heading already
states. A Project with a single checkout shows no heading. The Activity feed
and Status stay flat. A hovered row takes the soft ink wash and the row
the workspace is showing takes a stronger neutral ink wash (never the
theme-tinted selection or control fill, which drew a coloured slab on tinted
presets), the same two states the thread tab strip draws, so pointing never looks like
being there. Provider identity remains at the leading edge. A Project row leads with a 20px
rounded letter tile: the Project's first letter, white, on the colour the person
picked from the theme palette, or a neutral tile when none is set. The same tile
heads the Project overview, where it is the colour picker; the row's actions menu
offers Colour with a No colour choice, and an archived Project cannot change it.
A Project whose folder holds a favicon or app icon shows that picture, drawn as
an image at the same 20px, in place of the tile (and in place of the folder
glyph in lists); the tile and glyph remain for a Project without one.
The colour is identity, never status: it never stands in for a warning, a
selection, or an activity mark. One fixed trailing
status position shows a working spinner, an attention symbol, a clock when a
snooze ends, or a neutral unread dot, in that priority order. Its accessible
label and hover details retain overlapping states; a row never renders a
second activity dot or a separate "Woke" label. A list longer than eight rows folds behind one quiet "Show
more (n)" row that becomes "Show less"; the active thread stays visible while
folded. Under checkout headings each checkout folds its own list, so a worktree's
threads are never hidden behind the primary checkout's Show more. Project View and
Project Overview are real features, not
decorative shortcuts.

The sidebar header carries the mode switcher, Search, and New thread (New
chat in Chat, New task in Work and Code); no New thread row repeats it. Under the header sit four count tiles in a 2×2 grid: Inbox (the
threads that need the person: an approval, a question, a follow-up that is due,
or a subagent request waiting on them; a finished turn is not one, and the
dock badge counts the same threads), Running (threads the host projects as
executing), To review (finished turns not opened since), and Done today
(threads put away since local midnight). Each tile is one button whose name
carries its count ("Running, 2"); Inbox opens the Inbox, Running opens the
Board (the Activity feed in Chat, which has no board), To review opens the
Review page, and Done today opens the Put away shelf (see [Workspace](#thread-visibility-and-completion)). With the tiles on,
the Inbox and Board rows are left out because their tiles go to the same
place. Settings › Sidebar › Count tiles turns them off and brings the rows
back. Tiles show only where the sidebar stands without a rail in a window wider
than 960px, that is, when Settings › Sidebar › Icon rail is Never, or When
hidden while the sidebar is open. They are neutral faces under Mono; under
Colour each takes a palette hue, as a solid face with primary-foreground text in
the light theme and as a tint with a coloured count in the dark one. At 960px and
narrower, where no rail shows (the same breakpoint as the rail's own, one
number), and in the phone drawer, the four destinations are compact rows
instead: icon, name, and the count at the trailing edge, with no fill, so they
sit quieter than the thread list under them. The row's icon, like every icon in
the rail, stays in the sidebar ink in every style, and each count has one mark
wherever it shows (Inbox, a play circle for Running, an eye for To review, a
ticked circle for Done today); the name and the count stay in the sidebar ink. Each row keeps its name with its
count and its destination. The drawer itself paints the opaque sidebar surface
in every material, since it overlays the page and a transparent drawer let the
page's text show through it.

Primary sidebar destinations are Board and Pull requests when valid for the
active mode. The destinations a person placed under Menu
only wait in a More row that closes the destination list (the rail's More
button when the rail stands beside the sidebar) — an ellipsis opening a popup
beside the rail with those destinations and Customize sidebar; the
setting that turns the More row off returns them to the bottom-left identity
menu. The identity menu owns Settings, Navigator, Agents, Providers, Usage,
Plugins, Automations, Artifacts, and Zen entry points. The account menu opens
above its identity row, aligned to the
row’s leading edge. Search is a compact in-place filter for the current mode's visible
threads: the header's Search icon opens a Filter threads field under the
header, Escape or its close control clears and hides it, and Settings ›
Sidebar › Thread filter can keep the field always shown. Enter in the field
hands its text to the command-style overlay, which searches every thread of
the mode; the overlay also stays in the command palette. The list's three
arrangements, Status (the default), the Project tree, and the Activity feed,
are a visible Status/Projects/Activity switch on the row the Project view
picker uses, not an icon in the header. That row stands in the same place in
all three, with the Project tree's own Projects heading under it, so pressing
the switch moves nothing but the list. Status headings carry their count in
meta ink after the label ("Needs input 2"), the same face as the feed's folded
Earlier count. A row whose pull request's checks pass adds a 12px check in the
success ink after the PR number.

### Icon rail and title band navigation

**Icon rail foot.** The rail's destinations scroll, with the same short fade at
their edges and no scrollbar, above a foot (usage, Settings) that stays on
screen. One column that scrolled as a whole put Settings out of reach in a short
window and cut the last destination through its icon at the window's edge.

**Icon rail.** By default (Settings › Sidebar › Icon rail: Always) an icon
rail stands in its own column in front of the open sidebar. It is exactly as
wide as the title band is tall (44px), open or collapsed, so the frame's two
arms match. In the desktop app the traffic lights sit in the title band above
it, and the sidebar's head, or with the sidebar hidden the window chrome,
keeps the rest of their width clear. Beside the sidebar it
carries the places: the count tiles as icons with badges (under Colour the
four icons take the tiles' hues, Inbox blue, Running amber, To review purple,
and Done green, from the same palette roles; the hover and current fills and the
count badge stay neutral, and under Mono and increased contrast the icons stay
grey), the destination
rows the person keeps shown (Settings › Sidebar › Sidebar destinations decides
which and in what order, for the rail as for the sidebar), the Activity feed,
Projects, a tile for each Project the person pinned (its icon or initial on the
same 32px face, after the divider; a context menu on the tile unpins it; the
collapsed rail lists pinned Projects first and draws six Project tiles at most
so Settings and the rings stay in the window), More (the menu-only destinations and Customize sidebar), the usage
rings, and Settings. The sidebar keeps its header (modes, search, new thread,
hide), the Project list with its view, filter, and Activity controls, the
threads, and the profile, so nothing is offered twice. Rail icons are 16px on
a 32px face; every rail control names itself in its accessible name and in a
label that opens beside the rail on hover or keyboard focus. Destinations
have their own marks: Inbox a tray, Running a spinner, To review a checked
clipboard, Done today a double check, Board a kanban, Issues the issue dot,
Pull requests the pull-request arrow, Linear a checklist, Projects stacked
folders, Agents a bot, Automations a calendar clock, Artifacts layers, Image
generator images, Plugins blocks, and the Activity feed a pulse line.

**Sidebar header width.** The mode tray never shrinks. Where the sidebar header
(modes, Home when no rail stands beside it, Search, New thread, Hide, Back and
Forward) cannot fit one row, which is a sidebar of 220-236px (also the width a
1100px window leaves it beside an open dock), the actions wrap to a second row
under the tray instead of sliding beneath it. The tray's row stays first at the
top of the sidebar, and the header keeps its full wrapped height however long
the thread list is, so the list always starts under both rows.

**Usage rings.** Above Settings, at the foot of either rail, each provider
that reports a plan window with a figure gets a ring in its identity colour
around its 12px logo:
the outer arc is what is left of the longest window (the week), the inner arc
what is left of the shortest (five hours), chosen by each window's length, and
a window near or at its limit takes the danger ink. Hovering or focusing a
ring opens a card with every window, its share left, and when it resets;
clicking opens Settings › Usage. A provider with no figure gets no ring,
because an empty ring would claim a limit nobody reported. The rings read the
host's last observation every few minutes, never a fresh provider call. The
host keeps that observation across restarts, so the rings are there on launch;
when the reading is more than a few hours old the card says "Last read 5h ago".

**Back and forward.** Back and Forward sit in the title band beside the
sidebar control (beside Show sidebar while the sidebar is hidden, with or
without the icon rail, and in the sidebar's header in a browser). They step
through the pages (Inbox, Board, Pull requests, Projects, the other sidebar
places, Review, and the archive) and the tabs (threads, drafts, canvases) this
window opened. A step in another mode switches to that exact mode (Chat and
Work keep separate layouts though they share one visible mode) and opens the
page or tab once that mode is on screen, without the home landing a person's
own mode switch makes. The history belongs to the window and is never stored; it holds
the last 50 steps, a new place drops the steps ahead of the current one, and
a step whose tab was closed since is skipped. Each button stays in place,
disabled, at its end of the history.

**Hiding the sidebar.** Hide sidebar, or Mod+\ (rebindable, "Show or hide
the sidebar", answered in text fields too and leaving focus where it was),
collapses the sidebar to the rail alone, which then also shows New thread and
Search at the top, the modes (with the same marks as the sidebar's mode switcher, so Work keeps one icon), and up to six Project letters (outlined at icon
size in the icons' muted ink) with a Projects button for the rest; Show sidebar, Back, and Forward move into the
title band, so the rail stays one icon wide. Icon rail: When hidden shows the
rail only in that state; Never removes the sidebar completely when hidden and
leaves Show sidebar and New thread in the native title rail. Neither rail
appears below the narrow-window breakpoint (960px): there the width belongs to
the page, and below the drawer breakpoint a collapsed sidebar is a closed
drawer.

### Right dock and bottom panel

The right dock defaults to 640px when open, and opening a Browser or a
Terminal widens a narrower dock to 640px once (the person can drag it back;
the next such opening widens it again). A terminal in the dock is an inset,
rounded plate rather than an edge-to-edge slab; under Glass the plate and
its cells are the page colour with 12% of the ink, a grey that sits with the
frosted panels instead of a black slab. A fresh window
starts with it
closed; choosing a tool or restoring an explicit prior choice opens it. The
pane/title control rail is `--oct-title-rail-h` in the native host and the status
bar is `--oct-statusbar-h`.

The right dock follows the active pane and never leaks another pane's content.
The dock and the bottom panel both step aside while a reader route (Board,
Inbox, pull requests, issues, Archive) holds the pane: a reader is a page about
many threads and shows none of them, so one thread's tools do not keep a
quarter of the viewport there. Both keep their tabs and their height and return
with the thread, and their toggle leaves the reader rather than closing a
region that was only stepped aside.
On wide windows it may use at most half of the workspace beside the sidebar
(`dockWidthCeiling`, never under the sidebar minimum or over its maximum), which
keeps the thread readable beside any tool, and the resize handle stops there
too; with two columns of tool tiles shown it may take all the thread's own
minimum leaves (the thread keeps 440px beside two columns from 1100px up and
360px below, which the stylesheet's grid mirrors as `--octant-tiled-primary-min`;
one column keeps 560px from 1100px up. At 560px two tools could never stand side by
side in a 1440px window, so a second column asks the thread for less); the bottom panel may use at most 38 percent of the
viewport height while preserving 320px for the primary workspace, and it hosts
exactly Review, Terminal, Browser, Files and Side chat. The dock can host
Review, Pull requests (open rows for a Code thread's Project), Files, Document
(only once a turn has written one), Browser, Terminal, Canvas, Plan (only for a
real plan artifact), Delivery (only for a configured target), Agents (when
children exist or explicitly invoked), Artifacts (a Work or Code thread in a
Project on this host), Simulator, and Side chat. A Markdown or
text file a Code turn creates or rewrites, and a Canvas a Work or Code turn
authors, open in the dock beside the transcript once, the first time they appear: the
offer never moves focus from the composer, a rewrite never reopens a tab, and a
tab the person closed stays closed. Document
reads the file through the same host-authorized open the editor uses and
renders Markdown with the preview's own viewer. With no open tab, the dock
opens on a stack of cards, one fact group each and each omitted when the window
has nothing true to put in it. A card is the overview's own recipe: the surface
fill, a hairline, a medium-weight title, and rows at the 28px step, with a
figure or word in meta ink at the title's right. **Environment** names where
the thread runs (the host, the Project, the branch with Worktree when it runs
in one) and the mode at its right, and, in the desktop app's own window for a
thread on this computer, a **Remote access** switch read once from the host's
listener status: on turns the listener off through the same host action
Settings uses, and off opens Settings › Remote access, where the address and
certificate enabling needs are chosen and confirmed; **Local servers** lists the servers this
thread's checkout is serving, each a dot (the success ink when it answers) and
its name with the port, from one observation when the overview opens, never a
poll; both titles open the Environment tool. **Context** shows the share used
at its right beside a short neutral bar, with used of total under it, from the
composer meter's own source. **Changes** (Code only) shows the board's observed
`+`/`-` totals over the file count, never a stale observation, as the row that
opens Review, and the thread's pull request with its checks in words.
**Outputs** lists the documents and Canvases the window knows the thread has
(those it had when opened and those its turns wrote since, never a deleted
file), newest first and at most five, each a row that opens it in Document or
Canvas, with the count at the title's right. **Background tasks** lists the
runs the thread's agent handed work to, from the same read and cadence as the
Environment tab's Subagents row: each running one a spinner, task, and age,
with the running count at the title's right, and the finished ones folded under
one "N finished" row; a row opens that run in Agents.
**Running now** lists the other threads the window knows are working (any
mode, at most five, newest first, never the thread on screen), each a spinner,
title, Project, and age, and opens that thread. Model and access are not
repeated here: they are on the composer. Tools open from the title band's tool row. More tools opens a menu in a
portal anchored to its button, aligned to its end edge and kept inside the
window by collision handling; it takes focus on its first item, closes on a pick,
on Escape or on an outside press, and returns focus to its button. The bottom
panel uses the compact tool-tab and Add tool model for Review, Terminal, Browser,
Files, and Side chat where supported. Opening a tool in the dock leaves the
bottom panel open: a Terminal below and a simulator and a page beside it are the
point of having both regions. Only a tool the panel is already showing moves out
of it, because one instance appears in one region at a time; Terminal
immediately attaches or starts and preserves one server session when moved.

Browser and Terminal are repeatable right-dock workspaces: New Terminal and New Browser page on the tool's button menu create a
new tab identity, an isolated Browser context or Terminal session, and a stable
numbered label when siblings are open. Files, Document, Review, Agents, Canvas,
Plan, Delivery, Simulator, and Side chat are singleton destinations. One instance
still appears in only one region at a time.

The right dock has one width whatever it shows, so a click inside it moves
nothing: the launcher and every tool use the width the person last dragged it to.
It never takes more than half the workspace, and its handle stops at the same
half. A Browser or Terminal tab that needs more holds 640px while that tab stays
open, including one restored after a restart, and does not save it. A width the
person drags to stands until the next Browser or Terminal opens.

Without a saved show or hide choice, a wide window starts with the right dock open and a narrow window starts with it closed. The bottom panel starts closed. An explicit dock show or hide is restored per window; merely mounting the default records no choice, so an initial narrow frame does not become a saved close. The active-pane eligibility rules below still determine whether dock chrome is shown.

A welcome, Project, or other pane with neither a bound thread nor a valid
launchable tool keeps the dock closed and omits its toggle. A new Code task's
pane before its thread exists keeps the toggle but starts closed, whatever the
window's saved choice: it has nothing of a thread's to show, and opened by
default it covered a third of a blank start screen to say its tools were not
available yet. Opened there by the person, its title band shows the common
tools disabled ("Available once the task starts") and its body says so (or,
once the start screen has a Project, holds that Project's quick tools). That
show or hide belongs to the draft and is never saved as the window's choice;
once the task has a thread the window's own choice applies again. Restored presentation for another subject never makes unavailable
chrome visible.

The right Tools launcher starts directly beneath the window control rail, without an extra top spacer.

### Tool tiles

**Tool tiles.** The dock body shows one open tool by default. A maintainer
testing an app in the simulator beside the page it served had to choose between
them, so open tools can also be shown together as tiles, each one live, beside
the one tool row. At most two columns of at most three tiles are shown; a
request past either cap is refused, except that "beside" with two columns present
puts the tool below in the last column. A tile is a region named for its tool
with **one bar**, the tool's own header, 32px high in every tile so neighbouring
bars line up. Its leading edge names the tool once (the icon and name; for the
Browser the bar is its row of pages, each with its close, and the new-page
control, and with one page the page's title is the name) and its trailing edge
holds the tile's controls: an **Arrange <tool>** menu button and a **Close
<tool>** button that closes the tool as pressing its button again does (every
page for the Browser). Stacked, a page showed four bars (a strip, a "Browser"
caption, the Browser's own page row and its toolbar) and named the tool three
times, so the dock has no strip and a tile has no caption over its bar. A tool alone has no tile bar and keeps the one slim row below. The Arrange menu holds **Move
left**, **Move right**, **Move up** and **Move down**, each present only when
that move is possible within the caps (a one-column layout moved sideways makes the
second column, and a column left empty goes), then **Show alone**, **Hide
from view** and, for the Browser and Terminal only, **Minimise to card**; a move keeps every tool mounted and the native Browser page
follows its tile. The focused tile (the one whose tab is selected) is told apart by its bar
reading in the full ink, with no ring and no fill, so a see-through theme shows
through every tile; the dock's own surface is the tiles' ground. Dividers
between columns and between a column's tiles are hairline separators with an 8px
hit area, a hairline at rest, in the quiet strong-divider role while hovered or
held, and never an accent line after a click (only keyboard focus shows a mark,
the app's own focus outline), that resize by pointer drag or arrow keys (Home and End go to the ends
of the range the floors allow), each named for the two tools it sits between
("Resize Environment and Vitals") and reporting the range it can really reach; no tile
is shorter than 140px or column narrower than 280px (the dock's own minimum
width) while the dock has the room, and the columns stack when the tile area
cannot give two columns 280px each. Columns therefore stand side by side only
when the tile area has the width: at 1440px with the sidebar open a second
column widens the dock to about 620px and the columns stand side by side at about
306px each (they stacked at 500px while the thread kept 560px), and in a narrower
window "beside" stacks, which is why the head control promises no direction;
a tool button's menu keeps an explicit Show below. Stacked columns stay
resizable by a separator between them along the vertical axis, and no tile is
ever under its floor: when stacked tiles cannot all fit the dock, the tile area
scrolls with every tile at the floor. Pressing the button of a shown tool closes it; pressing one that is open but not
shown shows it beside the focused tile; a drop on the middle of the dock replaces
the focused tile's tool.
All Browser tabs are pages of one Browser tool, so there is at most one Browser
tile and choosing another page changes that tile's page; the dock remembers the
page last shown and returns to it whenever the Browser is shown again, from its
button or a drag. A tile clips its tool to its box (it has no fill of
its own), and gives the tool a definite height to scroll within, so one tool's
rows are never painted over the next tile. A tile resolves its own
tool: one that cannot be described for the active pane says so inside its tile,
never shows another pane's content, and leaves the other tiles on screen. The
single-tool view is the same tile area with one bar-less tile, and tiles are
positioned children of one element, so a tool is never remounted when a
neighbour joins or leaves, when it moves between columns, or when focus or a
divider moves; only choosing another tool for a tile replaces it.

A tool's button carries the placement a tab menu once did. Its context
menu (right click, the menu key or Shift+F10) offers **Show below** for an open
tool that is not on screen (disabled when the caps refuse it), and, for a tile in
a layout, **Show alone**, **Hide from view** and the moves that are possible,
then **New Terminal** on Terminal and **New Browser page** on Browser, then
**Close <tool>**; what does not apply is absent. These menus, and dragging,
belong to the five tools with a button of their own (Environment, Terminal,
Review, Browser, Files); a tool opened from More tools is shown the same way
and is then arranged, hidden and closed from its own tile's bar, a tool alone
having no bar and being closed by picking it again in More tools. Pressing a
button shows a tool beside the focused tile in one step (opening it first when
needed), beside it when the columns stand side by side and below it when they
stack; when the tile caps are full it shows the tool in the focused tile's place
and the tool it replaces stays open, hidden from view. Dragging an open tool's
button onto the dock body does the same: the right third shows it
beside, the lower third below, and anywhere else replaces the focused tile. With two columns shown and no width the person
has chosen, the dock widens to 840px (not saved), under the ceiling above;
showing a tool beside, which makes the second column, clears the person's
sizing the way opening a Browser or Terminal does, and a drag afterwards holds. The
narrow modal presentation has room for one tool and draws only the focused tile;
the layout stays stored. The layout is window-local presentation, stored with
each thread's open tools, and the bottom panel never has one. Tile changes are
made on the tools on screen, so a tool the bottom panel holds never counts
toward a cap or a divider's shares. A tool the bottom panel takes, or one that
becomes unavailable, loses its tile and comes back as a tab, not as a tile.

### Minimised tools

**Minimised tools.** A thread's Browser and Terminal can stand as small live
cards at the foot of the dock, so a page or a shell can be watched while another
tool, or only the overview, is in front. A floating preview drawn over the thread
covered the thread's own text and could not show a shell at all, so it is gone;
the cards replace it. The shelf is a group named **Minimised tools** at the foot
of the dock body, under the overview when no tool is shown and under the tiles
when tools are shown (the tiles measure what is left and keep their floors). It
takes its natural height and holds at most two cards (Browser, then Terminal),
side by side at half the width each (8px gap) once each can have 160px, a dock
about 352px wide or wider, and stacked below that; one card takes the whole width.
It is never more than two fifths of the dock (it scrolls inside past that, which
two side-by-side cards do not reach in a dock 420px tall or taller) and is not
drawn in the narrow modal dock, where the state is kept and the tool's button in
the drawer's row reads as any open tool's. A card is a `.dock-card` like the overview's, with no
frosted parts and no new fill, an 8px inset round a 28px bar over a 104px preview,
152px in all: a head with the tool's icon, a title (the page's
title or host with the profile name beside it where the page lives in one, or
"Terminal"), a detail word (such as "Exited (1)"), a quiet 6px dot named "New
output" for a shell that printed while nobody looked, an expand icon button
(**Show Browser**, **Show Terminal**) and a hide icon button (**Hide Browser card**,
**Hide Terminal card**, which removes the card and closes or stops nothing: the
tool stays open and its button in the title band's tool row reads open but not shown; every button a 24px target), then a preview that is itself the expand button (named
"Show Browser, live preview"; its corner is the card's 12px minus the 8px inset, 4px). The name truncates with an ellipsis
before a detail word or a button moves. The Browser's picture is cropped to the preview from its top left, never stretched, a neutral skeleton while stale or missing; the
Terminal shows its last lines in the smallest terminal type, read-only, or "No
terminal running" or "Preview unavailable". The picture and the terminal keep
their own content fill, inside the card. A minimised tool's button in the title
band's row is not pressed, carries the open dot, and reads "Minimised to a card";
pressing it shows the tool. A tile's **Arrange <tool>** menu offers **Minimise to
card** (Browser and Terminal only, after **Hide from view**), and so does the
context menu of the Browser and Terminal buttons; pressing a pressed Browser or
Terminal button minimises it instead of closing it. The tile bar gains no
button for it. Show on a card returns the tool as a
tile of its own, to the place it left while that place still exists and else as
the last tile, focused, without taking a shown tool's tile.
While an agent's Browser session is live and the thread's Browser is out of sight
the Browser shows as a card without being minimised; with the dock closed, the
window's dock toggle (not in the modal dock, which has no shelf) carries one quiet
dot described as "Browser is active". The
rules, reads and limits are in [Workspace](#tool-lifecycles).

### Environment tool

Environment is a right-dock tool, opened from the title band's tool row and
nowhere else. It reads
top to bottom as cards in the Settings kit's grouped-card look: one header card,
then two captioned cards of rows. A card is a faint wash of the ink over the
dock with no ring (increased contrast adds one), so it never paints the opaque
page colour onto the glass. The header card names what the thread works
in: the name on its own line, then the branch glyph, the branch, a dot, and the
home-relative folder in mono, with the full summary (working folder, running
servers) kept as one sentence for assistive technology. Inside it, an inner
soft box says what the checkout holds (a file-diff glyph tile, Uncommitted
changes with its added and removed counts under it, and a chevron, opening
Review; No uncommitted changes when clean), a detached HEAD or separate
worktree when true, and Commit or push and Create pull request sit under it as
two equal buttons. The rows follow in two cards, Running (Local servers, open by
default only when this checkout is serving something; Subagents, one row with
its working / to review / done counts that opens the Agents tool — reading and
steering a subagent belongs there; Computer use) and Delivery (Pull requests,
Sources, Delivers, Working folder, and Usage, closed by default; totals, the
spend ceiling form for tokens, turns, hours, and US dollars, whose fields wrap
two by two in a narrow rail, and Open Usage dashboard inside). A card with no
rows to show is omitted with its caption. Every row has one grammar: a 26px
glyph tile, the name, the row's state as a small neutral chip, and a trailing
chevron where the row opens (a row's own action, such as All pull requests,
wraps under it when the dock is narrow rather than squeezing the chip). Rows are 44px, lift their ink on hover
rather than taking a fill, and an open row's content starts under its name.
Other servers stay behind a nested disclosure; none are stopped or removed by
hiding them. The cards sit one step above the dock's own background. Sources list the current thread's journaled image attachments when present.
Computer use offers Picture in Picture show/hide for its live activity card
that floats over the main conversation. The Browser's live preview is separate:
it is a card on the dock's shelf and follows the thread's Browser, not this
control (see [Minimised tools](#minimised-tools) and
[Workspace](#tool-lifecycles)). Neither preview occupies
Environment, and hiding one never stops its session. Computer-use approval and
stop controls stay with its card. It does not duplicate the Agents dock. Missing checkout context
is neutral explanatory text rather than a warning callout.

### Browser toolbar

The Browser toolbar is one row under the tile bar and never wraps. It holds back,
forward and reload as plain icon buttons (no capsule, no fill at rest, the
standard hover fill and disabled look); then the address field, which takes the
rest of the width; then icon-only buttons. The field is the system's text field:
the control corner (`--oct-radius-sm`, never a pill), the field border, the hover
edge and the keyboard-focus fill, at the 28px rail height. It holds at most one
mark: the connection mark (lock or globe) of a loaded page. With no page it is
empty but for its placeholder. After the field, in this order and each only when
it applies: a **status** icon (who may use the page, who holds it, how long it
idles, or that the agent cannot use it, as its name and tooltip; a spinner while
the page loads or the agent drives it), **Take over** or **Hand back**, the
extensions button (when an extension is on in the page's profile), and the
**profile** icon, a menu button named for the page's profile that also signs out
of a stored profile. The status icon is not drawn at rest; the availability
sentence is then part of the profile icon's tooltip. The last button is **More
Browser actions**, which holds Screenshot, Draw on page (only in a Work or Code
thread's Browser), Open in default browser (desktop), Login permission, Hand
back while a remote owner holds the page, the agent-availability recovery
action, Dock in the focus zone and Stop this Browser session, each only when it
applies; the menu is absent when it would be empty. While a remote owner holds
the page, **Reclaim locally** replaces Take over and Hand back as the trailing
button, because a hand back is refused until the page is reclaimed. The profile
icon names a signed-in profile (Project, Personal or a named account) beside
itself in the meta ink and extra-small size the dock's cards use, so a page that
acts as the person's own account is named at rest as it is everywhere else; a
Private page, which signs nothing in, stays an icon. The name shortens with an
ellipsis before the address gives up width, and the icon and tooltip stay. No
more than three icons trail the field besides More. When there would be more, or
the address would otherwise be narrower than 120px, the left-most move into More
(status as a non-interactive first line, then Take over, then the extensions),
each counted at its own width (the extensions button grows a count while the
agent drives). When only the profile is left and the floor still fails, the
profile's choices and its sign-out move into More as well. Back, forward and
reload always stay. The row's inset follows the tile bar: its first glyph
stands on the bar's 12px lead inset and its last button ends 8px from the edge,
as the bar's does, with 4px between controls. With no page open the row is the history buttons, the
empty field and the profile icon.

### Board

The Board is an operational reading surface with four fixed,
server-authoritative statuses: Ready, In Progress, Waiting, and Done. All
four lanes show by default as soft wells: a faint tint of the text ink (3%)
over the workspace colour, one soft hairline, `--oct-radius-md`, 8px of inner
padding, and 12px between wells. A well's head names it once by mark, name,
and count, with no rule under it: the name at the section-label step in the
secondary ink and the count pinned to the trailing edge in the meta ink. The
mark is told apart by shape, not hue: Ready a hollow ring, In Progress a small
turning arc while any card in the column is executing and a filled dot when
none is, Waiting a filled dot, Done a check. Under the Colour style the marks
take palette colours (Ready stays grey, In Progress orange, Waiting purple,
Done green). A Board/List toggle leads the toolbar, and every control on it
(the segmented choices, search, Filters, Refresh, View) is one rail control
(`--oct-rail-button-h`). A card is a raised object inside its well: the card fill, a hairline,
`--oct-radius-inset`, and 12px of padding. It carries the Project as an
eyebrow, the title, and, while the thread is executing, a live line under the
title (a small turning arc and the latest sub-agent line in the mono meta voice,
or "Working…" before one reports). Under that come what the thread waits on,
active runs and failing checks, and each linked pull request as a compact
preview box (the PR mark and title, then the repository, state, and checks).
The card ends with a footer row: the provider mark (the same glyph as the
sidebar's, 16px, named for assistive technology), the worktree branch in a mono
chip and the diff size in the existing green and red roles (Code only, and only
when the tree changed), and the age at the trailing edge. Checkout, plan, and
review facts live on the list view and the thread. Waiting does not become a
warning wall. Labels and facts use the selected
interface typography. Thread listing, pull-request snapshot, and per-thread
runtime reads overlap where independent.

### Zen

Zen is a desk. Every card is a window: its title bar moves it, every edge and
corner resizes it, the arrow keys nudge it and Alt with the arrows resizes it,
and it stays exactly where it was left. There is no pan or zoom; everything is
on the one screen. **Tidy**, top right, re-tiles every window in reading order
into the room the surface has, leaving the spaces bar and the Navigator bar
their own edges; the column count follows the window count and drops when the
area is too narrow for a readable measure. A space that has never been arranged
is tiled once when it opens and that tiling is written down as each window's
own geometry, so nothing jumps when a person first drags one.

A window's title bar is one quiet line: a small mark for its kind, its name,
how long ago it moved for a thread, and two icons, minimize and remove, that
brighten on hover. The corner handle shows a small bracket on hover so a person
can tell windows resize. Windows are glass panes: the regular step of the glass ladder over a lighter
floor, so the ground's colour reads through the blur, with a one-pixel light
edge along the top, a hairline stroke, and a long soft shadow; the window in
front takes a brighter edge and a stronger lift, and reduced transparency or
increased contrast turns them opaque. A new space stands on a first-party picture rather than
a flat colour, and a space still carrying the old flat default is shown on that
picture too. Add terminal and Add browser list the threads they can open in,
the focused card's first: a terminal runs in a Code thread's checkout and a
browser in a Work or Code thread's browsing context, under that thread's
authority. The browser is a window too; it moves by its bar and resizes from
the edges away from its anchor, for the session.

A card is a reading of one thread. Its head carries the thread's name in the
interface face at the body size, and beside it how long ago that thread last
moved; the editor face and the metadata ink are for code, paths, and
identifiers, not for the one label that says which thread this is. A card that is not streaming
reads its host, mode, Project, and the model that answers, in that order. It
does not print a stored ISO timestamp or a provider instance id.

Zen's own chrome is one dock and one sheet. The dock is a row of icon keys,
each named in a tooltip and to assistive technology: Threads, Add, Navigator,
Appearance, then Hide and Exit Zen after a divider. Asking the Navigator lives
in the Navigator panel, which has the field and shows the answer. Putting
something on the desk is one destination, not two: the Add sheet shows each
kind of window as a tile (Thread, Terminal, Browser, Notes, Checklist) and the
two that take a value, a timer's minutes and a link, as one line each. A panel
is a page in a sheet, so its title is the page title and its close is an icon,
and it stops above the dock. The dock, the bars, the sheets, and the empty
space's guidance wear the windows' glass one step lighter and with a larger
radius, the same step for every floating object. The Appearance sheet reads
Look (one Dim dial that darkens every ground, window opacity, picture fit),
Effect (Off, Pixelate, or Dither, with pixel size and tones), then Background
as one grid of pictures that opens on App background and Your picture. Pixelate
and Dither print a picture ground at one canvas pixel per cell and upscale it
without smoothing; dither quantizes each cell through the same ordered
threshold as the application ground. They print pictures only; the app ground
keeps its own dither in Settings. Escape closes the open panel and only leaves
Zen when none is open. Pinning shows no notice: the card that arrives says the
same thing, and the notice landed on top of it.

### File editors

File editors share a compact command toolbar and one Editor settings disclosure.
The primary Save and the unsaved/saving/error state stay visible above the
source; preferences are secondary. Source/preview switching retains selection
and undo, and a Markdown split stacks at narrow widths. Each source/preview
region owns its scrolling. Conflicts show a bounded disk-versus-draft comparison
with explicit keep-draft or discard actions. A selection proposal or replacement
review remains a separate disclosure above the editor, with its own before/after
comparison and an explicit apply action. Colors and typography come from the
existing editor projection and shared controls. Behavioral detail is in
[Workspace: File editing](#file-editing).

### Pull requests and issues

Pull requests and usage surfaces use explicit loaded, refreshing, stale,
rate-limited, empty, unavailable, and error states. GitHub refresh is user
triggered and asks `gh` only for open/draft rows. Connected repositories refresh
with at most four concurrent reads, then reconcile in stable Project order under
the global preview bound. Known closed or merged identities are recovered
separately. Stale cached data is visibly stale. Provider usage follows the same
provider-neutral context/limit model and preserves unavailable values.

The Issues surface reads like GitHub's issue list: one toolbar with a
repository chooser (All recent repositories, or one repository, from the same
popover), state, sort, and search; then a bordered two-pane card with rows on
the left (state glyph, `#number title`, repository and author beneath) and the
reader on the right (kicker, title, state and dates, labels, Start a Code
thread, the body and each comment in their own cards). With no recent
repository the page asks for one in a single panel rather than opening on the
whole catalogue. Start a Code thread leaves the surface with the issue
attached to a new draft as its Create from context.

The Pull requests page is a dense list in a 720px reading measure at the
page's leading edge: a title band with the count and Sort, Filter, Repository
settings and Refresh icon buttons; rows of a medium-weight title (two lines at
most) and one 12px meta line (state glyph, repository, author, age, and the
number in tabular numerals at the trailing edge); one quiet chip or a success
check at the trailing edge of the title line instead of three chips; no hairline
between rows and the control hover fill with the row radius under the pointer.
Grouping by repository gives each group a slim header with a "..." menu holding
Auto-refresh, Agents may merge, Agents may comment on pull requests and Refresh. A Project that is not on GitHub is
one notice at the foot, never an empty block. Where agents may merge is on, the
group shows a quiet chip and the Repository settings button a dot. The Issues
place uses the same row, group head and Sort menu. The dock packs its search,
freshness and rows at the top of its scroll area in the same row anatomy, one
flat list with no menus.

The pull-request merge warning stays inline and nonmodal. Opening it focuses
Cancel; Tab can leave the warning to continue reviewing. Escape within the warning
or Cancel returns focus to Merge (or the review heading if Merge is unavailable).
An attempted merge keeps its existing freshness and reviewed-head checks, and
focus moves to its result when the attempt completes. It is not a trusted task
approval surface. Who may merge (a person, or a Code thread the person
allowed) and what the host checks are owned by
[architecture](../architecture.md#modes-chat-work-and-code).

### Git history in Review

History uses the existing interface face and monospace identifiers, semantic
text/status tokens, and shared `OctantInput`, `OctantSelectField`,
`OctantToggleGroup`, and `OctantButton` controls. A semantic commit table owns
its vertical scroller and virtualizes fixed-height rows. Author, date, and SHA
columns progressively give space to the commit message in narrow docks.

A row opens an immutable commit comparison inside Review. Back restores the
history list and keyboard focus; search, branch choice, and loaded pages stay
within that thread/checkout presentation, not the URL or journal. Search results
show individual nodes rather than inventing graph edges across omitted commits.
Loading, unavailable, no-result, shallow, and truncated states remain explicit.
Historical file inspection is read-only. Existing unified diffs and Monaco own
diff presentation; file disclosures mount only their open preview. Unified and
Side by side are a compact Settings row on Code, used only until this window
stores a layout for that thread.

### What's new card and announcement

After an update the person chose finishes applying, the full sidebar shows one
small raised card above the profile row. A 64px band carries the Octant
aperture on a soft wash of the theme's ink with a hint of the accent, so the
card is depth and not an accent banner. Under it sit a "New · v{version}" line,
the notes' first line as a one-line strong headline, the next paragraph as a
muted two-line summary, and a quiet "Find out what's new" button with a
trailing arrow that opens the notes dialog. A "Dismiss" icon button sits top
right. Either one acknowledges
the update, so the card shows once. The collapsed icon rail never draws the
card and does not acknowledge it; it waits for the sidebar to open. A browser
or remote client has no card.

A release may bundle announcements beside its notes: one to five, shown in a
row. They replace the card as a modal dialog laid out as a poster: a 200px
picture running to the dialog's edges at its top (the aperture band with the
mark at 56px when there is none), then a title, a body and the answers, all
centred. (With the picture inset and the text ranged left it read as a settings
dialog that happened to hold an image.) The dialog shows one announcement at a
time. "Not now" is the quiet filled button on every step, and the primary
button opens the notes, labelled "See what's new" unless the announcement names
its own. With a single announcement that is the whole dialog: it opens with
focus on the primary button and has no paging.

With several, a position line ("2 of 3") sits under the body and is part of the
dialog's accessible description; it is a polite status, so each step is read
out. A "Back" button (a ghost button before "Not now") is absent on the first
announcement. "Next" is the primary button on every announcement but the last;
on the last the announcement's own button (or "See what's new") takes its
place. An announcement that names its own action keeps that button, quiet,
beside "Next" on its step. Left and Right arrow move between announcements
unless focus is in a field or widget that uses them, and stop at the ends;
Escape closes. Focus stays in the dialog and lands on the primary button after
each step. The step changes with no animation of its own, so reduced motion
needs nothing extra; the dialog's open and close follow the overlay rules.

The set is acknowledged once, however it ends: closing at any step, pressing an
action, or finishing the last announcement acknowledges the update, and neither
the dialog nor the card is shown afterwards. The acknowledgement is the app
version, which names the whole bundle, so changing, adding or removing an
announcement means a new release and the set shows again. Reason: a row of
announcements is one message from one release, and asking again for each one
would turn a courtesy into a chore.

The announcements are one bounded file and optional bundled pictures; none of
them can run code or name anything outside the resources folder. The file is
`{ "schemaVersion": 2, "announcements": [ ... ] }` with entries of `title` (80
characters), `body` (600), and optionally `actionLabel` (32), `picture` (a bare
png, jpg or webp name, 524,288 bytes at most, whose bytes must match its
name) and `pictureAlt` (160). The file is at most 16,384 characters: five full
entries, pretty-printed and escaped, come to about 3,000 characters each. A
version 1 file (one announcement object) still works as a list of one. A file
that is not valid as a whole (bad JSON, an unknown top-level field, a wrong
shape) shows nothing. Inside a valid version 2 file an entry that is invalid by
itself, including one whose picture is missing, too large or the wrong format,
is skipped and the others still show in order; beyond five, the first five
valid ones show. Pictures are read only for entries that will be shown, and all
of them cross to the renderer together as data URLs (at most about 3.5 MB, once
per launch, only when the notes are due), because a second round trip would
make the Next button wait on disk. The rule is in
[Decisions and requirements](decisions.md#whats-new-after-an-update).

When a verified app update finishes downloading, its notice offers a direct
link to the Updates control; applying the update still requires an explicit
request from the person.

### Mode-specific utility chrome

Chat admits only the Agents dock when helpers exist, it was explicitly requested,
or its tab is retained; see the [workspace rule](#subagents).
Chat has no bottom panel. With the dock closed, the conversation uses the available
workspace width. A Chat
Canvas opens as a content tab beside the thread (**Open Canvas**). Work shares
Code's quiet transcript edge: Browser is a dock tool and completion lives in the
add menu's Mark done, preserving its confirmation flow.

### Shell edge cases

- The native window is transparent; the shell root paints the one window
  surface, so no column may leave its own opaque backing. Without Cover the
  sidebar, the application ground starts at the workspace's leading edge, and
  covers the whole window when the sidebar is collapsed.
- Dock tab fitting subtracts window-control padding and measures actual tab
  widths. Overflow and Add tool controls must never sit under window controls.
- A selected Project pull request may keep Review open beside its list. Other
  global destinations hide unrelated dock content and are mutually exclusive.
- PR readers own a compact, scrollable hierarchy. Descriptions and discussion
  use shared Markdown without executing HTML or fetching remote images. The
  original description remains available when unsupported HTML is omitted;
  diffs use the shared code block.
- Surface actions wrap before titles are squeezed into narrow columns. Settings
  navigation remains a vertical, full-width list inside its narrow drawer.

### Readability and scroll containment

Activity group labels align with their thread titles at the same content inset.
Titles use primary text; project attribution uses secondary text and a separate
line with comfortable leading. Native document scrolling is clipped: Settings
occupies a fixed viewport while content and navigation scroll independently.
A terminal turn cannot present an unresolved tool call as still running; it
shows Unfinished unless the tool has its own recorded outcome. Usage resolves
known provider and task names locally, with original identifiers in tooltips.

### Sidebar operation progress

Sidebar operation progress and results stay visible until dismissed or replaced
by a later operation, rather than expiring while work is still running. The
compact notice has a keyboard-accessible Dismiss action. Export files remain in
downloads and hand-off documents remain in the dock; this single latest-result
surface is not a notification history or queue.

### Command palette and agent-page strip

The command palette groups results and shows a shortcut badge when a row maps to a user-bindable chord.

The Project browser's agent-page strip is one `OctantTabs` rail whose tabs hold
two lines (the page, then the thread that owns it, with an "Agent active"
badge). In a narrow dock it wraps onto further rows rather than scrolling, so
no tab hides past an edge.

### Code editor and terminal scrollbars

The code editor and the terminal draw their scrollbars as elements of their
own, out of reach of that rule, and are set to the same picture through each
library's own options and theme colours: a thumb 6px wide with round ends,
standing 2px in from the edge, in the strong border role. The role travels
through the editor and terminal projections, so both modes and a custom
theme reach it.
Nothing else is painted at the edge: no track, no shadow where the text has
scrolled, no outline or cursor mark on the editor's ruler, and no strip
beside a comparison for a map of its changes. The editor's ruler still marks
errors and search matches under the thumb. Where the system floats
scrollbars the thumb shows while the surface scrolls or the pointer is over
it and hides at rest; where the system keeps a strip for them the editor's
thumb stays for as long as its text overflows. Three things still differ
from a pane, because neither library has an option for them. The thumb
cannot widen under the pointer as a floating system thumb does, so it takes
the strong divider role there and while it is dragged. The terminal's thumb
hides at rest even where the system keeps scrollbars on screen. And the
terminal keeps its engine's 14px lane clear of text, where a pane's text
runs under a floating thumb: the one option that narrows that lane stops the
terminal opening where a canvas is refused. A fourth is not built: under
forced colours a pane's scrollbar falls back to the system's, and theirs
keeps the theme's roles. The measurements are in
`apps/web/src/code/scrollbarTreatment.ts`; the two rules that shape the
thumb where no option exists are in `styles/code.css` and name the library
classes they hold on.

### Terminal keyboard exit

A surface that takes Tab and Escape for its own use is never a keyboard trap.
The terminal sends every key to its shell, so it has one documented way out:
`Mod+Escape` moves focus to the next control and `Mod+Shift+Escape` to the
previous one (Command on Apple hardware, Control elsewhere), sending nothing
to the shell, and both are remappable under Settings › Keyboard shortcuts.
Chosen because a shell reads a bare Escape and Control letters but nothing
distinctive from a modified Escape, Command chords never reach a shell on
Apple hardware, and no application-menu accelerator claims it; Windows and
KDE take Control+Escape and Control+Shift+Escape for the OS, which is why the
chord can be rebound. The terminal draws the chord in a muted line under its
output only while it holds the keyboard (the row keeps its height, so
focusing never moves the output) and always lists it in the terminal's
accessible description. Tab, Shift+Tab, a bare Escape and function keys still
reach the shell.

### Quitting

- The macOS status menu always offers **Fully quit Octant**. Ordinary Quit and
  Fully quit share one guarded shutdown: refresh current host activity, ask for
  confirmation when provider sessions remain open or the desktop cannot confirm
  what the host is running, then stop only the
  desktop-owned host and its child resources. Cancellation leaves both app and
  host running. The session count can include idle sessions kept for another turn;
  the warning names open sessions without claiming they are executing turns.
  When this host is in a hub and another member can take one of its threads,
  the confirmation adds **Move threads first…**, which opens Prepare to shut
  down (above) instead of quitting; Cancel stays the default.
  Once the person confirms, quitting never waits on a person: a
  failed or stalled window-state save or host stop is logged rather than shown
  in an alert, and a fixed deadline ends the app (after force-stopping the
  managed server) if shutdown has not finished.
- The **⌘Q keyboard shortcut** needs a second press within 1.5 seconds while
  the setting "Press ⌘Q twice to quit" is on, which is its default; with it
  off, one press enters the guarded shutdown (maintainer request, 2026-11-12).
  The switch is in Settings › General under Quitting, shown only in the Mac
  app; the app starts guarded and learns the choice when settings load. The
  first press quits nothing and shows a short "Press ⌘Q again to quit Octant"
  toast in the focused window; the second enters the guarded shutdown above
  unchanged, including its session confirmation. With no window open, the first
  press quits directly. Choosing Quit with the pointer (app menu, Dock, status
  menu's Fully quit), OS shutdown or logout, updater restarts and signals stay
  immediate. A menu accelerator cannot tell a held key from a tap, so a
  double press stands in for hold-to-quit.
