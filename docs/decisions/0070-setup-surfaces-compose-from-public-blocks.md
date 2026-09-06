# 0070. Renderer visual language matches public block catalogs

**Status:** Superseded by 0086

## Context

The renderer already owns its control stack: Base UI recipes under
`apps/web/src/ui/shadcn`, Octant adapters under `apps/web/src/ui/base`, and
`bun run ui:check` as the gate. Feature modules do not import Base UI. The
product still reads as a flat, inconsistent workbench because 0016 and
DESIGN.md require hairline panes, 8/10/12px radii, and `shadow-none` cards,
while leftover `.btn*` and feature hover rules repaint those adapters.

Public block catalogs are the approved visual reference for grouping, radius,
elevation, and progress. They are not a dependency. Originality and 0016 still
forbid vendoring catalog source or replacing composers, the shell, Monaco, the
terminal, or authority UX. This record is the scoped exception that changes
_how those owned surfaces look_.

## Decision

- **Stack unchanged.** Base UI remains the only primitive. Feature code
  imports `ui/base` only. Tokens stay `--octant-*`. A second primitive stack,
  a catalog registry package, or a third-party chat kit is not added.
- **Visual language.** This supersedes 0016's "ordinary panes stay flat" and
  the 6/8/10/14px radius targets, and DESIGN.md's "avoid oversized setup
  cards" / "Settings is a dense operating surface" of flat `.setrow` groups.
  Remaining 0016 rules stand (adapters, token ownership, scarce accent,
  architecture). New defaults: control radius 10px, panel/card 16px,
  composer/dialog 20px; `OctantCard` uses `--octant-shadow-sm`; floating
  overlays keep `--octant-shadow-overlay`; setup and form objects are raised
  cards with section progress; selected rows use a fill _and_ a label.
  Runtime radius and elevation aliases change once in `styles.css`,
  `octant.css`, `shadcn-theme.css`, and the owned recipes so every surface
  inherits. Persisted semantic colours remain owned by `packages/theme`.
- **Shell stays an ADE.** Navigation rows stay compact (28–32px). Monaco,
  xterm, the dock grid, and authority copy stay Octant-owned. They consume
  the new radii and selection fill; they are not replaced by sidebar or
  table blocks.
- **Composition targets.** Restyle the Octant owner; do not swap in a
  foreign block. There is no account login surface.

  | Surface                     | Octant owner                                           | Visual pattern                   |
  | --------------------------- | ------------------------------------------------------ | -------------------------------- |
  | Settings, Provider Settings | `SettingRow`, settings registry                        | Raised form cards                |
  | First-run                   | `FirstRunOnboarding` (0019 / 0033)                     | Stepped progress on cards        |
  | Welcome + composer chrome   | `ChatWelcome`, `ThreadComposer`, `ComposerModelPicker` | Raised prompt card, quiet chrome |
  | Command palette             | `CommandPalette`                                       | Searchable command list          |
  | Shared dialogs              | `OctantDialog` callers                                 | Raised dialog card               |
  | Usage                       | `UsageDashboard`                                       | Stat cards                       |
  | Boards / empty              | board + empty-state owners                             | Card grid and empty state        |

- **Dual paint dies on contact.** A touched surface drops `.btn*` on
  `OctantButton` and feature CSS that repaints adapter color, border, radius,
  shadow, focus, hover, disabled, or error (0046).
- **Implementation sequence**: tokens and recipes first, followed by Settings,
  first-run, welcome and composer, palette and dialogs, then shell selection,
  usage, boards, and Environment. Each shipped slice updates `DESIGN.md`.

## Consequences

- The product can look like a modern block catalog while remaining one
  Octant-owned theme and adapter API.
- 0016's ban on replacing composers and the shell stands. `DESIGN.md`, the
  owned recipes, and the visual-language contract tests ship with this record.

## Related

- 0016 Component foundation and theme (flat-pane and radius rules scoped here)
- 0019 User profile and first-run setup
- 0033 First run asks what to call you
- 0046 shadcn recipes own product controls
- 0086 supersedes this record on radius, elevation, and the single-owner focus
  ring. Its stack, token, shell, and dual-paint rules are carried forward there.
