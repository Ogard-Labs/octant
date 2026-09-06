# 0085. The application ground is the theme's pattern or a person's photo

**Status:** Accepted

## Context

DESIGN.md kept the page ground plain: avoid decorative gradients, no
decorative animation, one monochrome accent. That held while the start screen
was a hero question over a composer. A maintainer review on 2026-09-06 of a
peer coding workspace's start screen set a different direction for Octant: the
ground is part of the theme, it moves, a person can put a photo of their own
there, dial how strong and how fast it is, and choose whether it stays behind
the start screens or runs under everything, sidebar included.

Two things already exist that the ground joins instead of duplicating. The
sidebar has a background pipeline: custom uploads behind the window's
authority and a store on the host with size and format limits. Workspace
translucency (0047) already knows how to let something show through the
workspace layer and its panes. The theme already resolves one accent per
preset and paints it on the root as `--octant-accent`. A second image library,
a second way to make surfaces see-through, or a second colour source would be
the wrong shape.

## Decision

- **One ground, three kinds.** `ThemeSettings.appBackground` is `theme` (the
  default), `photo`, or `none`, persisted through the theme command like every
  other appearance setting and decoding to `theme` on rows and events written
  before it existed. It is chosen in Settings › Appearance › Background.
- **The pattern is the theme.** The `theme` ground is an ordered-dither cloud
  drawn by Octant's own WebGL2 shader in `apps/web/src/theme/`, one cell per
  three CSS pixels, scaled up without smoothing. Its ink is `--octant-accent`
  exactly as the theme provider painted it, read live, so a preset switch or an
  accent override recolours the ground at once. No shader library is added and
  there is no per-theme artwork to keep.
- **A photo is a print, not a wallpaper.** The `photo` ground is an image from
  the host's background image library, the same store and routes the sidebar
  uses under the same 8 MiB, 4096×4096, PNG/JPEG/WebP limits, drawn once through
  the same ordered dither in its own colours, with the pattern over it. A photo
  the ground shows cannot be deleted from the library while it is in use.
- **The dials travel with the ground.** Pattern opacity, speed, and intensity
  and photo opacity are percentages on the setting, carried across every kind
  so switching away and back loses nothing. Speed zero holds the pattern still;
  opacity zero removes it.
- **Scope is the person's.** `scope` is `welcome` (the default: each start
  screen draws the ground under itself, masked away behind the composer and
  faded below it, so the prompt keeps the plain page) or `everywhere` (the
  ground is drawn once under the whole shell, and the workspace layer, its
  panes, and the page-level surfaces go translucent over it the way 0047
  already makes them for native glass). `coversSidebar` extends an everywhere
  ground under the sidebar by making the sidebar's own paint translucent; it
  has no effect on a welcome-scoped ground.
- **Motion is bounded.** The cloud drifts at no more than 24 frames a second,
  pauses while the document is hidden or the pane is off screen, and holds
  still under `prefers-reduced-motion` or the persisted Reduced motion
  setting. Increased contrast turns the ground off. Without WebGL2 the pattern
  is absent and a photo still shows.
- **A scoped exception.** This supersedes DESIGN.md's "avoid decorative
  gradients" and "no decorative animation" for the application ground alone.
  Controls, cards, menus, and text keep those rules, and the accent stays
  monochrome: the pattern is drawn in the accent, not beside it.

## Consequences

- `packages/contracts` gains `AppBackground`; `packages/domain` resolves it
  against the accessibility settings; `apps/server` refuses to delete a photo
  the ground is showing; `apps/web` gains the backdrop, the pattern and photo
  dither modules, the shell-level stage, and the Settings row.
- DESIGN.md's "Welcome and composer" and "Motion and interaction" sections
  describe the ground, its scope, and its limits; `apps/docs/advanced/themes.md`
  documents the setting and the photo limits.
- A "+" tab in the thread strip, seen in the same review, is a separate change
  under 0041 and is not part of this record.

## Related

- 0016 Component foundation and theme
- 0047 Workspace translucency opt-in (the see-through workspace the everywhere
  scope reuses)
- 0070 Renderer visual language matches public block catalogs
- 0073 One surface language across the renderer and the site
- 0078 The welcome composer carries its context beneath the prompt
