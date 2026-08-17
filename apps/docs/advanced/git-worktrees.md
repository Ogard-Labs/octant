---
description: Repository identity, managed worktrees, Git operations, authority matrix, and pull requests.
---

# Git and Worktrees

Code binds one repository root per Project. Repository identity, worktrees,
and Git operations are server-authoritative and fail closed at every boundary.

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

## Pull Requests window

The Pull Requests surface lists all repository PRs with descriptions,
commits, changed files, diffs, checks, reviews, and comments, plus navigation
to the linked thread or worktree and **Open the PR on GitHub**. Commenting,
approving, requesting changes, merging, closing, or reopening remain on
GitHub in V1.

## Next steps

- [Code Thread Board](/advanced/code-board) for runtime-derived thread status
- [Subagents](/advanced/subagents) for child runs in isolated worktrees
- [Recovery and troubleshooting](/advanced/recovery) for inventory and conflict recovery
