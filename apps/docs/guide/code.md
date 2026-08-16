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

## Authority modes

Code threads run in one of four server-enforced authority modes:

- **Plan**: strictly read-only. No write-approval path exists. Plan mode remains read-only even when Full access is remembered for the Project.
- **Approval-gated**: confines work to the bound Project root. Each mutation or command surfaces an approval request. This is the default for new Code threads.
- **Auto-accept edits**: the same confinement as approval-gated, except file writes inside the bound root proceed without a prompt. Shell commands, network access, destructive actions, credential access, and anything outside the root still ask.
- **Full access**: unsandboxed execution within the Project root. Starts only when explicitly selected. Use the permission-persistence control to apply to the current session or remember for the Project.

Code starts approval-gated unless the user explicitly remembers Full access. A Work-to-Code promotion always starts approval-gated, never inheriting Work authority. The access control sits in the thread composer and applies from the next turn; raising a thread to Full access still needs the native confirmation.

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
- Terminal (confined to the Project root)
- Files/Explorer
- Diff viewer, including discarding a tracked file's uncommitted changes (asked about every time outside Full access, because nothing can restore them)
- Git/Review surfaces
- Side Chat
- Browser tabs
- Extension-contributed surfaces approved by effective activation policy

## Next steps

- [Promotions](/guide/promotions) for creating Code threads from Work work
- [Projects](/guide/projects) for managing Code Projects
- [Chat](/guide/chat) for conversations without filesystem authority
