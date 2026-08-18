# 0031. Hosts as environments

**Status:** Accepted

## Context

A person who runs Octant on a laptop and a workstation has two of everything:
two sidebars, two lists, two places to look for the thing they started
yesterday. 0015 described one window's shell; it did not say what a window
shows when more than one host is connected.

The tempting fix is to make the window the authority — gather everything into
one list and let whichever window is open act on any of it. That moves
execution to whoever is looking, which is precisely backwards: a thread runs
where its files, its checkout, and its credentials are.

This record extends 0015 and sits beside 0013, which already governs how a
client reaches a host it does not run on. It changes neither.

## Decision

- **An environment is a connected host under the name a person uses for it.**
  It is vocabulary and view state, nothing more. The host this window runs on
  is always **"Local"**, whatever the machine is called — a person does not
  think of the machine they are sitting at by its name, and two people looking
  at one federation should each see their own as Local.
- **Ownership never moves.** An item is owned and executed only by its own
  host. Other hosts render it through merged reads, and every mutation travels
  to the owning host as a journaled remote command under 0013's authority. A
  list that gathers from four environments still runs nothing.
- **Filtering, grouping, and ordering are pure client-side view state.** They
  decide what is shown and in what order, never what may happen. One vocabulary
  serves every gathered list — the sidebar, the routines center, the artifact
  library — so a person who learned it in one list already knows it in the next,
  and two surfaces cannot disagree about what an environment is called.
- **"All environments" means all, including the ones not connected yet.** It is
  not a frozen set of today's host ids: a host that connects tomorrow is
  included, because freezing the set is what makes a new machine's work
  invisible.
- **An unreachable environment goes stale, never absent.** Its row keeps its
  place and its count, and its items stay listed and marked stale. A host that
  dropped out is a thing to see; a list that empties itself on a dropped
  connection is a list nobody can trust.
- **A row says which environment owns it only when that is not this one.**
  Badging every row would make the machine you are sitting at look like one
  more remote environment.
- **Creating names a destination.** New work is created on one environment,
  chosen before the facts that depend on it, and it defaults to Local. The
  Projects, bindings, and profiles offered are facts of the destination host,
  never of the window doing the asking.

## Consequences

- Every gathered list needs an owning-host column in its data, and every
  mutation needs a route to that host. That is the cost of not letting the
  window act as an authority, and it is the cost we want.
- A person can filter their way to an empty list. Saying "nothing matches the
  current filters" and that nothing was deleted is part of the feature, not an
  edge case.
- Offering a destination the client cannot actually create on would be a
  control that does nothing. A destination is offered only where the facts it
  needs can be fetched and the command can be routed.

## Linux headless hosts

Linux headless hosts are an accepted direction, so nothing in the environment
model may assume macOS. Environment rows already derive their name from the
shared vocabulary rather than from a platform, and "Local" is platform-neutral
by construction.

What a Linux host will need before it can be one of these environments:

- **Confinement to replace Seatbelt.** 0009's guarantees are stated as
  behavior, not as a macOS mechanism. A Linux host must provide an equivalent
  confinement and **fail closed** where it cannot — a host that cannot confine
  runs nothing, rather than running it unconfined.
- **A credential store to replace Keychain.** Credentials must live in an
  OS-provided secret store with the same properties, and a host without one
  **fails closed**: no credential, no provider, rather than a file on disk
  standing in for a keychain.

Both are host capabilities, not federation contract changes. Until a host
reports them, it is not offered as a destination.

## Related

- 0009 Sandbox confinement, approvals, and Plan mode
- 0013 Remote clients and mobile
- 0015 Workspace shell, navigation, and layout
