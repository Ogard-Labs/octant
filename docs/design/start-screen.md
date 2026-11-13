# Start screen

This is the detailed specification for what a Chat, Work, or Code start screen
shows around its composer: the card area and Code's agent home. The rule set a
contributor needs first is in
[Workspace: start-screen cards](workspace.md#start-screen-cards); the question
and the composer are in [DESIGN.md](../../DESIGN.md#composer-row).
Update this specification with an approved change, following the
[design workflow](README.md#changing-the-design).

## Optional capability card in Your first task

The existing first-run readiness view, **Your first task**, includes an optional
**Explore capabilities** card. It adds no setup step, progress count or readiness
requirement, and appears on no New task or Code Home surface by itself.

The card explains Browser, Computer use, helper agents and person memory. Browser
names tool-transport support from the selected model's current host observation,
including model-specific verification; it does not promise a future task's grants.
Computer use reports the existing host setting and desktop support/permission
facts when reported. Helper agents and memory read their current host settings.
Missing, refused or failed reads say Not reported instead of assuming a default.
The existing defaults remain unchanged.

Each capability is a compact disclosure row showing its current state, with a static, labelled example when expanded. Viewing it starts no provider call, agent, Browser, control session, driver installation or permission request. Reading status may start the bundled driver to check its actual grants when Computer use is enabled and macOS allows Octant.
**Review** links open the existing owning Settings surfaces, whose controls,
server checks and refusal handling own every change. Computer use additionally offers the same guided setup as Settings after the
person expands its row: Set up Computer use saves enablement and pending setup
through the existing settings command, then requests macOS permissions. It offers
separate Accessibility and Screen Recording shortcuts, Recheck and an explicitly
approved local test. A refused save requests no permissions. Pending setup resumes
in Your first task after relaunch, even if provider setup is incomplete. When
onboarding was already completed or skipped, the local desktop opens Computer
use Settings once on launch instead, preserving the onboarding outcome. Skip for
now clears pending setup without disabling Computer use; it remains optional for
starting a task. The state distinguishes enabled, permissions granted and verified
working. See [Computer use](../architecture.md#extensions-and-skills) for the
diagnostic's exact-window scope and lifecycle. A read-only surface omits those
links; paired clients have no first-run capability card, because those
permissions are granted on the host computer, and (not built yet) today they
acquire no local settings authority.
Installation, package trust, enablement and task access remain separate.

**Dismiss capability card** hides only this card for the current setup session.
It records no setting or first-run outcome. Skip setup and Start a task retain
their existing behavior and never depend on visiting or dismissing the card.
Returning from Settings rereads current host facts and preserves the first-task
draft. The card uses the shared card recipe, stacks at narrow widths and keeps
all actions keyboard accessible. Its explanatory memory copy never claims that
a host whose setting is off has memory on.

## Presentation

### Layout

There are two start screens. **New task**, in every mode, is the question in
the middle of the page and the composer docked at its foot, and nothing else;
Chat and Work add their starter chips only before the mode's first thread.
**Code Home** is where Code lands with nothing chosen (the Code welcome tab):
the question and the composer, then Code's prompt suggestions, the card area,
and [Code agent home](#code-agent-home). With those the page scrolls and the
composer sits under the question. Switching to Code opens no draft of its own,
and a New task draft left with no text or images counts as nothing chosen:
switching to Code gives its pane back to Code Home, while a draft with text
stays as New task. Neither screen has tabs or action tiles:
adding a folder lives in the composer's Project picker, a terminal in the
workspace tools, and what is running or waiting for review in the sidebar.

### Card area

The card area is a ghost **Customize** button right-aligned under the composer
(icon at the 14px step and the label), then a grid of cards, two columns and one
under 560px. The card area, the suggestions and everything below end on the
composer's own edges at every reading width, and cards in a row share the
row's height; a fixed narrower measure under a wide composer, with each card at
its own height, read as two unrelated ragged stacks. A card uses the glass card recipe (`OctantCard` `variant="glass"`: the glass
ring, no shadow, the composer's material; the opaque card fill under reduced
transparency) at a compact 12px rhythm. Its header is an icon at the
16px step in secondary ink, the title as a section label, and a count as
tabular meta text; its body is rows or one quiet line in the detail step. No
card has a hue of its own: a state is carried by wording and weight, and the
accent and status roles colour its marks as they do elsewhere. A row is a bare card-shaped button whose face
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
decision's options as full-width buttons with the recommended one first, a
trailing "Recommended" in meta text rather than a hue, and the option's detail
as a second meta line; a decision also shows its why as a meta paragraph under
the ask, an "Urgent" tag in the warning role beside the wait when the agent
marked it urgent, and an **Add note** control; when a second opinion exists, a meta line inside the recommended
option's button naming the asking model and, inside the option the reviewer backs, a line naming the
reviewer's model and its one-sentence reason, each led by a 12px provider mark, and a
"Second opinion differs" tag in the warning role beside Urgent when the two options differ).
Rows
are told apart by a hairline, never a tinted fill, and the waiting state is a
glyph and words with no hue. **Working now**
lists up to five rows of threads and agent runs in progress, each with the
provider mark, the title, a time, and a one-line step; like Needs you it leaves
the grid while nothing runs. A running tool is shown in mono
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
draft; it does not send. Code's five prompt
suggestions are one compact row of label-only chips directly under the composer
they fill in, above the cards (under the cards they were a screen away from
the box they act on), and
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

Under the composer, Code Home carries the card area; New task has none. The
area is a **Customize** control on the
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
its row shows the ask clamped to two lines and, when the agent gave one, the
why beneath it (clamped to three lines inside a card that already names the
thread, whole elsewhere). Each option is one full-width numbered button with the
recommended option first (first number, first in focus order) and marked
"Recommended" in words, and with its detail, when given, as a second line. An
"Urgent" tag beside the wait appears when the agent marked the decision urgent;
it is the agent's claim and changes no order. **Add note** (outside an embedding
card) reveals a short text field: picking an option while it has text sends the
option's words and the note, and Escape closes it; number keys type into the
field rather than pick. **Reply…** opens the thread. When the person has chosen a second-opinion
model (Settings › Providers & Models › Automatic model calls, off by default), a decision also
shows who asked and who reviewed: inside the recommended option's button, under its detail, a small muted line with the asking
thread's provider mark and model and "· asking thread", and inside the option the reviewer backs a
line with the reviewer's mark and model and "· Second opinion: " and its reason (both inside one
option when they agree, so each backer reads as part of the option it backs). A "Second opinion differs" tag sits beside Urgent when the reviewer backs
another option. While the review is queued one muted line under the options says "Getting a second
opinion…"; when none will come (the reviewer's answer could not be read, it read outside content,
or the Project does not allow the chosen provider) it says "No second opinion" with the reason as
its tooltip; with no model chosen, or while the chosen account cannot be asked, nothing shows.
Inside an embedding card these lines stay to one line each. The opinion is advice: it never picks
an option or changes the order. A decision can also be
deferred with the same controls as a question, so it drops below the active
requests until the chosen time or **Bring back now**. A subagent waiting on an approval or question is a row too, headed "Research
subagent needs your approval" or "Review subagent asked a question" (the
child's role), under the parent thread's title, with the child's task and the
request text. It has one action, **Review request**, which opens the parent
thread on its Agents tab with that child selected; it offers no Approve, Deny,
or choices, so the answer is given in the child's own detail view. The agent's
own harness approval ("needs your approval") and a Work agent's own question
("is waiting for your answer") are rows the same way, with the request text and
one action, **Review request**, which opens the thread, whose approval or
question card above the composer answers it. If the window's thread list does not hold the parent yet, it reads the list once more and, when the parent is still missing, says it could not open the thread rather than doing nothing. This pending-request projection lists Work and Code children only; Chat's
[Agents dock](workspace.md#subagents) does not extend that scope. At most five rows show, then **+N more**, which
opens the Inbox. The card is hidden while nothing waits, and unavailable where
this window has no reader (a remote window).

The card holds no authority. An answer goes through the mode's own command with
the handle the host listed, the same calls the open thread makes; a provider
input response is kept as evidence first. A decision's option is the thread's
ordinary next turn: its words, followed by the note when the person added one, go through the
mode's own send command, kept as prompt evidence, with the authority the
composer has in this window. An option
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
now and the Computers card share that one read: at most one is
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
Local servers and Running services). A row is two lines: the server's name (its
framework, else its runtime) and port with the Project and the branch or thread
it belongs to on the same line, cut from the end, then
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
and a Stop the host will not offer (a server in a Plan thread's own worktree,
today, a server Octant does not own from a paired device) is explained in a line
with no
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
with a listed approval is not listed again as waiting for approval. The Inbox
is a triage view: a line under its title reads "N waiting", with "· M urgent" in
the warning colour when any decision is marked urgent, and a single-choice group
of chips (**All**, **Urgent**, **Decide**, **Stuck**, **Finished**, each with its
count) narrows it. Urgent is the decisions marked urgent, Decide every decision,
Stuck every approval, question and waiting subagent, and Finished the threads
whose turn ended and wait for what is next. A chip with nothing stays in place
with a count of 0, and its list says so in one line. Only All also shows the
assigned GitHub and Linear work, and a due follow-up shows under All only. The
waiting items are grouped under their Project (a folder mark, the Project name,
its count, and "N urgent" when any), with waits that belong to no Project under
"No Project". A group holding an urgent item that is not deferred comes first, then the group that
has waited longest; inside a group urgent items lead, then the oldest, then
deferred ones, urgent or not. The choice lives in the open Inbox and is not remembered. A
finished turn is never counted by the Inbox's tile or the dock badge, and All
does not list it; it belongs to To review (the Finished chip is the one place the
Inbox lists it), and its one-shot banner is unchanged. The list is read at a local
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
no Approve or Deny; an agent's own approval, or a Work agent's own question,
is only its thread's row, which opens the thread. Each approval also gets **Approve** and **Deny** commands, so typing
"approve" finds them; they answer through the mode's own approval command
without opening the thread,
and a refusal shows as a notice. A question's choices are not listed, so its row
opens the thread. A decision has one row (Enter opens the thread) and one
command per option, titled with the option's words and the thread, so typing an
option finds it (its detail is part of the command's detail text, and there is
no note here); running one sends those words as the thread's next turn, the
same send the card makes. The palette reads the list each time it opens and never on a
timer. With nothing waiting, or at a remote window, the group is absent, and the
composer `/` list never carries it.

