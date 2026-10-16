# Start screen

This is the detailed specification for what a Chat, Work, or Code start screen
shows around its composer: the action tiles, the New task and Running tabs, the
card area, and Code's agent home. The rule set a contributor needs first is in
[Workspace: start-screen cards](workspace.md#start-screen-cards); the greeting
and the composer are in [DESIGN.md](../../DESIGN.md#welcome-and-composer).
Update this specification with an approved change, following the
[design workflow](README.md#changing-the-design).

## Presentation

### Action tiles

Under the composer, Work and Code start screens offer a row of action tiles and
then the card area (Chat's start screens carry the card area alone), both on the composer's measure and ahead of Code's prompt
suggestions, so a running thread is never under the fold. The tiles are
always a three-column grid, one column under 560px, so one or two tiles keep a
tile's width instead of stretching across the row; a detail line wraps to a
second line before it is cut. A tile is a card
button: a 36px icon square, the action as a row label, and one detail line.
Code offers **Add a folder** (Bind a repository as a Project), **Open
terminal** (A shell on this computer, in Octant) once a Project is selected,
and **Review N changes** (Finished threads that wait for you) when N is above
zero, where N counts unread threads that are not running or rested, the
sidebar's To review rule. Open terminal starts a Project terminal and pins it in
Zen, the only place one lives. Work offers the same tiles without a terminal,
because Work has no shell. Review opens the Review page. The tiles leave when they
have nothing to show.

### New task and Running tabs

Above the composer, the two start-screen tabs (**New task**, **Running** with
the sidebar's count as tabular meta text) use the plain-text underline tabs
(`surface-tabs`) on the composer's top-left edge. They never wrap, and the
selected tab is carried by ink and the underline, with no fill or hue. The
Running tab's body is one hairline-ringed list on the card fill: each row is the
Working now row face with **Open** and **Stop** ghost buttons at the extra-small
step, and the stop question takes its own line under the row with a destructive
**Stop** and a ghost **Keep running**. See [Running tab](#running-tab) for
behavior.

### Card area

The card area is a ghost **Customize** button right-aligned under the tiles
(icon at the 14px step and the label), then a grid of cards, two columns and one
under 560px. A card uses the card recipe (`OctantCard`: hairline ring, no
shadow, the card fill) at a compact 12px rhythm. Its header is an icon at the
16px step in secondary ink, the title as a section label, and a count as
tabular meta text; its body is rows or one quiet line in the detail step. No
card has a hue of its own: the default theme stays monochrome, and a state is
carried by wording and weight. A row is a bare card-shaped button whose face
fills at 5% ink on hover and focus, the provider mark and a row label on its
first line, and a mono meta line for what is happening. The Customize panel is a
popover at most 340px wide: one row per card with a drag grip, the icon, the
title, up and down icon buttons, and a switch, then **Reset to default**; a
dragged row marks its drop target with a hairline above it. **Needs you**
comes first and leaves the grid while nothing waits: each row is the provider
mark (or the mode's glyph), the thread title, "Waiting 4m" with a pause glyph
at the 12px step, the Project as meta text, and the request text clamped to two
lines, with small buttons below (Approve filled, Deny ghost; a question's
choices as outline buttons with a leading number, then a ghost Reply…; a
decision's options the same way, the recommended one first with a trailing
"Recommended" in meta text rather than a hue). Rows
are told apart by a hairline, never a tinted fill, and the waiting state is a
glyph and words with no hue. **Working now**
lists up to five rows of threads and agent runs in progress, each with the
provider mark, the title, a time, and a one-line step; it says "Nothing is
running right now." when empty. A running tool is shown in mono
(`Command: bun run test`); a turn waiting on the person is plain prose. A turn's
time says "Running 12m" from the start time the host reports, and "Active 4m
ago" only for a host that reports none; a fact the host does not report is left
out rather than invented. **Pull requests** lists up to six rows on a Code
start screen, in Waiting on your review and Yours. Each row is the title, a
short repository and number, and the words for checks and review — never
colour alone. It is absent when that read is not allowed. It never says
"Nothing is waiting on you." for a list it has not seen: a failed read says it
could not read, and until a refresh has reached every connected Project the
quiet line says so, with an **Open Pull requests** link under it. A snapshot
whose latest refresh failed carries its age as meta text. **CI failures**
lists up to five failing checks from that same read, the check name, the
repository or branch, and how long ago it failed. It is absent when nothing is
failing, and absent when that read is not allowed. **Start a fix** opens a
draft; it does not send. Under the Vivid style the tiles'
icon squares take the blue, orange, and purple palette hues. Code's five prompt
suggestions are one compact row of label-only chips under the cards, and
Work's Write, Learn, Plan, and Explore starters use the same chip (the outline
button: hairline, resting fill, hover and focus fill); the prompt rides as the
chip's tooltip and description and fills the composer when chosen, nothing more.

### Code agent home

Under the Code composer the start screen is an agent home rather than a
blank prompt: the suggested prompts as one row of label-only outline chips
(see [Card area](#card-area)); then
three sections that share one card grid (Continue's rows share one card), two
across at the composer's width. Each card opens with a badge naming what it
is (Issue, Pull request, Review requested, Linear, or a thread's delivery
state: Running, PR #n, Merged, Done, Waiting), the repository or identifier
in mono, and the age at the trailing edge; then the title and one line of
facts. Up next holds what is in flight for the person (review requests,
their own open pull requests, assigned GitHub issues, assigned Linear
issues), each badge naming why it is there, and says "You're all caught up"
in a panel when empty, with Open Inbox at the section's trailing edge. Start
something new holds open GitHub and Linear issues nobody has picked up, with
Browse all issues beside it. Continue holds the latest Board cards: the badge
is the thread's own state (Running, Done, Waiting, In progress, Ready) with
changed lines, and the facts line names the Project, the branch (marked
worktree when managed), the linked pull request with its number and state as
a chip, and the provider last. Picking an item fills the prompt and attaches
the issue as the thread's Create from context.

## Card area behavior

Under the composer, every start screen carries a card area: Chat, Work, and
Code, in each variant a mode has, including the Chat screen that also lists the
threads to continue. It is the same area with the same stored setting on all of
them; Chat has no folder tiles. The area is a **Customize** control on the
right, then cards in a grid (two columns, one at phone width). The composer paints first; the area mounts on the frame after the
first commit, and each card begins its reads only then, so a start screen never
waits on a card. A card that is off or unavailable is never mounted and reads
nothing.

### Card registry

The cards come from a small renderer registry (`apps/web/src/home`). A card is a
value: `id`, `title`, `icon`, `defaultOn`, `available`, an optional
`hideWhenEmpty`, one `emptyLabel`, and a `useContent` hook returning `loading`
or `ready` with a count and a body. A `ready` result may replace the empty line
for a card that could not look, and may add one link after it. The shell builds the list and hands it to the
frame, which knows nothing about any card: a new card is a new definition, with
no change to the frame, Customize, or the stored setting. `available: false`
(no GitHub connection, insecure token storage, no client in this window) hides
the card and leaves it out of Customize rather than showing it broken;
`hideWhenEmpty` drops the card from the grid while it has nothing to say. A
card that is empty otherwise shows one quiet line and never fake rows. A lone
card spans the row.

### Customize

Customize is a small panel: one switch per available card, a drag handle, and up
and down buttons for the keyboard, with each change stored at once, and **Reset
to default**. The choice is the `homeCards` shell setting: `order` (card ids in
the requested order; cards it does not name follow in registry order) and
`visibility` (an entry only where the person moved away from a card's default,
so a card shipped later arrives with its own default). Ids are an open
vocabulary: an id the registry does not know is ignored, and adding a card never
changes the contract. A store from before the cards decodes to the defaults.

## Cards

### Needs you

**Needs you** is the card before Working now, on by default. It lists the
approvals and questions a provider is waiting on, and the decisions finished
Work and Code turns asked, from one host list of everything this window can
answer across Chat, Work, and Code and across Projects, oldest waiting first. Work's start screen shows Chat and Work
requests, Code's shows Code's. A row (`PendingRequestRow`, reused by other
surfaces) shows the provider mark when the shell knows the thread's provider and
its mode's glyph when it does not, the thread title (which opens the thread),
the Project, how long it has waited (minute resolution from the shell's
once-a-minute clock), and the text clamped to two lines. An approval offers
**Approve** and **Deny**. A question offers one numbered button per choice (the
matching number key picks it while the row has focus) and **Reply…**, which
opens the thread so the answer is typed in its composer; a question without
choices offers Reply… alone. A decision is the ask a finished turn closed with:
its row shows the ask clamped to two lines, one numbered button per option with
the recommended option first (first number, first in focus order) and marked
"Recommended" in words, and **Reply…**. A subagent waiting on an approval or question is a row too, headed "Research
subagent needs your approval" or "Review subagent asked a question" (the
child's role), under the parent thread's title, with the child's task and the
request text. It has one action, **Review request**, which opens the parent
thread on its Agents tab with that child selected; it offers no Approve, Deny,
or choices, so the answer is given in the child's own detail view. If the window's thread list does not hold the parent yet, it reads the list once more and, when the parent is still missing, says it could not open the thread rather than doing nothing. Chat has no
Agents tab, so a Chat subagent is never listed. At most five rows show, then **+N more**, which
opens the Inbox. The card is hidden while nothing waits, and unavailable where
this window has no reader (a remote window).

The card holds no authority. An answer goes through the mode's own command with
the handle the host listed, the same calls the open thread makes; a provider
input response is kept as evidence first. A decision's option is the thread's
ordinary next turn: its words go through the mode's own send command, kept as
prompt evidence, with the authority the composer has in this window. An option
is words, never an action: "merge it" is sent to the agent and merges nothing.
The commands each mode uses are listed in
[Host reads and commands](host-reads-and-commands.md#answering-a-waiting-request).
After an answer the card re-reads and the row leaves with the next read.
A refused answer (a stale version, a turn that ended, a turn that cannot take
it, such as one in Plan mode, an unreachable host) shows one quiet line in the
row saying why, and then the card re-reads; a row the host no longer lists stays
until the next read or the next minute so the line can be seen. A Code answer
the provider received counts as answered even when the host then stopped the
turn; which Code results count as refused is in
[Host reads and commands](host-reads-and-commands.md#answering-a-waiting-request).
The command palette and the open Code thread read Code answers the same way,
and the open thread keeps a refused request and adds the host's reason to its
waiting line.
The card reads the list when it mounts, on the Machine change feed's Chat,
Work, and Code navigation topics, and when the shell settings or the window
workspace change (neither has a feed topic). Signals that arrive while a read
is in flight become one more read once it lands, so a streaming reply does not
start a host read per delta.

### Working now

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
adds no timer, and a window sees only what its own authority returns. Working
now, the Running tab, and the Computers card share that one read: at most one is
in flight, and the changes that arrive meanwhile (a streaming Chat reply moves
the thread lists on every delta) become one more read once it lands. The turn
start and step ride on the same navigation rows as the executing flag (see
[Architecture: persistence](../architecture.md#persistence), fast thread
reads), so a remote window sees them for exactly the threads it can already
list.

### Running services

**Running services** follows Working now, on by default. It lists the dev servers
and other listeners running in the host's Code Projects: the Code Environment's
Local servers read host-wide, across every active Code Project the Project
bootstrap lists, which today does not vary by window (see
[Architecture: security and authority](../architecture.md#security-and-authority),
Local servers and Running services). A row is the server's name (its framework,
else its runtime) and port, the Project and the branch or thread it belongs to,
its health with a glyph and a word ("Listening", "Not responding", "Not
checked"; never a colour), and the host's name only when the window is reading a
computer that is not this one. A server Octant owns says nothing more; any other
says **Not owned by Octant**. Such a server is listed only while nothing names
another editor as its starter, which does not show who did: one an earlier
Octant session left behind looks the same as one started in Terminal, by Claude
Code, or by Codex, so neither the row nor its Stop confirmation says Octant
started it. Each row
has **Open** and **Stop**. Open places the page the host prepared: as a Browser
tab of the thread whose own worktree the server runs in, otherwise in this
computer's own browser, and only there, so a window reading another computer
never opens that computer's loopback address on its own. In the desktop app,
a window whose Environments filter is narrowed to one connected paired
computer lists that computer's services instead, names it, and offers an
Octant-owned, listening server in a thread **Open** and **Open in browser**,
which show the page live on this computer (see
[Architecture: security and authority](../architecture.md#security-and-authority),
Forwarder and signer on the device); any other row there says in one line
why it opens only on that computer, and a refusal shows on the row. While that
computer is not connected, the card says it cannot check it rather than
listing this computer's servers under its name. Stop is the
Environment's authorized stop unchanged: a server Octant owns stops at once, one
it does not own asks for the same confirmation naming process, folder, and port,
and a Stop the host will not offer (a server in a Plan thread's own worktree, a
server Octant does not own from a paired device) is explained in a line with no
control. A server in the Project folder itself is no one thread's, so it is
judged as the person's own, approval-gated, even when a Plan thread works in
that folder. At most five rows show, then
**+N more listening**. The card reads when it mounts and then every five
seconds, the Environment panel's cadence, and only while the window is visible;
a card that is off, or a start screen that is not showing, scans nothing. When
the host cannot scan, the card says it could not check rather than that nothing
is running, and a refused refresh keeps the last listing. A window with no Code
Project sees an empty card.

### Pull requests

**Pull requests** follows Running services, on by default, and only on a Code
start screen. It is hidden — and left out of Customize — unless the Pull requests
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

The card says "Nothing is waiting on you." only when the read succeeded and a
refresh has reached every connected Project. The snapshot moves only on an
explicit refresh or a Project's opt-in cadence, which is off by default, so a
host that has never refreshed has not looked. A read that fails or is refused
says "Octant could not read pull requests." A snapshot no refresh has reached
says "Pull requests have not been checked yet.", and one where some connected
Project was never refreshed says "Some Projects have not been checked yet.";
both offer **Open Pull requests**, where the refresh is. When the latest
refresh failed, the snapshot is as old as the last one that succeeded, and the
card says so from the snapshot's own freshness: "Last checked 3h ago." under
the rows, or "Nothing was waiting on you when checked 3h ago." Pull requests
and CI failures share one read of the snapshot when they mount together.

### CI failures

**CI failures** follows Pull requests, on by default, and only on a Code start
screen. It uses the same gate as Pull requests: no connection, insecure token
storage, or a missing pull-request capability hides it and leaves it out of
Customize. It lists failing checks the pull-request refresh already recorded,
on the signed-in person's open pull requests and on the current branches of
Code Projects. A current branch is the branch of an active thread's available
checkout; the card does not observe checkouts itself. A pull request from a fork
(the list read's `isCrossRepository`) never matches a current branch: its head
branch is a branch of the fork, whatever its name. A failing check that is
neither is left out. A row shows the check name, the repository and number
when the pull request is the person's (`repo#12`) or the branch when it is
only a current checkout, and how long ago the check finished failing. The
refresh's rollup carries the name and the finish time; it does not carry a
log, so a row never invents one. At most five rows show, most recently failed
first. The card hides when it has nothing to show — there is no empty line —
which is its default. **Start a fix** opens a new Code task draft in that
Project with the failing branch as its chosen base branch and a new worktree as
its workspace, since the current checkout may be on another branch; the
checkout's head does not replace that branch. The pull request, check, branch,
and repository are already written in; the rollup carries no failure text, so
the draft quotes none. Sending, switching the draft's Project, or starting a
new draft lets go of that branch, wherever the new draft is started: the
sidebar's New task, the command palette, thread search, or the menu bar's Start
new agent all start the same clean draft. A pull request from a fork offers no
Start a fix, since its branch is not in the Project. It does not start a turn; the person sends
it. Opening the card reads the same cached snapshot
Pull requests reads and adds no poll.

### Computers

**Computers** follows CI failures, on by default, on Chat, Work, and Code. It
leaves the grid while the only computer is this one and no agent is running
on it, including while that count is still landing, so a quiet start screen
does not open on host gauges. It comes back when a second computer is
connected or an agent is running. Customize still lists it. It lists every
host this window is connected to: this computer, paired remote hosts, devboxes,
and servers. A row names the host and says whether it is connected,
reconnecting, or offline — the word, not colour alone. A connected or
reconnecting host this window may read shows its core count, total memory, and
small monochrome bars for CPU, memory, and disk, each with a percentage. Disk
is left out when the volume could not be read. A host that is connected but
which this window has no authority to read shows as connected with no figures.
An offline host shows when it was last seen and no bars. A read that fails
drops that host's figures until a later read succeeds, rather than showing old
figures as current. The host this window was opened from reports how many
agents run there, and that count opens Running with the environment filter set
to the host; any other host does not report one, so its row shows no count.
At most four hosts show, then **+N more**. The card reads each host's load only
while it is mounted and the window is visible (not minimised, on another space,
or behind another tab), about every ten seconds, and stops when the window is
hidden; a window that is visible but not focused still reads. It never polls in
the background. A host whose last read has not answered is not asked again, a
read that takes longer than five seconds is abandoned and leaves that host
without figures, and leaving the start screen cancels the reads in flight.

## Running tab

Above the composer the same screens, the Chat screen that lists the threads to
continue among them, carry two tabs on its top-left edge, **New task** and
**Running**. New task is selected first and is the composer as
it was: the Running tab never takes the focus the composer takes on arrival. The
Running label carries the sidebar's own Running count for the current mode, read
from the same place as the tile (nothing is added at zero), so the two cannot
disagree; the list can run longer by an agent run whose thread is resting, which
the sidebar does not count either. The tabs are a tablist: Arrow keys move
between them, Enter or Space chooses, and Tab goes on to the composer. Choosing
Running hides the composer without unmounting it, so the draft, the chosen
Project, model, and attachments are all there when New task comes back; the list
mounts, and reads, only while it is open. It shows the Working now rows
without the five-row limit, compact, each with **Open** (the thread, as a Working
now row does) and **Stop**. A start screen has no thread open, and the
navigation rows carry no turn or attempt identity, so Stop sends the command its
mode already uses for the Stop control inside the thread (interrupt a Chat
attempt, cancel a Work turn, cancel a Code provider turn, or cancel an agent run
for a row that is only a run). A thread with no running turn is sent nothing;
how each mode tells is in
[Host reads and commands](host-reads-and-commands.md#stopping-from-the-running-tab).
It asks first, in the row: "Stop this turn?" ("Stop this agent run?"
on a row that is only a run) with **Stop** and **Keep running**, the safe
answer holding the focus. In every mode a turn that finished
meanwhile is reported ("Already finished.") and never cancelled twice, and a
host refusal shows in the row in the host's words. The tabs and list add no persisted state or authority.

## Needs you across surfaces

**Needs you** surfaces (a start-screen card, answering from Board cards, the
command palette, the Inbox, and the Review page for decisions) each read the same host list described with the Needs you
card above (the pending-requests read); each surface's own paragraph says when
it reads. Each item names its mode, Project, thread and title, kind, text,
options where the mode has them, and when it was asked, and carries the handle
that mode's own answer command takes, so a surface answers in place through the
commands the open thread already uses. An answered or ended request is gone
from the host's next list. The Inbox lists each decision, each waiting subagent, and each agent's own
harness approval as the same row (a decision answered in place, a subagent
request reviewed in its Agents tab, an approval reviewed in its thread, where
the approval card decides it), above its other waiting threads, and a thread
with a decision is not listed again as a finished turn, nor a thread with a
listed approval again as waiting for approval. The list is read at a local
window only, so a remote window has no Needs you source. What it includes and leaves out is in
[Architecture: pending requests across modes](../architecture.md#security-and-authority).
With every window closed, the desktop menu bar carries the same waiting threads
as its **Needs you** section, beside **Working** and **Done since you looked**;
a row opens the thread. It is described in
[Architecture: desktop menu bar](../architecture.md#desktop-menu-bar).

The command palette opens on a **Needs you** group when this window can read
that list. It has one row per waiting thread, titled with the thread and
detailed with its mode, what it waits on, and how long, and Enter opens the
thread (when every request on a thread is a subagent's, Enter opens that
child's Agents tab). A waiting subagent gets one **Review request** command and
no Approve or Deny; an agent's own approval is only its thread's row, which
opens the thread. Each approval also gets **Approve** and **Deny** commands, so typing
"approve" finds them; they answer through the mode's own approval command
without opening the thread,
and a refusal shows as a notice. A question's choices are not listed, so its row
opens the thread. A decision has one row (Enter opens the thread) and one
command per option, titled with the option's words and the thread, so typing an
option finds it; running one sends those words as the thread's next turn, the
same send the card makes. The palette reads the list each time it opens and never on a
timer. With nothing waiting, or at a remote window, the group is absent, and the
composer `/` list never carries it.

## Verification

- Card area, registry, and Customize: `apps/web/src/home/HomeDashboard.test.tsx`
  and `apps/web/src/home/homeCards.test.ts`.
- Each card: the `*Card.test.tsx` suite beside it in `apps/web/src/home/`, plus
  `workingNow.test.ts`, `pullRequests.test.ts`, and `ciFailures.test.ts`.
- Tabs and Stop: `apps/web/src/home/HomeComposerTabs.test.tsx`,
  `RunningTab.test.tsx`, and `stopRunningRow.test.ts`.
- Code agent home: `apps/web/src/code/CodeHome.test.tsx`.
- Render changed cards at desktop and phone width with and without data, and
  with the read refused.
