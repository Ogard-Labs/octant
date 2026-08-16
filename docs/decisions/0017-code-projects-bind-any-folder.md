# 0017. Code Projects bind any folder

**Status:** Accepted

## Context

Decision 0003 said a Code Project binds "exactly one existing repository
root", and the desktop picker enforced it: the server ran
`git rev-parse --show-toplevel` on the chosen folder and rejected anything
that was not a Git top level or linked worktree. In dogfooding this blocked
the most common first step — pointing Code at a folder that is not (yet) a
repository — and produced a confusing "Choose the top-level Git repository"
error for an otherwise valid directory. Every downstream Code service already
treats "not a Git repository" as an expected, typed observation
(`unavailable` / `ineligible`), so the up-front rejection protected nothing.

## Decision

- A Code Project binds exactly one existing, OS-confined local directory —
  the same rule as Work. Git top-level status is not a binding requirement.
- Repository identity, checkout, worktree, branch, remote, and delivery
  facts remain observed lazily by the Code services and are reported as
  `unavailable` when the bound folder is not a Git repository. Features that
  need them (managed worktrees, PR observation, Git tools) fail closed
  per action with a typed failure; they never crash the thread or Project.
- The Project availability check validates only that the canonical root
  exists and is a directory. "Relink required" therefore means the folder is
  gone or unreadable, not that Git is missing.
- Amends the "Code Projects bind exactly one existing repository root" rule
  in 0003. All other rules in 0003 (approval-gated start, Plan is read-only,
  no inferred roots, explicit attach) are unchanged.

## Consequences

- Users can start Code work in a fresh folder and `git init` later; Octant
  picks up repository facts on the next observation.
- The desktop picker's Code copy no longer mentions Git; both Work and Code
  say "Choose one directory."
- A non-repository Code Project shows as _Available_ with empty repository
  projections rather than being refused at creation.

## Related

- 0003 Product modes: Chat, Work, and Code authority (amended)
- 0009 Sandbox confinement, approvals, and Plan mode
