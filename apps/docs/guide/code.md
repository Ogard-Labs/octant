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

The server validates that the folder exists and the renderer receives an opaque receipt. If the folder is not a Git repository, Git-dependent features report _unavailable_ until you initialise one.

A Code Project can remember how new threads should start: in **this Project's current checkout**, or in **a managed worktree Octant creates**. The default is the current checkout, which creates no worktree the owner did not ask for. Set the habit from the Project overview; the composer still lets one thread override it without rewriting the Project. Desktop and phone both inherit that default, and the new thread shows which root it bound. A missing or unauthorized root fails closed instead of inventing a worktree.

## Authority modes

Code threads run in one of four server-enforced authority modes:

- **Plan**: strictly read-only. No write-approval path exists. Plan mode remains read-only even when Full access is remembered for the Project.
- **Approval-gated**: confines work to the bound Project root. Each mutation or command surfaces an approval request. This is the default for new Code threads.
- **Auto-accept edits**: the same confinement as approval-gated, except file writes inside the bound root proceed without a prompt. Shell commands, network access, destructive actions, credential access, and anything outside the root still ask.
- **Full access**: unsandboxed execution within the Project root. Starts only when explicitly selected. Use the permission-persistence control to apply to the current session or remember for the Project.

Code starts approval-gated unless the user explicitly remembers Full access. A Work-to-Code promotion always starts approval-gated, never inheriting Work authority. The access control sits in the thread composer and applies from the next turn; raising a thread to Full access still needs the native confirmation.

## Plans

A Code thread's plan is a durable, ordered list of steps, not prose in the
transcript. Write one in the thread's **Plan** panel — one step per line, with
an optional reason after an em dash — and press **Propose plan**. It appears
beside the transcript as well, so it stays in view while you read the thread.

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

## Attaching images

Paste or drop a PNG, JPEG, WebP, or GIF into the thread composer to send it with your next message. Each image uploads to the host as you attach it, and the turn sends only the identifier the host answered with, so the provider receives bytes the host itself accepted.

A turn carries at most eight images, each up to 10 MB, alongside a written message. Repository files do not need attaching — name them with `@path` instead. If the thread's model does not read images, the composer says so at the paste — _"Local OpenCode — Model One does not support images. Choose a vision model to attach one."_ — instead of taking the upload. The host checks the thread's own model again at send, so a turn never reaches a model with its pictures quietly dropped.

Images stay readable in the transcript after a restart. Removing a chip before sending discards the image on the host too.

## Thread environment

Each Code thread tab owns its Environment panel, which reflects the authoritative thread environment. The panel can be:

- **Floating**: a contained overlay within the thread tab.
- **Pinned**: a resizable trailing rail inside the thread tab.
- **Hidden**: no detailed panel, but a compact control shows effective placement and worktree identity.

Environment content includes changes, checkout/worktree, branch, commit and push readiness, local servers, repository, external editor handoff, subagents, sources, and Browser sessions.

## Managed worktrees

Code can create managed git worktrees for isolated feature branches. New managed worktrees default to **Start from origin** when the selected branch has a usable remote. The server fetches the remote, resolves the exact object ID, and creates the worktree from that commit. The existing checkout is never mutated.

## Workspace surfaces

Code exposes repository-valid engineering surfaces:

- Thread conversations, including the tool steps and thinking a turn recorded — a reopened thread replays a bounded number of them and says when it kept only the earliest
- Terminal (confined to the Project root). A thread's own terminal keeps running when you close its tab and reattaches when you open it again; an extra terminal you opened alongside it belongs to that tab, so closing the tab stops its shell rather than leaving a process nothing can reach.
- A thread list you can shape: rename a thread in place (double-click or F2), pin the ones you keep coming back to so they stay at the top, and see which threads moved while you were elsewhere
- Quick open by file name (`Cmd+P`) and search across file contents (`Cmd+Shift+F`), both confined to the repository bound to the thread and both bounded — Octant says when it stopped before searching everything rather than reporting a partial answer as complete
- Files/Explorer, which follows the checkout live: when the agent or anything else changes a file, the tree relists and an open editor reloads. A file you have edited but not saved is never overwritten — Octant reports the external change as a conflict instead.
- Diff viewer, including discarding a tracked file's uncommitted changes (asked about every time outside Full access, because nothing can restore them)
- Git/Review surfaces
- Side Chat
- Browser tabs
- Extension-contributed surfaces approved by effective activation policy

## Next steps

- [Promotions](/guide/promotions) for creating Code threads from Work work
- [Projects](/guide/projects) for managing Code Projects
- [Chat](/guide/chat) for conversations without filesystem authority
