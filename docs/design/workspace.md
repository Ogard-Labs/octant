# Workspace behavior

This is the current specification for workspace navigation, pane contents, and
tool presentation. [Architecture](../architecture.md) owns server, provider,
persistence, and authority boundaries; [DESIGN.md](../../DESIGN.md) owns appearance.
Update this specification with an approved behavior change, following the
[design workflow](README.md#changing-the-design).

Historical links explain rationale; their old status or placement rules do not
override this specification. The specification describes existing behavior.
Unfinished plugin extraction and other proposals are separate from these rules.

## Continuing after a restart

Status: Done (2026-10-28). Approved by Henrik on 2026-10-28.

A conversation whose turn was cut off by a host restart shows a notice above
its composer: "Octant restarted before this turn finished. Review any changes
before continuing." Its **Resume** button explicitly submits one continuation
in the same thread. Completed turns, deliberate stops, and a lost renderer
connection alone do not show it. Nothing continues automatically.

The server tracks turn start and settlement for every provider through the
existing session journal; routing and advisor behavior remain provider-specific.
Resume checks current window/thread authority, provider availability, and the
Project or checkout before expiring dead approvals/questions. It queues a
host-written request to inspect saved progress and continue the unfinished
request, using the ordinary mode admission and native-session restoration.
Neither the composer draft nor its attachment selections change.

The persisted queue identity is derived from the interrupted session's recovery
identity, so concurrent windows, repeated clicks, and a lost response cannot
queue a second continuation. Existing unrelated queued messages must be reviewed
and removed before this action can queue the continuation;
Resume never unpauses its other messages. A refused recovery leaves the notice
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

## Navigation and Projects

The window is mode-first: a persistent left sidebar with the Work and Code
icon buttons (Work presents the Chat and Work domains together; see
[architecture](../architecture.md#modes-chat-work-and-code)), optional count tiles, mode-aware destinations, Projects and
threads, and settings (the sidebar's anatomy is in [DESIGN.md](../../DESIGN.md#shell-and-layout)); an
integrated borderless top chrome; a central workspace; and an optional right
dock. Mode changes alter content, authority, default composition, and density,
never the navigation grammar. See [decisions/0015-workspace-shell-model.md](../decisions/0015-workspace-shell-model.md).

Projects opens its searchable directory in the main workspace. Selecting a Project
replaces that directory with the Project overview; Projects in primary navigation
returns to the directory. Neither view adds a second sidebar. Other destinations
replace the directory while preserving the underlying Project selection.
Work's sidebar lists Chat and Work Projects only. When it has none and Code
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
**No project**, never both. No project is a collapsible folder row following
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
each. A thread appears once, under the first heading that holds it. A mode
with no threads at all shows a short first-run note in Status and the Activity
feed instead of an empty list: "No threads yet" in the secondary ink, then
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
journaling the ordinary thread update as the `system` actor. It archives only;
see [decisions/0088-completed-and-snoozed-threads.md](../decisions/0088-completed-and-snoozed-threads.md).

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
Thread titles appear once in the title row, and the row shows the thread's
current title: a pane stores the title the thread had when it opened, so the
shell reads the title from the navigation rows instead, and a rename made in
any window reaches every open pane. A thread pane's title row is its
drag handle: an environment mark (a small neutral tile holding a laptop glyph
when the thread runs on this computer, a cloud glyph and the host's name when
it runs on another host), then a breadcrumb: the Project in meta text, a slash,
and the title. The Project keeps its width (capped at a fixed character count,
not a share of the header) and the title truncates first (it shrinks much
faster, with no fixed floor so a narrow pane keeps its status pill); without a
Project the breadcrumb is the title alone. A header narrower than 520px (a
pane in a split) drops the Project step too and names it in the title's
tooltip, so the title is read whole instead of both steps being cut. The branch is not repeated here: it
is in the composer's strip, beside the thread it runs. While the host projects the thread as executing, a "Running" pill (a neutral wash, not the theme's tint) with
a spinner follows them; it carries no elapsed time because the host does not
report when the turn began. A thread whose turn is parked on the agent's own
approval, or on a question the turn asked, is not running: the pill reads
"Needs you", with no spinner, until someone decides or answers. A surface that is not a thread shows no environment mark.
With content tabs open the bar holds the drag handle and the tabs alone: the
Project and the Running or Needs you pill leave it. A Project name ahead of
the tabs read as one more tab, so it moves into the handle's tooltip ("Project
· Drag to move or split"), and the composer's strip still names it; each tab
carries its own thread's state, a spinner in place of its provider mark while
it runs and a small warning dot after its title while it waits on the person.
At phone width (680px and below) the title row drops both chips so the title
stays readable; the composer's context strip below the thread names the
Project and branch there.
The model stays in the composer, not the title row. The tile holds its glyph
so a later per-environment icon can replace it in place. Tab
geometry and close-control presentation are shared with dock tools under
[Content tabs](../../DESIGN.md#content-tabs).

These tabs add no persisted layout or authority; see
[decision 0156](../decisions/0156-content-opens-beside-the-conversation.md).

**Opening into tabs.** A single click on a sidebar thread opens it in the
active pane in place: it takes over the pane's open tab unless that tab was
kept, so browsing threads does not grow the tab row. A double click keeps the
thread as a tab of its own, and so does a later double click on its tab; a
kept tab stays when another thread opens in the pane, which then opens beside
it as a new tab. A tab opened from anywhere else (a link, a search result, a
drop) is kept.

**Moving tabs and showing them side by side.** A tab drags the way a pane's
title row does, through the same drop rules: dropped on another pane's edge it
splits that pane and opens there, dropped on a pane's centre it opens in that
pane, and a tab that is not the pane's open one may split its own pane, so a
tab dragged to its pane's right edge lands beside the open thread. A tab that
moved out of a pane leaves that pane's tab row. ⌘-click (Ctrl-click off Apple
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
or a valid launchable tool. A new Code task's pane, before its thread exists, keeps
the dock: its title band shows the common tools disabled ("Available once the task
starts") and its body says so, so the band does not vanish and return around the
first message. Once that start screen has a Project, the dock's body holds the
Project's quick tools (Terminal and Browser) instead of a second column beside
it ([DESIGN.md](../../DESIGN.md#welcome-and-composer)). An available empty dock opens on a stack of fact cards (Environment with
the local window's Remote access switch, Local servers, Context, Changes,
Outputs, Background tasks, Running now; see [DESIGN.md](../../DESIGN.md#shell-and-layout));
its title band offers the common tools, Add tool lists the rest, and an open
dock shows a tool strip. Direct tools are Side Chat, Browser, Files,
Document, Canvas, artifact-gated Plan, conditional Delivery, Review, Terminal,
Tests, Run and debug ([language services](language-services.md#debugger-panel-rules)),
iOS Simulator, Android emulator, and Desktop, as mode and capability allow. Chat
admits only the [Agents dock](#subagents) and has no bottom panel. Side
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
an ordinary answer (see
[decisions/0080-hand-off-writes-a-canvas-from-the-export-cut.md](../decisions/0080-hand-off-writes-a-canvas-from-the-export-cut.md)). The dock follows the active
pane's thread and Project, restores that subject's open tools, and presents an
explicit unavailable state when the newly active pane cannot describe the
selected tool — never the previous pane's content. Hiding a Browser or Terminal
tool does not stop its server-owned lifecycle. Restoring a Terminal tab may
reattach to an existing process, but a saved layout is not permission to start
a new shell. When no process remains, the tab offers **Start terminal**.
Explicitly opening or selecting the tab in the current window session also
requests a shell. The host still checks the thread's checkout and authority;
Plan cannot start or stop terminals. Restored transcripts never replay commands.
A terminal never traps the keyboard: it sends Tab, Escape and function keys to its shell, so `Mod+Escape` (next control) and `Mod+Shift+Escape` (previous) move focus out without sending anything, the pane names the chord while it has focus, and the rule is recorded in [DESIGN.md](../../DESIGN.md#accessibility-and-reliability). While an agent's Browser
session is live and the thread's Browser is out of sight, a small live preview
of its active page floats over the thread as a small preview (sized by `.browser-pip`), resting in one of
the four corners of the thread frame (top right by default), draggable between
them with an arrow-key twin, and remembered per client. Out of sight means no
pane shows the thread's shared Browser and neither the dock nor the bottom panel
has it as its active tool (a tab bound to one link or local server is a page of
its own and does not count); the preview leaves as soon as the Browser appears and returns
when it closes. Clicking it shows the Browser (the dock when the thread is the
dock's subject, else the pane), the close control hides it for that session, and
the page's title or host shows only under the pointer or focus. A bottom corner
rests above the composer by measuring it; the preview ranks below the window
chrome. It holds a skeleton at the page's aspect ratio until the
first frame and never prints status prose. It reads the same host snapshot the
Browser pane reads, asks for a fresh picture only while it is on screen, pauses
with the window, and backs off while the page does not change. Computer Use keeps
its separate card. **Browser start.** A Browser with no page opens on an empty
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
the control at the left of the address field; the toolbar's puzzle-piece button
lists the profile's enabled extensions. The rules are in
[Browser profiles and extensions](browser-profiles.md). **Browser captures.** The Browser pane toolbar has a
Screenshot button (a camera icon beside Open in default browser) that keeps the
page's picture with the thread, and a thread that kept screenshots shows a
_Browser captures_ strip in its transcript beside the generated images. The
rules are in [Browser captures](browser-captures.md). The iOS Simulator and Android emulator are separate device destinations. An
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
Dock visibility and responsive presentation follow [DESIGN.md](../../DESIGN.md#shell-and-layout).

### Subagents

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
keeps completed history reachable. Chat admits Agents as its only dock tool;
opening it does not expose Work or Code tools or the bottom panel. Provider-observed children carry an explicit
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
hierarchy across modes for the threads this window holds (the thread in each mode's panes, pinned ones included), because the host
authorizes a parent's runs only to a window whose workspace contains that thread on the matching Project; on a wide window it can draw the current query as a
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
Chat has no board. A person marks a Work thread Done with **Mark done** in the
task's Task actions menu, after a confirmation, and the card moves to Done and
stays there; a Code thread reaches Done only by its objectively satisfied
delivery target
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
host restart and is cleared when GitHub authority is revoked (see
[decisions/0064-pull-request-observation-cadence.md](../decisions/0064-pull-request-observation-cadence.md)
and
[decisions/0076-pull-request-snapshot-survives-restart.md](../decisions/0076-pull-request-snapshot-survives-restart.md)).

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
quiet stats line states what the thread used: its turns, input and output tokens,
thinking tokens when reported, the cache hit, output speed, time to first token, and
cost. The provider's account limit windows stand in the strip above the box, right of
the thread's context, one bar per window showing the share left; the stats line's
switch hides the figures, not those bars
(`composerLimitWindows` in `apps/web/src/context`, read from the context snapshot and
falling back to the Code thread's own report). A provider that reported neither windows
nor usage shows no line. In a split workspace the line shows in the active pane only: the
figures and limits come from one shell-wide scope, so an inactive pane shows no line rather
than another thread's numbers. It reads the host's recorded
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