## Welcome screen

Chat, Work, and Code open on the same screen: one question in the middle of
the page and one raised composer docked at its foot, where it stays once the
thread starts, so the first message is typed where every later one is. Above
the question sits the Octant aperture mark (`icons.svg#aperture`) at 22px,
drawn in the primary ink and set 2px closer to the question than the
heading's usual gap. The hero asks "What are we building today?" (the hero
role: regular weight, -0.012em tracking, the primary ink in every style and
never the accent). The approved size is 24px on a 30px line; the type scale
has no 24px step and `ui:check` refuses a raw size, so the nearest token,
`--oct-text-2xl` (26px), carries it on the 30px line, and phone width uses 20px.
One quiet line under it, at the detail step in muted ink, says
"Pick a project, or just start typing". The start screen names no time of day
and counts nothing: what is running and what waits for review live in the
sidebar. Once a Code start screen has a Project chosen, its quick tools are
the Project's own Terminal and Browser (a server Project's Terminal only) as plain rows in the right dock's body,
above one muted line, "Other tools open once the task starts". They live only
in the dock: a column beside the start screen squeezed the composer off centre
and contradicted the dock, so with the dock closed the start screen stands
alone. Each opens in the dock without starting a thread, the same window-local
Project terminal and browser Zen uses, which no agent can see or reach;
"Quick tools" returns to the list, and closing the terminal (or leaving the
start screen) stops its shell, since nothing else could reopen it. The
composer never remounts when the Project is chosen, so the draft stays. Send
on a Code start screen with no Project chosen stays live and answers with one
card directly above the box, "Choose a Project first. A Code task works in a
folder.", rather than greying out with no reason. Every
start screen's composer asks "Ask anything…", and the message field keeps its
accessible name.

