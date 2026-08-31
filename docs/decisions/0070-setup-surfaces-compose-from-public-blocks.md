# 0070. Setup surfaces compose from public block catalogs

**Status:** Proposed

## Context

The renderer already owns its control layer: Base UI recipes under
`apps/web/src/ui/shadcn`, Octant adapters under `apps/web/src/ui/base`, and
`bun run ui:check` forbidding feature imports of either plus undocumented raw
controls. Settings, first-run, chat welcome, and the command palette all
compose those adapters. The remaining inconsistency is composition, not
missing primitives: leftover feature CSS still repaints adapter hover and
radius, `.btn*` classes still sit on `OctantButton`, and Settings / first-run
read as a flat dump of `.setrow` groups.

[blocks.so](https://blocks.so/) is a MIT, Base UI–backed shadcn registry of
copy-paste blocks (AI composers, onboarding checklists, command menus, form
layouts). It is a useful visual reference for those surfaces. 0016 still
forbids replacing composers, the shell, Monaco, the terminal, or authority UX
with a recipe catalog. Originality forbids importing another product's source,
identifiers, or distinctive implementation. This record is the scoped
exception that lets those four surfaces group and progress like a public
block without vendoring one.

## Decision

- **Controls stay Octant-owned.** Feature code imports `ui/base` only. 0016
  and 0046 still own interaction, tokens, and who paints a button. `ui:check`
  remains the gate. Touching a surface removes leftover `.btn*` dual recipes
  and feature rules that repaint adapter color, border, radius, shadow,
  focus, hover, disabled, or error.
- **Public catalogs are reference, not source.** Do not add the blocks.so
  registry, `@blocks-so/*` identifiers, `cmdk` as a second palette, the Vercel
  `ai` chat kit, or copied block markup. Implementation is an independent
  restyle of the existing Octant surfaces.
- **These surfaces may use card grouping and progress.** This is a scoped
  exception to 0016's "ordinary panes stay flat" and to DESIGN.md's "Settings
  is a dense operating surface" / "avoid oversized setup cards", for exactly:
  the Settings reading column, first-run, Chat/Work/Code welcome, and the
  command palette. Cards, section progress, and a raised composer chrome are
  allowed there when they make a discrete setup object scannable. Tokens,
  radii, density, Lucide, and typography stay Octant. Shell tree, boards,
  Environment, dock, Monaco, and the terminal stay hairline panes.
- **Composition targets, not replacements.** Restyle the named Octant owner;
  do not swap in a foreign block.

  | Surface | Octant owner | Public-block pattern to match |
  | ------- | ------------ | ----------------------------- |
  | Settings rows and provider forms | `SettingRow`, settings registry, Provider Settings | Side-label groups; checkbox/select settings page; workspace field groups |
  | First-run | `FirstRunOnboarding` (0019 / 0033 steps) | Checklist with completed / active / pending and a progress mark |
  | Chat welcome and composer chrome | `ChatWelcome`, `ThreadComposer`, `ComposerModelPicker` | Centered heading, model control in the composer, attachment chips, starter prompts |
  | Command palette | `CommandPalette` | Grouped results and shortcut badges on the existing dialog/combobox |

- **Out of scope.** Sidebar, login, data-table, and full-chat-kit blocks do
  not replace the workspace shell, transcript, or authority UX. Octant has
  no account, so login blocks are unused. First-run keeps write-through
  settings and the five-step order; this record does not add a second wizard.
- **Implementation sequence** (design only until Accepted): (1) Settings
  reading column and Provider Settings grouping; (2) first-run checklist and
  progress; (3) welcome + composer chrome; (4) command-palette grouping and
  shortcut badges. Each slice updates DESIGN.md for the shipped composition.

## Consequences

- Setup surfaces can look like a modern block catalog while the adapter,
  theme, and originality rules stay one owner.
- 0016's architectural ban on replacing composers and the shell stands. 0046
  still forbids a second paint path once a slice is touched.
- Accepting this record without the slices would leave DESIGN.md describing
  flat Settings as current truth; DESIGN.md updates only with the shipped
  surface.

## Related

- 0016 Component foundation and theme (flat-pane rule scoped here)
- 0019 User profile and first-run setup
- 0033 First run asks what to call you
- 0046 shadcn recipes own product controls
