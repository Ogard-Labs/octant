# Octant UI component layer

This directory plus `../styles/components.css` is the defined component set
for the shared renderer. Build features from these pieces; do not restyle
them inside feature stylesheets.

## Interactive primitives (`ui/base`)

| Primitive                                        | Use for                                                           |
| ------------------------------------------------ | ----------------------------------------------------------------- |
| `OctantButton`                                   | All buttons (primary/secondary/ghost/icon variants)               |
| `OctantInput`, `OctantTextarea`                  | Text entry                                                        |
| `OctantSelect`                                   | Dropdown selection (opaque semantic popover)                      |
| `OctantCheckbox`, `OctantSwitch`, `OctantSlider` | Toggles and ranges                                                |
| `OctantTabs`                                     | Tab strips                                                        |
| `OctantMenu`, `OctantPopover`                    | Menus, submenus, checkbox items, and disclosure popovers (opaque) |
| `OctantContextMenu`                              | Right-click menus mirroring the same items                        |
| `OctantDialog`                                   | Modal dialogs (opaque)                                            |
| `OctantTooltip`                                  | Tooltips (opaque for legibility)                                  |

`ui/shadcn` contains the owned shadcn recipe implementations; import product
primitives from `ui/base`, not from `ui/shadcn`, inside features. The recipes
use the repository's Base UI interaction primitives while retaining shadcn's
New York composition and semantic Tailwind variables.

`bun run ui:check` fails closed on new `@base-ui/react` or `ui/shadcn` imports
outside this directory, on raw `<button>`, `<input>`, `<select>`, `<textarea>`,
or `<dialog>` in feature modules, and on `OctantInput` used as a checkbox or
radio. Remaining raw controls must be native platform exceptions:

| Exception comment            | Use for                                            |
| ---------------------------- | -------------------------------------------------- |
| `native-file-input`          | Hidden or OS file choosers the adapter cannot host |
| `native-platform-control`    | Native color/media/window controls                 |
| `specialized-editor-surface` | Monaco, xterm, Canvas, or drag hit regions         |

Place `{/* ui-boundary-exception: native-file-input */}` immediately above the
element. Hidden `type="file"` inputs are also recognized without a comment.

## Surface utilities (`styles/components.css`)

- `octant-card` / `octant-card--flat` — raised or flat in-flow container.
- `octant-chip` — compact pill chip; `aria-pressed`/`data-active` for selection.
- `octant-glass` / `octant-glass--overlay` — frosted glass material for layers that
  float above content.

## Tuning

- Colors, radii, shadows, and glass intensity are tokens: `--octant-*` in
  `apps/web/src/styles.css` (per-mode) and `packages/theme/src/tokens.ts`
  (theme-resolvable roles).
- Glass: `--octant-glass-bg|border|highlight|blur|saturate` + `--octant-shadow-pop`.
  Use only for native/optional sidebar material and the floating activity
  picture-in-picture. Menus, dialogs, forms, Environment, and ordinary
  popovers are opaque semantic surfaces.
- Which surfaces use glass: the explicit material selectors in
  `styles/components.css`; do not add glass to a product control.

Accessibility fallbacks (reduced transparency, no backdrop-filter,
increased contrast) live beside the materials in `components.css`; keep them
updated when adding glass surfaces.
