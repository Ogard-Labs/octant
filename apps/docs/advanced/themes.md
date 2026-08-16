---
description: Semantic themes, presets, typography, sidebar appearance, translucency, backgrounds, and vibrancy.
---

# Themes and Appearance

Octant uses a semantic theme engine shared across the desktop and web. A
set of `--octant-*` tokens is the source of truth; controls and surfaces project
those tokens, so theme choices stay consistent across the app.

## Settings → Appearance

The **Appearance** section covers sidebar width, the mode switcher, the
environment panel, the translucent sidebar switch, sidebar background and
vibrancy, theme mode and preset, UI/editor/terminal typography, theme
accessibility, and theme import and export.

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
