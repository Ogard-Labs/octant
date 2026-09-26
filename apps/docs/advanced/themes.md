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

The **Appearance** page covers the color scheme and presets, UI/editor/terminal
typography, theme accessibility, and theme import and export, then **Window**
(Glass), **Background**, **Sidebar** (width, destinations, the More row, the
mode switcher, provider icons), **Sidebar thread rows**, and **Reading**
(transcript text size and width).

**Project view switcher** lives in **Settings → Code**. It chooses how the Code
sidebar offers saved project views: a dropdown, or one icon button per view
that shows the view name on hover. Each project view can be given its own icon
and color when you create or edit it.

### Sidebar destinations

**Sidebar destinations** controls where navigation destinations live: as a
sidebar row, under the sidebar's More row, in the account menu, or nowhere.
Open **Customize sidebar** from the More row or the account menu, or use
**Settings → Sidebar → Sidebar destinations**. Use the visibility control to
choose **Always show**, **Menu only** where the destination offers that
placement, or **Don't show**, and use the chevrons to move it up or down.
**Reset sidebar destinations** restores the untouched placement and order.

**More row in the sidebar** (on by default) ends the sidebar's navigation with
a More row above the Project and thread lists. Its popup holds the **Menu only** destinations and **Customize
sidebar**, so a destination set to Menu only opens from the rail it was hidden
from. Turning it off returns those destinations to the account menu. A
**Don't show** destination appears nowhere either way.

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
fallback.

You can import a bounded subset of VS Code color-theme JSON
(`octant-theme` format). Themes can never contain scripts, extensions, or
executable payloads; invalid themes fall back safely and can be previewed
before activation.

### Typography

UI, editor, and terminal typography are independent. UI uses family, size,
and weight; editor and terminal add line height and ligatures. Font sizes run
8–32, weights 300–700, and line heights 1–2.5. Missing fonts fall back safely
per client; no remote or untrusted fonts are loaded. The default interface is
the bundled Inter face at 13px, falling back to the platform stack. The default editor is JetBrains Mono Variable (or
its declared local fallbacks) at 13px, and the terminal uses JetBrains Mono
Variable, JetBrains Mono, SF Mono, Menlo, Symbols Nerd Font Mono, and monospace
at 12px. Transcript text starts at 13px; the existing small, medium, and
large transcript choices remain available. The platform face remains available
from the font picker as System interface.

### Glass

**Glass** is the frosted material behind the sidebar and around the workspace
cards: **Off** paints it solid, **Subtle** or **Strong** uses the system
material at that strength. **Tint** (0–90%) sets how much colour lies over
the glass behind the sidebar and around the cards; lower is more see-through,
and until you move it the slider shows the level's own tint. In the desktop app
the glass frosts your desktop; with a background shown everywhere it frosts
that instead. Increased contrast keeps the tint at 80% or more, and Reduced
transparency makes it solid. **Glass cards** lets the glass show through the
cards as well. When the material resolves to opaque — for accessibility or
performance reasons — the interface says so honestly. **Reduced
Transparency** and **Increased Contrast** resolve the sidebar to opaque.

### Sidebar background

On **Settings → Sidebar**, the sidebar can use a built-in preset or no background,
with overlay color and opacity. Presets cover gradients, shapes, dev-inspired
patterns, and subtle ambient textures — all static in V1. **Reduced
Transparency** disables the background entirely; **Increased Contrast** clamps
overlay opacity to at least 80%.

### Background

The app sits on a background of its own, set in three choices.

**Background** is what sits behind Octant. **Dot pattern** (the default) is an
ordered-dither field drawn from the theme's bounded pattern palette. Most themes
use the accent alone; Pride uses a six-colour spectrum and Norway uses red,
white, and blue. The resolved accent remains the first ink, so switching presets
or overriding the accent recolours the leading ink at once. **Built-in picture**
uses the same still or animated first-party image catalog as Zen; the current
picture stands for the set until you choose **Change**. **Your photo** uses a
picture of yours: upload a PNG, JPEG, or WebP up to 8 MiB and 4096×4096 pixels,
or pick one already on this host, and **Photo strength** sets how strongly it
shows. The sidebar and the background share one photo library, and a photo in
use cannot be deleted. **None** keeps the plain page.

**Effect** prints a picture: **Off** shows it as it is, **Pixelate** draws it in
square pixels, and **Dither** does that with fewer colours, like a print.
**Pixel size** (2–16 px) and **Colours** (2–16, fewer is bolder) tune it. An
animated built-in is printed from its still frame. A photo saved before this
choice existed keeps its original two-pixel, four-colour dither.

**Motion** is what moves: **Still** holds everything, **Pulse** lets the
background slowly breathe a little brighter and back, and **Wave** rolls soft
bands of dots across it, with **Wave speed**, **Dot strength**, and **Dot
density**. The dot pattern keeps its dots whatever moves; over a picture they
are the Wave.

**Show behind** puts the background behind the start screens only, where it is
masked away behind the composer and fades out below it, or behind every page,
where the workspace stays transparent over it and transcript responses carry
their own reading cards; **Cover the sidebar** extends it under the sidebar.
Reduced motion holds everything still; Increased contrast turns the background
off; a browser without WebGL2 shows a picture but no dots.

### Zen backgrounds

Zen Appearance has three short sections.

- **Look**: **Dim** darkens the ground (one dial for every kind of ground),
  **Windows** sets how solid the windows are, and **Picture** chooses Fill, Fit,
  or Tile for a picture.
- **Effect**: **Pixelate** draws a picture in square cells and **Dither** also
  prints each cell with a few tones through an ordered pattern, like a
  halftone. **Pixel size** sets the cell (2–16 px) and **Tones** sets how many
  steps each colour keeps (2–16; fewer is bolder). The effect works on built-in
  pictures and your own; an animated picture is printed from its still frame.
- **Background**: **App background**, **Your picture** (a local PNG, JPEG, WebP,
  or GIF), the first-party still and animated pictures, and **Custom fill** for
  a solid color or a linear, radial, or conic gradient. Animated pictures fall
  back to a still frame under **Reduced Motion**. Built-in loops use animated
  WebP.

**App background** stands the space on the same ground as the rest of Octant:
whatever **Background** is set to in Settings › Appearance, with the dials you
set there, including its own dither. It carries none of its own, so changing a
pattern, built-in image, or photo once changes every space that uses it.
**Dim** still darkens it, **Reduced motion** keeps animated backgrounds on
their still frame, and **Increased contrast** still turns it off.

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

Appearance and Sidebar choices, including the mode switcher presentation, are
keyboard-navigable. The sidebar's width, destinations, More row, mode switcher,
provider icons, background, and thread-row details live on **Settings → Sidebar**. See [Keyboard workflows](/advanced/keyboard-workflows)
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
