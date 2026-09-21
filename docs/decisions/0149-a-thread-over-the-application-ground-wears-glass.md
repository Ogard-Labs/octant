# 0149. A thread over the application ground wears glass

**Status:** Accepted

## Context

0107 made glass the material for a surface with an atmospheric ground behind
the work, and named the two surfaces that met that condition then: the phone
and Zen. It closed with "and nowhere else", and gave the reason: nothing else
on the desktop sits over a ground.

0091 then let a person put the application ground behind everything. With that
scope a thread's workspace is transparent over a photo or the theme's pattern,
and each reply carries its own reading card so its text has a surface. That
card, the person's bubble, and the composer are painted opaque. Over a photo
they read as slabs stamped on the picture, the same complaint 0107 answered for
Zen: the ground survives only in the gutters between them, and the more a
thread says the less of the ground is left.

A thread over the application ground now meets the condition 0107 names. Only
its list of surfaces is out of date.

## Decision

This is a scoped exception to one rule of 0107: "That is the phone and Zen, and
nowhere else." A third surface meets the condition and takes the material:

- A Chat, Work, or Code thread shown over the application ground. Its reply
  card, the person's message bubble, and the composer take the thick step of
  the glass ladder, because each carries running text. A follow-up composer is
  one pane at the chrome step, and the message surface inside it adds one more
  thick tint rather than a second blurred pane.

Everything else 0107 decided still stands, and applies here unchanged:

- The tint, stroke, and floor are the theme's glass roles. There is no second
  palette.
- The tint is poured over `--oct-glass-floor`, which is what keeps body text
  legible over a white photograph (8.36:1 in 0107's worst case).
- Reduced transparency, as an app setting or an OS preference, and an engine
  without `backdrop-filter`, keep the opaque paints these surfaces had before.
  A browser that cannot report the transparency preference is treated the same
  way.
- The rest of the desktop keeps its hairline-and-no-shadow elevation. Menus,
  popovers, dialogs, and the Environment stay opaque (0047). A thread with the
  ground behind the start screen only, or on a translucent workspace without
  the application ground, is unchanged.

## Consequences

- `apps/web/src/styles/octant.css` names the three thread surfaces beside
  Zen's glass rules, so the ladder keeps one definition.
- DESIGN.md's glass rule lists the thread over the application ground with the
  phone and Zen.
- A surface added to a thread later does not take glass by being inside the
  thread. It is named here and in `octant.css`, as 0107 requires of Zen.
- Each glass surface re-blurs the moving pattern behind it on every frame. A
  thread shows a handful of cards at once, about what a Zen wall shows, and
  reduced motion holds the pattern still.

## Related

- 0047 Workspace translucency opt-in
- 0091 The application ground is the theme pattern or a photo
- 0107 Zen wears glass over its ground
- 0108 A Zen space may stand on the application ground
