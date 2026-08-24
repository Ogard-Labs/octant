# 0046. shadcn recipes own product controls

**Status:** Accepted

## Context

0038 gave Octant one stylesheet vocabulary, but that vocabulary duplicated
button, form, overlay, badge, card, and state recipes already owned by the
shadcn layer in 0016. The duplicate recipes drifted. Feature classes applied
after Tailwind could repaint shadcn controls with older metrics, while menus
and dialogs kept a decorative glass treatment that did not match the selected
New York component style.

Octant still needs its own shell architecture, domain-specific workspaces, and
runtime theme roles. It does not need two visual implementations of an input
or button.

## Decision

- The Base UI variant of shadcn New York owns product controls, fields,
  selects, menus, dialogs, tabs, switches, badges, cards, empty states,
  separators, and segmented choices.
- Recipes live under `apps/web/src/ui/shadcn`. Feature code imports only the
  Octant adapters under `apps/web/src/ui/base`; Radix and a second interaction
  backend are not added.
- `--octant-*` runtime roles remain the theme source. `shadcn-theme.css`
  projects them into shadcn variables. shadcn variables never own persistence,
  theme editing, or native material policy.
- `octant.css` keeps layout, shell navigation, composers, pane geometry,
  domain workspaces, Monaco, terminal, and other product-specific treatments.
  It does not define a second generic control recipe.
- Feature styles may place or size a shared component. They may not repaint
  its color, border, radius, shadow, focus, hover, disabled, or error states.
- Menus, dialogs, Environment, and ordinary application popovers are opaque
  semantic surfaces. Translucency remains only where a native material or a
  genuinely floating activity overlay requires it.
- Migration removes replaced legacy rules as each product area adopts the
  adapter. Tests assert semantic slots, variants, and user behavior instead of
  obsolete legacy class names.

## Consequences

- Controls match the documented shadcn New York style while preserving Base UI
  accessibility and Octant theme customization.
- The shell can remain purpose-built without making forms and overlays look
  like a separate product.
- Dual CSS remains for product layout, but a touched product control has one
  owner. Bundle size and rendered behavior stay part of verification.

## Related

- 0016 defines the Base UI, shadcn, adapter, and theme stack.
- 0038 is superseded where it made `.btn`, `.setrow`, and similar visual
  recipes the component source of truth.
