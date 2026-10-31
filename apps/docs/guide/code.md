---
description: Code mode binds one folder for engineering work with approval-gated authority, worktrees, and Git tools.
---

# Code

Code is the repository workspace. Each Code Project binds exactly one folder chosen through the native picker; when that folder is a Git repository, worktrees, branches, and pull-request tools become available. Code is always available; disabling it in Settings never deletes existing Code data.

## Code Projects

Create a Code Project from the sidebar:

1. Select **Code** as the mode.
2. Use the native picker to choose a folder. A Git repository root is recommended but not required.
3. Name the Project.
4. When the chosen folder is not yet a Git repository, leave **Initialize as a Git repository** checked so Octant runs `git init` during create. Turn it off only if you want to bind without Git.

The server validates that the folder exists and the renderer receives an opaque receipt. If you create without initializing Git, Git-dependent features report _unavailable_ until you initialise one.

A Code Project can remember how new threads should start: in **this Project's current checkout**, or in **a managed worktree Octant creates**. The default is the current checkout, which creates no worktree the owner did not ask for. Set the habit from the Project overview; the composer still lets one thread override it without rewriting the Project. Desktop and phone both inherit that default, and the new thread shows which root it bound. A missing or unauthorized root fails closed instead of inventing a worktree.

## Actions

A Code Project can keep named commands such as Run, Test, or Dev. Open the
Project overview and choose **Actions**. Add a name, the command, and
optionally a folder inside the Project. Octant also looks in the Project's
`package.json` scripts and `Makefile` targets and offers them as suggestions;
nothing is saved until you add one and choose **Save actions**.

Each action becomes a button in the window header (the first three, with the
rest under **More**) and an entry in the command palette. Choosing it types the
command into the Project terminal and opens that terminal in Zen. It runs with
the same sandbox and approvals as anything else you type there. If the terminal
is already running a program, the command goes to that program, so stop it
first. Actions are set from this computer's window, not from a paired device.

## Quick tools on the start screen

Once you choose a Project on a Code start screen, **Terminal** and **Browser**
appear in the right sidebar. Open the sidebar to use them. They open the
Project's own terminal and browser right there, before any thread exists. No
agent can see or use either. **Quick tools** takes you back to the list;
closing the terminal stops its shell.

A Code task always works in a folder, so Send asks you to choose a Project
first. To talk without a folder, start a chat from the Work composer instead.

## Sending while a response is running

The composer stays open while a response is streaming. Press Enter and the
message is sent: it leaves the composer, joins the transcript at the end, and
runs as soon as the response in progress stops — nothing to release, discard,
or re-send by hand. A response that is cancelled or fails has also stopped, so
the message runs then too.

Only one message waits at a time. Anything typed after it stays in the
composer as an ordinary draft. If the host refuses the message, its words come
back to the composer — unless you have already typed something newer, which is
kept instead. The waiting message lives on this client only; a restart drops it
rather than sending it behind your back.

