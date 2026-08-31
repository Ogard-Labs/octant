# 0070. Renderer visual language matches public block catalogs

**Status:** Proposed

## Context

The renderer already owns its control stack: Base UI recipes under
`apps/web/src/ui/shadcn`, Octant adapters under `apps/web/src/ui/base`, and
`bun run ui:check` as the gate. Feature modules do not import Base UI. The
product still reads as a flat, inconsistent workbench because 0016 and
DESIGN.md require hairline panes, 8/10/12px radii, and `shadow-none` cards,
while leftover `.btn*` and feature hover rules repaint those adapters.

[blocks.so](https://blocks.so/) is a MIT, Base UI–backed shadcn catalog. It
is the approved visual reference for grouping, radius, elevation, and
progress. It is not a dependency. Originality and 0016 still forbid vendoring
its source or replacing composers, the shell, Monaco, the terminal, or
authority UX. This record is the scoped exception that changes *how those
owned surfaces look*.

## Decision

- **Stack unchanged.** Base UI remains the only primitive. Feature code
  imports `ui/base` only. Tokens stay `--octant-*`. Radix, a second primitive
  stack, the blocks.so registry, `@blocks-so/*` ids, `cmdk`, and the Vercel
  `ai` chat kit are not added.
- **Visual language.** This supersedes 0016's "ordinary panes stay flat" and
  the 6/8/10/14px radius targets, and DESIGN.md's "avoid oversized setup
  cards" / "Settings is a dense operating surface" of flat `.setrow` groups.
  Remaining 0016 rules stand (adapters, token ownership, scarce accent,
  architecture). New defaults: control radius 10px, panel/card 16px,
  composer/dialog 20px; `OctantCard` uses `--octant-shadow-sm`; floating
  overlays keep `--octant-shadow-overlay`; setup and form objects are raised
  cards with section progress; selected rows use a fill *and* a label.
  Tokens change once in `packages/theme`, `octant.css`, `shadcn-theme.css`,
  and the owned recipes so every surface inherits.
- **Shell stays an ADE.** Navigation rows stay compact (28–32px). Monaco,
  xterm, the dock grid, and authority copy stay Octant-owned. They consume
  the new radii and selection fill; they are not replaced by sidebar or
  table blocks.
- **Composition targets.** Restyle the Octant owner; do not swap in a
  foreign block. Login blocks are unused (no account). `ai-05` is unused.

  | Surface | Octant owner | Public-block pattern |
  | ------- | ------------ | -------------------- |
  | Settings, Provider Settings | `SettingRow`, settings registry | form-layout-01/02/03 |
  | First-run | `FirstRunOnboarding` (0019 / 0033) | onboarding-01/02/03 |
  | Welcome + composer chrome | `ChatWelcome`, `ThreadComposer`, `ComposerModelPicker` | ai-01/02/03/04 |
  | Command palette | `CommandPalette` | command-menu-01/02 |
  | Shared dialogs | `OctantDialog` callers | dialog-01/02/11 |
  | Usage | `UsageDashboard` | stats-12/14 |
  | Boards / empty | board + empty-state owners | grid-list-02, stats-03 |

- **Dual paint dies on contact.** A touched surface drops `.btn*` on
  `OctantButton` and feature CSS that repaints adapter color, border, radius,
  shadow, focus, hover, disabled, or error (0046).
- **Implementation sequence** (design only until Accepted): (1) tokens and
  recipes; (2) Settings; (3) first-run; (4) welcome and composer; (5)
  palette and dialogs; (6) shell selection, usage, boards, Environment.
  Each slice updates DESIGN.md for what shipped.

## Consequences

- The product can look like a modern block catalog while remaining one
  Octant-owned theme and adapter API.
- 0016's ban on replacing composers and the shell stands. Accepting this
  record without the slices would leave DESIGN.md describing the flat
  workbench as current truth.

## Related

- 0016 Component foundation and theme (flat-pane and radius rules scoped here)
- 0019 User profile and first-run setup
- 0033 First run asks what to call you
- 0046 shadcn recipes own product controls
