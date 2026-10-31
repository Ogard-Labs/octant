# 0118. A default folder for what nobody gave a home

**Status:** Accepted

## Context

0037 removed rootless threads: every Work and Code thread belongs to a Project,
and a composer with no Project cannot start a turn. That kept one thread stack
instead of two, and it stays right. What it cost was the quickest start there
is — a question that does not belong to any folder — which now demanded a
folder anyway, and every such question produced a Project the person did not
want to keep.

Code had a second wall. 0017 lets a Code Project bind any folder, but thread
start prepares a checkout observation, and a folder that is not a repository
failed it. 0079 offered `git init` at create; a person who did not want a
repository in that folder had no path at all.

Two more things had no home: the artifact mirror wrote nothing by default
(0029), and the one folder Octant made on its own was `~/Octant/Repositories`,
hardcoded, for managed clones.

## Decision

- **One default folder, host-wide, configurable.** `ShellSettings.defaultFolder`
  names it; absent means `~/Documents/Octant`, which the host fills in on read
  so every client sees the folder in effect. A folder the person names must be
  inside their home — the same boundary 0029 draws for the mirror's global
  folder — and is judged on the host before it is journaled.
- **A thread without a Project starts in the mode's default Project.** The
  composer offers "No Project — use the default folder". Choosing it asks the
  host to `ensure-default-project`: the host creates `<default folder>/Work` or
  `<default folder>/Code` if missing, binds it as an ordinary Work or Code
  Project marked `origin: "default-folder"`, and returns the same Project on
  every later ask while the default folder is unchanged. Changing the folder
  provisions a new default Project; the old one stays an ordinary Project with
  its threads. This amends 0003's "the only folder Octant may create is a
  managed clone" and 0037's "a composer with no Project selected cannot start a
  turn": there is still no rootless thread, no second thread stack, and no
  inferred root — the Project is real, journaled, and chosen by an explicit row.
- **Work always may; Code only by its own switch.** The default folder is not
  a repository, so a Code thread there can start only while the Git requirement
  is off. `CodeSettings.allowDefaultFolderThreads` (default off) sits beside
  `requireGitRepository`; the host refuses to journal both on at once, and
  refuses `ensure-default-project` for Code while the switch is off. Turning
  the Git requirement back on turns this off with it.
- **Code may run in a plain folder when the person turns the Git requirement
  off.** `CodeSettings.requireGitRepository` defaults to on, which is what Code
  always did. Off, a folder observed as `not-repository` yields a `plain-folder`
  checkout whose head is `{ kind: "none" }` and whose repository identity is a
  digest of the canonical root. Everything that needs a revision — branches,
  worktrees, diffs, pushes, pull requests, repository tests, Apple evidence,
  child worktrees — reads the `none` head and reports itself unavailable. It
  never invents an object id and never runs `git init` on its own. Files,
  terminal, search, and turns work on the folder as they would on a checkout.
  This amends 0079's consequence that a non-repository Code Project's first
  thread cannot start; 0017's binding rule is unchanged.
- **Artifact files mirror under `<default folder>/Artifacts` until someone
  chooses otherwise.** The mirror's fallback, when no mirror setting has ever
  been journaled, is a global folder there. The first mirror command a person
  issues journals that effective fallback rather than the empty record's
  `internal-only`, so setting one override does not quietly turn files off.
  This amends 0029's "writing nothing is the default"; its one-way, derived,
  re-import-by-version, and inside-home rules stand.

## Consequences

- Starting a Work or Code thread costs one row in the Project menu rather than
  a folder picker. The default Projects show in the sidebar as Projects, named
  "Octant folder", and can be renamed, archived, or given memory like any other.
- All folderless threads of a mode share one folder. That is the trade for one
  thread stack: per-thread subfolders would need a root narrower than the
  Project's, which nothing in Work or Code has today.
- A plain-folder Code thread is a Code thread with most of its Git surface
  saying "unavailable". `git init` in the folder later makes the next prepare
  observe a real checkout; the plain-folder checkout stays in the journal as
  history for the threads that used it.
- Managed clones keep `~/Octant/Repositories`. Moving an inventory with clones
  in it is its own change with its own recovery, recorded as a follow-up.

## Related

- 0003 Product modes: Chat, Work, and Code authority (amended: folder creation)
- 0017 Code Projects bind any folder
- 0029 The artifact storage mirror (amended: default destination)
- 0037 A thread starts in a Project (amended: the composer's no-Project path)
- 0079 Code Project creation may initialize Git on request (amended consequence)