See [Continuing after a restart](/guide/work#continuing-after-a-restart) if Octant
stopped while the agent was working.

## Unsent drafts

New-task text stays with its mode and pane while you visit Settings or switch
modes in the same window session. Choosing another Project preserves that text;
an explicit New task starts over. This temporary text does not survive an app
restart.

Each Code thread keeps one unsent composer draft on this client. Leaving the
thread, switching tabs, or restarting the app restores the text and caret.
Sending or clearing the composer removes it. Mentions that are part of the
typed text persist; staged attachments and extra selections do not, and the
composer says so if they were dropped. Deleting or purging the thread removes
its draft.

## Modes

Each Code thread runs in one of five server-enforced modes. The mode picker
in the composer changes it in one click, for new and existing threads alike:

- **Auto**: the provider's own reviewer approves each action (Claude's auto
  mode, Codex's approval reviewer), inside the same sandbox as Ask first.
  What the reviewer escalates, and everything after the thread reads outside
  content, comes back to you. Providers without a reviewer show Auto
  unavailable with the reason, and a thread set to Auto asks first there.
- **Ask first**: confines work to the bound Project root. Octant's sandbox
  does this for most runtimes; Codex, and Claude outside Plan, rely on their
  own sandbox instead. Each mutation or command surfaces an approval request.
  Where it can be derived safely, the request names the file (relative to the
  checkout) or the command it is for; otherwise it names only the tool.
- **Accept edits**: the same confinement as Ask first, except file writes
  inside the bound root proceed without a prompt. Shell commands, network
  access, destructive actions, credential access, and anything outside the
  root still ask.
- **Plan**: strictly read-only. No write-approval path exists. On macOS,
  Claude in Plan can run read-only commands such as `git log`, `git diff`,
  `rg`, `ls`, and `cat` without asking: the sandbox lets it start only a
  short list of reading tools, refuses every write they try outside a
  scratch folder of its own, and gives them no network.
- **Full access**: no sandbox and no prompts, as in the providers' own apps.
  Agents can change any file and run any command without asking, so they can
  read your whole home folder, including SSH and cloud keys. Nothing asks,
  pushing, merging and publishing included; the agent does those because you
  asked in the thread, and every action is recorded. Outside content the
  agent read is tagged on the tool row and the thread card, never blocked.
  The first time this computer or a Project picks Full access, Octant shows
  that warning once.

New threads start in the default mode from first run or **Settings → Code →
Access**; a Project can choose its own under **Access and limits** in its
overview. Full access needs no confirmation from a window on this computer
and is remembered on the thread. A paired phone or browser can lower a
thread's mode but cannot raise one to Full access. A Work-to-Code promotion
always starts in Ask first, never inheriting Work authority. The transcript
records the mode each turn ran under.

## Long threads

A long Code thread opens on its newest turns, at the end, and follows new
output while you are there. **Load earlier messages** at the top adds the turns
before the oldest one shown; the turn you were reading stays where it is. In a
fork, once its own turns are all shown, Load earlier continues with the thread
it was forked from, starting at the reply you forked from. The usage and
context figures always cover the whole thread, and a restore's **Undo restore**
stays offered however far back the restore was. Find in page searches the turns
loaded so far. Export always covers the whole thread.

The phone app opens a Code thread on its newest 20 turns and says so when
earlier ones exist; it has no Load earlier, so read those on the desktop.
`octant agent` shows a Code thread's newest 50 turns, and its footer then
counts them as **newest 50 turns**.

In `octant agent`, Stop reports an interruption only when the host confirms it.
If the turn finishes before Stop arrives, it reports that nothing is running;
if the host refuses, the terminal shows the reason.

## Export

**Export…** downloads a portable JSON cut of this Code thread: the
conversation the host holds, Canvas artifacts it originated, and provenance
(provider, model, checkout identity, fork origin). The file says when it was
cut. Checkout paths, credentials, and raw provider payloads never appear.

## Plans

A Code thread's plan is a durable, ordered list of steps, not prose in the
transcript. Choose **Propose plan** beside the composer's attachment controls
to open the plan form. Write one step per line, with an optional reason after
an em dash, and press **Propose plan**. It appears
beside the transcript as well, so it stays in view while you read the thread.

The right dock's Plan tool appears only when this thread already has a current
plan artifact. The composer offers a new proposal when no current plan exists,
including after withdrawal; the dock does not
show an empty Propose plan form.

A plan starts **Proposed · not approved**. Nothing about it is work yet: the
host refuses to start, finish, or drop a step until the plan is approved.
**Approve plan** is that gesture and the only one — changing a thread's
authority mode says what the thread may do and never that its plan was agreed.
Approval records the exact wording you read, so rewriting the steps returns the
plan to proposed and asks for approval again. A step that survives a rewrite
keeps whatever was already done to it.

Once approved, the steps are the thread's task list: **Start**, **Finish**,
**Drop**, and **Reopen** each move one step, and the card counts how many are
done. **Withdraw** puts the plan aside so the thread can propose a different
one; the withdrawn wording stays in the recorded revisions.

Plans work under every authority mode, Plan mode included — deciding what to do
is exactly what a read-only thread is for. The host records the plan in its
journal, so it survives a restart.

Assistant replies in Code render as markdown, so a plan an agent writes out as a
heading and a numbered list reads as one. What you type stays exactly as typed.

## Turn actions

Fork, checkpoint, copy, and restoring files to a recorded point live in each
turn's **More actions** menu (the ⋯ control that appears when the turn is
hovered or focused). The same items are on the turn's context menu.

