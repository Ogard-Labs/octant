# 0106. A Zen space arranges itself

**Status:** Accepted

## Context

0015 made Zen a focus zone: several named spaces per window, one shown at a
time, each holding cards bound to their own source context. It said a space is
a place to arrange cards, and the implementation read that as free placement.
Every pin was written at a stored coordinate from a cascade counter, so:

- two pins landed on top of each other, and the second hid the first;
- removing a card left the hole it had been in;
- resizing the window left the arrangement where it was, off screen or bunched;
- the cascade counter never reset, so the tenth card in a space sat past the
  edge of a laptop display.

A focus zone exists to hold several threads in view at once. An arrangement
that hides one card behind another, and that the person has to repair by hand
after every pin and every removal, is the opposite of that.

## Decision

- A space carries a `layout`: `wall` or `arrange`. A new space is a `wall`.
- On a wall the renderer derives every card's rectangle from the number of
  cards and the area on screen. Cards cannot overlap, a removal reflows the
  survivors, and a window resize re-tiles. The wall is computed, never
  journaled.
- The wall reads the space's own element order, not z-index. Raising a card to
  work on it must not move it across the wall, so a wall writes no z-index when
  a card takes focus.
- A wall offers no hand placement: no drag, no resize grip, no arrow-key nudge,
  no pan, and no zoom. Each of those would write a geometry the wall ignores,
  so the card would snap back and the write would misreport what the person
  did.
- The column count follows the card count, and drops when the area is too
  narrow to give each column a readable measure. A short last row spreads its
  cards across the full width rather than leaving one card beside dead space.
- `arrange` is the exception, reached from the surface itself. It uses the
  geometry each card stores and restores drag, resize, nudge, pan and zoom.
- Switching between the two writes only the space's `layout`. Card geometry is
  never rewritten, so leaving `arrange` for the wall and coming back finds the
  arrangement exactly as it was.
- A space journaled before this record replays as a wall too. Its stored
  geometry came from the spawn cascade rather than from a person, so keeping it
  would preserve the stacking this record replaces. Because a wall never writes
  geometry, a space someone did arrange by hand is one press of Arrange away
  from exactly what it was.

This record extends 0015's Zen section, which says a space is a place to
arrange cards, by settling how a space arranges them by default. Every other
rule in 0015 stands, including that a card acts only under its own bound source
context, that a space grants nothing and lends no authority, and that the
element and live-card budgets belong to the space.

## Consequences

- A person can pin several threads and read them without repairing the layout
  after each one, which is what a focus zone is for.
- The layout is responsive, so the same space is usable on a laptop and on a
  large display without being re-arranged by hand.
- Free placement stays available for anyone who wants a specific spatial
  arrangement, and their arrangement survives a trip through the wall.
- The wall is presentation, so it adds no journal event of its own and cannot
  disagree with the aggregate about where a card is.

## Related

- 0015 Workspace shell model (Zen section extended)
- 0091 The application ground is the theme's pattern or a person's photo
- 0016 Component foundation and theme
