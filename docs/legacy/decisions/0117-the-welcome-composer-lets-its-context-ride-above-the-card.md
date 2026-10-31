# 0117. The welcome composer lets its context ride above the card

**Status:** Accepted

## Context

0078 attached where-the-thread-runs pickers (Project, base branch, host,
workspace, Create from…) to a band inside the composer card, ruled off by a
hairline under the toolbar. In use the band made the welcome's one object
read as a two-box stack — a field card glued to a dimmed second card — and
it duplicated what the tray had already been moved out of once before: an
attached chrome band competing with the prompt it serves.

A maintainer review on 2026-09-11 against a peer coding harness's start
screen set the direction: the pickers sit in a quiet row above the card,
and the composer stays a single clean object — prompt and send row.

## Decision

- **The composer is one object.** The welcome composer carries only the
  prompt and its toolbar row. Nothing renders as a band inside the card,
  and no welcome attaches a tray beneath or behind it.
- **Context rides above.** The pickers that decide where the thread runs
  sit in `.composer-tray--above`, a quiet row immediately above the card on
  the page ground — chips and menus, no fill, no border, no band chrome.
  The row wraps rather than grows; a control that needs a list still floats
  over the page (0078's wrapping rule stands).
- **A prompt is a paragraph.** The welcome prompt still starts four lines
  tall (96px at the default scale) before it grows; 0078's prompt rule
  stands.

This supersedes 0078's "lower band" clause; its wrapping and prompt-height
rules carry forward. The rest of 0073's welcome rule (hero question, shared
recipes, the row holds where the thread runs and the toolbar holds how it
runs) still stands.

## Consequences

- `styles/surface.css` styles `.composer-tray--above` as the quiet row; the
  `.composer > .composer-tray` band recipe is gone, and the contract test in
  `theme/visualLanguageContract.test.ts` pins the row's placement and the
  prompt height.
- The Chat, Work, and Code welcomes render their context controls above
  `ThreadComposer` inside `.composer-stack`; none pass them through the
  composer's `footer` slot.
- DESIGN.md's "Welcome and composer" section describes the row.

## Related

- 0078 The welcome composer carries its context beneath the prompt
  (superseded: the lower-band clause)
- 0073 One surface language across the renderer and the site
- 0098 Follow-up composers separate message and context
