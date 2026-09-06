# 0086. Recipes own their own shape, elevation, and focus

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

The global focus rule turns out to be the one place where 0070's reasoning no
longer holds on its own terms. DESIGN.md justifies the single ring by saying a
coloured ring reads as a website's link outline rather than an app control. But
`--ring` is projected from `--oct-fg` in `shadcn-theme.css`, so a recipe ring is
already monochrome here. What the global rule actually prevents is a _doubled_
ring — and it prevents it by also setting `border-radius` on focus, which snaps
a focused control to a shape it does not otherwise have.

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
- **Recipes paint their own focus.** Keyboard focus is part of a recipe's state
  vocabulary. The global `:focus-visible` rule no longer applies to an owned
  recipe — it is scoped away from elements carrying a `data-slot`, so it still
  covers every surface that is not one, and no control is painted twice or
  reshaped on focus.
- **The ring stays monochrome.** `--ring` remains a projection of the
  foreground. A recipe may not introduce a hue for focus, and the token
  ownership rules in 0016 and 0085 are unchanged.
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
- The switch and the GitHub search field currently re-assert the global ring
  because their own `box-shadow` outranks it. With focus scoped to the recipe,
  those become recipe state rather than stylesheet corrections.
- Surfaces that are not owned recipes — the shell, Monaco, the terminal, the
  dock — keep the global ring unchanged, so the rule that a focused thing always
  shows focus still holds everywhere.

## Related

- 0070 is superseded on radius, elevation, and the single-owner focus ring. Its
  stack, token, shell, and dual-paint rules are carried forward here.
- 0085 settles which style the recipes follow.
- 0073 owns the type hierarchy a recipe's sizes land on.
- 0016 owns the primitive stack and token authority.
