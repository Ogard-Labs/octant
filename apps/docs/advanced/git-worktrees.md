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

Serializing does not make a restore safe against another thread's turn. Restoring
files in place refuses while a different thread has a writing turn in flight on
the same checkout path. A thread on its own managed worktree has its own path
and is never held up by, or holding up, the Project's checkout.

**Unavailable in V1:** broad staging, shared stash, reset, checkout-based
discard, rebase, history rewriting, and force push options. Staging always
receives an explicit normalized path set.

- **Commit** requires an explicit staged summary and message.
  A commit needs an author. The checkout's own Git config is read inside the
  confined command; when it names no author or email, the host's recorded
  profile (Settings → Profile) fills only the missing fields, and a
  checkout that names its own author keeps it. When neither source names an
  identity, the commit is refused with a reason that says so, rather than
  attributing your work to an address invented from the OS account. Merges and
  reverts create commits too, so they resolve their author the same way.
- **Push** requires an approved action or Full access, a confirmed remote and
  refspec, and a non-detached branch. A thread pushes only its own branch.
  After you amend a commit, the agent can push it with **force-with-lease**:
  Git replaces the remote branch only if it is still the commit Octant saw, so
  a branch someone else moved is left alone. A plain force-push, or any push to
  the default branch, happens only when you approve that one push; Full access
  does not cover it.
- **Pull requests** are created through the installed authenticated `gh`
  CLI. Octant first checks for an existing PR for the same head and base,
  so a retry returns the same PR and never duplicates it. **Octant stores
  no GitHub token** and strips ambient token variables from ordinary Git
  commands. It never creates a fork automatically; you select an already
  configured writable head remote and the intended base repo and branch.
- **Agents and pull requests.** When you ask, the agent can edit its own pull
  request, add or remove labels the repository already has (it never creates
  one), close it or reopen it (a merged one stays merged, and the branch is
  never deleted), and post a comment or a reply in a review thread. Every
  comment and reply asks you first, at every access level, and shows the whole
  text, because it posts under your name. The agent never approves or requests
  changes on a pull request. It can merge its own pull request when you ask,
  after you approve that one merge; Octant merges only the head you saw, and
  only when the repository's required checks have passed. Two choices of yours
  let it merge without asking each time: **Agents may merge** on a Project
  (in the Pull requests list, beside Auto-refresh), and **Merge the pull
  requests it opens** on a Code routine in Automation Center. Only a window on
  this computer turns either on, and the head and required-check rules still
  apply. Switch the choice off and the next merge asks again. A routine's
  choice covers only the threads its own runs create.