The question belongs to a new task only. When the same composer serves a
decision, such as reviewing a planner's proposal, the caller replaces the mark,
question, and quiet line with a heading that names the decision ("Review the
planner's proposal") and the proposal's title, set at the dialog's top-left with
the fixed proposal text directly under them in the composer. Rendered review
showed the question above a fixed proposal read as an invitation to write a
different task.

**New task**, in every mode, is the question and the composer and nothing
else; Chat and Work add one row of outline starter chips only before the
mode's first thread. **Code Home** is where Code lands with nothing chosen:
the same question and composer, then Code's prompt suggestions, the card area
(a **Customize** control and the cards, on by default), and Code's agent home
(Up next and Continue). There the page scrolls and the composer sits under
the question. The cards appear on no other start screen. Neither screen has
tabs or action tiles: adding a folder lives in the composer's Project picker. Their anatomy is in
[Start screen: presentation](#presentation); their
behavior is in [Workspace](workspace.md#start-screen-cards).

Chat, Work, and Code welcome composers share the composer's box (`--oct-radius-md`,
`--octant-shadow-md`) and one first-read hierarchy: one question, then the
composer. Starter actions appear only when recent work does not already give
the person a next step. In light the card is workspace white on the
`--octant-app-background` well, not the grey floating fill — that fill reads
as a sunken field. Code welcome keeps one stable question while Project and
Environment sit on the context row above the composer
(`.composer-tray--start`, rendered before the card inside `.composer-stack`),
on the page ground with no band chrome. The base-branch chip joins that row
once a Project is chosen. Environment is the
create-facing presentation of Octant's authoritative host federation: its
dropdown selects This computer, devbox, or another healthy capable host without
creating a second environment model. Every create composer shows Environment
only when more than one host is known. With one host there is nothing to
choose, so no Environment control or label appears. With several, an existing
Project's fixed host reads as a label instead of a dropdown. Workspace remains on that rear card after the three primary choices;
nothing about delivery is asked up front (see [Voice](../../DESIGN.md#voice)). The Project
control is one menu: saved Projects to search, then New Project from folder
and New Project from GitHub repository. Choosing GitHub swaps the menu's body
for the managed-clone flow in place, so there is no second repository control
beside the Project. Access is
a titled menu in the row under the prompt card, and carries the
"Remember for this Project" switch.

The Code start screen's agent home (suggested prompts, Up next, Start something
new, and Continue) is laid out in
[Start screen: Code agent home](#code-agent-home). The start screen has no image-generation control: a job needs a thread to
land in, and the Image generator surface serves everything else. Attaching an
image is a composer affordance and is available here.

## Usage-limit warning

**Usage-limit warning.** On a start screen, when the chosen account has a window
that is spent or at 80% used (the same levels the meters colour), a warning
callout takes the full row above the context chips, in the row above the
card: which account, that it has
reached or is close to its usage limit, and the reset time the provider gave.
For each other ready account that has room (an observed window below the near
level; an account with no observed window is never offered as having room) up to
three `Use <account>` buttons follow, each choosing that account and its model
(the current model when it lists it) exactly as the model menu would. Nothing
switches on its own and the warning never blocks sending: the provider's own
limit decides whether a turn runs. The model menu's rail lists accounts with
room first and the ones at their limit last, in the person's own order within
each, and marks a limited account with the danger dot and "Usage limit reached"
(a near one with the warning dot and "Near usage limit"); a readiness problem
takes the dot first.

## First run

First-run setup asks only what a first task needs — a usable provider, a
Project folder, a model, and the
[mode](../architecture.md#security-and-authority) new threads start in
(Auto pre-selected and marked Recommended, then Ask first, Accept edits, Plan,
and Full access, in that order; Full access reads "No sandbox, no prompts"
and is never pre-selected; Auto uses the provider's own reviewer or
[Octant Shield](../architecture.md#octant-shield), so it is listed for every
runtime, and where no reviewer can run the picker shows it unavailable with
the reason; the pick becomes the default for every new Work and Code thread
until changed in Settings › Work or Settings › Code, or for one Project) — and ends in one primary action, Start a task,
that opens the new-task composer in that Project. Setup also asks once whether
Octant may check for updates, and does not ask again whatever the answer
(maintainer request, 2026-11-12). The question is an Updates card on the
readiness view with one switch, Check for updates automatically, off until the
person turns it on; it is shown only in the desktop app, which is the only
window that updates anything, and the answer is the Automatic update checks
setting. Every step is optional from
the first one. Opening setup focuses the current step's heading so a long
provider list does not scroll past its introduction; Tab then reaches the
step's controls. Skipping preserves settled answers, waits for pending writes,
grants no authority, and creates no thread: provider, Project, model, and
permission readiness are checked again when work is requested. After Skip, or
in a later session with no ready instance, the New task composer in Work and
Code shows a primary **Set up a provider** action that opens Providers &
Models and returns to the same draft. The action leaves once any instance is
ready; the model picker takes its place. Profile,
appearance, the mode switches, and Navigator are not first-run steps: Profile
lives in Settings › General, Appearance in Settings › Look & feel, and
Navigator's models in a section of Settings › Octant Harness. No display name is inferred from the OS account. Continue retains
compact recent-task rows and their status and Git cues.
Empty Code entry offers folder setup and a direct route to Code settings; opening
that setting never turns on projectless threads.
A Work or Code pane with no thread and no Project asks one centred question
("Pick a folder to work in"), says in one sentence what choosing a folder
means, and offers Choose a folder… as the primary action with starting
without one beside it; once a Project exists the new task leads instead.

First run is a four-step wizard with a progress rail: Providers, Project, Model,
and Mode, in that order, followed by an uncounted readiness view titled Your first
task. Each step is pending, current, or completed: the current step is a filled
card, completed steps show a check, and pending steps show their number. The
Project step chooses the first task's mode (Work or Code; Code alone when Work
is off; Chat Projects have no folder and are not offered) and its folder with
`OctantToggleGroup`; Choose a folder… opens the same Project create surface as
the empty Work and Code pages, so making the folder a Git repository stays an
explicit choice there, and a folder created that way becomes the first task's
Project. The Model step writes to what a new task in that mode already starts
from: Work's default model in Work settings, and the composer's remembered
model for Code. The readiness view reports provider, Project, and model
separately; a missing fact opens its exact setup surface, and Start a task
appears only when all three hold. Its heading reads Ready to start only then and
otherwise names what is missing (Needs a provider and a model). Answers still write through to the settings
that own them. First run records its outcome only after every answer has landed. When
the host refused an answer, the first press of Skip setup or the primary action
says so in a warning notice and records nothing; the next press goes on without
that answer, so a refusing host can never leave the dialog impossible to leave.
A refused outcome is reported the same way and the dialog stays open.
The readiness view also offers an optional Explore capabilities card for Browser,
Computer use, helper agents and person memory. It reports current host settings,
uses labelled static examples and links to existing Settings controls. Computer use
shares the guided permission setup and working test from Settings, with saved
progress across relaunch. Setup is optional and never grants an agent app access. Dismissing
it changes no setting or readiness answer. It adds no step or progress count.
[Start screen](#optional-capability-card-in-your-first-task)
owns its behavior.

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
