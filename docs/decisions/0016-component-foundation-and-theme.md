# 0016. Component foundation and theme

**Status:** Accepted

## Context

The shared renderer needs accessible menus, dialogs, selects, tooltips, and
similar controls that Octant should not reimplement, plus a visual identity
("Octant, distilled": near-black graphite, hairline pane boundaries, compact
rows, typography-led hierarchy, scarce accent) that must survive library
choices, run on desktop and web, honor macOS accessibility settings, and let
users import and edit themes safely. Earlier direction forbade a utility-CSS
stack and a component-recipe library; that was reversed once an unstyled,
tree-shakable primitive backend proved compatible. This ADR records the
resulting stack and the theme rules that make it Octant-owned.

## Decision

- The renderer stack is: Base UI as the only interaction-primitive backend
  for complex controls; owned, editable shadcn recipe sources (Base UI
  variant) under `apps/web/src/ui/shadcn/`; Octant wrappers under
  `apps/web/src/ui/base/` (`OctantButton`, `OctantMenu`, `OctantDialog`,
  `OctantSelect`, `OctantSwitch`, `OctantTooltip`, ...) as the API feature
  code imports; Tailwind as the styling runtime for those controls and new
  control-adjacent UI. Feature and shell code never import `@base-ui/react/*`
  or `ui/shadcn/*` directly. Radix or a second primitive stack is not added.
- shadcn supplies controls only. It does not replace workspace architecture,
  the split tree, tabs, composers, navigation, Monaco, the terminal, the
  utility dock, or authority UX; those remain Octant-owned components styled
  through Octant tokens.
- Octant semantic tokens (`--octant-*` in the renderer stylesheet and the
  theme-resolvable roles in `packages/theme`) are the single source of visual
  truth: application and elevated surfaces, foreground and muted foreground,
  borders, accent, selection and focus, success, warning, destructive,
  pending, provider and runtime status, diff and diagnostics, editor and
  syntax, terminal, browser and artifact colors, radii, shadow scale, glass
  material. Tailwind and shadcn variables (`--background`, `--primary`, ...)
  are a projection of the active Octant theme at the document root; they never
  own theme persistence or Appearance settings.
- New UI extends semantic tokens; it does not hardcode one-off colors,
  radii, or shadows. Ordinary panes stay flat with hairline separation; cards
  are for discrete objects; accent is scarce; status never relies on color
  alone; icons come from the selected icon library, never text glyphs or
  emoji.
- `packages/theme` owns the semantic theme schema, built-in System, Light,
  Dark, and original Octant presets, WCAG contrast validation, safe fallback
  for invalid or incomplete themes, import of a safe subset of interoperable
  color-theme JSON, export, and projection to Monaco and terminal palettes.
  Users may edit semantic colors, density, contrast, and typography (UI,
  editor, terminal independently) with live preview, validation, and reset.
- Themes and appearance packs cannot contain scripts, executable payloads,
  remote assets, or untrusted fonts. Missing fonts fall back per client.
  Sidebar background images (built-in generated presets or user uploads) are
  server-stored, fetched by id through authenticated routes, and rendered
  under a user-configured legibility overlay; vibrancy stacks beneath them.
- The sidebar material is a preference (`system` or `opaque`), not a promise:
  reduced transparency, increased contrast, readability, performance, and
  unsupported hosts resolve to opaque without changing the saved preference.
  Accessibility fallbacks live beside the materials they replace.
- Density targets: compact navigation and list rows of 28 to 32 px, radii of
  6 px for chips, 8 px for controls, 10 px for panels, 14 px for composers,
  brief functional motion that respects Reduced Motion.
- Migration is incremental: legacy Base UI adapters are replaced by
  shadcn-backed wrappers as they are touched and removed when unused;
  existing plain CSS remains valid for shell chrome; bundle impact is
  measured and fails closed if desktop cost is unacceptable.

## Consequences

- Complex control accessibility (focus management, typeahead, portals,
  dismissal) comes from a maintained backend, and Octant owns the recipe
  source so upgrades are deliberate.
- A single token layer means preset and override changes restyle shell CSS
  and controls together; a theme bug is fixed once.
- Feature authors have one import path for controls and one place to tune
  visuals, which keeps feature stylesheets from drifting.
- Dual styling (plain CSS plus Tailwind) persists during migration and must be
  watched for bundle growth.
- Reversing the earlier ban is recorded here so the reasoning does not have to
  be rediscovered.

## Related

- 0004 Monorepo layering and dependency direction
- 0015 Workspace shell model
- 0044 The dock hosts live thread-owned tools
