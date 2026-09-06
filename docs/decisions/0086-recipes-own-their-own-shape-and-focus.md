# 0086. Recipes own their shape; the app owns its focus ring

**Status:** Accepted

## Context

0070 gave the renderer a visual language at a moment when the product read as a
flat, inconsistent workbench. It fixed that by writing the language down as
fixed pixel values: control radius 10, panel 16, composer 20, elevation as one
of three named shadows, and — with DESIGN.md — keyboard focus painted exactly
once by a global `:focus-visible` rule that every recipe was forbidden to add
to.

0085 moved product controls onto the Base UI-native shadcn style. That style
carries its own answers to the same three questions, and they are not
compatible with 0070's:

- Radius is derived from one `--radius` root rather than set per surface class,
  and a control is the `lg` step with small sizes clamped, not a fixed 10px.
- A card is bounded by a hairline ring, not lifted by a shadow.
- Every control paints its own focus ring, because focus is part of the recipe's
  own state vocabulary alongside hover, pressed, and disabled.

Holding 0070's values meant reconciling each of these by hand on every recipe,
in perpetuity, against a style that will keep moving. That is the hand-port
0085 exists to stop.

Focus is the exception, and it is worth stating why, because the obvious reading
of "take the style whole" gets it wrong.

The style paints focus per control as a wide, soft, translucent halo. That is a
web idiom: it reads as a page element that happens to be focusable. An app
control is expected to show a crisp indicator tight to its own edge, which is
what `--oct-focus-ring` already draws — a hairline gap in the background colour,
then a muted ring. Handing focus to the recipes replaced an app treatment with a
website one, and did it inconsistently, one recipe at a time.

The genuine defect in the old rule was smaller than it looked: it set
`border-radius` alongside the shadow, which snapped a focused control to a
corner it does not otherwise have. A box-shadow already follows the element's
own radius, so that line bought nothing and cost the control its shape.

## Decision

- **Radius derives from one root.** `--radius` is the control step; recipes use
  the Tailwind scale it feeds (`rounded-lg` for a control, `rounded-xl` for a
  card or menu, the clamped `min(--radius-md, …)` form for compact sizes) rather
  than naming pixels. The composer and dialog keep the 20px step 0070 set; the
  style does not speak to those Octant-owned surfaces.
- **A card is bounded, not lifted.** A discrete object is drawn with a hairline
  ring. Shadow is reserved for something that genuinely floats above the page:
  the composer (`--octant-shadow-md`) and overlays (`--octant-shadow-overlay`).
  `--octant-shadow-sm` is no longer the way a card says it is an object.
- **The app owns one focus ring.** Keyboard focus stays a single global
  `:focus-visible` treatment: a hairline gap then a muted ring, tight to the
  control. A recipe does not paint focus, and the style's own
  `focus-visible:ring-*` utilities are stripped on import. This is the rule
  0070 and DESIGN.md already had, and it is kept deliberately rather than by
  omission — a per-control soft halo is what makes an interface read as a web
  page rather than an app.
- **That rule imposes no shape.** The global rule sets no `border-radius`; the
  shadow follows whatever corner the control has. Correcting this, not moving
  ownership, is what fixes a focused control changing shape.
- **A badge is a filled pill.** It reads as a status token, sized on the type
  ramp rather than below it.
- 0073's type hierarchy is unchanged and still binding. The style's occasional
  arbitrary size is retargeted onto the ramp; it brings no competing hierarchy.
- Everything else 0070 settled stands: the stack, `--octant-*` token ownership,
  the shell staying an ADE with compact navigation rows, restyling the Octant
  owner rather than swapping in a foreign block, selected rows using a fill and
  a label, and dual paint dying on contact.

## Consequences

- A recipe can be reconciled against upstream by reading it, rather than by
  translating its shape and focus into local pixel values first.
- Controls round slightly more, cards trade a shadow for a hairline, and focused
  controls keep their own shape. The change is visible across every surface and
  is verified by rendered review.
- Every focusable thing keeps exactly one indicator, drawn the same way, whether
  or not it is an owned recipe. The switch and the GitHub search field still
  re-assert the ring where their own `box-shadow` outranks it.
- A focused control now keeps its own corner, which is the only behaviour that
  changes here.

## Related

- 0070 is superseded on radius and elevation. Its single-owner focus ring is
  kept, minus the radius it imposed. Its
  stack, token, shell, and dual-paint rules are carried forward here.
- 0085 settles which style the recipes follow.
- 0073 owns the type hierarchy a recipe's sizes land on.
- 0016 owns the primitive stack and token authority.
