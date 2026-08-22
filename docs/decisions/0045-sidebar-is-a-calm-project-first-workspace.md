# 0045. Sidebar is a calm project-first workspace

**Status:** Accepted

## Context

0015 made the shell mode-first: Chat, Work, and Code on top, then mode-aware
destinations, Projects and threads, boards, and settings. Layout, the split
tree, and authority still hold. What did not hold under daily use is the
destination grammar. Agents, Automations, Artifacts, Plugins, and Settings sat
as permanent rows above Projects, so the tree a person actually works in
competed with secondary product surfaces. Thread rows mixed folder hierarchy
with implementation identifiers. Empty and setup surfaces dominated the
transcript. 0015 already said visual redesigns can change density and chrome
without touching the layout model; this record is that change for the sidebar.

## Decision

The left sidebar is a calm project-first workspace. Mode still selects
authority; Projects and their threads are the main hierarchy.

- Permanent destinations above Projects are only **New thread**, **Thread
  board**, and **Pull requests**. Chat offers New thread. Work offers New
  thread and Thread board. Code offers New thread, Thread board, and Pull
  requests. A destination the mode or host cannot honestly serve is absent,
  never a dead row.
- Projects and threads are folder rows and children: compact density, one
  selected state, restrained status marks, no raw implementation identifiers
  on the row.
- Secondary project and thread actions are reachable from the keyboard. A
  context menu may remain; it is not the only path.
- Agents, Automations, Artifacts, Plugins, Navigator, and Settings live in
  one keyboard-accessible bottom-left app menu (the existing profile
  disclosure). Gated items are absent, not disabled-looking rows. Usage,
  Providers, and Zen may remain there when the window can offer them.
- The transcript, board, or Project overview stays the visual center. Setup,
  empty, loading, unavailable, stale, and error states are compact and
  truthful. They do not present false affordances or oversized setup cards.
- The right dock remains the thread-aware host of live tools (0044). Chrome
  and launcher presentation may match this hierarchy; tool lifecycle and
  authority do not change.

0015 still owns layout, the split tree, mode authority, boards as real
destinations, and the dock as a region outside the tree. This record
specializes only the sidebar destination grammar.

## Consequences

- Opening Agents, Automations, Artifacts, Plugins, Navigator, or Settings
  takes one extra step through the app menu. Permanent rows above Projects
  shrink to the destinations a person uses to start or survey work.
- A capability that is off is invisible in the menu, so discovering it
  requires Settings or a later enablement path rather than a greyed row.
- Board and Pull requests remain real destinations with honest unavailable,
  stale, empty, and refresh states. This record does not invent those
  backends.
- Future shell chrome follows `docs/DESIGN.md` and the semantic tokens in
  0016 and 0038.

## Related

- 0015 Workspace shell model
- 0016 Component foundation and theme
- 0038 The owned design system stylesheet
- 0041 Panes hold one surface; the sidebar is the only switcher
- 0044 The dock hosts live thread-owned tools
