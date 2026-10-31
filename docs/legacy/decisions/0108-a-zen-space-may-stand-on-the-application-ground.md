# 0108. A Zen space may stand on the application ground

**Status:** Accepted

## Context

Octant has two grounds that have never met.

0091 gave the application one: an ordered-dither cloud in the theme's accent,
or a person's photo printed through the same dither, with opacity, speed, and
intensity dials, configured once in Settings › Appearance › Background. Its
scope is `welcome` or `everywhere`, and both are readings of the shell.

Zen has a ground of its own, older than that one: a solid colour, a gradient,
a first-party preset, or a local image, chosen in the space's own Appearance
panel. 0107 then gave Zen's cards, bars, and panels glass, on the reasoning
that Zen is the surface where one puts an atmospheric ground behind the work.

So the surface whose whole point is a ground was the one surface that could
not show the ground the person had already configured. Someone who set the
cloud in Settings and then entered Zen lost it at the door, and the only way
to get something like it back was to pick one of Zen's own pictures instead.

The wrong fix is a second cloud: a Zen copy of the pattern renderer, or a Zen
copy of the dials. Two implementations of one ground drift, and a space
carrying its own opacity and speed would disagree with the app it was meant
to match the moment either was changed.

## Decision

`ZenBackground` gains a fifth kind, `theme`, and it carries no fields.

- A space of that kind is drawn by the application's own `AppBackdrop`, from
  the same `ResolvedAppBackground` the shell draws, so there is one pattern
  renderer, one photo library, and one set of dials. What the ground shows is
  the person's Background setting, read where the surface is drawn.
- Zen's Appearance panel offers it above the built-in pictures, not among
  them, and says where its settings live. It is not a picture Zen owns.
- The backdrop takes a third placement, `zen`, beside `welcome` and `shell`.
  Zen fills the window edge to edge, has no composer to mask away, and reads
  its text through glass rather than directly off the ground, so the `zen`
  placement takes no mask and stays under the space's own dimmer and canvas.
- The space's `dimming` still lies over it, as it does over every other Zen
  ground. Nothing else about the ground is a Zen setting.
- Accessibility stays where it already is. The resolved value arrives with
  Increased contrast having turned the ground off and Reduced motion having
  held the pattern still; Zen resolves the same two preferences for its own
  surface and honours whichever reading asks for less.
- This extends 0091's scope rather than replacing it. `welcome` and
  `everywhere` remain the shell's two readings and are unchanged; Zen is not a
  third scope, because a space asks for the ground itself rather than the
  Settings row reaching into Zen.

## Consequences

- `packages/contracts` gains the `theme` member; `apps/web` threads the
  resolved application background and its authenticated fetcher into
  `ZenSurface` as optional props, so a caller that has no ground to offer
  renders a space exactly as before.
- A space that asks for the application ground while that ground is off shows
  the theme's plain workspace colour, without Zen's dot grid: the grid marks
  an unconfigured Zen ground, and this one is configured elsewhere.
- No server change. The kind carries nothing to validate, nothing to store
  beyond itself, and no asset to keep alive.

## Related

- 0091 The application ground is the theme's pattern or a person's photo
- 0107 Zen wears glass over its ground
- 0016 Component foundation and theme
