# 0079. Code Project creation may initialize Git on request

**Status:** Accepted

## Context

0017 lets a Code Project bind any folder, including one that is not yet a Git
repository. Repository facts stay lazy and fail closed. That binding rule is
still right: Octant must not refuse the Project, and must not invent a
repository without being asked.

Creating a Code thread is different. Thread start prepares a checkout
observation; a non-repository root fails that prepare, so the first thread in a
fresh folder cannot start. Dogfooding showed people pointing Code at an empty
directory and then hitting that wall. The recovery today is "run `git init`
yourself and retry," which the create dialog never offered.

## Decision

- During **Code** Project creation only, the create command may carry an
  explicit `initializeGit` request.
- When that request is true, after the binding receipt is consumed and before
  the Project is journaled, the server initializes the bound canonical root as
  a Git repository if it is not already one. The operation is confined to that
  root. If the folder is already a repository, the request is a no-op.
- Initialization is never inferred from folder emptiness, mode, or picker
  copy. Absent or false `initializeGit` preserves 0017: bind without mutating
  Git state.
- Work Project creation ignores the field. A standalone "git init anywhere"
  command is out of scope.
- Failure to initialize refuses Project creation with a typed failure; it does
  not journal a Project whose first thread would still be unusable for the
  reason the user asked to fix.
- 0017 remains Accepted. This record amends only its consequence that users
  must `git init` later themselves; binding without Git stays allowed.

## Consequences

- The Code Project create dialog can offer "Initialize as a Git repository"
  so a new Code thread can prepare a checkout immediately after create.
- Non-Git Code Projects remain creatable when the option is left off.
- Checkout, worktree, and delivery features still observe lazily and fail
  closed when Git is missing.

## Related

- 0017 Code Projects bind any folder (amended consequence only)
- 0003 Product modes and authority
- 0009 Sandbox confinement, approvals, and Plan mode