**Fork from here** starts a second thread on its own worktree and branch,
with the files exactly as they were when that reply finished — including
changes nobody committed — so the fork and this thread never write to the same
files. The fork starts approval-gated and carries this thread's provider,
model, and delivery outcome, not its access. Octant refuses a fork from a
reply that is still running, or from a point where it did not record the
files, and says which.

The fork's first message carries the conversation up to that reply, never the
replies after it. On the Octant Harness it continues the source's own session,
tool activity included. Otherwise, and whenever the fork runs on a different
provider, Octant hands over up to 23 recent messages as text, each labelled
with the provider and model that wrote it; hidden reasoning, tool activity and
the source's session stay behind. The fork's first reply says which happened
and what was left out. If no readable conversation is left to hand over,
Octant refuses to create the fork, or refuses its first message, and says why.

If this thread is marked as having read outside content, a fork or a restored
thread made from it starts marked too, because it carries the same
conversation. A thread whose mark you cleared makes an unmarked fork. Clear
the new thread's mark from its own notice like any other.

**Merge back to source** appears on a fork's own finished replies. It hands the
fork's conversation — its messages after the fork point, or after its previous
merge back, up to that reply — back to the thread it was forked from as text,
each message labelled with the provider and model that wrote it. Nothing runs
and nothing is asked: the source's next message carries the merged messages,
and that reply says how many came over, what was left out, and that hidden
reasoning, tool activity and the fork's file changes did not. Code still
reaches the source only through Git review. If the fork took in outside
content, the source is marked as having taken it in too. Octant refuses a
merge from a reply still running, a merge with nothing new since the last one,
and a merge into a thread this window cannot reach, and says which.

**Restore from here** starts a second thread at the marked checkpoint and
leaves this one untouched. The restored thread's sidebar row — and the Project
Overview list, which shares those rows — carries a fork mark, as does the
thread it came from. Open the mark to see the origin chain and any direct
forks and to switch to one of them. If the origin has been archived or
deleted, the lineage says the origin is no longer available rather than
hiding that the thread is a fork. **Restore files to this point** overwrites
the working tree in place: it is named separately, still asks for
confirmation, and still goes through the thread's approval path. Undo restore
stays on the thread after a successful overwrite. Octant refuses the restore,
and Undo restore, while another thread has a turn writing in the same
checkout, and names that thread when it is in the same Project. Wait for its
turn to finish or stop it, then restore; the Undo restore button stays after a
refusal. A restore is also refused while another restore of the same folder is
still running. A thread on its own worktree is not held up by other threads.

A checkpoint marker stays on the turn only when that point is marked.

## Attaching images

Paste or drop a PNG, JPEG, WebP, or GIF into the thread composer to send it with your next message. Each image uploads to the host as you attach it, and the turn sends only the identifier the host answered with, so the provider receives bytes the host itself accepted.

A turn carries at most eight images, each up to 10 MB, alongside a written message. Repository files do not need attaching — name them with `@file` instead. Type `@` to complete a path inside this checkout; the host refuses a path outside the bound root before reading it. If the thread's model does not read images, the composer says so at the paste — _"Local OpenCode — Model One does not support images. Choose a vision model to attach one."_ — instead of taking the upload. The host checks the thread's own model again at send, so a turn never reaches a model with its pictures quietly dropped.

Images stay readable in the transcript after a restart. Removing a chip before sending discards the image on the host too.

In the macOS desktop app, the paperclip opens a menu: **Choose file…** or **Capture window…**. Capture window lists your open windows by title and attaches a picture of the one you choose, as an image like any other. The first time, Octant explains why macOS needs Screen Recording permission and asks only when you press **Continue**; if you turned it off, Octant opens System Settings instead. Octant reads a window only after you choose it, and the picture goes only to the thread you attach it to. The web app and the phone app do not offer it.

## Thread environment

Each Code thread owns an Environment tab in the right dock. Open it from the
dock's tab strip or **Add tool**. The top names the repository, its branch, and
its folder. A card under it says whether the checkout has uncommitted changes
(click it to open Review) and offers **Commit or push** and **Create pull
request**. Below that, one list: local servers, subagents (opens the Agents
tool), computer use, pull requests, what the thread delivers, the working folder
(with **Change working folder**), and usage. Switching the active pane shows that pane's Environment instead of
leaving the previous thread's facts in place.

