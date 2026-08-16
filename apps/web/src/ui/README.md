# Octant UI component layer

This directory plus `../styles/components.css` is the defined component set
for the shared renderer. Build features from these pieces; do not restyle
them inside feature stylesheets.

## Interactive primitives (`ui/base`)

| Primitive                                        | Use for                                             |
| ------------------------------------------------ | --------------------------------------------------- |
| `OctantButton`                                   | All buttons (primary/secondary/ghost/icon variants) |
| `OctantInput`, `OctantTextarea`                  | Text entry                                          |
| `OctantSelect`                                   | Dropdown selection (portal popup is glass)          |
| `OctantCheckbox`, `OctantSwitch`, `OctantSlider` | Toggles and ranges                                  |
| `OctantTabs`                                     | Tab strips                                          |
| `OctantMenu`                                     | Menus and disclosure popovers (glass)               |
| `OctantDialog`                                   | Modal dialogs (glass)                               |
| `OctantTooltip`                                  | Tooltips (opaque for legibility)                    |

`ui/shadcn` contains the owned adapter implementations; import primitives
from `ui/base`, not from `ui/shadcn`, inside features.

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
- Which surfaces are glass: the single group selector in
  `styles/components.css`.

Accessibility fallbacks (reduced transparency, no backdrop-filter,
increased contrast) live beside the materials in `components.css`; keep them
updated when adding glass surfaces.
