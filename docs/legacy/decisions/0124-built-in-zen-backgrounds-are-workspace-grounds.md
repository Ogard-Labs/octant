# 0124. Built-in Zen backgrounds are workspace grounds

**Status:** Accepted

## Context

0091 made the application ground a theme pattern, a person's photo, or a
plain page. 0108 then let Zen stand on that same resolved ground, while Zen's
Appearance panel kept a separate first-party image catalog for its own spaces.
That split meant a person could preview and choose the built-in images in Zen,
but could not use the same images behind the ordinary workspace or start
screens.

The catalog already contains the still frames, animated WebP assets, and
reduced-motion-friendly pairings. Maintaining a second workspace catalog would
make the choices drift and would give the same image two persistence shapes.

## Decision

- The application ground gains a `builtin` kind with a `presetId` from the
  shared Zen first-party catalog. The existing `theme`, `photo`, and `none`
  kinds, tuning dials, and `welcome`/`everywhere` scope remain unchanged.
- Settings › Appearance › Background presents the built-in catalog with the
  same grouped, still-frame preview tiles as Zen Appearance. Selecting a tile
  persists the built-in id and keeps the existing pattern and scope dials.
- The resolved ground carries the selected public asset and its still frame.
  Animated presets use their WebP when motion is allowed; Reduced Motion or a
  reduced-motion system preference resolves the still frame instead.
- The renderer draws a built-in asset through the existing `AppBackdrop` layer.
  Built-ins are bundled public assets, so they never use the authenticated
  photo library or its deletion protection.

## Consequences

- Zen spaces using the application ground automatically show the same built-in
  image and accessibility fallback as the shell; no second Zen setting or
  renderer is introduced.
- `packages/contracts/src/backgroundCatalog.ts` owns the shared id schema so
  the Zen and application-ground contracts cannot silently diverge.
- The application-ground docs now describe four selectable kinds. The
  existing accessibility and surface translucency decisions still govern how a
  ground is resolved and shown.

## Related

- 0091 The application ground is the theme's pattern or a person's photo
- 0108 A Zen space may stand on the application ground
- 0120 Clean application background controls