Local servers are compact rows grouped by process and port, with this checkout
separated from other classified leftovers. **Open** stays on a usable listener.
Copy URL and details live in that row's menu. **Stop** appears only for an
Octant-owned safe stop, or for a classified leftover after confirmation.
Unmanaged processes say so and have no fake Stop control. The same servers,
across every Project, are on the start screen's **Running services** card. Files, Plan,
Delivery, Agents, Browser, Review, iOS Simulator, and Android emulator stay in
the dock.

A Code thread's agent can also propose a scheduled routine, confirmed by you
in the thread, and you can create one yourself with **New routine** under
Routines here, which lists all of this Project's routines; see
[Routines from a thread](/guide/work#routines-from-a-thread). A Code routine
runs in this thread's checkout, asks before effects, and cannot be proposed
from Plan. A Code thread can also [follow up later](/guide/work#follow-up-later)
in the same thread; that turn asks before effects even if the thread has
since been given more access, and does not run if the thread has Full access.

## Managed worktrees

Code can create managed git worktrees for isolated feature branches. New managed worktrees default to **Start from origin** when the selected branch has a usable remote. The server fetches the remote, resolves the exact object ID, and creates the worktree from that commit. The existing checkout is never mutated.

## Workspace surfaces

Code exposes repository-valid engineering surfaces:

- Thread conversations, including the tool steps and thinking a turn recorded — a reopened thread replays a bounded number of them and says when it kept only the earliest
- Terminal (confined to the Project root). A thread's own terminal keeps running when you close its tab and reattaches when you open it again; an extra terminal you opened alongside it belongs to that tab, so closing the tab stops its shell rather than leaving a process nothing can reach.
- A thread list you can shape: rename a thread in place (double-click or F2), pin the ones you keep coming back to so they stay at the top, and see which threads moved while you were elsewhere
- A thread card on hover or keyboard focus: Project, branch, provider, fork origin, recency, and the thread's exact linked pull requests read from the cached snapshot (hovering never asks GitHub). Click a pull request to open it in Review; Cmd-click, the trailing GitHub control, or the row menu's **Open on GitHub** entry opens it in your browser
- Quick open by file name (`Cmd+P`) and search across file contents (`Cmd+Shift+F`), both confined to the repository bound to the thread and both bounded — Octant says when it stopped before searching everything rather than reporting a partial answer as complete
- Files/Explorer, which follows the checkout live: when the agent or anything else changes a file, the tree relists and an open editor reloads. A file you have edited but not saved is never overwritten — Octant reports the external change as a conflict instead.
- Review, beside the thread, including discarding a tracked file's uncommitted changes (asked about every time outside Full access, because nothing can restore them)
- Git surfaces
- Side Chat, a Chat-mode lane that can ask about this thread without interrupting its Lead turn. It reads the thread's conversation, branch and changes, files, and subagent results, and cannot change any of them. Type `#` in the composer to mention another thread as read-only context, or drag a sidebar thread onto the composer, or choose **Attach as context** from that row's menu. `@` names a file in this checkout.
- Browser surfaces
- iOS Simulator and Android emulator device panes, when the host has those destinations
- A Desktop pane for the thread's [disposable desktops](/advanced/browser-and-computer-use#disposable-desktops) on a Linux host
- Extension-contributed surfaces approved by effective activation policy

The active Code thread's composer shows a circular context-usage meter. Opening
it shows the authoritative used-versus-available breakdown for that thread.
Project memory lives on the Code Project Overview. Navigator opens from the
bottom-left profile and Settings control without changing the active Project
or thread. The right sidebar is a compact launcher when empty and a tool strip
when open. It can host Side Chat, Browser, Files, Canvas, Plan when this thread
has a current plan artifact, Pull requests for the thread's Project, Delivery
when a target is enabled, Changes,
Terminal, Tests, [Run and debug](/advanced/debugging), iOS Simulator, Android emulator, or Desktop instead of replacing the Code thread. iOS
Simulator is absent until Octant has found an Xcode project and Apple
toolchain. Android emulator is always launchable on Code; a host without the
SDK shows the destination as unavailable. When either pane is open it shows a
live frame for that thread's destination, or an honest unavailable state when
the host cannot attach one. Hiding Browser, Terminal, or a device pane does
not stop the server-owned session.
**Pull requests** lists the active Project's open and draft requests from the
cached snapshot and opens a selected row in Review in the same dock; the
request named on a pane tab opens there too.
When you ask, the agent can open the pull request for the thread's own
branch, as a draft or ready for review, and stack it on another branch that
already has an open pull request. It can also change that pull request's
title and description, or mark a draft ready (or turn it back into a draft).
It never chooses another branch, and it cannot merge or close anything. A
thread that asks before acting shows you the exact change first; Full access
goes ahead; Plan refuses. The thread's pull request shows in Review and on
its card, stacked ones included.
The sidebar follows the pane that last received pointer or keyboard input.
Each thread remembers its open tools and selected tool.

## Put away and snooze threads

The same actions exist for Chat and Work threads; this section describes
them once, for Code.

A thread you are done with can be put away without archiving it. Choose
**Put away** from the row's menu (right-click, or the ⋯ control on hover) and
the thread leaves its Project group for the collapsed **Put away** shelf at
the foot of the sidebar. Everything about it stays: the transcript, the
checkout, its pull request link, and search. **Reopen** brings it back to the
top of its group, and so does sending it a new message.

Octant refuses to put a thread away while its turn is still running or while
the agent is waiting on an approval or an answer from you, so a thread never
disappears with work in flight. Putting a thread away also clears its pin.

**Snooze** hides a thread until a time you pick — in an hour, in three hours,
this evening, tomorrow morning, or next Monday morning. Snoozed threads sit in
their own collapsed shelf with the time until they return. A snoozed thread is
otherwise untouched: a running turn keeps running. It comes back early if the
agent needs you, or if the turn that was running when you snoozed it finishes.
When a snooze ends the row reappears where it was, marked **Woke** until you
open it. **Wake** in the row menu ends a snooze by hand, and so does sending
the thread a message. A thread that is waiting on you cannot be snoozed.

Put-away threads move to the archive on their own after a week. Change that
window, or turn it off, under **Settings › General › Archive put-away
threads**. Archiving keeps every thread and its history; only a confirmed purge
in **Settings › Data & storage** deletes anything.

## Agents that see the other threads of a Project

When several Code threads work in the same Project, each thread's agent can
look at the others before it messages one or while it waits for one to finish.
It has three read-only actions:

- **List** the other open threads of the Project, up to 32, with each title,
  whether the thread is working, waiting for you, or idle, and when that last
  changed.
- **Read** one of them: its title, state, and recent messages, the same window
  a `#thread` mention of it would show from your window.
- **Wait** for one to stop working, for up to two minutes. Waiting returns the
  state only.

An agent sees only the open Code threads of its own Project. Threads in other
Projects, put-away or archived threads, Chat and Work threads, and helper
agents started by a thread are never listed or readable, and asking for one
gets the same refusal as asking for a thread that does not exist. Nothing the
agent does here sends, changes, or stops another thread, so it works in Plan
mode too.

A turn may read 8 times and wait 4 times. Listing or reading marks the
thread as having read outside content, because titles and messages were
written by someone else. From then on the thread asks you before risky
actions until you clear the mark. Each read and wait is recorded on the
thread that made it, without the text it read.

The agent is offered these actions only on providers that can carry Octant's
own tools: Claude, Codex, ACP agents that accept Octant's tools, OpenCode
with Octant's isolated configuration, Pi, and direct endpoints for models
you verified for tools. A profile whose tool list leaves out `octant_threads`
does not offer them.

## Next steps

- [Promotions](/guide/promotions) for creating Code threads from Work work
- [Projects](/guide/projects) for managing Code Projects
- [Chat](/guide/chat) for conversations without filesystem authority

After a Code task is created, Octant opens it while the provider starts the first
turn. The initial prompt stays visible in the task; a slow provider startup does
not keep you on the welcome screen. Any startup refusal appears in the task so
you can correct the prompt or provider selection and retry.

### Conversation continuity

Follow-ups resume the same provider-native CLI session, including its tool history.
Octant sends only the new message and never silently starts a replacement session.
If the saved session cannot be resumed, the task reports that failure. Older tasks
without a saved session reference need a new task; a host restart also requires
an adapter that supports durable resume identity.
