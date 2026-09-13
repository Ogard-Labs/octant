# 0120. Clean application background controls

**Status:** Accepted

## Context

0091 made the application ground a theme-owned dither pattern or a person's
photo. Its sliders can technically reduce the pattern to zero, but a person
who wants to see an uploaded photo plainly must also know that the photo is
being quantized by the renderer. The controls did not make either choice
discoverable, and turning the pattern off required changing a visual dial.

## Decision

- `AppBackground.patternEnabled` is a persisted switch that controls whether
  the pattern layer is present. It is independent of the opacity, speed, and
  intensity dials, which remain preserved when the switch is turned off.
- `AppBackground.photoDithered` is a persisted switch that controls whether a
  photo uses the ordered-dither print treatment. When it is off, the renderer
  draws the image at the viewport resolution with ordinary image sampling.
- Settings exposes the switches as **Show pattern** and **Dither photo**. The
  latter appears for a photo ground; both retain the existing dials and scope
  controls. Legacy settings decode both switches as enabled, preserving 0091's
  appearance for existing stores.
- Reduced motion and increased contrast continue to apply as described by 0091. Turning the pattern switch off also makes the resolved pattern static
  and removes its canvas; it does not alter the photo or its opacity.

## Consequences

- A clean photo is one Photo selection plus two explicit switches, without
  relying on three separate slider values.
- The photo renderer has a full-resolution path in addition to the existing
  ordered-dither path; the host image store, limits, and deletion protection
  do not change.

## Related

- 0091 The application ground is the theme's pattern or a person's photo
- 0072 Settings collections stay open
