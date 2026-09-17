---
description: Semantic themes, presets, typography, sidebar destinations and appearance, translucency, backgrounds, and vibrancy.
---

# Themes and Appearance

Octant uses one semantic theme foundation across desktop, web, mobile, public
documentation, and marketing material. `@octant/theme` is the source of truth;
CSS and React Native adapters project those roles into platform controls and
surfaces. Platform-specific materials and touch geometry may differ, but they do
not own a second core palette.

## Settings → Appearance

The **Appearance** section covers sidebar width, the mode switcher, the
project view switcher, the translucent sidebar switch, sidebar background and
vibrancy, theme mode and preset, UI/editor/terminal typography, theme
accessibility, and theme import and export.

**Project view switcher** chooses how the Code sidebar offers saved project
views: a dropdown, or one icon button per view that shows the view name on
hover. Each project view can be given its own icon and color when you create or
edit it.

### Sidebar destinations

**Sidebar destinations** controls where navigation destinations live: as a
sidebar row, in the account menu, or nowhere. Open **Customize sidebar** from
the More row or the account menu, or use **Settings → Appearance → Sidebar
destinations**. Use the visibility control to choose **Always show**, **Menu
only** where the destination offers that placement, or **Don't show**, and use
the chevrons to move it up or down. **Reset sidebar destinations** restores the
untouched placement and order.

**More row in the sidebar** (on by default) puts that control at the end of the
sidebar's navigation, above the Project and thread lists. The row is the
sidebar's own control rather than a destination: its popup carries one checkbox
per element, checked while the rail shows it. Unchecking a workspace destination
sends it back to the account menu; unchecking a primary one hides it.
**Customize sidebar** opens the full editor for ordering and for **Menu only**
placement. Turning the row off leaves those controls to Settings. A destination
set to **Always show** stays in the rail either way, and one set to **Menu only**
waits in the account menu either way. A **Don't show** destination appears
nowhere.

Availability still follows the active mode and the host's capabilities: a
destination that is unavailable or unauthorized does not appear merely because
it is set to **Always show**. Destination choices are durable shell settings and
replay across restarts.

### Theme mode and presets

Theme mode is **System**, **Light**, or **Dark**. Built-in presets are
**System** (follows the current system appearance), **Light**, **Dark**,
**Octant** (the original charcoal-and-brass palette), and twenty tinted
palettes that lean the whole page toward one hue and colour the accent, in
light and dark: **Moss**, **Lagoon**, **Harbor**, **Iris**, **Rose**,
**Ember**, **Coral**, **Clay**, **Sand**, **Olive**, **Mint**, **Sky**,
**Slate**, **Plum**, **Ash**, the true-black **Ink**, **Obsidian**, and
**Onyx** for OLED screens, plus **Pride** and **Norway**. Pride pairs softly
violet surfaces with a six-colour spectrum; Norway pairs fjord-blue surfaces
with a red accent. Every preset clears the same text and control
contrast bars.
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

### Background

The app sits on a ground of its own. **Theme pattern** (the default) is an
ordered-dither cloud drawn from the theme's bounded pattern palette. Most themes
use the accent alone; Pride uses a six-colour spectrum and Norway uses red,
white, and blue. The resolved accent remains the first ink, so switching presets
or overriding the accent recolours the leading ink at once. **Built-in** uses the same still or
animated first-party image catalog as Zen, with a preview tile for every
choice. **Photo** prints a picture of yours through the same dither, with the
cloud over it; upload a PNG, JPEG, or WebP up to 8 MiB and 4096×4096 pixels, or
pick one already on this host. The sidebar and the ground share one photo
library, and a photo in use cannot be deleted. **None** keeps the plain page.

**Show behind** puts the ground behind the start screens only, where it is
masked away behind the composer and fades out below it, or behind everything,
where the workspace stays transparent over it and transcript responses carry
their own reading cards; **Cover the sidebar** extends an everything ground
under the sidebar. **Show pattern** is the direct on/off switch for the cloud,
while **Pattern opacity**, **Pattern speed**, and **Pattern intensity** remain
its tuning dials. For a photo, **Dither photo** keeps or removes the
ordered-dither print treatment and **Photo opacity** dims the image. Reduced
motion holds the cloud still; Increased contrast turns the ground off; a
browser without WebGL2 shows a photo but no cloud.

### Zen backgrounds

Zen Appearance can use a first-party still or animated preset, a custom local
image, a solid color, or a custom linear, radial, or conic gradient. Overlay
and card opacity stay adjustable. Uploads remain local PNG, JPEG, WebP, or
GIF. Animated presets and custom animated uploads fall back to a still frame
under **Reduced Motion**. Built-in loops use animated WebP.

**App background**, above the built-in pictures, stands the space on the same
ground as the rest of Octant: whatever **Background** is set to in Settings ›
Appearance, with the dials you set there. It carries none of its own, so
changing a pattern, built-in image, or photo once changes every space that
uses it. **Background opacity** still dims it, **Reduced motion** keeps animated
backgrounds on their still frame, and **Increased contrast** still turns it off.

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

The everywhere background also shows behind page surfaces such as Board, Inbox,
Archive, and Pull requests. Reader pages and Project overviews soften it behind
a translucent reading surface. Cards, menus, and controls keep their own
surfaces.

When an everywhere background covers the sidebar, separate sidebar decoration
controls are suspended. Turn off **Cover the sidebar** to restore your saved
sidebar background and overlay settings. Increased contrast keeps its existing
background suppression behavior.
