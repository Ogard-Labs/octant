---
description: Semantic themes, presets, typography, sidebar appearance, translucency, backgrounds, and vibrancy.
---

# Themes and Appearance

Octant uses a semantic theme engine shared across the desktop and web. A
set of `--octant-*` tokens is the source of truth; controls and surfaces project
those tokens, so theme choices stay consistent across the app.

## Settings → Appearance

The **Appearance** section covers sidebar width, the mode switcher, the
project view switcher, the environment panel, the translucent sidebar switch,
sidebar background and vibrancy, theme mode and preset, UI/editor/terminal
typography, theme accessibility, and theme import and export.

**Project view switcher** chooses how the Code sidebar offers saved project
views: a dropdown, or one icon button per view that shows the view name on
hover. Each project view can be given its own icon and color when you create or
edit it.

### Theme mode and presets

Theme mode is **System**, **Light**, or **Dark**. Built-in presets are
**System** (follows the current system appearance), **Light**, **Dark**, and
**Octant** (the product's original graphite palette).
Semantic token roles cover foundation, surface, control, border, text,
focus, accent, status, and diff colors with contrast validation and safe
fallback. Theme density is **comfortable** or **compact**.

You can import a bounded subset of VS Code color-theme JSON
(`octant-theme` format). Themes can never contain scripts, extensions, or
executable payloads; invalid themes fall back safely and can be previewed
before activation.

### Typography

UI, editor, and terminal typography are independent. UI uses family, size,
and weight; editor and terminal add line height and ligatures. Font sizes run
8–32, weights 300–700, and line heights 1–2.5. Missing fonts fall back safely
per client; no remote or untrusted fonts are loaded.

### Translucent sidebar

The **Translucent sidebar** switch uses the system sidebar material when
available. When the material resolves to opaque — for accessibility or
performance reasons — the interface says so honestly. **Reduced
Transparency** and **Increased Contrast** resolve the sidebar to opaque.

### Sidebar background and vibrancy

The sidebar can use a built-in preset, a custom uploaded image, or no
background, with overlay color and opacity plus a vibrancy mode of **Off**,
**Subtle**, or **Strong**. Presets cover gradients, shapes, dev-inspired
patterns, and subtle ambient textures — all static in V1.

Custom uploads accept PNG, JPEG, and WebP only (magic-byte validated), up to
8 MiB and 4096×4096 pixels. **Reduced Transparency** disables the background
and vibrancy entirely; **Increased Contrast** clamps overlay opacity to at
least 80%. Vibrancy is native to the Electron app; web hides the control and
forces it off.

### Zen backgrounds

Zen Appearance can use a first-party still or animated preset, a custom local
image, a solid color, or a custom linear, radial, or conic gradient. Overlay
and card opacity stay adjustable. Uploads remain local PNG, JPEG, WebP, or
GIF. Animated presets and custom animated uploads fall back to a still frame
under **Reduced Motion**. Built-in loops use animated WebP.

### Handing the theme to a project

Appearance offers two exports beside **Export theme JSON**, which writes
Octant's own settings file:

- **Export design tokens (CSS)** writes custom properties a project outside
  Octant can adopt directly — `:root` for the light reading, a
  `prefers-color-scheme: dark` block for the dark one, and `[data-theme]`
  blocks for a project that pins the mode itself.
- **Export design tokens (JSON)** writes the same values as a token document,
  with both modes side by side.

Both write **both** readings of the theme, not whichever one is on screen, and
both carry the theme's own overrides rather than the preset they started from.
A prefix other than `octant` is accepted for the custom-property names. If the
theme refused an override — an unknown role, an unreadable colour, or one that
failed its contrast target — the export leaves it out and says so, instead of
handing a project values Octant does not itself render.

Type-scale variables travel with the export.

## Keyboard and navigation

Appearance and layout choices, including the mode switcher presentation, are
keyboard-navigable. See [Keyboard workflows](/advanced/keyboard-workflows)
for navigation and the Zen focus surface.

## Current status

Semantic themes, original presets, font controls, editor and terminal
projection, sidebar background images, and Electron vibrancy are part of the
in-progress technical-preview theme program. Theme changes are durable and
replay across restarts.

## Next steps

- [Keyboard workflows](/advanced/keyboard-workflows) for navigation and Zen
- [Privacy and security](/advanced/privacy-and-security) for where appearance state lives
- [Release compatibility](/advanced/release-compatibility) for preview boundaries
