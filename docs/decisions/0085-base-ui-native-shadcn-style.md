# 0085. Product controls follow the Base UI-native shadcn style

**Status:** Accepted

## Context

0046 settled that shadcn recipes own product controls and named the style: the
Base UI variant of shadcn New York. That style was written for shadcn's Radix
era. Upstream has since rebuilt every recipe on Base UI, made Base UI the
default for new projects, and moved its component work to a set of Base
UI-native styles. New York now receives no new components.

Octant already runs Base UI underneath, so the recipes in `apps/web/src/ui/shadcn`
are a hand-port: Base UI primitives wearing New York's Radix-era classes. The
cost is not cosmetic. Upstream's maintained lane carries roughly sixty
components against our twenty-two, and Base UI itself ships toast, collapsible,
radio group, avatar, accordion, number field, meter, progress, drawer,
navigation menu, and OTP field that nothing here wraps. Each gap is hand-rolled
somewhere in the renderer, and the hand-rolled versions have drifted: eighteen
surfaces implement listbox and combobox keyboard semantics separately, and the
five hand-rolled radio groups have no roving tabindex at all.

Staying on New York means hand-porting each future component too, from a style
that is no longer where the work happens.

## Decision

- Product controls follow the Base UI-native shadcn `nova` style. The recipes
  remain owned, editable source under `apps/web/src/ui/shadcn`, and feature code
  still imports only the adapters under `apps/web/src/ui/base`. Base UI remains
  the only interaction backend; Radix and a second primitive stack are not added.
- The style's density is adopted, not just its structure: the default control
  height drops one step, `xs` and `icon-xs` sizes appear, controls acknowledge a
  press, and `destructive` becomes a tonal fill rather than a solid one.
- Three divergences from the style are deliberate and kept, because a record,
  the visual language, or a guarding test already owns them:
  - Recipes paint no focus ring. The global `:focus-visible` rule is the only
    keyboard focus treatment, as the visual language requires.
  - The badge is an outline-only status label, not a filled pill.
  - The card is borderless and carries elevation, per 0070.
- `--octant-*` roles remain the theme source and `shadcn-theme.css` remains the
  projection into shadcn variables. A style's own `:root` palette is never
  adopted; it would land literal colours and take ownership of `--background`
  away from `packages/theme`.
- A recipe that ships `dark:` utilities requires the dark variant to describe how
  this renderer records its mode. The variant reads `data-octant-theme-mode` and
  treats dark as the base an explicit light overrides, matching both
  `shadcn-theme.css` and the terminal runtime.
- Upstream's shared stylesheet is not a dependency. Base UI emits presence-only
  state attributes, so Tailwind's own `data-*` variants already match; the
  utilities the stylesheet adds beyond that are copied into the Tailwind entry
  only when a recipe here actually uses one.
- Recipes hold recipes. Composed product components, their accessibility wiring,
  and their focus behaviour live in the adapter layer, where a style change does
  not reach them.

## Consequences

- Controls sit on the lane upstream maintains, so a new component is an import
  and a reconcile rather than a hand-port from a frozen style.
- Every surface gets tighter. The density change is visible across the whole
  renderer and is verified by rendered review, not only by tests.
- Recipes that deliberately carry no paint keep carrying none: their appearance
  belongs to unlayered `.octant-*` rules that beat any layered utility, so
  importing the style's Tailwind paint there would add dead code.
- The stylesheet contract ratchets in both directions, so each restyled slice
  records a new baseline as part of its own change.
- `bun run ui:check` runs in CI, so the component-boundary and stylesheet gates
  this migration depends on hold on every pull request rather than only locally.

## Related

- 0046 is superseded: it named New York as the owning style. Its rules that
  recipes own product controls, that features import only adapters, that
  `--octant-*` stays authoritative, and that feature styles may place but not
  repaint a shared component are carried forward here unchanged.
- 0016 defines the Base UI, shadcn, adapter, and theme stack.
- 0070 sets the radius and elevation contract the recipes consume.
- 0073 owns the type hierarchy a recipe's sizes must land on.
