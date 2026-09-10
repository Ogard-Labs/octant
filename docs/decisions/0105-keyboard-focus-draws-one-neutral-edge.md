# 0105. Keyboard focus draws one neutral edge

**Status:** Accepted

## Context

0094 removed the drawn focus indicator and left the state fills to carry
focus. Measured on the shipped dark theme, they do not carry it. The quiet
focus fill a ghost or outline control receives is `--octant-control` on the
workspace, a 1.23:1 step; the `default`, `secondary`, `destructive`, and
`link` button variants receive no focus treatment at all, and a global
`:focus-visible { outline: none }` removes the browser's own indicator from
every control the recipes do not cover. A keyboard user cannot see where they
are, which fails WCAG 2.4.7 and, at that contrast, 2.4.11.

The reason 0094 removed the ring still holds: the accent halo it replaced made
every focused control read as a new outlined object, and it competed with the
selected and expanded fills. What was wrong was the colour and the weight of
that indicator, not the existence of one.

## Decision

- Keyboard focus draws one indicator, declared once, for every focusable
  element: a 1px inset outline in `--oct-focus-edge`. It is an outline, so it
  never moves layout and needs no border of its own, and it is inset, so a
  dense list or a scrolling container cannot clip it.
- `--oct-focus-edge` is mixed from the foreground, not from the accent and not
  from the `focus-ring` theme role. A focused control never reads as a coloured
  halo, and the edge tracks any theme or preset without its own token.
- The indicator is `:focus-visible` only. A pointer press does not match it, so
  clicking a control still paints nothing.
- Hover, selected, checked, expanded, and pressed fills remain the state cues
  they were. They are not the focus indicator and are not required to carry it.
- A container that takes focus only to hold the keyboard (a popup, positioner,
  listbox, canvas, or preview surface) suppresses the edge on itself; the item
  inside it that the user is actually on shows it.
- A surface may not re-suppress the edge on a control a user can reach. Feature
  CSS does not declare its own focus outline, ring, or focus-only shadow.

This record supersedes one rule of 0094: that the global `:focus-visible` rule
suppresses the indicator rather than painting a replacement. Every other rule
in 0094 stands, including that the `focus-ring` theme role and bridge token are
never painted as the indicator, that state fills carry state, and that
`focus-within` remains structural.

## Consequences

- Keyboard navigation is visible on every control, at a measured 4.9:1 against
  the workspace in both schemes, without an accent halo.
- One declaration owns the treatment, so a new control inherits it and a
  surface cannot invent a second focus language.
- Controls that had accumulated their own focus suppression lose it; the four
  button variants that had no focus treatment gain the shared one.

## Related

- 0094 Focus is quiet; selection carries state (partially superseded)
- 0090 Recipes own their shape; the app owns its focus ring
- 0016 Component foundation and theme
- 0089 Product controls follow the Base UI-native shadcn style
