---
description: Work mode binds one OS-confined folder for local knowledge work with documents, artifacts, research, and citations.
---

# Work

Work is local knowledge work for documents, presentations, spreadsheets, reports, PDFs, images, and artifacts. Each Work Project binds exactly one OS-confined project root selected through the native directory picker.

The **Work** mode also holds your chats. Above its composer, **Chat** starts a
conversation with no file access, and **In a folder** starts work in one folder
you choose. Both kinds of thread show in the same sidebar list, and each keeps
the kind it started as.

## Work Projects

Create a Work Project from the sidebar:

1. Select **Work** as the mode.
2. Use the native picker to choose a directory.
3. Name the Project.

The selected directory becomes the confined root. Work threads cannot access paths outside this root. The renderer receives an opaque receipt rather than the raw path.

Octant writes nothing of its own into the folder unless you ask it to. On the Project page, **Status file** turns on a `STATUS.md` at the top of the folder: every task reads it and updates where the work stands, and its dated follow-ups and deadlines become reminders on the board and in the inbox. It is off for every Project until you turn it on, and the default folder never offers it. Turning it off leaves the file where it is; Octant just stops reading and writing it.

## Authority and confinement

Work threads operate within the bound Project root. Filesystem operations, artifact mutations, and tool access are confined to that directory. The server enforces confinement; renderer focus cannot extend authority.

Capability-aware workspace surfaces available in Work include:

- Confined Files/Explorer
- Artifact Review and preview surfaces
- Browser surfaces (host-owned, policy-gated)
- Side Chat, a Chat-mode lane that can ask about the focused thread without interrupting it. It reads the thread's conversation, folder, files, and subagent results, and cannot change any of them
- Research with citations and provenance
- Scoped memory and child agents

The active Work thread's composer shows a circular context-usage meter. Opening
it shows the authoritative used-versus-available breakdown for that thread.
Project memory lives on the Work Project Overview. Navigator opens from the
bottom-left profile and Settings control without changing the active Project
or thread. The right sidebar is a compact launcher when empty and a tool strip
when open. It can host Side Chat, Browser, Files, Canvas, or Plan when this
thread has a current plan artifact, instead of replacing the Work thread. The
sidebar follows the pane that last received pointer or keyboard input and
restores that thread's open tools and selected tool when you return to it.

The sidebar **Thread board** is a server-derived view of Work threads as Ready, In progress, Waiting, and Done. Status comes from turn, request, artifact, citation, child-run, recovery, and delivery evidence; a thread is Done when you mark it Done with **Mark done** in its **Task actions** menu. Each column is a soft well headed by a mark, its name, and a count; the In progress mark turns while a task is running. A card shows its title, a live line while the task is executing, what it waits on, any linked pull request as a small preview, and a footer with the provider and when it last moved. A card that waits on you also shows the question or approval with its answer buttons, so you can clear it without opening the task. Cards are not dragged between columns. Opening a card activates that Work Project and thread. Chat has no board.

To redesign an existing website, ask the agent to open the page in the Browser and take a screenshot. It can then build a Canvas design with the page as it is now beside a redesigned version. The before frame shows the screenshot the thread kept (a small picture, about 40 KB), and the agent draws the after frame itself; it never pulls the site's own images, styles, or fonts into a frame. Only screenshots this thread took are used. The Canvas preview shows them, but a share, a public link, and an export leave them out.

Work and Code can do the same things. A Work thread gets the same shell, Git, command-line tools, `ssh` to your own machines, and provider tools as a Code thread, under the same mode: at **Ask first** and **Accept edits** you approve each command, at **Auto** the provider's own reviewer answers, or Octant Shield when you chose it in Settings or the provider has none (Shield's decisions show in the turn's steps, and anything it will not allow comes to you), and at **Full access** nothing asks and nothing is sandboxed. Octant keeps no SSH keys; `ssh`, `scp`, and `rsync` run as ordinary commands with your own agent and settings, so at Ask first you approve them like any other command. Pick the mode from the shield button beside the model in the composer; the next turn runs at it. Work has no Plan mode. When Work work becomes software engineering with a delivery target, use a [promotion](/guide/promotions) to start a linked Code thread with explicit user approval.

What differs is focus: Work shows documents, artifacts, local tasks, and its board, and keeps Git panels, pull requests, reviews, issue trackers, and worktrees out of sight until you turn on **Developer tools** in the Work Project's overview. A Work thread is still Done when you mark it Done.

Turn on **Developer tools** in the Work Project's overview (under Access and limits) to show the Project's terminal and its **Actions**: named commands such as Build or Preview that you save once and run from the toolbar or the command palette, in the Project's own terminal at its folder. Only you can turn the switch on, from a window on this computer; Octant records when. It changes what the Project shows, not what its tasks may do.

## Continue a terminal session

