# 0078. The welcome composer carries its context beneath the prompt

**Status:** Accepted

## Context

0073 gave Chat, Work, and Code one welcome: a hero question, a rear context
tray, and the raised composer in front, with the tray sliding under the
prompt by one corner radius. In use the tray read as a second card peeking
out above the composer rather than as part of it, sat too high over the
prompt, and had to expand in place when one of its controls opened, so the
"Create from…" repository list pushed the prompt down the page and its
labels collided. The prompt itself started at 64px, which reads as a search
field, not a place to describe work.

A maintainer review on 2026-09-03 against GitHub's agent composer set the
direction: one card, prompt first, with the repository, worktree, and branch
on a band attached beneath it.

## Decision

- **One card, prompt first.** The welcome composer is a single raised object:
  the prompt, its toolbar row (attachments, model, access, send), and then a
  lower band. The band is `.composer-tray` rendered as the composer's
  `footer`, ruled off by a hairline and rounded only where the card ends.
  This supersedes 0073's "rear context tray" clause; the rest of 0073's
  welcome rule (hero question, shared recipes, the tray holds where the
  thread runs and the toolbar holds how it runs) still stands.
- **The band wraps; it never grows.** Controls on the band open as anchored
  overlays (`OctantPopover`) or menus. A control that needs a list, such as
  "Create from…", floats over the page instead of expanding the band.
- **A prompt is a paragraph.** The welcome prompt starts four lines tall
  (96px at the default scale) before it grows.

## Consequences

- `styles/surface.css` styles `.composer > .composer-tray` as the attached
  band; the negative-margin tray recipe is gone, and the contract test in
  `theme/visualLanguageContract.test.ts` pins the band and the prompt height.
- The Chat, Work, and Code welcomes pass their context controls through
  `ThreadComposer`'s `footer` slot; no welcome renders a tray beside the
  composer.
- DESIGN.md's "Welcome and composer" section describes the band.

## Related

- 0073 One surface language across the renderer and the site (partially
  superseded: the rear tray clause)
- 0070 Renderer visual language matches public block catalogs
