# 0107. Zen wears glass over its ground

**Status:** Accepted

## Context

Zen is the focus zone: several threads at once over a ground the person
chose. The ground is the point of the surface. A person picks a photo, a
gradient, or the theme's own dither cloud, and then works on top of it.

Every Zen surface today paints the app's opaque surface roles. A card is
`--oct-surface` with a hairline; the orbit bar and its pills are the same.
Over a photograph that reads as a solid rectangle stamped on a picture: the
ground survives only in the gutters between cards, and the more threads a
person opens the less of it is left. The surface asks for a ground and then
covers it up.

The design system already has the material this wants. `--oct-glass-*` is a
five-thickness ladder of blurred tints, hairline strokes, and a top inner
highlight, with fallbacks for reduced transparency and for engines without
`backdrop-filter`. It was built for the phone, and scoped away from the
desktop on purpose:

> Glass earns its place on the phone and nowhere else. On desktop this system
> draws elevation as a hairline ring and no shadow, because a dense
> information surface wants edges, not depth. A phone shows one thing at a
> time over a photographic ground, and there translucency is what tells you a
> panel is floating rather than painted on.

That reasoning is about the surface, not the device. The phone earns glass
because it puts one thing at a time over a photographic ground. Zen is that
same condition on a desktop. The rule named the device when it meant the
condition, and Zen is the case that shows the difference.

## Decision

Glass belongs where a person has put an atmospheric ground behind the work.
That is the phone and Zen, and nowhere else.

Zen's cards, orbit bar, and pills take the `--oct-glass-*` ladder. The rest of
the desktop keeps its hairline-and-no-shadow elevation, because nothing there
sits over a ground.

Zen's panels are the one surface this decision authorises but does not yet
reach. They ride the OctantCard adapter, and a feature rule may not repaint a
shared control (0046), so a panel stays opaque until that adapter gains a glass
variant. That variant is its own change; this record is what authorises it.

Zen does not get a second palette. The glass tint, its stroke, and its
highlight are theme roles like every other colour in the app, and
`packages/theme` stays the one runtime theme authority. What Zen gets is a
different _material_, not a different colour system. Because the ground shows
through it, a Zen space over a bright photograph reads bright even in a dark
theme. That is the material working, not the theme leaking.

Thickness follows how much text a surface carries, which is what the ladder
already encodes: a card body, where a transcript reads, takes the thick step;
floating chrome takes the chrome step.

A glass surface must carry its own legibility, because the ground under it is
a photograph the app never sees. The tint alone does not: measured against a
pure white ground in the dark theme with the dimming dial at zero, body ink on
a card reads 2.97:1, well under the 4.5:1 the type needs.

So every glass surface pours its tint over `--oct-glass-floor`, in that order,
the way the phone lays that floor over its atmosphere. That takes the same
worst case to 8.36:1 on a card and 7.88:1 on the orbit bar, and a light theme
over a black ground to 11.90:1. A dark ground is unaffected, because the floor
is already darker than what is behind it, so the material loses nothing where
these grounds usually sit.

The dimming dial stays what it was: the person's control over how much of
their own ground they want to see. It is no longer the only thing between body
text and a photograph.

Reduced transparency, as an app setting or an OS preference, and an engine
without `backdrop-filter` support both drop every glass surface to the opaque
floating surface, exactly as they do on the phone.

## Consequences

- The scoping comments in `apps/web/src/styles/octant.css` and the mobile note
  in `DESIGN.md` no longer say "the phone and nowhere else". They name the
  condition instead, and list both surfaces that meet it.
- The material is applied by naming each Zen surface, not by scope, because a
  Zen surface can be a shared control that a feature rule may not repaint. A
  surface added later takes the material by being named here and in
  `octant.css`, or by asking its adapter for a glass variant.
- Increased contrast keeps its existing behaviour: it turns the ground off,
  which leaves the glass with nothing to blur and the opaque floor beneath it.