A new Work task can start from a Claude Code or Codex session you had in a
terminal in the same folder. Choose **Create from…**, then **Terminal**, and
pick the session. The task shows that conversation as folded, read-only
history, and the assistant reads it once at the start. The session stays on
this Mac, and the task is marked as holding outside content.

## Work settings

**Settings › Work** sets what a new Work thread starts with:

- **Default model** is the provider and model a new thread starts on, unless you pick another in the composer. If that model is no longer available, the first available one is used.
- **Access** is the mode a new thread starts in, the same modes a Code thread has. **Ask first** (the default) asks before every command and every change. **Accept edits** lets edits inside the Project folder happen without a prompt and still asks before commands; anything outside the folder is still refused. **Auto** lets the provider's own reviewer answer. **Full access** runs with no sandbox and no prompts; the first time you pick it, Octant says what that means and asks you to confirm. Only a window on this computer can pick Full access; a paired device can lower a thread but not raise one to it.

Changing the setting never changes a thread that already exists; each thread changes its own mode from its composer. A goal loop only auto-accepts edits when its own limits allow it too, and never runs a round above them. A Work folder has no checkpoint to go back to, so a goal loop's rounds run only while they ask before each edit; a loop that would accept edits on its own pauses and says so.

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

## Continuing after a restart

If Octant restarts while a turn is running, the affected conversation shows
**Resume** above its composer. Review any changes already made, then click it
to ask the agent to inspect its saved progress and continue the unfinished
request in the same thread. This works in Chat, Work, and Code; nothing resumes
automatically, and your composer draft is left alone.

Octant checks the thread's current access, provider, and folder first. If another
message is already queued, review and remove it from that queue before using
this Resume action. Octant does not discard or unpause those messages for you. Old approvals and
questions cannot be reused; the agent must ask again if needed. Resume continues
from saved conversation state, not the exact operation interrupted by the crash.

## Long threads

A long Work thread opens on its newest messages, so it is ready to read and
reply to straight away. **Load earlier messages** at the top of the thread adds
the messages before the oldest one shown; the message you were reading stays
where it is. Find in page searches the messages loaded so far. Export and purge
always cover the whole thread.

## Unsent drafts

New-task text stays with its mode and pane while you visit Settings or switch
modes in the same window session. Choosing another Project preserves that text;
an explicit New task starts over. This temporary text does not survive an app
restart.

Each Work thread keeps one unsent composer draft on this client. Leaving the
thread or restarting the app restores the text and caret. Sending or clearing
the composer removes it. Mentions that are part of the typed text persist;
staged attachments do not. Deleting or purging the thread removes its draft.

## Put away and snooze threads

A thread you are done with can be put away without archiving it. Choose
**Put away** from the row's menu (right-click, or the ⋯ control on hover) and
the thread moves to the collapsed **Put away** shelf at the foot of the
sidebar. Everything about it stays. **Reopen** brings it back, and so does
sending it a new message. Octant refuses to put a thread away while a turn is
still running or while the agent is waiting on an approval or an answer from
you.

**Snooze** hides a thread until a time you pick, in its own collapsed shelf
with the time until it returns. It comes back early if the agent needs you, or
if the turn that was running when you snoozed it finishes. When a snooze ends
the row reappears marked **Woke** until you open it; **Wake** ends a snooze by
hand. A thread that is waiting on you cannot be snoozed.

Put-away threads move to the archive on their own after a week. Change that
window, or turn it off, under **Settings › General › Archive put-away
threads**. Archiving keeps every thread; only a confirmed purge deletes.

## Move to a Project

Choose **Move to Project…** from a Work thread's row menu to file it into
another Work Project. The thread stays a Work thread and keeps its history and
its access level. It can move only to a Work Project whose folder is the same
as, or contains, the folder it works in; Projects bound to any other folder are
listed greyed out with the reason, and the host refuses them too. The thread
keeps working in the same place inside the new Project's folder. Octant refuses
the move while a turn is running or the agent is waiting on you.

## Export

**Export…** downloads a portable JSON cut of this Work thread: the
transcript, Canvas artifacts it originated, any note recorded when the thread
was marked Done, and provenance. The file says when it was cut. Secrets
and filesystem paths never appear.

## Research workflow

Work supports a research workflow with citations and provenance. Research threads can produce briefs, sources, evidence, claims, and reports. Citations link back to verified sources within the confined root or approved external references.

## Artifacts and previews

Work threads can create, edit, and preview artifacts within the bound root. Preview surfaces are authenticated and cancelable. Split-view previews render through the shared renderer with server-authoritative policy.

## Attaching images

Paste or attach a PNG, JPEG, WebP, or GIF in the Work composer to send it with a provider turn. The image uploads to the host, and the turn names only the identifier the host answered with, so the provider receives bytes the host itself accepted.

A turn carries at most eight images, each up to 10 MB, alongside a written message. If the selected model does not read images, the composer says so at the paste instead of taking the file. The host checks the thread's own model again at send, so a turn never reaches a model with its pictures quietly dropped. Removing a chip before sending keeps that image off the turn.

