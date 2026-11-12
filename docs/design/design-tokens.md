# Design tokens and the app feel

The design system exists as custom properties in the web renderer's stylesheets
and in the theme package. This page is how a website or another app reuses it
without copying values by hand: a generated token set, the rules for using it,
and the rules that make a screen read as an app instead of a flat page.
[DESIGN.md](../../DESIGN.md) still owns every design rule; this page owns the
export and states the rules a consumer needs, with the section that owns each.

## What is exported

`packages/theme/tokens/` holds four files:

| File          | What it is                                                                                                |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| `tokens.css`  | Generated. Plain custom properties, dark by default, light under `[data-theme="light"]` and the OS choice |
| `tokens.json` | Generated. The same values in the Design Tokens Community Group format, with the light value alongside    |
| `recipes.css` | Hand-written. The minimum recipes in the appendix, built from the tokens only                             |
| `demo.html`   | A page that loads only `tokens.css` and `recipes.css` and shows the recipes in both themes                |

The generated files are never edited. `bun run tokens:export` rebuilds them from
the stylesheets, and `bun run tokens:check` (run in CI and in `bun run verify`)
fails with that command when a stylesheet edit has left them stale.

**Where it lives.** `@octant/theme` already owns the semantic theme schema and
the built-in presets, and its stated role is the visual language's portable
projection (DESIGN.md, [Source of truth and CSS layers](../../DESIGN.md#source-of-truth-and-css-layers)).
Non-colour foundations are the same kind of thing, so they sit beside the colour
roles in `packages/theme/tokens/` and no new package was made. The generator is
`scripts/export-design-tokens.ts`, not package code: it reads the renderer's
stylesheets, and a package must not import an app.

**Inputs.** The generator reads, in the renderer's own load order:
`apps/web/src/styles/octant.css` (the static system, with `light-dark()`),
`octant-bridge.css` (the runtime mapping, which wins over the static value),
`apps/web/src/styles.css` (the theme roles' first-paint values and the material
recipes, with the light block), and the type-role classes in `surface.css`. It
cross-checks every colour role's stylesheet value against the defaults in
`packages/theme/src/tokens.ts` and refuses to export if they differ. A name
declared twice in one block, an unresolved `var()`, a circular reference or a
`light-dark()` without both values fails the export.

**Names.** The export keeps the app's names, so a value in the app and in the
export have the same name and there is no mapping table to maintain:

- `--octant-*` are the theme roles and the material: surfaces, inks, borders,
  accent, status, bevels, shadows, glass. They are what the theme engine edits.
- `--oct-*` are the foundations and the aliases a stylesheet reads: type, spacing,
  radii, motion, sizes, and short colour aliases (`--oct-bg`, `--oct-fg`,
  `--oct-border`) that point at the roles.
- In `tokens.json` a token's key is its CSS name without the leading dashes, under
  a group (`radius.oct-radius-md`). The group list is in the file.

A token that is defined in terms of another keeps the reference in
`tokens.css`, so it follows the active theme. In `tokens.json`, `$value` is the
**dark** value resolved to a literal wherever it can be computed without a
browser (`calc()` over lengths, `color-mix()` over colours, references).
`$extensions["com.octant"]` carries the CSS name, the source file, the `light`
value when it differs, and `cssValue` when the original was an expression. A
value that depends on the viewport (`clamp()` with `vw`) has no literal; it is
kept as the expression and marked `expression: true` with a description saying
so. Shadows are multi-layer CSS strings with no DTCG type; the string is the
value. Types follow the draft's string form (`"12px"`, `"150ms"`).

Values the app does not make theme-dependent (the type scale, spacing, radii,
motion) are the same in both modes. The interface size is a user setting in the
app; the export is the default 13px, and `--oct-text-step` carries the ratio, so
a consumer that sets `--octant-ui-font-size` scales the whole type ramp.

## Loading the tokens

Plain CSS:

```html
<link rel="stylesheet" href="tokens.css" />
<link rel="stylesheet" href="recipes.css" />
<body class="oct-root"></body>
```

Dark is the base. A light OS preference switches the page to light, and
`<html data-theme="light">` or `data-theme="dark"` forces either. Flipping that
one attribute is the entire theme switch.

Tailwind v4: import the tokens, then project them into `@theme inline` the way
the app does in `apps/web/src/styles/tailwind.css`, so utilities read the same
roles and the type ramp follows the interface size:

```css
@import "tailwindcss";
@import "./tokens.css";

@theme inline {
  --color-background: var(--oct-bg);
  --color-foreground: var(--oct-fg);
  --color-card: var(--octant-card);
  --color-popover: var(--octant-float);
  --color-border: var(--octant-border);
  --color-primary: var(--octant-accent);
  --color-primary-foreground: var(--octant-primary-foreground);
  --font-sans: var(--oct-font-body);
  --font-mono: var(--oct-font-mono);
  --text-xs: var(--oct-text-xs);
  --text-sm: var(--oct-text-sm);
  --radius-md: var(--oct-radius-sm);
  --radius-xl: var(--oct-radius-md);
}
```

A site outside this repository copies the generated files from a commit it
names, as the public documentation does for the theme defaults
(`scripts/export-docs-theme.ts` prints an immutable reference). It never edits
them; a value change is a change here, then a re-copy.

## Using the tokens by role

Reach for a role, not a number. The rules below are DESIGN.md's; the section
that owns each is named.

**Type** ([Scale](../../DESIGN.md#scale)). The interface is 13px in the platform
face; code and identifiers use `--oct-font-mono`. There are eight roles and the
export carries each recipe as `--oct-role-<role>-{family,size,weight,tracking,leading}`:
title, title-hero, page-title, section-label, row-label, row-detail, meta,
meta-mono. The hero exports size, tracking and leading only, so a consumer takes
its family and weight from the title role. A title is never the size and weight of the text it heads. Weights are
one ladder: regular for reading, medium for labels and names, strong for
emphasis, and `--oct-weight-title` for the large title alone. Nothing is set
between steps (no 11.5 or 12.5px).

**Spacing** ([Spacing, shapes, and depth](../../DESIGN.md#spacing-shapes-and-depth)).
A 4px scale: `--oct-space-1` to `--oct-space-12` (4, 8, 12, 16, 20, 24, 32, 48).
Use a gap for stacks and groups. A padding or margin off the scale is a defect.

**Control and row heights.** `--oct-rail-button-h` (28px) is the height of an
icon control and of the default button; `--oct-menu-row-h` (28px) is a menu or
picker row; `--oct-nav-row-h` (32px) is a navigation or list row;
`--oct-title-rail-h` (44px) is the title band. `--oct-control-height` and
`-sm` (44 and 34px) are the touch sizes, not the desktop default.

**Radius** ([Shapes and depth](../../DESIGN.md#shapes-and-depth)). One number per
role. A control or a row takes `--oct-radius-sm`; a card, panel, well or the
window's own cards take `--oct-radius-md`; a dialog `--oct-radius-lg`; the
composer's pill `--oct-radius-composer`; `--oct-radius-pill` is for chips,
meters and circular icon controls only. A corner one gap inside a rounded parent
is concentric: the parent's radius less the gap, or square, never the same token
again. A radius is a token, `0`, `50%`, or the 1 to 4px of a chart mark, never a
bare pixel value.

**Hairlines.** Panes and rows are divided by one 1px line in `--octant-border-soft`;
`--octant-border` is the card edge; `--octant-border-strong` is a field's edge
and `--oct-hairline` is an ink-tinted line that holds on any surface. The line
must register on the surface it separates, so never hand-pick a grey.

**Colour.** Ink is `--oct-fg` (primary), `--oct-muted` (labels and detail) and
`--oct-meta` (timestamps, hints). A fact in a list is its name in muted ink and
its value in primary ink. The accent is for the action and for the one thing a
surface is for, not for decoration; status colours always travel with text or a
shape. Normal text holds 4.5:1, large text and non-text marks 3:1
([Accessibility and reliability](../../DESIGN.md#accessibility-and-reliability)).

**Icons.** `--oct-icon-sm/md/lg` (14, 16, 20). A glyph is drawn in a box of one of
those sizes at a stroke of 1.5 and takes `currentColor`
([Iconography and provider marks](../../DESIGN.md#iconography-and-provider-marks)).

## The app feel

The system is meant to read as an app's controls, dense and with real material,
not as a flat website. Each rule names the section that owns it. Where a rule is
in the stylesheets and not in DESIGN.md, it is marked **implemented, not
specified** with its `file:line` at the time this page was written.

### Depth comes from material, not flat fills and outlines

Source: [Shapes and depth](../../DESIGN.md#shapes-and-depth).

- There are three levels, each a step lighter than the one under it: the page,
  a raised object, a floating one. A card, a menu and a dialog are never told
  from the page by an outline alone.
- **A control is a raised tile.** A filled button has its own fill, light on its
  top edge (`--octant-bevel`) and a short shadow under it
  (`--octant-shadow-control`). Pressing darkens the fill and swaps the shadow
  for `--octant-shadow-control-pressed`; nothing scales or moves. Ghost, link and
  chip controls draw no tile and stay flat.
- **A well is cut in.** A field is the strong border with no fill and no shadow;
  an inset region uses `--octant-surface-inset`. It takes no outer shadow.
- **A card is for one object a person acts on as a whole**: the raised fill
  (`--octant-card`), `--octant-shadow-xs`, rounded by `--oct-radius-md`.
- **The row being shown is a raised tile** (`--octant-shadow-selected`); the row
  under the pointer is a flat wash. Here and pointed-at are two states.
- **A floating surface is frosted material over a ground.** A menu, popover or
  dialog takes `--octant-float`, the overlay shadow, and exactly one 1px edge
  (the shadow draws it; the popup sets no border). Frosted blur
  (`--octant-glass-blur`, `--octant-glass-saturate`) is used only where a ground
  sits behind to read through, and a reduced-transparency preference puts the
  opaque float fill back. What sits on a floating surface steps up from it
  (`--octant-float-control`, `-hover`, `-pressed`, `-line`).
- **Panes are flat and divided by one hairline.** The frame and the sheet draw
  the soft hairline once; no stronger line doubles it. Navigation and open form
  layouts stay unshadowed. A shadow or bevel never decorates a flat row.
- In dark a shadow cannot be seen on a near-black page, so the fill and the bevel
  carry the lift; in light the surfaces are already the lightest thing, so the
  shadow carries it. Both are in the tokens; do not tune them per theme.
- Implemented, not specified: the frosted recipe's strengths, blur 24px and
  saturation 150% (`apps/web/src/styles.css:145`), and the 150% saturation on
  the thicker glass steps (`apps/web/src/styles/octant.css:6608`).

### Density

Source: [Scale](../../DESIGN.md#scale),
[Spacing, shapes, and depth](../../DESIGN.md#spacing-shapes-and-depth).

- The interface is 13px; a row label is 14px at medium weight; metadata is 12px
  and nothing essential sits under 12px.
- Controls are 28px tall by default (20, 24, 28 and 32 across the sizes), rows
  32px, a menu row 28px, the title band 44px. A page that sets a bigger control
  for a desktop surface is not using the system.
- Padding is on the 4px scale and small: a button's inline padding is
  `--oct-space-2`, a card row's is `--oct-space-4`.
- Implemented, not specified: the default control's 28px comes from the button
  recipe's rem step rounded to a whole 2px
  (`apps/web/src/ui/shadcn/button.tsx:61`), and the only 28px tokens are
  `--oct-rail-button-h` and `--oct-menu-row-h` (`octant.css:224`, `:237`).
  `--oct-control-height` is 44px (`octant.css:214`), the touch size, which
  DESIGN.md states as "44px by default".

### Alignment

Source: [Spacing, shapes, and depth](../../DESIGN.md#spacing-shapes-and-depth),
[Page shell](../../DESIGN.md#page-shell), Settings in
[Shell and layout](../../DESIGN.md#shell-and-layout).

- **One gutter per surface.** A page has one inline inset and everything stands
  on it. A grouped card takes a 16px inset for everything inside, including
  content that is not a row, and its row hairlines are inset by the same 16px so
  the line starts where the text does.
- **Text and icons share a left edge within a surface.** A Back control's glyph
  sits on the content's left edge; every leading icon in the sidebar stands on
  the nav inset (`--oct-nav-inset`), so no row's text begins to the left of
  another's.
- **Icon columns have one width.** Navigation, the Project tree and the activity
  feed use the same icon column; the title sits after it. In the recipes the icon
  column is `--oct-icon-lg` wide and the glyph `--oct-icon-md`, centred in it.
- **Controls on a rail share a centreline.** The title band, window controls, dock
  head and bottom toolbar are all `--oct-title-rail-h` high, so a 30px tab and a
  28px icon control sit on one line and the hairlines meet.
- **Optical alignment of icons with text.** Centre a glyph in a grid box the size
  of its column rather than nudging it with margin. Implemented, not specified:
  the one baseline nudge in the stylesheets is the spinner's
  `vertical-align: -3px` (`octant.css:1944`); DESIGN.md has no rule for an
  icon beside a line of text, so a consumer should centre with `align-items` and
  check the result by eye at 13px.

### Behaviour that makes it feel native

Source: [Motion and interaction](../../DESIGN.md#motion-and-interaction),
[Face](../../DESIGN.md#face),
[Accessibility and reliability](../../DESIGN.md#accessibility-and-reliability).

- **No text selection on chrome.** Words in the chrome do not select when the
  pointer drags across them; reading matter (a message, a diff, a value, an
  error, a field) opts back in. Pictures and links do not lift off as drag ghosts.
  Recipes: `.oct-root` turns selection off and `.oct-selectable` turns it on.
- **The pointer stays an arrow on controls**, disabled ones too. The hand is for a
  real link only.
- **Focus rings only for keyboard focus.** The edge is one neutral outline
  (`--oct-focus-edge`) and shows only on `:focus-visible`; a pointer press paints
  nothing, and a dialog handing focus back to its opener paints no ring after a
  click. A control filled with the accent inverts the edge to
  `--oct-focus-edge-on-accent`. Implemented, not specified: the edge's geometry,
  a 2px outline inset by 2px so it moves no layout and a scroller cannot clip it
  (`octant.css:467`), and the pointer-modality switch that suppresses it
  (`octant.css:517`; DESIGN.md names `data-octant-input` but not the CSS).
- **Instant press feedback.** A press darkens the fill on the same frame: the recipes
  turn the transition off while a control is pressed, and there is no scale. A disabled control is drawn at `--oct-disabled-opacity`
  with no hover fill and no pointer events.
- **150 to 200ms motion with the standard easing.** Colour settles in
  `--oct-dur-base` (150ms) with `--oct-ease-color`; geometry and overlays in 150ms
  with `--oct-ease-motion`, and an overlay leaves faster, in `--oct-dur-fast`
  (100ms). There is no decorative entrance and no ambient motion behind work.
  Only opacity, scale and translate change on an overlay.
- **Respect reduced motion and reduced transparency.** Under
  `prefers-reduced-motion` transitions and animations stop without removing state;
  a running indicator keeps a shape that reads as busy. Under
  `prefers-reduced-transparency` frosted panels go solid.
- **Platform face, platform rendering.** The platform face, default smoothing (no
  antialiased thinning on dark), `text-rendering: optimizeLegibility`, no
  synthetic bold.
- Implemented, not specified: `text-wrap: pretty` on paragraphs and `balance` on
  headings (`octant.css:451`, `:457`); tabular figures wherever a number is
  compared (`apps/web/src/styles.css:874`, `:1153`; DESIGN.md names them per
  surface, never as a rule); `font-optical-sizing: auto` (`octant.css:433`).
- A conflict to resolve in DESIGN.md, not here: Shapes and depth says pressing a
  raised tile "sinks it", and Motion and interaction says a press moves nothing.
  The implementation does both without movement (a darker fill and an inset
  shadow), which is what the recipes copy.

## Appendix: minimum recipes

`recipes.css` is the complete set. It is plain CSS with no colour literal, radius
or shadow of its own; a few tints are mixed from exported colour tokens. A test
refuses a raw colour or a token the export does not define. Add `class="oct-root"` to the page and use:

| Recipe      | Classes                                                                                               | Built from                                                                              |
| ----------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Button      | `oct-button`, `--primary`, `--ghost`                                                                  | `--octant-control`, `--octant-shadow-control`, `--oct-rail-button-h`, `--oct-radius-sm` |
| Icon button | `oct-icon-button` with an `svg`                                                                       | `--oct-rail-button-h`, `--oct-icon-md`                                                  |
| Field       | `oct-field`                                                                                           | `--octant-border-strong`, `--octant-control-hover`                                      |
| Card        | `oct-card`, `oct-card__row`                                                                           | `--octant-card`, `--octant-shadow-xs`, `--oct-radius-md`                                |
| Menu        | `oct-menu`, `--frosted`, `oct-menu__row`, `oct-menu__rule`                                            | `--octant-float`, `--octant-shadow-overlay`, `--oct-menu-row-h`, `--octant-glass-bg`    |
| Pane layout | `oct-panes`, `__sidebar`, `__stage`, `__band`, `__body`, `oct-nav-row`                                | `--octant-border-soft`, `--oct-sidebar-w`, `--oct-title-rail-h`, `--oct-nav-row-h`      |
| Type roles  | `oct-type-title`, `-page-title`, `-section-label`, `-row-label`, `-row-detail`, `-meta`, `-meta-mono` | `--oct-role-*`                                                                          |

The button, in full, as the template for the others:

```css
.oct-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--oct-space-1);
  height: var(--oct-rail-button-h);
  padding: 0 var(--oct-space-2);
  border: 0;
  border-radius: var(--oct-radius-sm);
  background: var(--octant-control);
  color: var(--oct-fg);
  font: inherit;
  font-size: var(--oct-text-sm);
  font-weight: var(--oct-weight-medium);
  cursor: default;
  box-shadow: var(--octant-shadow-control);
  transition:
    background-color var(--oct-dur-base) var(--oct-ease-color),
    box-shadow var(--oct-dur-base) var(--oct-ease-color);
}
.oct-button:active {
  background: var(--octant-control-pressed);
  box-shadow: var(--octant-shadow-control-pressed);
}
```

`demo.html` renders all of them in dark and, with `#light` on the address, in
light. It links only `tokens.css` and `recipes.css` and needs no network. Open it
after a token change: raised, lit, dense controls are the pass condition; a
button that reads as a flat web button is a regression.

## Known limits

- The export carries each token's default value. The app overrides some of them
  by context, and the export does not: Glass (`.shell--material-translucent`,
  `apps/web/src/styles/shell.css:53`) replaces the card fill with a tint of the
  ink and the xs, sm and md shadows with the glass-raised shadow; some layers
  repoint `--oct-surface` (`apps/web/src/styles/surface.css:1009`, `:1024`);
  increased contrast swaps the three text roles for their high-contrast values
  (`apps/web/src/styles.css:4880`); and at 680px and narrower the hero title's
  size is replaced by `--oct-text-2xl` (`surface.css:665`).
- The icon stroke is written as `1.5` in the stylesheets and in the recipes; it
  is not yet a token, so it is not in the export.
- `apps/share` declares its own hand-written radius and type set for an embedded
  frame (`apps/share/src/frames.ts`), with different values (4 and 8px radii,
  rem sizes) for a sandboxed document that loads nothing. It does not consume the
  export yet.
- The export is a snapshot of the default theme. A custom theme's roles are the
  theme engine's; a consumer that wants them reads the theme export, not these
  defaults.
