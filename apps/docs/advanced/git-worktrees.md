---
description: Repository identity, managed worktrees, Git operations, authority matrix, and pull requests.
---

# Git and Worktrees

Code binds one folder per Project. When that folder is a Git repository,
repository identity, worktrees, and Git operations are server-authoritative
and fail closed at every boundary.

## Repository identity

Each Code thread binds an immutable repository identity derived from the
filesystem identity of the Git common and object directories, one explicit
checkout or worktree, an execution posture, and a user-confirmed delivery
target (branch intent, remote name, and proposed PR base).

Repository identity survives ordinary rename or move on the same volume. A
copy or a cross-volume replacement requires an explicit audited relink; a
moved checkout is unavailable until relinked. Submodules and bare
repositories are reported honestly but are not eligible Code Project roots in
V1.

When a bound Project has exactly one matching, credential-free GitHub remote,
the host projects only its `github.com` owner/repository identity to the Code
composer. New threads use that identity as their PR base default, so a manual
Pull Requests refresh can match the thread on its first read. Credentials,
non-GitHub remotes, mismatched fetch/push identities, and multiple different
remotes stay unconnected; the thread then proposes the local Project as its
base repository.

## New-thread checkout

A Code Project remembers whether new threads bind the current checkout or
start in a managed worktree. That habit is a Project setting, not a second
workspace product: the create composer can override it for one thread
without rewriting the Project, and desktop and phone both inherit it. The
thread then shows which root it bound. Missing, locked, or unauthorized
roots fail closed.

The conservative default is the current checkout, which creates no worktree
and no host state the owner did not ask for.

## Managed worktrees

Code can create managed Git worktrees under
`<repository-parent>/.octant-worktrees/<repository-identity>/<thread-identity>`,
with a **Start from origin** default when the selected branch has a usable
remote: the server fetches the remote, resolves the exact object ID, and
creates the worktree from that commit. The existing checkout is never
mutated.

Creating or using this sibling root requires a **separately confirmed
authority grant** that is one-use, short-lived, and local-desktop-only.
Remote clients cannot grant it, even under Full access. The server creates
collision-safe names, records a durable ownership receipt in the Octant
data directory before use, and verifies repository identity, Git worktree
inventory, and ownership before reuse or cleanup.

Octant never silently switches, resets, prunes, unlocks, removes, or
reuses a checkout. Cleanup refuses dirty, active, locked, mismatched,
unowned, undelivered, or ambiguous worktrees and requires explicit local-user
confirmation when work may remain. Ambiguous identity or inventory becomes
`waiting` or `unavailable`, never pruned.

## Git operations

Read-only observation and mutation are separate ports. Mutation serializes
per checkout and refuses an active Git index lock.

**Unavailable in V1:** broad staging, shared stash, reset, checkout-based
discard, rebase, history rewriting, and force push options. Staging always
receives an explicit normalized path set.

- **Commit** requires an explicit staged summary and message.
- **Push** requires an approved action or Full access, a confirmed remote and
  refspec, a non-detached branch, and no force option.
- **Pull requests** are created through the installed authenticated `gh`
  CLI. Octant first checks for an existing PR for the same head and base,
  so a retry returns the same PR and never duplicates it. **Octant stores
  no GitHub token** and strips ambient token variables from ordinary Git
  commands. It never creates a fork automatically; you select an already
  configured writable head remote and the intended base repo and branch.
- **PR interaction is read-only plus creation.** Comments, approvals,
  request-changes, editing, closing, reopening, and **merge are denied under
  every posture**. Durable local review findings stay thread-owned; publishing
  them to GitHub is a later phase.

## Authority matrix

| Operation                       | Plan                                                        | Approval-gated                                           | Full access |
| ------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------- | ----------- |
| Read, search, status, diff      | Allow                                                       | Allow                                                    | Allow       |
| Edit, save, rename, delete file | Deny                                                        | Prompt                                                   | Allow       |
| Start/stop terminal or test     | Deny                                                        | Prompt (agent); your own terminal opens without a prompt | Allow       |
| Stage, commit, push, create PR  | Deny                                                        | Prompt                                                   | Allow       |
| Merge or other PR mutation      | Deny everywhere                                             | Deny everywhere                                          | Deny        |
| Create sibling managed root     | Separate local-user confirmation (denied to remote clients) |                                                          |             |

## Pull requests workspace

Code's **Pull requests** destination is a Project-scoped list of active open
and draft pull requests from authorized connected Code Projects. Octant
resolves each Project's github.com origin from the bound root's git remotes.
Projects without a github.com origin stay visible as unconnected.

The list is a cached read of a private host-local snapshot. A successful
refresh survives an app or host restart; opening the workspace, switching
Projects, and ordinary board queries do not call GitHub.
Refresh all and per-Project refresh are explicit; repositories are read
concurrently through the installed authenticated `gh` CLI, then reconciled in
stable Project order. A Project can also opt into **Auto-refresh** with
the toggle in its group header: while enabled and the Project has
board-relevant pull requests, the host re-observes the snapshot on a bounded
cadence (never faster than every 30 seconds, every 2 minutes by default),
backs off after failures, and stops entirely when `gh` is missing or not
authenticated. The default is off, which keeps the explicit-refresh-only
behavior. The preview bounds
the refresh to 25 repositories and 100 pull requests. The workspace continues
to show only active open and draft rows, while Code board cards may use the same
explicit refresh to show exact linked PRs as Open, Draft, Merged, or Closed.
Merge readiness also requires fresh mergeability, passing checks, and an
approved review; conflicts and unknown mergeability never appear ready.
Disconnect, timeout,
malformed output, and rate limits keep the last authorized snapshot and label
it stale. Logging out of GitHub or losing Project authority drops private
actionable data. The journal never stores the list or detail cache. It retains
only exact PR identities produced by Code operations, so after restart a Code
card can show an identity as **Unknown** and stale until a user refreshes.

Thread-scoped create and observe remain on the thread. This workspace does
not merge, approve, comment, close, or force-push.

## Issues browser

The GitHub plugin's **Issues** destination is a host-scoped, read-only browser
of issues from any accessible repository. It is not a Project-bound Code
surface: it does not replace Pull requests, Thread Boards, or git worktrees.

The row appears only when the GitHub plugin is enabled, its destination action
is wired, and the authentication snapshot reports issue-read available.
Disabled GitHub or a missing capability hides the row entirely. Search, state
filter, and pagination use the existing GitHub catalogue reads. Detail is
plain text; URLs stay inert.

## Linear issues workspace

When the Linear plugin is enabled and a workspace is connected, Code's
**Linear** destination lists issues from that workspace (identifier, title,
state, assignee). Search and filters for team, state, assignee, and project
fail closed on missing capability, expired authorization, rate limits, and
network loss. Opening an issue shows its description and status. **Open in
Linear** follows the issue's Linear URL in the system browser. The first slice
is read-only: it does not create, edit, or comment, and it does not inject
Linear bodies into threads.

## Next steps

- [Code Thread Board](/advanced/code-board) for runtime-derived thread status
- [Subagents](/advanced/subagents) for child runs in isolated worktrees
- [Recovery and troubleshooting](/advanced/recovery) for inventory and conflict recovery