Type `#` in the composer to mention another thread as read-only context, the same bounded excerpt Chat uses. Dragging a sidebar thread onto the composer, or choosing **Attach as context** from that row's menu, attaches the same reference and does not send the draft. Type `@` to complete a path inside this Project's bound folder; the host refuses a path outside that root before reading it. Chat has no `@file` mention, because Chat Projects have no filesystem authority.

In the macOS desktop app, the paperclip opens a menu: **Choose file…** or **Capture window…**. Capture window lists your open windows by title and attaches a picture of the one you choose, as an image like any other. The first time, Octant explains why macOS needs Screen Recording permission and asks only when you press **Continue**; if you turned it off, Octant opens System Settings instead. Octant reads a window only after you choose it, and the picture goes only to the thread you attach it to. The web app and the phone app do not offer it.

## Thread board

Work has a server-authoritative [Thread board](/advanced/work-board) that
derives Ready, In progress, Waiting, and Done from turn, request, artifact,
citation, child-run, recovery, and delivery evidence. A thread is Done when
you mark it Done; no evidence text is needed. Opening a card activates
that Project and thread. Chat has no board.

## Routines from a thread

Ask the agent to do something later or on a schedule ("every Monday at 9,
summarize last week's changes") and it can propose a routine. It shows as a
suggestion at the foot of the thread with exactly what would run and when: the
name, the schedule and time zone, the first run, what happens to runs missed
while the computer is off, and the prompt each run starts with. Nothing exists
until you click **Create routine**; dismissing it, or no answer within ten
minutes, creates nothing. The agent can never create one on its own, even in a
thread with Full access.

You can also create one yourself: open **Routines** in the thread's
Environment and choose **New routine**. Give it a name, the task for each run,
a schedule (once, every so many minutes, or weekly at a time in a time zone),
and what to do with runs missed while the computer is off. It belongs to the
thread's Project and mode; you do not pick them.

A routine made this way belongs to the thread's Project. Each run starts a new
thread there that asks before it runs a command or changes anything, whatever
the proposal said. A Work routine saved before Work threads had the shell
does not run until you edit it in Automation Center and save it with a
profile that includes the shell and Git; its run history says why.

To let a routine run at the mode its Project's new threads start in instead
of asking first, open it in Automation Center and turn on **Run at this
Project's mode**. If that mode is Full access, the routine's runs change files
and run commands with nobody asked. Only a window on this computer can turn
it on, and the change is recorded with the routine; a routine an agent
proposed never has it until you turn it on. A Code routine also has **Merge the
pull requests it opens**: when it is on, the run's agent may merge the pull
request its own thread opened without asking, once the head it saw is still
current and the repository's required checks have passed. It is off by default
and set the same way, from a window on this computer. It appears under Routines in the thread's
Environment. That list shows every active and paused routine of the
Project, not only this thread's: this thread's follow-ups first, then the
routines made from this thread, then the rest. Each can be paused, resumed, or
opened in Automation Center. Past five, choose **Show all**. A
routine's own run cannot propose more routines. A provider that cannot use
Octant's tools does not get this; create the routine in Automation Center
instead.

### Follow up later

A follow-up is a one-time turn sent back into the same thread at a time you
pick, so the agent picks up the conversation where it left off ("tomorrow
morning, check whether the reply arrived and summarise it"). Set one up from
the thread's Environment with **Follow up later** under Routines: choose **In 1 hour**,
**Tomorrow at 9:00**, or **Pick a time**, and say what to check. The agent can
also propose one; it shows as a suggestion, and nothing is scheduled until
you click **Schedule follow-up**.

A pending follow-up is listed in Environment ("Follows up tomorrow at 9:00")
with **Change time** and **Cancel**. When it runs, the transcript marks the
turn as a scheduled follow-up. It runs once, with the thread's own access and
asking before it changes anything, then ends. It does not run if the thread
is busy with a turn, marked Done, archived, moved to another Project, or now
on another provider or model; if the computer was asleep, it runs when Octant
is back, unless it is more than a day late, in which case it is recorded as
missed. Automation Center keeps its history. Chat threads have no follow-ups.

## Find in a thread

Press **⌘/Ctrl+F** in an open thread to search its conversation. A bar at the top
shows "n of m", highlights each match, and moves with **Enter** (next) and
**Shift+Enter** (previous). **Escape** closes it. Inside the code editor or a
terminal, ⌘/Ctrl+F stays with that tool.

Select text in one of the agent's replies and choose **New thread from
selection**, from the small button under the reply or the right-click menu. A
new Work draft opens in the same Project with your selection quoted at the top.
Nothing is sent until you send it.

## Next steps

- [Work Thread Board](/advanced/work-board) for derived status, grouping, and marking a thread Done
- [Promotions](/guide/promotions) for escalating Work work to a Code thread
- [Projects](/guide/projects) for managing Work Projects
- [Code](/guide/code) for repository engineering
