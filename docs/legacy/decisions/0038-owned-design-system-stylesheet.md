# 0038. The owned design system stylesheet

**Status:** Superseded by 0046

## Context

The renderer's visual identity was carried by per-surface CSS files grown
alongside features. The result read as assembled rather than designed: three
settings layouts, ad-hoc control metrics, and accent colors that failed
normal-text contrast when used as text. A complete design system now exists —
one stylesheet (`octant.css`), an icon sprite, a display face, and a
styleguide with self-auditing contrast, cascade, and pointer-target checks —
developed against the product's own screens. This ADR records how it enters
the app without contradicting 0016, which makes `--octant-*` theme roles the
single source of visual truth.

## Decision

- The design system is **copied into `apps/web` and owned there**
  (`src/styles/octant.css`, `public/icons.svg`, `src/fonts/`). It is not a
  package and does not track an upstream; edits land in the copy with the
  same review as any renderer code.
- `octant.css` consumes `--oct-*` tokens. A bridge stylesheet
  (`src/styles/octant-bridge.css`) maps every runtime-varying `--oct-*` token
  to the `--octant-*` role the theme engine publishes. 0016 stands:
  `--octant-*` roles remain the single source of visual truth; `--oct-*` is a
  consumption alias, never a place to define color. Non-varying tokens
  (spacing, radii, type scale, motion) live in `octant.css` itself.
- Accent used as text is its own theme role (`accent-text`, held to
  normal-text contrast) because the `accent` fill role is only policed to
  3:1. Status text roles target the surface they actually render on.
- Import order in `styles.css` is a contract: Tailwind (layered) →
  `octant.css` → bridge → app CSS. Tailwind's preflight is layered, so the
  system's unlayered base always beats it; app CSS imports after the system,
  so un-ported surfaces keep winning ties. **Porting a surface means moving
  its markup onto system classes and deleting the replaced app rules** — not
  overriding the system from app CSS.
- Ported surfaces use the system vocabulary as written (`.setrow`,
  `.provrow`, `.extcard`, `.btn`, `.tag`, …) and `--oct-*` tokens in any
  residual app rules. Base UI keeps supplying interaction behavior per 0016;
  where a system recipe targets a native element an owned wrapper does not
  render, the wrapper's product class is drawn to the system's metrics
  instead.
- **A treatment shared by more than one surface is defined exactly once, in
  `octant.css`.** Chat, Work, and Code render the same component the same
  way because they share the same classes, not because per-surface CSS
  mirrors the same declarations. Copying a recipe into a second stylesheet
  is the drift this ADR exists to end: when two surfaces need the same look,
  the rule is hoisted into the system sheet (scoped by vocabulary, e.g.
  `.composer-row`, not by surface) and the copies are deleted. Per-surface
  CSS may position and size a component within its layout; it may not
  restyle it.
- The styleguide's audits are the acceptance bar for visual changes: 4.5:1
  for text, 3:1 for UI marks, 24px minimum pointer targets. The brand marks
  (aperture shear included) are canonical and are not redrawn.

## Consequences

- One vocabulary ends the drift between surfaces, and deleting replaced
  rules keeps the cascade small enough to reason about; the cost is a
  transition window where un-ported surfaces look older than ported ones.
- Owning the copy means no upstream churn, but also no free fixes: the
  styleguide and its audits are the regression net.
- The bridge is the one place theme reachability can silently break; a token
  added to `octant.css` that varies at runtime must be mapped there.

## Related

- 0016 component foundation and theme (extended, not superseded).
