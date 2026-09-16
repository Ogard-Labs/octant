# 0128. Theme patterns may carry a bounded palette

**Status:** Accepted

## Context

Decision 0091 made the application ground a single-accent ordered-dither cloud
and prohibited per-theme artwork. That keeps the workspace quiet, but it also
means a theme whose identity depends on several colours cannot express that
identity in the only decorative surface Octant permits. Pride needs a visible
spectrum, and Norway needs its red, white, and blue relationship; reducing
either to one accent would make the names cosmetic rather than truthful.

The semantic surface and control roles still need one contrast-validated accent.
The artwork should not add image assets, a second renderer, or unbounded theme
data.

## Decision

- A built-in theme may define an ordered `patternPalette` of one to six
  six-digit hex colours. Presets without one continue to use the resolved accent
  alone.
- The resolved semantic accent is always the first pattern ink. An accent
  override therefore remains visible in the ground without allowing artwork
  colours to bypass semantic contrast validation.
- The existing ordered-dither WebGL2 cloud remains the only theme-pattern
  renderer. It interpolates across the bounded inks inside the cloud; themes do
  not ship separate shaders, scripts, images, or animation rules.
- Multi-colour treatment is confined to the application ground. Controls,
  text, status roles, charts, selection, and focus continue to use semantic
  theme tokens and their existing contrast gates.
- The existing motion and accessibility boundaries remain: reduced motion holds
  the pattern still, increased contrast removes the ground, and a client without
  WebGL2 falls back to the plain ground or selected photo.

## Consequences

- `@octant/theme` owns and validates the optional palette with the preset.
- The renderer projects the active palette beside the semantic tokens and feeds
  it to the shared pattern without knowing named themes.
- Pride can use a six-colour spectrum and Norway can use a red, white, and blue
  palette while both retain readable light and dark semantic surfaces.
- Theme catalog serialization includes the palette so downstream first-party
  surfaces can represent the same visual identity.

## Related

- 0016 Component foundation and theme
- 0091 The application ground is the theme's pattern or a person's photo
- 0108 A Zen space may stand on the application ground
