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

## Unsent drafts

Each Code thread keeps one unsent composer draft on this client. Leaving the
thread, switching tabs, or restarting the app restores the text and caret.
Sending or clearing the composer removes it. Mentions that are part of the
typed text persist; staged attachments and extra selections do not, and the
composer says so if they were dropped. Deleting or purging the thread removes
its draft.

## Authority modes

Code threads run in one of four server-enforced authority modes:

- **Plan**: strictly read-only. No write-approval path exists. Plan mode remains read-only even when Full access is remembered for the Project.
- **Approval-gated**: confines work to the bound Project root. Each mutation or command surfaces an approval request. This is the default for new Code threads.
- **Auto-accept edits**: the same confinement as approval-gated, except file writes inside the bound root proceed without a prompt. Shell commands, network access, destructive actions, credential access, and anything outside the root still ask.
- **Full access**: unsandboxed execution within the Project root. Starts only when explicitly selected. Use the permission-persistence control to apply to the current session or remember for the Project.

Code starts approval-gated unless the user explicitly remembers Full access. A Work-to-Code promotion always starts approval-gated, never inheriting Work authority. The composer shows the posture the next turn will run under, defaulting to the thread's. A turn may only narrow what the thread already grants; Plan mode stays read-only and cannot be overridden from the composer. The transcript records the posture each turn actually ran under. Raising a thread to Full access still needs the native confirmation.

## Export

**Export thread** downloads a portable JSON cut of this Code thread: the
conversation the host holds, Canvas artifacts it originated, and provenance
(provider, model, checkout identity, fork origin). The file says when it was
cut. Checkout paths, credentials, and raw provider payloads never appear.

## Plans

A Code thread's plan is a durable, ordered list of steps, not prose in the
transcript. Write one in the thread's **Plan** panel — one step per line, with
an optional reason after an em dash — and press **Propose plan**. It appears
beside the transcript as well, so it stays in view while you read the thread.

The right dock's Plan tool appears only when this thread already has a current
plan artifact. Proposal stays the thread's planning workflow; the dock does not
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

**Restore from here** starts a second thread at the marked checkpoint and
leaves this one untouched. The restored thread's sidebar row — and the Project
Overview list, which shares those rows — carries a fork mark, as does the
thread it came from. Open the mark to see the origin chain and any direct
forks and to switch to one of them. If the origin has been archived or
deleted, the lineage says the origin is no longer available rather than
hiding that the thread is a fork. **Restore files to this point** overwrites
the working tree in place: it is named separately, still asks for
confirmation, and still goes through the thread's approval path. Undo restore
stays on the thread after a successful overwrite.

A checkpoint marker stays on the turn only when that point is marked.

## Attaching images

Paste or drop a PNG, JPEG, WebP, or GIF into the thread composer to send it with your next message. Each image uploads to the host as you attach it, and the turn sends only the identifier the host answered with, so the provider receives bytes the host itself accepted.

A turn carries at most eight images, each up to 10 MB, alongside a written message. Repository files do not need attaching — name them with `@file` instead. Type `@` to complete a path inside this checkout; the host refuses a path outside the bound root before reading it. If the thread's model does not read images, the composer says so at the paste — _"Local OpenCode — Model One does not support images. Choose a vision model to attach one."_ — instead of taking the upload. The host checks the thread's own model again at send, so a turn never reaches a model with its pictures quietly dropped.

Images stay readable in the transcript after a restart. Removing a chip before sending discards the image on the host too.

## Thread environment

Each Code thread owns an Environment tab in the right dock. It shows repository
identity, branch, clean or dirty state, the current working folder, and how many
local servers are running. Open it from the title-bar shortcut or **Add tool**;
the tab contains checkout facts, grouped local servers, and **Change working
folder**. Switching the active pane shows that pane's Environment instead of
leaving the previous thread's facts in place.

Local servers are compact rows grouped by process and port, with this checkout
separated from other classified leftovers. **Open** stays on a usable listener.
Copy URL and details live in that row's menu. **Stop** appears only for an
Octant-owned safe stop, or for a classified leftover after confirmation.
Unmanaged processes say so and have no fake Stop control. Files, Plan,
Delivery, Agents, Browser, and Review stay in the dock.

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
- Side Chat, a Chat-mode lane that can ask about this thread without interrupting its Lead turn or inheriting the repository. Type `#` in the composer to mention another thread as read-only context; `@` names a file in this checkout.
- Browser surfaces
- Extension-contributed surfaces approved by effective activation policy

The active Code thread's composer shows a circular context-usage meter. Opening
it shows the authoritative used-versus-available breakdown for that thread.
Project memory lives on the Code Project Overview. Navigator opens from the
bottom-left profile and Settings control without changing the active Project
or thread. The right sidebar is a compact launcher when empty and a tool strip
when open. It can host Side Chat, Browser, Files, Canvas, Plan when this thread
has a current plan artifact, Delivery when a target is enabled, Changes,
Terminal, Tests, or iOS Simulator instead of replacing the Code thread. iOS
Simulator is absent until Octant has found an Xcode project and Apple
toolchain. When it is open it shows a live frame for that thread's destination,
or an honest unavailable or stale-after-restart state when the host cannot
attach one. Hiding Browser, Terminal, or Simulator does not stop the
server-owned session.
The sidebar follows the pane that last received pointer or keyboard input.
Each thread remembers its open tools and selected tool.

## Complete and snooze threads

The same actions exist for Chat and Work threads; this section describes
them once, for Code.

A thread you are done with can be put away without archiving it. Choose
**Complete** from the row's menu (right-click, or the ⋯ control on hover) and
the thread leaves its Project group for the collapsed **Completed** shelf at
the foot of the sidebar. Everything about it stays: the transcript, the
checkout, its pull request link, and search. **Reopen** brings it back to the
top of its group, and so does sending it a new message.

Octant refuses to complete a thread while its turn is still running or while
the agent is waiting on an approval or an answer from you, so a thread never
disappears with work in flight. Completing a thread also clears its pin.

**Snooze** hides a thread until a time you pick — in an hour, in three hours,
this evening, tomorrow morning, or next Monday morning. Snoozed threads sit in
their own collapsed shelf with the time until they return. A snoozed thread is
otherwise untouched: a running turn keeps running. It comes back early if the
agent needs you, or if the turn that was running when you snoozed it finishes.
When a snooze ends the row reappears where it was, marked **Woke** until you
open it. **Wake** in the row menu ends a snooze by hand, and so does sending
the thread a message. A thread that is waiting on you cannot be snoozed.

Completed threads move to the archive on their own after a week. Change that
window, or turn it off, under **Settings › General › Archive completed
threads**. Archiving keeps every thread and its history; only a confirmed purge
in **Settings › Host** deletes anything.

## Next steps

- [Promotions](/guide/promotions) for creating Code threads from Work work
- [Projects](/guide/projects) for managing Code Projects
- [Chat](/guide/chat) for conversations without filesystem authority
