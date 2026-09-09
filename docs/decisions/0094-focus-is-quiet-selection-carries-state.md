# 0094. Focus is quiet; selection carries state

**Status:** Accepted

## Context

Octant's controls are used in a dense desktop workspace where a focus halo
made every click look like a new outlined object. The global ring from 0090
also competed with selected and expanded fills, and individual surfaces had
started to add their own outlines and shadows to compensate. That produced
several focus languages and made the composer read as nested fields.

The keyboard contract still matters: focus order, keyboard activation, listbox
semantics, and selected or expanded state must remain intact. The change is
the visual treatment around a focused element.

## Decision

- Focusable elements keep their native DOM focus, keyboard order, activation,
  and ARIA state. The app's global `:focus-visible` rule suppresses the drawn
  outline and halo instead of painting a replacement ring.
- Hover, selected, checked, expanded, and pressed fills remain the visible
  state cues where a control exposes those states. A focus selector may reveal
  an action or change text colour, but it must not add an outline, ring, or
  focus-only shadow.
- Focus-within remains valid for structural behavior such as revealing a row
  action or keeping a popover open. It does not draw a focus ring.
- The `focus-ring` theme role and bridge token remain available for imported
  theme compatibility and derived accent tints. They are not painted as a
  focus indicator.
- New UI stylesheet checks and rendered review must preserve these rules.

This record supersedes only 0090's focus-ring rule and its consequences. 0090's
radius, elevation, type hierarchy, primitive ownership, selected-row fills, and
all other shell rules remain in force.

## Consequences

- Composer, dock, Settings, list, and picker controls share one quiet focus
  treatment while keyboard behavior remains available to assistive technology.
- Selected and expanded states are easier to read because a focus halo no
  longer competes with their fills.
- Theme editors can continue to round-trip the focus role without implying
  that a custom color will create a visible ring.

## Related

- 0089 Product controls follow the Base UI-native shadcn style
- 0090 Recipes own their shape; the app owns its focus ring (partially superseded)
- 0016 Component foundation and theme