- **You merge yourself.** Open a pull request's review and choose a method,
  then **Confirm merge**. Octant merges only the head you reviewed, refuses
  if it moved or if a required check has not passed, and uses your signed-in
  `gh`. A paired phone or web client can merge a pull request, or a whole
  stack from the bottom, the same way; a stack that is not one chain is
  refused before anything merges. Under **Your actions** in the review you can
  add or remove a label the repository already has, post a comment, reply in an
  open review thread, approve it or request changes (a note is needed to
  request changes), and close or reopen the pull request. Comments, replies,
  and reviews post under your name, and these controls work in the desktop
  window only. A review is recorded on the head you read and refused if the
  pull request has a newer commit; GitHub does not let you approve your own
  pull request. You
  can also turn on **Merge when ready** and **Auto-fix** there; see
  [Automatic actions](#automatic-actions-on-a-pull-request). Durable local review findings stay thread-owned; publishing
  them to GitHub is a later phase.

## Authority matrix

| Operation                        | Plan                                                        | Approval-gated                                           | Full access         |
| -------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------- | ------------------- |
| Read, search, status, diff       | Allow                                                       | Allow                                                    | Allow               |
| Edit, save, rename, delete file  | Deny                                                        | Prompt                                                   | Allow               |
| Start/stop terminal or test      | Deny                                                        | Prompt (agent); your own terminal opens without a prompt | Allow               |
| Stage, commit, push, create PR   | Deny                                                        | Prompt                                                   | Allow               |
| Merge, comment, or reply on a PR | Deny                                                        | Prompt for each act                                      | Prompt for each act |
| Labels, close, reopen a PR       | Deny                                                        | Prompt                                                   | Allow               |
| Create sibling managed root      | Separate local-user confirmation (denied to remote clients) |                                                          |                     |

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

Thread-scoped create and observe remain on the thread. A pull request's review
can merge it after you confirm; nothing here comments, closes, or
force-pushes without your action.

### Automatic actions on a pull request

A pull request's review has two switches under **Automatic actions**. Only you
can turn them on. **Auto-fix** needs a click in a desktop window on the computer
running Octant. **Merge when ready** also works from a paired phone or browser,
and asks you to confirm the head you reviewed first, in a window or on the
phone, before it turns on.

- **Merge when ready** asks GitHub to merge the pull request itself once its
  required checks and reviews pass, using the merge method selected beside
  **Merge**. It is pinned to the head you were looking at, so a push in between
  makes GitHub refuse. If the repository does not allow auto-merge, the review
  says it is unsupported and turns nothing on; enable **Allow auto-merge** in
  the repository's GitHub settings first. The status line shows what it waits
  on, when GitHub merged it, or when GitHub turned auto-merge off.
- **Auto-fix** watches the pull request about once a minute while Octant runs.
  When a required check fails, a reviewer leaves an unresolved comment, or the
  branch conflicts with its base, it wakes the linked Code thread with one turn
  that lists the failed checks with the end of their logs, the review comments,
  and the conflict. That text comes from GitHub, so it is marked as outside
  content and the thread's usual approvals apply. The agent is told to fix,
  commit, and push on the branch, never force-push or rewrite history, and to
  merge the base branch rather than rebase; it may reply to a review thread and
  resolve it after fixing it.
- Auto-fix tries at most three times per failure, then stops and marks the
  thread for your follow-up. It waits while you are typing in that thread or a
  turn is running there, and stops when the pull request merges or closes, the
  thread is archived, the Project no longer connects the repository, or you
  turn it off. After Octant restarts, it stays quiet until you open the pull
  request's review again.

Every switch change and every wake is recorded in Octant's journal.

A Code thread's right sidebar can also host **Pull requests**: it lists the
active Project's active rows from the same cached snapshot and opens a selected
row in Review in the same dock. The pull request named on a pane tab opens
there too, so a mention in the thread reaches the request without leaving the
transcript.

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

## Review what only exists on this machine

Open **Review** in the right sidebar of a Code thread, then choose **Local
commits**. The list shows the commits on the thread's branch that its upstream
does not have yet. A branch that was never pushed is compared with its base
branch instead, and the list says which one it used. Select a commit to expand
its diff. Octant reads this from the local checkout and never fetches, so it
is only as current as the last fetch you made. The list holds the newest 100 commits; when there are more, the count reads
"100+" and a note says older ones are not listed.

## Ignore whitespace

**Ignore whitespace** appears above the diff in **Working tree** and in a
commit's diff. It asks Git to leave out changes that only move or re-indent
text, which makes a reformatting easier to read past. Your choice is kept for
every thread in this browser or app profile. The changed-path count at the top
still includes files whose only change was whitespace, so it can be higher than
the number of files shown.

## Browse Git history

Open **Review** in the right sidebar of a Code thread, then choose **History**.
The list shows local commits, branch and tag labels, authors, dates, and a
parent graph. Select **Current branch**, **All branches**, or a specific ref.
Search matches commit messages, author names, and SHA prefixes. Use **Load older
commits** to continue through a bounded page or search scan.

Select a commit to inspect its message and changed files. Merge commits let you
choose the parent to compare. File sections collapse independently, and **Side
by side** opens the available changed regions in a read-only comparison.
**Back to history** preserves the loaded list and scroll position.

History works from the local checkout without GitHub or network access.
**Refresh** rereads local state; it does not fetch from remotes. Shallow clones
and preview limits are disclosed. Large unified previews show at most 2,000
lines per file; side-by-side comparison can inspect the available bounded diff.
The interface keeps at most 5,000 loaded commits before asking you to narrow
the branch or search. Switching threads always switches checkout authority.
