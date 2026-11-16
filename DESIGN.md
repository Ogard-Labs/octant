# Octant design system

This is the visual specification for Octant: desktop and web, the phone, the
public documentation and the marketing site. It holds:

1. [Principles](#principles): what the look is for, in six rules.
2. [Foundations](#foundations): colour, translucency, type, spacing, radii,
   heights, icons, lines, depth, motion, focus, layers and the appearance
   choices a person can make. Each value is a token, defined once.
3. [Window frame](#window-frame): the rail, the title band, the framed panel
   and the docks.
4. [Components](#components): one specification for each shared adapter in
   `apps/web/src/ui/base`.
5. [Patterns](#patterns): arrangements several screens share.
6. [Enforcement](#enforcement): what the checks and contract tests pin.

What one screen shows and does lives in the topic file that owns it. This
document is the system those files build with; they never define a second
palette, type scale, radius or control.

| Screen or tool                                                                                                                            | Owner                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Shell grid, tool row, content tabs, sidebar, icon rail, right dock, tool tiles, Environment, Browser, Board, Zen, What's new, guided tour | [Workspace: Presentation](docs/design/workspace.md#presentation)        |
| Turn header, transcript, composer behaviour, model picker, mode picker, context meter, message queue                                      | [Thread view](docs/design/thread-view.md)                               |
| Welcome screen, Code Home, first run                                                                                                      | [Start screen](docs/design/start-screen.md)                             |
| Settings sheet, groups and pages, Appearance, Permissions, Usage                                                                          | [Settings](docs/design/settings.md)                                     |
| The picture or drawn field behind pages                                                                                                   | [Application ground](docs/design/application-ground.md)                 |
| Canvas charts, tables, mockups and designs                                                                                                | [Canvas visuals](docs/design/canvas-visuals.md)                         |
| Moving a thread, Prepare to shut down                                                                                                     | [Hub and spokes](docs/design/hub-and-spokes.md#moving-a-thread-screens) |
| Browser captures strip and Draw on page                                                                                                   | [Browser captures](docs/design/browser-captures.md)                     |

[Workspace behavior](docs/design/workspace.md) owns navigation and pane
interaction; [architecture](docs/architecture.md) owns system and authority
boundaries. The tokens a website or another app consumes are generated from the
same stylesheets and described in
[Design tokens and the app feel](docs/design/design-tokens.md).

## Principles

1. **Quiet and flat.** A surface at rest is one flat fill one step from what it
   sits on and, where it needs an edge, one 1px hairline. No bevel, inner
   highlight, gradient, inset shadow or resting drop shadow. Pointing at a
   surface or pressing it changes its fill and nothing else.
2. **One tone, one frame.** The window reads as one tone. The sidebar and the
   stage sit in one framed panel whose single hairline starts and ends on
   itself; inside it, panes touch and share one line. Hierarchy comes from
   type (size first, then weight), space and fills, not from stacked boxes.
3. **Soft corners on one scale.** Four radii and a round exception. A control
   is 8px, a container 12px, a floating surface 16px, a dialog 20px; a corner
   inside another corner is concentric.
4. **Depth only for what floats.** Menus, popovers, hover cards, toasts,
   dialogs, the Settings sheet and the composer cast a shadow. Nothing else
   does.
5. **Translucent when asked, legible always.** With window glass on, the
   window is one see-through coat and every card, row and control is an ink
   wash over it. Text keeps its contrast floor on every material; when a
   material cannot hold it, the surface goes denser, never the text fainter.
6. **Colour carries meaning.** Colour is the default style and Mono draws the
   same app in greys. A hue names a state, a Project, a kind of Canvas or a
   provider, and always comes with a shape or a word.
7. **Nothing moves under the pointer.** Clicking, choosing or typing never moves
   another control. A control that a choice adds or removes keeps a reserved
   slot (hidden, not collapsed), a row keeps its items in one order in every
   state, and something appearing above an anchored surface (a notice above the
   composer) grows away from it instead of pushing it. Data still on its way
   never places what is already drawn: the start screen's composer sits where the
   arrived list leaves it and late rows fill the space below, and a mode switch
   draws the target mode's list whole on its first frame, its pictures asked for
   before any row shows them. A placeholder stays until its content can paint, in the
   same box: a first read is never drawn as an empty section, and the content
   replaces the placeholder without a frame of neither. A popup opens at its final size and keeps it: data
   arriving, a choice made inside it or a toggle that reveals detail never
   resizes or moves it. Its width and height are fixed, a list scrolls inside
   them, loading draws skeleton rows of the real rows' height, and the rows a
   choice could add are laid out from the start, quiet and out of reach, never
   inserted. It hangs from its trigger's edge (above, aligned to its start or
   end, 6px off) and never covers the trigger; what it will show is read before
   it opens. The person's next click
   lands where they last saw the target. Only the person's own act of moving
   something (a drag, a resize, opening the sidebar) moves layout.

**Voice.** The same words, face and hierarchy travel to every surface.
Sentence case everywhere, product nouns keep their capital (Project, Chat,
Work, Code, Environment); nothing is uppercase except a monospace identifier
that already is. One title per page; a section note or row description is one
sentence. Numbers use English separators ("1,024", "4.1k"); dates follow the
locale. An empty state's title has no closing period. Copy about the host
says "this Mac" and "Keychain" only when the host reports macOS, "this
computer" and "credential store" otherwise. Vocabulary: `Project`, `thread`,
`checkout`, `worktree`, `base branch`, `Environment`, `mode` (Auto / Ask first
/ Accept edits / Plan / Full access), `delivery` (Investigation / Local
implementation / Pull request / Merged). The word "target" does not appear in
the interface.

Avoid dashboard walls, neon developer styling, permanent low-frequency
controls, oversized setup cards, pill-shaped controls and invented data. The
one decorative thing is the [application ground](docs/design/application-ground.md).

## Foundations

Sizes are written at the 13px reference size; the default interface size is 14px (maintainer request 2026-11-15: text read weak beside its icons at 13px), so every type token is drawn 14/13 larger. Type and control heights scale
with the Appearance interface size; spacing, icons and radii do not.

### Colour roles and surfaces

The theme roles live in `packages/theme/src/tokens.ts`; the renderer fallback in
`apps/web/src/styles.css` mirrors them exactly. Text is three greys and never a
fourth.

| Role                   | CSS variable                 | Dark      | Light     | Use                                                          |
| ---------------------- | ---------------------------- | --------- | --------- | ------------------------------------------------------------ |
| Application background | `--octant-app-background`    | `#151515` | `#fafaf9` | Page ground for start screens and standalone pages           |
| Sidebar                | `--octant-sidebar(-opaque)`  | `#101010` | `#fafaf9` | The window frame's ground (dark); sidebar role               |
| Workspace              | `--octant-workspace`         | `#1a1a1a` | `#ffffff` | Reading surface; the source of the pane tone                 |
| Floating               | `--octant-floating`          | `#232323` | `#fdfdfc` | Source of the float tone                                     |
| Control                | `--octant-control`           | `#2b2b2b` | `#f0f0ef` | Quiet control fill, secondary button                         |
| Control hover          | `--octant-control-hover`     | `#333333` | `#e2e2e1` | Pointed-at control                                           |
| Control pressed        | `--octant-control-pressed`   | `#3b3b3b` | `#d3d3d2` | Pressed control                                              |
| Border                 | `--octant-border`            | `#303030` | `#e0e0de` | Theme border (opaque); dividers prefer the ink hairline      |
| Strong border          | `--octant-border-strong`     | `#4d4d4d` | `#bdbdbb` | Field and outline-button edges; increased-contrast lines     |
| Strong divider         | `--octant-divider-strong`    | `#8a8a8a` | `#6f6f6d` | Off switch edge, unchecked checkbox, slider track            |
| Primary text           | `--octant-text-primary`      | `#f5f5f7` | `#141414` | Body and control text; the ink every wash is mixed from      |
| Secondary text         | `--octant-text-secondary`    | `#bcbcc2` | `#45454a` | Supporting copy, section labels                              |
| Muted text             | `--octant-text-muted`        | `#a8a8ad` | `#666666` | Meta, hints, counts                                          |
| Accent                 | `--octant-accent`            | `#5b9cf5` | `#1f5fc7` | One primary action or active mark                            |
| Accent text            | `--octant-accent-text`       | `#5b9cf5` | `#1f5fc7` | Accent as text, held to 4.5:1                                |
| Accent foreground      | `--octant-accent-foreground` | `#141414` | `#ffffff` | Text on the accent fill                                      |
| Selection              | `--octant-selection`         | `#2c2c2c` | `#ebebea` | Chosen row in a scrolling picker (opaque so it never shifts) |
| Scrim                  | `--octant-scrim`             | `#000000` | `#000000` | Opaque by contract; mixed to a wash where used               |

**Pull-request roles.** `--oct-pr-open`, `--oct-pr-merged`, `--oct-pr-closed`,
`--oct-pr-draft` and `--oct-link` are defined once in `octant.css` as the
host's own green, purple, red, grey and blue, a dark and a light value each, so
a state reads as it does on the host; the theme's success and danger inks are
tuned to sit quietly in a sentence and read weak as a state. Each state also
has a fill (`--oct-pr-open-fill` and its siblings, with `--oct-pr-on-fill` for
the text on it), used by the filled state badge at the head of a request. Mono greys open, merged and links; closed keeps its red. Feature CSS
names these tokens and never a hue.

_Why the muted change._ Meta ink at `#949494` on the opaque dark float
(`#333333`) is 4.17:1, under the 4.5:1 text floor, and the float is what every
menu shows under reduced transparency. `#9b9b9b` was the first grey that clears
4.55:1 there and stays 6:1 or more on the page. Dark meta ink is now `#a8a8ad`
(maintainer request, 2026-11-15: secondary text read weak), a step brighter, so
it clears both floors by more.

**Derived surfaces.** These are mixed in the stylesheets, never persisted. The
resolved values are for the default theme.

| Surface          | Token                                                   | Definition                                                                                      | Dark            | Light           |
| ---------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------- | --------------- |
| Frame ground     | `--octant-ground-opaque`                                | sidebar (dark); sidebar 93% toward the ink (light)                                              | `#101010`       | about `#eaeae9` |
| Pane             | `--octant-panel-opaque`                                 | workspace 98% (dark) / 99.5% (light) toward the ink                                             | about `#1e1e1e` | about `#fefefe` |
| Sidebar in panel | `--octant-sidebar-fill`                                 | pane 90% toward ground, at 94% opacity (100% under reduced transparency and increased contrast) | about `#1d1d1d` | about `#fcfcfc` |
| Card             | `--octant-card`                                         | workspace 95.5% toward the ink (oklab); workspace in light                                      | `#222222`       | `#ffffff`       |
| Float            | `--octant-float`                                        | floating 91% toward the ink (oklab); floating in light                                          | `#333333`       | `#fdfdfc`       |
| Float controls   | `--octant-float-control`, `-hover`, `-pressed`, `-line` | float 94 / 89 / 84 / 88% toward the ink; the control roles in light                             |                 |                 |
| Settings group   | `--oct-settings-card-fill`                              | ink 2% over the page                                                                            |                 |                 |
| Well             | `--octant-well`                                         | black 34% (dark), the theme's ink at 5% (light)                                                 |                 |                 |

The frame ground is darker than the pane in dark and a step greyer in light,
so the rail and band read as the window and the panel as the work. Inside the
panel the sidebar takes the pane's own tone (a few RGB steps apart), so a
hairline, not a grey fill, separates the two sides of the seam.

**Washes.** Interior state is a share of the ink, so it lands at the same
weight on any fill and on glass:

| Token                               | Value               | Use                                                            |
| ----------------------------------- | ------------------- | -------------------------------------------------------------- |
| `--oct-wash-hover`                  | ink 3% (oklab)      | A pointed-at row in the sidebar, rail, Settings rail and lists |
| `--oct-wash-selected`               | ink 4% (oklab)      | The row a list is showing; the rail's current face             |
| `--oct-fill-4` / `-3` / `-2` / `-1` | ink 4 / 6 / 8 / 14% | Tile faces, chips, count tiles                                 |
| `--oct-fg-soft`                     | ink 7%              | A chip's resting fill; the thread row's open mark              |

**Status.** Status roles pair a surface with its text; never rely on hue alone.

| Meaning  | Surface                                          | Text and border                                                             |
| -------- | ------------------------------------------------ | --------------------------------------------------------------------------- |
| Success  | `--octant-success-surface` `#16281f` / `#bfd8cc` | `--octant-success-text` `#6bb299` / `#0f6144`                               |
| Warning  | `--octant-warning-surface` `#33270b` / `#fbe9bd` | `--octant-warning-text` `#f2c75c` / `#5c3d00`; border `#c99a2e` / `#8a6218` |
| Danger   | `--oct-danger-soft` (danger text 20%)            | `--octant-danger-text` `#e17d96` / `#a8102f`                                |
| Addition | none                                             | `--octant-addition-text` `#6bb299` / `#0f6144`                              |
| Deletion | none                                             | `--octant-deletion-text` `#e17d96` / `#a8102f`                              |

Routine waiting and idle states are neutral. A state, empty or error message
draws its mark in neutral ink whatever went wrong; warning colour is for an
actionable warning only.

**Palette roles.** Eight categorical hues (`--octant-palette-red`, `-orange`,
`-yellow`, `-green`, `-teal`, `-blue`, `-purple`, `-pink`; read through
`--oct-colour-*` in `styles/colour.css`) name Projects, Canvas kinds, chart
marks and provider status. Every mark pairs its hue with a label, icon,
pattern or border style.

**Mono and custom themes.** Settings › Appearance › Style chooses Colour (the
default) or Mono; the root carries `data-octant-style`. Mono swaps in the ink
accent (`#f5f5f7` / `#141414`), the text on it, the neutral warning trio
(`MONO_STYLE_TOKENS`), grey tiles and marks. Increased contrast always draws
Mono. Bundled presets lean every role toward one hue and carry their accent; a
custom theme overrides only validated roles, and an incomplete or low-contrast
import falls back. Every derived surface and wash above is computed from the
resolved roles, so a preset or custom theme gets the same ladder without
writing it. Accent swatches and their per-mode fills are in
[Settings: Appearance](docs/design/settings.md). The editor and terminal draw
from the same roles through `packages/theme/src/editorColors.ts` and
`terminalColors.ts`. A plugin may contribute themes as data only, listed beside the built-in
presets while the plugin is installed, trusted and enabled
([Architecture: Themes as plugin contributions](docs/architecture.md#plugin-boundaries-and-remaining-extraction));
a stored choice whose plugin is off draws the default theme and comes back with the plugin.

### Translucency

Window glass is the `sidebarMaterial` shell setting with a level (Settings ›
Appearance › Window › Glass: Off, Subtle, Strong) and a Tint slider. It is on
only when the host reports the native material applied
(`html[data-octant-host-vibrancy="active"]` and `.shell--material-translucent`).
The host withholds it under the system's Reduce transparency, high contrast and
thermal pressure (the system's rich-animation hint, which reads false over
screen sharing, is not a gate: Glass is a material, not an animation); a browser
window never has it. While Glass is chosen and the window is opaque, the row
says why in one sentence that starts "Glass is off because", naming the host's
reason (Reduce transparency, Increase contrast, thermal pressure, an unsupported
system) or, in a browser, that it has no material to frost. The
desktop app logs the gate's inputs, and each change of them, to its log.

**One coat.** With glass on, the window is one translucent coat over the
native material, painted once on the shell (`--octant-window-surface`). The
rail, the title band, the sidebar, the stage, every dock tile, the bottom
panel and the dock's overview are clear on it: one tone, with the framed
panel's hairline as the only thing that tells the panel from the frame. A
surface never paints a second coat over the first, because stacked coats turn
nearly opaque where surfaces nest.

| Level  | Coat (`--octant-window-surface`)                                                   | Dark | Light |
| ------ | ---------------------------------------------------------------------------------- | ---- | ----- |
| Subtle | workspace colour at the level's alpha (`--octant-workspace-translucent-subtle`)    | 74%  | 88%   |
| Strong | `--octant-workspace-translucent-strong`                                            | 58%  | 76%   |
| Tint   | the person's Tint (0 to 90) replaces the level's alpha, clamped to the floor below |      |       |

The default coats were 66% and 50% in dark and 84% and 70% in light until
2026-11-15, when the text of apps behind the window read through them too
clearly (maintainer request); a Tint a person stored is kept as set.

**Contrast floor.** The coat must hold text over whatever the desktop shows. The
bound used is the native material at its worst: a white desktop behind a dark
theme and a black one behind a light theme, with no help from the material's
own tint. Computed from the role colours:

| Text role on the coat | Dark coat needs | Light coat needs |
| --------------------- | --------------- | ---------------- |
| Primary, 4.5:1        | 61%             | 50%              |
| Secondary, 4.5:1      | 77%             | 72%              |
| Muted, 4.5:1          | 90%             | 92%              |

- The coat is clamped at paint time to 45% in both modes. That is under the
  bare-desktop primary floor above on purpose: at 62% the dark coat matched a
  dark desktop's grey and the glass read as a solid fill. The bound is the
  native material's own tint under the coat, which already darkens (or, in
  light, lightens) what is behind; primary text is checked at 4.5:1 over the
  material as it actually draws, in the packaged app on a white and a black
  desktop. The saved value is kept, so moving the floor needs no migration.
- Where the coat is under the secondary floor (every dark level, or a low Tint), the
  muted role inside the shell takes the secondary ink, so meta text stays
  readable at the cost of one step of hierarchy.
- Secondary and muted text are held at 4.5:1 over the native material as it
  actually draws, measured in the packaged app on a white and a black desktop.
  The browser cannot show this: it has black behind the window.

**What each surface does.** A see-through surface is a share of the ink over the
coat, never an opaque theme colour (an opaque dark fill reads as a black slab
on mid-grey glass) and never a blur (the packaged window does not frost
page content over its native material: a backdrop filter there lays a sharp copy
under the fill).

| Surface                                                                | Opaque window                                                                                                        | Window glass                                    | Reduced transparency / increased contrast                       |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------- |
| Rail, band, sidebar, stage, tiles, bottom panel                        | frame ground; pane; sidebar fill                                                                                     | clear on the coat                               | opaque                                                          |
| Card (`--octant-card`, `bg-card`), Code Home cards, approval card      | card colour + hairline                                                                                               | ink 4% + hairline                               | card colour + hairline (strong border under increased contrast) |
| Settings group                                                         | ink 2% + hairline                                                                                                    | ink 2% + hairline                               | ink 2% + hairline                                               |
| Dock card                                                              | ink 4% (oklab)                                                                                                       | ink 4% (oklab)                                  | same                                                            |
| Control fill, chip, segmented track                                    | control roles                                                                                                        | ink 7%, 11% hover, 15% pressed; chosen ink 12%  | control roles                                                   |
| Outline button                                                         | rests on the page colour                                                                                             | rests on the card step                          | page colour                                                     |
| Composer box                                                           | card colour + faint hairline + float shadow                                                                          | ink 7% + faint hairline + float shadow, no blur | card colour                                                     |
| Person's message (bubble)                                              | card colour, no hairline                                                                                             | ink 4%, no blur                                 | card colour; strong border under increased contrast             |
| Composer notice card                                                   | callout ground                                                                                                       | ink 4% with its tone at 14% over it, no blur    | callout ground                                                  |
| Menu, popover, select, combobox, hover card, palette, toast, tour card | float at 66% (dark) / 78% (light) over `--octant-float-blur` in a browser; float at 96%, no blur, in the desktop app | float at 96%, no blur                           | opaque float, no blur                                           |
| Dialog, Settings sheet, narrow dock sheet, Settings' narrow drawer     | as menus                                                                                                             | float at 96%, no blur (Settings sheet: opaque)  | opaque float                                                    |
| Tooltip                                                                | the float, opaque                                                                                                    | the same                                        | the same                                                        |

- **Text keeps a calm ground.** Where the application ground runs behind the
  panes, every surface that holds running text (the thread's reading veil, the
  sidebar's lists, and in the opaque window the dock panes, the Environment
  section and the bottom panel, which are opaque) keeps at least 94% of its own
  surface colour over it: `--octant-reading-surface-keep`, one variable on the
  shell. Empty areas (a start screen's stage, the gutters between panes, the
  title band) keep the ground at full strength. No blur, and the Glass coat
  defaults are unchanged; Reduced transparency and Increased contrast resolve
  to 100%. At 80% and 82% a photo or a field of characters ran through the
  letters and read as noise (maintainer request, 2026-11-15). A start screen is no
  exception: only its stage stays open on the ground, and a pane opened beside
  it (a pull request in the dock, say) takes the same surface, the pane colour
  or, under Glass, the workspace colour, at 94%. letters and read as noise (maintainer request, 2026-11-15).
- **Why floats are dense on glass.** A frosted menu works over an opaque
  window because the blur hides the page under it. On a translucent window it
  cannot, so at 66% the text behind a menu would read through it. At 96% the
  menu's own text holds 5.9:1 (secondary, dark) over a white desktop.
- **Text never sits on a fill that only a blur makes readable.** The desktop
  app's window is transparent on macOS and its renderer draws no backdrop filter
  there, with Glass on or off
  (`html[data-octant-native-host="true"]`). In the desktop app every float
  (menu, popover, select, combobox, hover card, palette, toast, notice, tour
  card, dialog) is the dense 96% float with no blur whether
  Glass is on or off, and a surface that sits over the application ground (a
  person's message, a glass card, Zen's windows and bars; the composer box while
  Glass is off) is the float colour at 96% with no tint image and no blur; a
  card over the ground under Glass is its card colour at 94%. Under Glass the
  composer box is the ink wash every control on the coat is (7%, no blur), so it
  follows the glass level and the ground shows through it; Increased contrast,
  Reduced transparency and a window with Glass off make it opaque. A browser keeps the frosted fills,
  where the blur is drawn over an opaque page.
- **Settings leaves the window as it is; a dialog blurs it.** Settings is a
  sheet so a person can watch the window change while they change its
  appearance, so behind it nothing is blurred or dimmed: only a 6% shade sets
  the sheet apart. In the desktop app the sheet itself is solid, the float with
  no blur (maintainer request, 2026-11-15): under Glass the window lets the
  apps behind it through, and no blur in the page can reach them. An 80% fill
  over a 28px backdrop blur, then a 96% fill, both left another app's text
  readable through Settings. Everything beside
  it stays visible; blurring the whole window past reading hid exactly what
  Settings is a sheet for. Behind a dialog, a
  decision rather than a view, the layers that hold content (the rail, the
  sidebar, the title band, the workspace and its docks) blur past reading (5px)
  and stay at 92%. Where a ground is drawn (a picture, pixels or characters) a
  modal is the dense float with no blur. The ground stays one layer under the
  sidebar, the stage, the sheet and its scrim, never over any of them. Only
  paint changes: the content stays in place and inert, focus returns to its
  trigger, and it comes back exactly as it was on close. A menu or popover is
  not modal and keeps the dense float; a toast and a notice do too.
- **Blur stays** where a surface has an opaque page under it: floats on an
  opaque window, the composer, bubbles and notice cards over the application
  ground in a browser, Zen's windows and bars in a browser, the activity
  picture-in-picture and the phone's glass. Each keeps the glass floor
  (`--oct-glass-floor`, the page colour at 66%) under its tint, so a photograph
  never carries body text alone.
- **Increased contrast is opaque.** Either trigger (the Appearance setting or
  the system) resolves every surface above to its opaque colour and every
  hairline to the strong border.
- **Reduced transparency** (the app setting or the system) resolves every
  surface to opaque, the coat included.
- **Forced colours** draw system colours and a 1px `CanvasText` edge on every
  float, card and chip.
- **Terminal and editor.** The terminal draws its cells on the coat when glass
  is on and repaints in place when the material, level or reduced transparency
  changes.

### Type

**Face.** Interface text uses the platform face (`system-ui, -apple-system,
BlinkMacSystemFont, 'Segoe UI', sans-serif`, SF Pro on a Mac), smooth and
strong: grayscale smoothing (`-webkit-font-smoothing: antialiased`,
`-moz-osx-font-smoothing: grayscale`) draws calm edges, and because it thins a
stroke (light text on a dark ground most) the weights step up with it. Smoothed
at the plain weights the text read weak beside its icons, and unsmoothed it was
strong but grainy at its edges (maintainer requests, 2026-11-15 and 2026-11-16).
The platform face draws every weight in between (a 14px line grows 5.4px for
each 50 from 400 to 650, measured), so with smoothing on reading text is 450, a
name or a label 600 and a heading 650; the page title keeps 700, and the
body's own weight, which a person can set, takes the same half step. Geist is
an Appearance choice, and Appearance's Smooth text switch (on by default,
hidden off a Mac, `fontSmoothing` in the theme settings, default `"on"`; a
stored `"off"` stays off) returns the system's fuller strokes at the plain
weights (400, 500, 600).
Code, paths and identifiers use Geist Mono (`'Geist Mono Variable', 'SF Mono',
'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', monospace`); the terminal
defaults to 12px at 1.4 with ligatures off, the editor to 13px at 1.5.
`text-rendering: optimizeLegibility` and `font-synthesis: none` (no synthetic
bold) hold everywhere; every size is `calc(N * --oct-text-step)` with the step 14/13 at the
default interface size and 1 at 13px, and letter-spacing is normal on
the body.

**Native type.** A native Mac app gets SF's size-specific tracking and optical
size from the text system; a web view gets neither unless it asks. The body
takes the 14px tracking (`--oct-tracking-sf-14`, -0.011em), the default interface size, and `font-optical-sizing:
auto`; a role at another size names its own token (`--oct-tracking-sf-11` to
`-26`, the platform face's own tracking from the platform's published macOS
table, in thousandths of an em: +6 at 11, 0 at 12, -6 at 13, -11 at 14, -16 at
15, -20 at 16, -26 at 17, -23 at 20, +3 at 24, +8 at 26), because letter-spacing inherits as a
length. Code, the terminal and the editor keep normal tracking. A line of chrome
(a sidebar row, a menu option, a button, a label) is as tall as a native one,
17px at the 14px default, 16px at 13px (`--oct-line-chrome`, 1.23) and 14px at 12px (`-sm`, 1.2), in whole
pixels; reading text keeps its airier leading. Weights follow the platform:
regular for body and rows, medium where it marks a label or a row's title, strong
for headings, and 700 nowhere in chrome.

**Window manners.** Chrome behaves like a window, not a page: its text does not
select (`user-select: none` on the root, with reading matter opting back in),
controls keep the arrow and only a link in content shows the hand, nothing in
chrome underlines on pointer hover, there is no tap highlight and no focus edge
on a click (see Focus), icons and links do not drag, and scroll areas draw the
system's overlay scrollbars. The desktop app already withholds the browser's
context menu and offers only the editing menu. Anything that sits on a device
pixel stays on one: a dragged pane width is saved whole and drawn rounded,
hairlines are 1px, and icons are 16px in even boxes so no stroke is centred on a
half pixel.

| Role             | Size            | Weight | Leading | Ink         | Recipe and where                                                                                                                                        |
| ---------------- | --------------- | ------ | ------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hero             | 26 (20 phone)   | 400    | 30px    | primary     | `oct-title--hero`: the welcome question only                                                                                                            |
| Title            | 28              | 700    | 1.15    | primary     | `oct-title`: a page about one thing (a Project, a thread under review)                                                                                  |
| Page title       | 26              | 600    | 1.15    | primary     | `oct-page-title`: every destination and Settings page, the platform's tracking at 24 and up; its one line of state sits on the baseline, 13px secondary |
| Dialog title     | 17              | 600    | 1.35    | primary     | `.octant-dialog__title`; a part of a dialog 15 / 600                                                                                                    |
| Reply heading    | 20, 17, 15, 14  | 600    | 1.3     | primary     | Markdown `#` to `####`, 24px above, 12px below                                                                                                          |
| Section label    | 14              | 600    | 17px    | secondary   | `oct-section-label`                                                                                                                                     |
| Row label        | 14              | 500    | 17px    | primary     | `oct-row-label`                                                                                                                                         |
| Navigation name  | 13              | 500    | 16px    | primary     | `oct-nav-name`                                                                                                                                          |
| Navigation group | 12              | 400    | 14px    | muted       | `oct-nav-group`                                                                                                                                         |
| Menu option      | 13              | 500    | 16px    | primary     | `oct-menu-option`                                                                                                                                       |
| Body             | 13              | 400    | 1.5     | primary     | `body`                                                                                                                                                  |
| Reply text       | transcript size | 400    | 1.6     | primary     | Appearance's transcript size; lists indent 16px                                                                                                         |
| Activity line    | 13              | 400    | 1.4     | muted       | `oct-activity-line`                                                                                                                                     |
| Detail           | 13              | 400    | 1.45    | secondary   | `oct-row-detail`                                                                                                                                        |
| Meta             | 12              | 400    | 1.4     | muted       | `oct-meta`                                                                                                                                              |
| Identifier       | 12              | 400    | 1.4     | muted, mono | `oct-meta--mono`                                                                                                                                        |

- **Size tokens** (`octant.css`, each times `--oct-text-step`): `--oct-text-xs`
  12, `--oct-text-detail` 13 (`surface.css`), `--oct-text-sm` 14,
  `--oct-text-base` 15, `--oct-text-lg` 17, `--oct-text-xl` 20,
  `--oct-text-2xl` 26, `--oct-text-3xl` 36, `--oct-text-4xl` 72. Nothing
  essential is under 12px. Feature CSS reads a token, never
  `calc(N * var(--oct-text-step))`.
- **Weights**: `--oct-weight-regular` (reading), `--oct-weight-medium`
  (labels, controls, menu options, names in navigation and list rows),
  `--oct-weight-strong` (section labels, card titles, page and dialog titles):
  450, 600 and 650 with Smooth text on (the default), 400, 500 and 600 with it
  off, which are the weights the type table names. 700 `--oct-weight-title`
  (the large title only) either way. The utility classes follow the tokens.
- **Tracking**: the platform's own per size (`--oct-tracking-sf-11` to `-24`,
  see Native type) on the body and the roles; `--oct-tracking-tight` -0.025em
  (dialog titles, reply headings and display type, the 17 to 20px values),
  `--oct-tracking-snug` -0.01em (the 14px values), `--oct-tracking-wide` 0.06em
  on mono meta.
- **Leadings**: `--oct-leading-label` 1.35, `-meta` 1.4, `-detail` 1.45,
  `-snug` 1.3, `-heading` 1.14, `-tight` 1.1, `-body` 1.5, `-reading` 1.6,
  `-code` 1.7; the whole-pixel lines `--oct-line-label`, `-detail`, `-meta`,
  `-snug`, `-tight` for rows whose height is the sum of their lines.
- **Transcript**: Small 13px, Medium 14px, Large 16px; Narrow 680px, Medium
  800px, Wide 1040px; a fresh install reads Small and Medium (about 85 characters a line at 1440). The column is
  `width: min(100% - 40px, measure)`. Welcome composers share a 768px maximum.
  Canvas documents use `--oct-canvas-measure` (62ch).
- A title is never the size and weight of the text it heads. A fact in a list
  is its name in muted ink and its value in primary ink.

### Spacing

A 4px scale: 4, 8, 12, 16, 20, 24, 32, 48 (`--oct-space-1` to `-6`, `-8`,
`-12`). 1px and 2px exist only for hairlines and optical nudges (2px inside a
segmented track). Tailwind's step is `--spacing: 4px`, so `px-2` is 8px at every
interface size; a recipe never names a half step. `--oct-composer-gutter` is
16px. Use `gap-*` for stacks.

### Radii

One scale. This table is the one statement; elsewhere this document names the
token.

| Token                | Value  | Every use                                                                                                                                                                                                                                                                                                  |
| -------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--oct-radius-sm`    | 8px    | A control: every button size and variant, field, select trigger, combobox group, tab, segmented item, menu and option row, filled list or navigation row, chip, tag, the composer's attach and send, a one-line tooltip, a drag preview, a capsule or track that only groups controls, the Open in trigger |
| `--oct-radius-md`    | 12px   | A container: a card, a Settings group, a dock card, an Environment card, a callout and composer notice card, an empty state, a well, a person's message, the framed panel's outline                                                                                                                        |
| `--oct-radius-lg`    | 16px   | A floating surface: menu, context menu, popover, select list, combobox list, hover card, tooltip card, palette, toast, the guided tour's card, composer popups; and the composer once it grows past one row                                                                                                |
| `--oct-radius-xl`    | 20px   | A dialog, the Settings sheet, the narrow dock sheet (an `OctantDialog`)                                                                                                                                                                                                                                    |
| `--oct-radius-inset` | 8px    | An object resting inside a container: a board card in its column                                                                                                                                                                                                                                           |
| `--oct-radius-pill`  | 9999px | Only what is round: a switch's track and thumb, an avatar, a status dot, a count badge, a spinner, a radio, a round swatch, a meter, a slider thumb, the composer at one row                                                                                                                               |

- A part inside a control takes the control radius less the padding between
  them, never below 2px (a segmented thumb, a toggle-group item, a field's
  clear button).
- A control inside a container keeps the control radius (8px rows inside a
  16px menu stand 8px in, concentric to within the inset).
- An object within one radius of a rounded parent's corner takes the parent's
  radius less the gap, or square when the gap is at least the radius. The
  stage clips to the panel outline's inner radius (`calc(var(--oct-radius-md) -
1px)`).
- A corner is a token, `0`, `50%`, or 1 to 4px on a chart mark or dot. No rem
  and no bare pixels. The shadcn scale derives from `--radius`
  (`shadcn-theme.css` sets it to `--oct-radius-sm`): `rounded-md` and
  `rounded-lg` land on 8px, `rounded-xl` on 12px. Phone-only web surfaces use
  `--oct-radius-bubble` 22, `--oct-radius-card-m` 26, `--oct-radius-sheet` 30.

### Heights

| Height | Token or recipe                                                                                      | Used by                                                                                 |
| ------ | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 20     | button `xs`, `icon-xs`                                                                               | The smallest button                                                                     |
| 24     | button `sm`, `icon-sm`; `--oct-tray-segment-h`; `--oct-toast-control-h`                              | A row action, a chip, a tab, a tray segment, a tile bar control, a toast's dismiss      |
| 28     | button `default`, `icon`; `--oct-rail-button-h`; `--oct-menu-row-h`; `--oct-settings-control-height` | A button, field, select, combobox, tray, title band control, menu row, Settings control |
| 32     | button `lg`; `--oct-nav-row-h`                                                                       | A large button, a navigation row, a rail face, a tile bar                               |
| 44     | `--oct-title-rail-h`                                                                                 | The title band and the icon rail's width                                                |
| 44     | `--oct-nav-head-h`, `--oct-menu-row-two-h`                                                           | The account row, a two-line row, a touch target, the one-row composer                   |

Recipe heights are rem rounded to a whole 2px (`h-[round(2rem,2px)]` is 28
at the 14px default root) so they grow with the interface size. They were
written for a 13px root, and the 14px default drew every recipe control 2px
tall of its row (a 30px button in a 28px row, a 26px segment in a 24px tray)
until the recipes were rebased (2026-11-16). Other shell heights:
`--oct-rail-tab-h` 30, `--oct-statusbar-h` 26, `--oct-surface-header-h` 40.
`--oct-control-height` (44) and `--oct-control-height-sm` (34) are touch and
compact field heights; a new desktop control takes a recipe height.

### Icons

Phosphor, imported only through the app's icon module (`apps/web/src/ui/icons`),
which keeps the names call sites use. The family is drawn as filled outlines at
fixed weights, chosen by the module, never by a call site's stroke:

| State                                      | Weight  | Ink                        |
| ------------------------------------------ | ------- | -------------------------- |
| 12, 14 and 16px (regular stroke read weak) | bold    | the control's own ink      |
| 20 and 24px (bold there reads heavy)       | regular | the control's own ink      |
| The selected destination in the icon rail  | fill    | primary ink; muted at rest |
| A pressed tool whose glyph is a toggle     | fill    | primary ink; muted at rest |

A call site passes `weight="fill"` only to mark the selected or pressed state;
everything else follows the size. A few glyphs have no exact match (a folder's
git badge, a plus on a branch or an image) and draw the plain glyph.

Each destination or tool has its own silhouette. Pairs that read alike at 16px
were split:

- To-dos: a tick in a square (`SquareCheck`), apart from Done today's tick in a
  circle.
- Linear issues: bulleted list (`ListTodo`), apart from the plan's tick list.
- File tree toggle: indented tree list (`ListTree`, filled while the tree
  shows), apart from the panel glyphs beside it.
- Arrange (a tool's tile layout) has no icon: it is a pane bar's context menu.
- Goal: crosshair (`Target`), apart from the concentric issue dot.
- Environment dock tool: a tower (`HostTower`, the computer the thread runs
  on), apart from the sliders of Settings and the composer's options.

| Size | Token           | Where                                                            |
| ---- | --------------- | ---------------------------------------------------------------- |
| 12   | `--oct-icon-xs` | Disclosure chevrons, marks inside a chip, 20px buttons           |
| 14   | `--oct-icon-sm` | Inside a 24px control, inline in 13px text, a tab's leading icon |
| 16   | `--oct-icon-md` | The default: buttons, menu rows, navigation rows, tool buttons   |
| 20   | `--oct-icon-lg` | An empty state, a dialog header, a page's empty mark             |

A tick inside a filled mark asks for `MARK_TICK_STROKE_WIDTH` (2.5), which the
module draws as the bold weight at any size. In a button pass the glyph with `data-icon` and let the recipe size it.
Provider marks are bundled, licensed artwork from `ProviderGlyph`, never
fetched, never emoji.

### Lines

| Token                    | Value                                                                                      | Where it lives                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--octant-pane-line`     | ink 7% mixed into the pane's opaque colour (oklab); strong border under increased contrast | The framed panel's outline and every pane divider                                                                                                |
| `--oct-hairline`         | ink 10% (oklab)                                                                            | Rows in a card, section rules, the title band's marks, tile bar rules, the edge of a card, a Settings group, an empty state and an approval card |
| `--oct-hairline-strong`  | ink 14% (oklab)                                                                            | A divider that must be found (the rail's divider under a selected face)                                                                          |
| `--oct-border-faint`     | ink 5% (srgb)                                                                              | The composer's outline                                                                                                                           |
| `--octant-border-strong` | theme role                                                                                 | A field's border, an outline button, a hovered divider, the rule beside reasoning                                                                |
| `--octant-float-line`    | float 88% toward the ink                                                                   | A rule inside a floating surface                                                                                                                 |

- Lines are 1px and drawn where they cost no layout: an `outline` with a
  negative offset on a card or the composer, a `border` on the panel's
  pseudo-element, `border-top` and `border-left` on panes. A shared edge is drawn
  once.
- Separate with a line or select with a fill, never both.
- A divider handle is the hairline at rest, the strong border under the
  pointer, and the meta ink at 2px while grabbed; the hit area is 8px centred
  on the line. None of it is the accent.

### Depth

| Level      | What                                                                          | Fill                                                       | Edge and shadow                                   |
| ---------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------- |
| 0 Ground   | The rail and the title band                                                   | frame ground (or the coat)                                 | none                                              |
| 1 Pane     | The sidebar's area, the stage, a dock tile, the bottom panel                  | pane / sidebar fill (or clear on the coat)                 | the pane line; no shadow                          |
| 2 Card     | A card, a Settings group, a bubble, an approval card                          | card or wash                                               | one hairline; no shadow                           |
| 3 Control  | A filled button, a chip, a selected row, a segmented thumb                    | control fill or wash                                       | none; an outline button or a field has one border |
| 3 Well     | A segmented track, a history capsule, a command block, a stepper              | `--octant-well` or the field paint                         | one hairline at most                              |
| 4 Floating | A menu, popover, hover card, toast, dialog, the Settings sheet, the tour card | `--octant-float-glass` (see [Translucency](#translucency)) | `--octant-shadow-pop`                             |

| Shadow token               | Dark                                                                   | Light                                                                  | Use                                             |
| -------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------- |
| `--octant-shadow-pop`      | `0 0 0 1px rgb(255 255 255 / 10%), 0 16px 40px -14px rgb(0 0 0 / 70%)` | `0 0 0 1px rgb(16 24 40 / 10%), 0 16px 40px -14px rgb(16 24 40 / 28%)` | Every floating surface                          |
| `--octant-shadow-overlay`  | `0 0 0 1px rgb(255 255 255 / 10%), 0 12px 32px -12px rgb(0 0 0 / 70%)` | `0 0 0 1px rgb(16 24 40 / 10%), 0 12px 32px -12px rgb(16 24 40 / 28%)` | A small float drawn by a feature (tooltip card) |
| `--oct-shadow-float`       | `0 6px 24px -10px rgb(0 0 0 / 30%)`                                    | `0 4px 18px -6px` ink 7%                                               | The composer and a picker pinned to it          |
| `--octant-shadow-hairline` | `0 0 0 1px var(--octant-border)`                                       | the same                                                               | A ring where an outline cannot be used          |

The resting shadow tokens (`--octant-shadow-xs`, `-sm`, `-md`, `-lg`,
`-control`, `-control-pressed`, `-selected`, `-well`, `-primary`,
`-raised-glass`) stay as names and are `none`. A floating surface's ring is
part of its shadow, so it sets no border. What sits on a floating surface takes
its fills from the float (`--octant-float-control`, `-hover`, `-pressed`,
`-line`), so a pointed-at row in a menu is a lift, not a dent.

### Motion

| Token                    | Value                            | Use                                |
| ------------------------ | -------------------------------- | ---------------------------------- |
| `--oct-motion-fast`      | 150ms                            | Feedback; an overlay arriving      |
| `--oct-motion-base`      | 200ms                            | Geometry; a switch thumb           |
| `--oct-dur-fast`         | 100ms                            | An overlay leaving                 |
| `--oct-motion-panel`     | 300ms                            | The sidebar sliding open or closed |
| `--oct-motion-spin`      | 900ms                            | A spinner turn                     |
| `--oct-motion-pulse`     | 1.6s                             | A live dot                         |
| `--oct-motion-flowing`   | 36s                              | The Flowing ground's CSS fallback  |
| `--oct-motion-ground-in` | 1200ms                           | A drawn ground fading in           |
| `--oct-ease-standard`    | `ease`                           | Ordinary transitions               |
| `--oct-ease-motion`      | `cubic-bezier(0.22, 1, 0.36, 1)` | Overlays arriving                  |
| `--oct-ease-color`       | `cubic-bezier(0.4, 0, 0.2, 1)`   | Overlays leaving, colour           |
| `--oct-ease-panel`       | `cubic-bezier(0.32, 0.72, 0, 1)` | The sidebar's slide                |

- **Overlays** (menu, context menu, select, combobox, popover, tooltip, hover
  card, dialog, sheet, their scrims) fade in over 150ms and out over 100ms. A
  popup settles from 98% at its anchor, a dialog from 98% about its centre, the
  sheet rises 8px. Only opacity, scale and translate change. A recipe carries
  no arrival classes of its own.
- **Press** darkens a fill and moves nothing. Chrome text does not select on a
  drag; controls keep the arrow cursor; the hand is for a real link. Disabled
  is `--oct-disabled-opacity` (0.75), no hover fill, no pointer events.
- **Reduced motion** (system or setting) removes every transition and holds
  every drawn ground on a still frame. Running state always has a word or shape
  as well as motion.

### Focus

One indicator, declared once in `octant.css`: a 2px inset outline
(`outline-offset: -2px`) in `--oct-focus-edge` (the ink at 62%), following the
control's radius, on `:focus-visible` while focus moves by keyboard
(`data-octant-input`). A control filled with the accent inverts it to
`--oct-focus-edge-on-accent`. A pointer-focused field shows its caret and a
border at 30% ink. A container that only holds the keyboard (menu, dialog,
listbox, preview card) shows no edge; its item does. The composer frame draws
no edge. Recipes paint no ring or halo; feature CSS never suppresses, recolours
or doubles it; `--octant-focus-ring` is never the indicator.

### Accessibility

- Text 4.5:1, large text 3:1, marks and edges 3:1, on every material
  ([Translucency](#translucency) for glass).
- Pointer targets at least 24px on desktop and 44px on touch.
- Every overlay opens, navigates and dismisses by keyboard, and returns focus.
  A menu opened by keyboard starts on its current choice. Radio groups wrap and
  take Home and End (`moveWithinRadioGroup`).
- Tab order follows reading order from the left; the sidebar comes before the
  window chrome. A surface that takes Tab or Escape offers one documented way
  out.
- Increased contrast is one state with two triggers, published as
  `data-octant-increased-contrast="true"`; it swaps the text roles for their
  `-high-contrast` values, every hairline for the strong border and every
  translucent surface for its opaque colour.
- Every app form is `noValidate`; Octant owns validation, association and
  focus. A refused server command is never a silent no-op.
- One scrollbar for every product scroller (`styles.css`): a thin thumb in
  `--octant-border-strong`, `--octant-divider-strong` under the pointer, no
  track, forced-colours fallback.

### Layers

| Token              | Value | What stands there                                                          |
| ------------------ | ----- | -------------------------------------------------------------------------- |
| `--oct-z-base`     | 1     | Ordinary stacking                                                          |
| `--oct-z-sticky`   | 20    | Sticky parts of a page                                                     |
| `--oct-z-overlay`  | 40    | The top of page chrome                                                     |
| `--oct-z-floating` | 50    | Dialogs, sheets, their scrims, the guided tour's card and ring             |
| `--oct-z-toast`    | 55    | Notices                                                                    |
| `--oct-z-popup`    | 60    | Menus, context menus, popovers, selects, comboboxes, tooltips, hover cards |

Inside the workspace nothing goes above 7: the window chrome is 7 and the
panel outline 6. A new surface takes a token, never a number of its own.

### Appearance

What a person can change about the look, and how each choice reaches the
tokens above. Settings › Appearance draws these controls; their placement and
copy are in [Settings](docs/design/settings.md).

**A theme from a few seeds.** Every surface, wash and line in this document is
a mix of three things: the ground (the workspace role), the ink (the primary
text role) and the accent. The bundled tinted presets are built from one OKLCH
hue each (`tintedPreset`, `packages/theme/src/presets.ts`); System, Light, Dark
and the warm Octant preset are written out. A **Custom** preset per mode takes
three seeds (Ground, Ink, Accent) and a **Contrast** step (Soft, Standard,
Firm). The step moves the control fills, the edges, the selection and the
washes (3% and 4%) and the hairline (10%) one notch, each scaled by 0.75 at Soft
and 1.5 at Firm (`--oct-contrast-scale`); the reading surfaces (the page, the
panes, the float) keep one fixed step off the ground, because the status hues
are chosen against them. The three text
greys are derived from ink and ground and checked by the theme's existing
contrast validation; a seed set that fails it is refused with the role that
failed, never painted.

| Choice                | Offers                                                                         | Reaches                                                         |
| --------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Mode                  | System, Light, Dark                                                            | `data-octant-theme-mode`; `color-scheme`                        |
| Light and Dark preset | The bundled presets and Custom                                                 | The `--octant-*` roles                                          |
| Style                 | Colour (default), Mono                                                         | `data-octant-style`; Mono roles                                 |
| Accent                | Swatches and a custom colour                                                   | `--octant-accent`, `-foreground`, `--octant-primary-foreground` |
| Glass                 | Off, Subtle, Strong; Tint                                                      | [Translucency](#translucency)                                   |
| Density               | Comfortable (default), Compact                                                 | Below                                                           |
| Interface font        | System (default), Geist, a custom stack; size 12 to 16 in steps, 14 by default | `--octant-ui-font-*`, `--oct-text-step`                         |
| Smooth text           | On (default), off; hidden off a Mac                                            | `data-octant-font-smoothing`; grayscale smoothing only when on  |
| Transcript            | Small, Medium, Large; Narrow, Medium, Wide                                     | `--oct-transcript-font-size`; the column measure                |
| Code, terminal        | Family, size, line height, ligatures                                           | `--octant-editor-*`, `--octant-terminal-*`                      |
| Background            | A ground, its options, and where it shows                                      | [Home with the drawn ground](#home-with-the-drawn-ground)       |
| Accessibility         | Increased contrast, Reduced motion, Reduced transparency                       | The root attributes these rules key on                          |
| Theme file            | Import and export as JSON                                                      | The persisted theme settings                                    |

**Density.** Compact changes rows and padding, never controls or type:

| Value                           | Comfortable | Compact |
| ------------------------------- | ----------- | ------- |
| `--oct-nav-row-h`               | 32px        | 28px    |
| Settings row minimum            | 52px        | 44px    |
| Dock card row                   | 44px        | 32px    |
| Environment row                 | 28px        | 28px    |
| `--oct-thread-gutter`           | 40px        | 32px    |
| Composer prompt padding (block) | 12px        | 8px     |

Controls stay 20 / 24 / 28 / 32px and every type role keeps its size; a larger
or smaller interface is the interface size, not density.

## Window frame

The window is a frame and one framed panel. Geometry lives in `shell.css` and
the tokens in `octant.css`; what each region holds is in
[Workspace: Presentation](docs/design/workspace.md#presentation).

**The frame.** The icon rail and the title band sit on the frame ground (or the
coat), painted once on the shell. Neither has a fill or line of its own.

- **Title band**: `--oct-title-rail-h` (44px, the height of a Mac window's
  unified title bar with a toolbar; 38px read as cramped in the desktop app). Its controls are 28px
  (`--oct-rail-button-h`) with the control corner, 4px apart, on an 8px inset at
  both ends. The band's title (the Project mark and name, the thread title, the
  device chip) is left-aligned and vertically centred, starting 20px after the
  stage's left edge (the thread column's own inset, so the title stands over the
  transcript's left edge and the band's actions end over its right edge): after the sidebar's
  trailing edge when the sidebar is open, after the chrome's leading cluster
  when it is collapsed or only a rail shows. It does not move when a thread
  opens or closes or the dock opens, only when the sidebar is resized or
  toggled. A slot a Project
  fills only sometimes takes no room while empty.
- **Icon rail**: `--oct-rail-w`, 52px (maintainer decision, 2026-11-14: it
  gives the stage the room). Its faces are 36px at the control radius with 20px
  icons, 2px apart (the button's `rail` variant); the first face is centred on
  the band's centreline (4px down). The current face takes
  `--oct-wash-selected`, the pointed-at face `--oct-wash-hover`, no border.
- **Desktop title bar**: Electron's native frame with `titleBarStyle:
hiddenInset` and no custom `trafficLightPosition` (it would grow the native
  overlay and eat clicks; if a packaged run shows the lights off the band's
  centreline, the position to try is x 16, y 15, whose 44px overlay is the
  band's height). The traffic lights sit in the band;
  the renderer keeps `--octant-native-traffic-light-leading-width` (74px) clear
  before Show sidebar, Back and Forward. One drag layer
  (`shell-frame__title-band-drag`) covers the whole band, edge to edge, and is
  the shell's first child. Electron applies drag and no-drag rectangles in
  document order, a later one overriding an earlier one, so a control opts out
  with `window-no-drag` on its own box. No container that spans empty band
  space (sidebar, Projects pane, icon rail column, dock, chrome root) is
  `window-no-drag`, and nothing after the layer is a drag region over the
  band: either left the band's empty stretches undraggable. Test title-bar
  controls in the packaged app.
- **Changes in the band**: on the Code start screen or draft of a Project
  with a Git checkout (the Project's own checkout; in an open thread the count
  is Environment's Uncommitted changes row, and the band does not repeat it),
  the band's trailing
  cluster starts with its uncommitted line changes, "+added −removed" at the
  meta size with tabular numbers, as a button that opens the dock's changes
  view. A count above zero is in the success or danger ink; a zero ("+0 −0"
  included) is in meta ink. A reading that has gone stale stays on screen in
  meta ink with "Updating…" as its tooltip; until a first reading lands an em
  dash holds the slot, so nothing in the band moves when the number arrives. It
  grows leftward from a 56px minimum so the buttons after it never move, and it
  is absent only for a Project with no Git checkout.
- **New thread**: Mod+N by default and bindable; every New thread button shows
  the chord as a quiet key cap in its tooltip.

**The framed panel.** Under the band the sidebar and the stage (the thread, its
dock and the bottom panel) sit in one panel:

- One 1px outline in `--octant-pane-line` (ink 7% mixed into the pane's opaque
  colour, so it is one opaque colour over the sidebar, the stage and the ground)
  at `--oct-radius-md` on every corner,
  drawn by the shell's `::after` above the content (z-index 6), its top edge on
  the band's lower edge and 4px (`--octant-panel-gap`, `--oct-space-1`) from the
  window's right and bottom edges. It has no fill and no shadow. The line
  starts and ends on itself: no open end at the rail or the window edge.
- Inside, full-height 1px lines split the sidebar, the stage and the dock and
  meet the outline at both ends. A pane draws its line on its left edge, and on
  its top edge only where it starts below another pane (the bottom panel); the
  stage and the dock start on the outline's top edge, which draws it, so every
  edge is drawn once at one strength.
  A dock tile on the top edge draws no top line of its own; the outline does.
  A tile's header rule, its control row and the Browser's address row use the
  same line, so every hairline in the panel is one colour.
- The stage clips to the outline's inside (`clip-path: inset(calc(38px + 1px)
1px 1px …)` with the inner radius), so no pane paints over a rounded corner.
- Opaque, the sidebar paints `--octant-sidebar-fill` (its colour at 94%, so the
  application ground is a whisper; no blur, which the desktop app does
  not draw; reduced transparency and increased contrast keep it whole) rounded
  to the inner corner on its left; the panes paint `--octant-pane-fill`. With glass on, both
  are clear on the coat.
- The application ground lies on the thread's pane under the content, clipped
  to the panel.

**The sidebar.** 280px by default, resizable (180 to 420px,
`--oct-sidebar-w-min`, `-max`); Settings shares the saved width. Its header row
is its part of the title rail. Rows are 32px (`--oct-nav-row-h`) on a 12px
inset (`--oct-nav-inset`), the account row 44px. A thread row is up to three
lines, one button with one accessible name ("title, Project, branch, pull
request, status or time"):

- **Top line** (12px, secondary ink): the Project's 16px mark (its own icon, or
  two initials on a rounded square in a hue derived from the Project, the one
  colour a row spends besides its state) and name, then the branch in the mono
  face and the muted ink, folded in the middle when long. At its end, the state
  in words with its icon when the thread is running (Working 14m, in the accent)
  or waiting on the person (Needs you, in the warning tone), otherwise how long
  ago it moved (3h, 2d) in the muted ink; new activity is a named dot beside the
  time. The Project tree names the Project in its heading, so its top line is
  the branch alone.
- **Title** (13px, 500, primary ink): one line with an ellipsis, the strongest
  text in the row. A row with nothing to name on a top line carries the state or
  the time at the end of this line.
- **Detail line** (12px, muted ink), only when there is something for it: the
  pull request with its state in words (#1205 open, merged, closed, draft), who
  started the thread, a worker's coordinator. The provider's 12px mark ends the
  last line the row has. Colour is spent on the state word and the Project's
  mark only; the row's other facts keep the ink roles.

A two-line row is 48px (6 + 16 + 20 + 6) and a three-line row 64px, the text
block centred; Compact density takes the lines to 14 and 18, so a two-line row
is 44px. A group heading stands 8px clear of the rows above it. A thread
with no top line and no detail is the title alone at the row height. The open thread takes
`--oct-wash-selected` and the primary ink; a pointed-at row takes
`--oct-wash-hover`. A thread open in another pane
of the window carries a 2px by 14px mark in `--oct-fg-soft` at its leading edge,
the focused one in the ink.
A status group's heading ("Idle 6", "Working 7") is 12px in the secondary ink with
its count in the muted ink, and keeps its fold. A thread's pane header is the
same breadcrumb in the title band: the Project's mark, its name in the secondary
ink, a slash, then the thread's title in the primary ink.

**Collapse.** Collapsed, the stage is the panel's left side: it keeps the
outline's corners and the 4px gap from the window's left edge (beside the rail,
the rail is that gap) and draws no left line. The sidebar slides over
`--oct-motion-panel` on `--oct-ease-panel`, and the stage's left corners round
only once the slide has ended (`--oct-motion-fast` after `--oct-motion-base`), so
no notch opens on the way; reduced motion is immediate. Opening, the corners
leave at once. The title band's drag strip and the traffic-light reserve stay
where they are through the slide.

**Docks.** The right dock's tiles and the bottom panel are panes inside the
panel: flat, touching, one line between neighbours, no corner or gap of their
own. The dock's header is an empty spacer under the band; its tool row lives in
the band. Divider hit areas are 8px centred on the line (`margin-left: -4px`).
Every dock tool has a size class, declared once in `rightUtilityDockModel.ts`.
**Fixed** tools (Environment at 300px, and panel tools such as Vitals, Plan,
Agents and Delivery at 360px) always have that width and no resize handle,
whatever opens or closes beside them. **Flexible** tools (Browser, Terminal,
device and simulator, desktop, Canvas, Review, Document, Files) open at 640px
and resize between 480px and the dock's ceiling (half the workspace, or what
the thread's minimum leaves for two columns); the handle stands only on a
flexible column's edge. A flexible tool beside a fixed one gives the column the
flexible rules. Environment is not a pane: it is the thread's own surface
continued to the right, on the thread's fill, 300px wide, with the thread's
hairline on its leading edge and no header, close button or handle. It is a
flat list: a muted 12px section label, rows of a 16px muted icon, a 13px label
and a right-aligned muted plain-text detail (28px tall, filled only by the
pointer, a chevron only on hover), and a hairline between sections and none
between rows. A minimised Browser or terminal flows after the last section as a
live preview: its head has no box, only the 16:10 picture is rounded.

**Narrow windows.**

| At or below | What changes                                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 960px       | The right dock is a modal sheet holding one tool (`--oct-radius-xl`, a titled dialog, Escape closes it); the bottom panel is unavailable; the sidebar stops resizing; Settings uses its drawer.  |
| 680px       | The sidebar is an overlay drawer over a scrim (starts closed, closes on Escape, an outside tap or a choice); the frame is flat with no panel and no outline; pane headers drop the Project step. |

Inside a surface, layouts reflow at `--oct-bp-lg` 920px, `--oct-bp-md` 720px and
`--oct-bp-sm` 560px. At a phone's width the start screen's composer and a
thread's column stand 20px from each edge (`--oct-thread-gutter` is 0 there).

## Components

Feature code imports the adapters in `apps/web/src/ui/base`, never
`ui/shadcn` or `@base-ui/react`. The adapters wrap owned recipes in
`apps/web/src/ui/shadcn` (Base UI-native shadcn `base-nova`). Recipes paint;
feature classes position. A recipe styles the state attribute Base UI writes
(`data-active`, `data-pressed`, `data-checked`), never one it invents. Every
control carries `window-no-drag`. "Glass" below means window glass is on; every
float follows [Translucency](#translucency).

### OctantButton and OctantIconButton

- **Purpose.** Every button. `octantButtonClassName({ variant, size })` paints
  a trigger another adapter renders.
- **Anatomy.** Variants `default` (the accent), `solid` (the ink with the page
  colour on it), `secondary` (control fill), `outline` (rests on
  `--octant-outline-rest` with the border), `ghost`, `destructive` (danger at
  10%, 20% hover, 25% pressed), `link`, `bare`, `rail`, `chip` (24px, border,
  muted ink). Sizes `xs` 20, `sm` 24, `default` 28, `lg` 32, `icon-xs` 20,
  `icon-sm` 24, `icon` 28. `OctantIconButton` takes a required `label` and is
  the 28px ghost icon.
- **Tokens.** `--oct-radius-sm`; 8px inline padding (4px beside a `data-icon`
  glyph), 4px gap; label 14/500 (12px on `xs`, `sm`, `chip`); glyph 12, 14 or 16
  by height.
- **States.** Hover fills (ghost and outline take `--muted`), press darkens and
  moves nothing, `aria-expanded` and keyboard focus fill ghost and outline,
  disabled 0.75, `aria-invalid` danger border. Glass: secondary and ghost fills
  are ink washes; outline rests on the card step; default and solid keep their
  fills.
- **Keyboard and accessibility.** A native button; an icon-only button always
  has a label and a tooltip.
- **Do.** Use `bare` for a card-shaped button whose feature owns its face, `chip`
  for suggestions, `OctantIconButton` for a panel or band control and a 24px
  square for a row action. **Don't** repaint a button from a feature
  stylesheet, give a resting button a shadow or gradient, or draw a pill
  button.

### OctantBadge

- **Purpose.** A compact status label.
- **Anatomy.** A `span`; variants `default`, `secondary` (default),
  `destructive`, `outline`, `dashed`, `success`, `warning`.
- **Tokens.** 16px tall, 8px inline padding, 4px gap, 12/500, 12px glyph,
  round ends.
- **States.** `aria-invalid` danger border. Glass: `secondary` is an ink wash.
- **Accessibility.** No role; the words carry the state. **Do** use `dashed`
  for a one-off beside recurring siblings. **Don't** let colour stand alone.

### OctantCard

- **Purpose.** A discrete object a person acts on as a whole, or a group of
  form rows.
- **Anatomy.** `OctantCard`, `Header`, `Title`, `Description`, `Content`,
  `Footer`; variant `default` or `glass`.
- **Tokens.** `--oct-radius-md`, 12px padding and gaps, `bg-card` with one 1px
  hairline outline (`outline-offset: -1px`), no shadow. Title 15/600, snug; description 14px secondary.
- **States.** Glass: the card is ink 4% with its hairline. `glass` variant: the
  glass floor and thick tint over a blur, only where a ground lies behind it on
  an opaque window. Forced colours: 1px `CanvasText`. Increased contrast: the
  strong border.
- **Accessibility.** Real `section`, `header`, `h2`, `p`, `footer`.
- **Do** use the full composition. **Don't** make a card of a plain list, an
  empty state or a header.

### OctantCheckbox

- **Purpose.** A checkbox as a styled native input.
- **Tokens.** 14px square, `--oct-radius-sm` less its size step, 1px
  `--octant-divider-strong` edge; checked fills with the primary and draws a
  2.5-stroke tick in the primary foreground.
- **States.** Checked, disabled 0.75, `aria-invalid`; checked focus takes the
  on-accent edge.
- **Accessibility.** Native semantics; Space toggles. **Do** put it inside its
  label. **Don't** use it for two to seven exclusive choices
  (`OctantToggleGroup`).

### OctantCollapsible

**Purpose.** A disclosure: a summary row that opens a body below it.
**Anatomy.** Props `summary` (any content: a label, a label and a count, a
heading, or several lines), `summaryClassName`, `summaryProps` (native summary
attributes such as `id` or `aria-label`), `chevron` (`start`, the default, or
`end` for a row whose label spans it, such as a section heading),
`chevronSize` (12, 14, or 16), `children`, and every native `<details>` prop
(`open`, `onToggle`, `className`).
**Sizes and tokens.** A 14px chevron by default, 8px from the summary, inheriting
the row's ink unless the caller's summary rule colours it; the user-agent
triangle is hidden. The chevron points right when closed and down when open,
turning on its own disclosure only, so a closed disclosure inside an open one
still points closed.
**States.** Closed, open (the chevron turns 90 degrees, without motion).
**Keyboard and accessibility.** It stays a native `<details>`: Enter and Space on
the summary toggle it, the browser reports expanded state, and find-in-page opens
a closed body that holds a match.
**Do and do not.** Use it for every disclosure; do not ship a raw `<details>`.
The exceptions are transcript rows that draw their own chevron and mount their
body lazily (turn activity, thinking) and the Settings background catalog, whose
summary is a Change and Done control rather than a disclosure row. A body that
is costly to render mounts only while open.
**Gallery.** Composed patterns.

### OctantCombobox

- **Purpose.** A searchable choice from a bounded list.
- **Anatomy.** Combobox, InputGroup, Input, Trigger, Portal, Positioner, Popup,
  Empty, List, Item, ItemIndicator.
- **Tokens.** Input group 28px with the field paint and `--oct-radius-sm`;
  trigger 24px with a 16px glyph. Popup at most 320px tall, `--oct-radius-lg`, 4px padding,
  the float and `--octant-shadow-pop`, at `--oct-z-popup`, as wide as its
  anchor. Rows are the [menu row](#menus).
- **States.** Highlighted row `--octant-float-hover`; disabled 0.75; the group's
  border brightens on pointer focus. Glass: dense float.
- **Accessibility.** `combobox` and `listbox` roles; arrows, Enter, Escape.

### OctantConfirmDialog

- **Purpose.** An ordinary confirmation (usage reset, Git discard, remote
  administration, connection removal, key rotation).
- **Anatomy.** `title`, body, `details`, `confirmLabel`, `cancelLabel`,
  `destructive`, `pending`, `confirmDisabled`, `restoreFocus`, `onCancel`,
  `onConfirm`; built on `OctantDialog`.
- **Tokens.** Title 17/600; body 14px secondary at 1.5; answers in one row at
  the trailing edge, 8px apart, 16px under the body: Cancel (outline) then the
  confirm answer (default or `destructive`), both 28px.
- **States.** `pending` disables both and ignores Escape and the scrim.
- **Accessibility.** Labelled by its title, described by its body; focus starts
  on Cancel and returns to the opener. Git confirmations say **Keep changes** and
  **Discard changes**.

### OctantContextMenu

- **Purpose.** An action menu from the context-menu gesture.
- **Anatomy.** `items`, `onValueChange`, the trigger as children,
  `triggerClassName`; compound Root, Trigger, Content, Group, Label, Item,
  CheckboxItem, Separator, Sub, SubTrigger, SubContent.
- **Tokens.** At least 12rem wide, `--oct-radius-lg`, 4px padding, the float
  and `--octant-shadow-pop`, at `--oct-z-popup`; check and submenu chevron 14px.
- **Accessibility.** `aria-haspopup="menu"` and `aria-expanded` on the trigger;
  an item's description is `aria-describedby`. It is Octant's own menu in the
  desktop app too (see [Native menus](#native-menus)). Right click is never the
  only route to an action.

### OctantDialog

- **Purpose.** A modal dialog.
- **Anatomy.** `open`, `onClose`, `label`, `labelledBy`, `describedBy`,
  `className`, `initialFocus`, `restoreFocus`, `popupId`; classes
  `octant-dialog__backdrop`, `__viewport`, `__popup`, `__title`.
- **Tokens.** 420px wide (`--octant-dialog-width`), at most 640px tall
  (`--octant-dialog-height`), each capped at the viewport less 48px; 16px content
  inset; `--oct-radius-xl`; the float with no border and `--octant-shadow-pop`; the scrim
  (`--octant-scrim` at 62% dark, 38% light); viewport padding 24px; at
  `--oct-z-floating`.
- **States.** Leaving: backdrop and popup are `inert`. Glass: dense float.
- **Accessibility.** Modal; Escape and an outside press call `onClose`; a
  visually hidden title from `label` when there is no visible heading; focus
  returns as the exit starts (`useLeavingFocus`).
- **Do** declare a wider dialog with `--octant-dialog-width`. **Don't** give a
  dialog its own width, title size or answer height.

### OctantDialogPresence

- **Purpose.** Keeps a dialog a feature renders only while open mounted through
  its exit, so it leaves like every overlay.
- **Behaviour.** Holds the last rendered content until the exit ends and tells
  the dialog it has closed. A dialog whose owner goes with it, or one of two
  sharing a presence, leaves at once; in a hidden window it is removed at once.
- **Accessibility.** A leaving dialog is `inert`; focus returns as the exit
  starts and stays put if the person moved it meanwhile. Draws nothing.

### OctantEmpty

- **Purpose.** Every empty, connection, error, loading and whole-window state.
- **Anatomy.** One component, three layouts. **card** (the default) takes
  `title`, `message`, `eyebrow`, `icon`, `action` (any node) and `role` (`alert`
  or `status`). Giving it a `state` (`disconnected`, `loading`, `neutral`,
  `warning`) draws that state's glyph instead of an icon and takes `action` as
  `{ label, onClick, glyph? }`, one secondary button with a retry glyph by
  default; a loading state spins its glyph, is a `status` region and may omit
  `message`. **page** (`layout="page"` with a `state`) is a state that is the
  whole window. **line** (`layout="line"`) is the quiet single line a page shows
  when it has nothing on it: `title`, `detail`, `icon`, `action` and `tone`
  (`page` or `lane`). Parts Root, Header, Content, Description, Eyebrow, Media,
  Title stay exported for composed states.
- **Tokens.** The card is at most 480px wide, 16px padding, 8px gaps,
  `--oct-radius-md`, the card fill and one hairline; the mark a 24px neutral
  tile; eyebrow 12px muted; title 15/600; message 13px muted. The page layout
  is in [Empty, loading and whole-window states](#empty-loading-and-whole-window-states);
  the line layout in [Page shell](#page-shell), where `tone="lane"` sets the line
  in the meta ink for one empty column beside full ones.
- **States.** One tone: the mark is neutral whatever went wrong. A loading state
  in the page layout falls back to the card, since a spinner is not a dotted
  mark. Glass: ink 4%.
- **Accessibility.** The card title is a level-2 heading and the page title a
  level-1 heading; the caller sets `role` for a live state, except that loading
  and the line are always `status`. **Don't** recreate it with spans or a second
  component; a page's empty state follows [Page shell](#page-shell).

### OctantField

- **Purpose.** Form layout that keeps labels, descriptions and errors with
  their controls.
- **Anatomy.** `OctantFieldGroup`, `OctantField`, `OctantFieldLabel`,
  `OctantFieldDescription`, `OctantFieldError`.
- **Tokens.** Groups stack 12px apart, a field's parts 4px; label 14/500;
  description 14px secondary; error 14px danger ink.
- **Accessibility.** The error is `role="alert"` and stays by its field. A
  warning the person must review stays inline, never only in a toast.

### OctantInput

- **Purpose.** A single-line field.
- **Tokens.** 28px, 8px inline padding, `--oct-radius-sm`, the field paint
  (`ui/shadcn/field-paint.ts`): the strong border, no fill at rest; 14px (15px
  under `md`); placeholder muted.
- **States.** Hover takes the muted-ink border; keyboard focus the control
  hover fill; pointer focus brightens the border to ink 30%; invalid keeps the
  danger border; disabled 0.75. Glass: no fill at rest, so nothing changes.
- **Do** pass `unstyled` when the feature draws the frame (a toolbar search, a
  stepper's middle). **Don't** repaint a field from a feature stylesheet.

### OctantMenu

- **Purpose.** A dropdown of radio choices (default) or actions.
- **Anatomy.** `items`, `actions`, `value`, `onValueChange`, `trigger`,
  `triggerLabel`, `triggerClassName`, `triggerDisabled`, `triggerTitle`,
  `selectionMode`; compound Root, Trigger, Portal, Positioner, Popup, Group,
  GroupLabel, Item, CheckboxItem, RadioGroup, RadioItem, Separator, Sub,
  SubPopup, SubTrigger.
- **Tokens.** At least 12rem wide, `--oct-radius-lg`, 4px padding, the float and
  `--octant-shadow-pop`, 4px below its trigger, at `--oct-z-popup`; group label
  24px in the navigation group role; separator one hairline with 4px around;
  check 14px.
- **States.** Highlighted row `--octant-float-hover`; a chosen radio carries a
  check, never a fill; disabled 0.75. Glass: dense float.
- **Accessibility.** Opens on the current choice; a pick closes the menu and
  returns focus. It is Octant's own list in the desktop app too.
- **Don't** size a menu's rows from a feature stylesheet.

### OctantMenuIconSlot

- **Purpose.** The empty 16px icon column for a hand-built row without an icon,
  so a menu keeps one text edge. An `aria-hidden` span, `--oct-icon-md` square.

### OctantNumberStepper

- **Purpose.** A number with minus and plus. With `field` it is a plain
  right-aligned number field instead (28px, 88px wide, the unit inside it, no
  buttons, the arrow keys step it, blur commits and clamps): every numeric
  Settings row uses it.
- **Anatomy.** `label`, `value`, `min`, `max`, `step`, `suffix`, `onChange`.
- **Tokens.** 28px with the field paint, `--oct-radius-sm`, one border; ghost
  end buttons with 14px glyphs; the middle input `unstyled`, 14px, centred, the
  suffix 12px muted in the same column.
- **States.** Takes the control hover fill while focus is inside; a button is
  disabled at its bound; blur commits and clamps.
- **Accessibility.** "Decrease {label}", "Increase {label}"; a native number
  field.

### OctantPopover

- **Purpose.** A controlled popover from a button.
- **Anatomy.** `open`, `onOpenChange`, `trigger`, `triggerLabel`,
  `triggerVariant` (`ghost`, `ghost-icon`, `outline`), `triggerTooltip`,
  `triggerAriaPressed`, `triggerDescribedBy`, `triggerDataAttributes`,
  `triggerDisabled`, `triggerClassName`, `title`, `titledBy`, `description`,
  `side`, `align`, `sideOffset` (4), `collisionAvoidance`.
- **Tokens.** `--oct-radius-lg`, 8px padding, 14px type, the float and
  `--octant-shadow-pop`, at `--oct-z-popup`.
- **Accessibility.** `aria-expanded` (and `aria-pressed`) on the trigger;
  labelled by `titledBy` or a hidden `title`; Escape closes and returns focus.
  Searchable pickers and popovers with controls stay renderer surfaces in the
  desktop app.

### OctantPreviewCard

- **Purpose.** A delayed, non-modal card the pointer can enter.
- **Tokens.** At most 320px, 12px padding, `--oct-radius-lg`, the float and
  `--octant-shadow-pop`, 8px from its trigger, at `--oct-z-popup`; opens after
  350ms, closes 150ms after the pointer leaves.
- **States.** Glass: dense float (it
  opens on every row crossing, so it never cuts or re-composites the page).
- **Accessibility.** `role="group"` named by `label`; no focus edge on the card.

### OctantSelectField

- **Purpose.** A select for forms and filters.
- **Anatomy.** `options` (id, label, disabled, disabledReason, group), `value` or
  `defaultValue`, `onValueChange`, `placeholder`, `name`, `id`, `aria-label`,
  `className`, `triggerClassName`; parts Root, Group, GroupLabel, Item, Popup,
  Portal, Positioner, Trigger, Value. The empty value is `octant-select:empty`.
- **Tokens.** Trigger 28px with the field paint, 8px gap, 14px, a 12px chevron
  never dimmed while enabled. Popup at most 18rem tall, at least the trigger's
  width, `--oct-radius-lg`, 4px padding, the float and `--octant-shadow-pop`,
  4px from the trigger; rows leave room for a 14px check.
- **Accessibility.** Base UI select; opens beside the trigger; `name` writes a
  hidden input. In the desktop app it is an `OctantMenu` radio list behind a
  field-painted trigger. **Do** use `OctantToggleGroup` for 2 to 7 visible
  choices.

### OctantSeparator

- **Purpose.** A hairline between groups; `OctantSeparatorWithLabel` sets 12px
  muted text between two rules, 8px apart.
- **Tokens.** 1px `--oct-hairline`.
- **Accessibility.** `role="separator"`.

### OctantSheet

- **Purpose.** A page-sized floating surface with the app live behind it
  (Settings).
- **Tokens.** At most 1040 by 760px, no padding, the float, no border,
  `--oct-radius-xl`, `--octant-shadow-pop`; a light scrim (`--octant-scrim` at 34%, 20% in a light theme); viewport
  padding 48px above, 32px at the sides and below; at `--oct-z-floating`.
- **States.** Rises 8px in and out; `inert` while leaving. Glass: dense float.
  Its loading outline is styled from an eager stylesheet so it is never blank.
- **Accessibility.** Modal; hidden title from `label`; Escape, close and a press
  behind it close it.

### OctantSlider

- **Purpose.** A range input (`octant-slider`, native).
- **Tokens.** A 4px round track in `--octant-divider-strong` (3:1 on a card in
  both modes); a 14px round thumb in the primary with a 2px page-colour ring.
- **States.** Disabled 0.75; grab cursor while dragging. Native range keys.

### OctantSwitch

- **Purpose.** An on/off setting that saves at once.
- **Anatomy.** `checked`, `onCheckedChange`, `label`, `describedBy`,
  `disabled`, `disabledReason`.
- **Tokens.** A 38 by 22px round track in the control fill with a 1px
  strong-divider edge; a 16px round thumb in the page colour travelling over
  `--oct-motion-base`; on, the track and edge take the primary ink, never the
  accent: colour is for status dots.
- **States.** Unchecked under keyboard focus takes the control hover fill;
  checked takes the ink edge; disabled names its reason. Glass: the track
  is ink 15% and the off thumb ink 62%.
- **Accessibility.** `role="switch"`; Space toggles. A switch that sends
  something off this computer carries that fact as its section's description,
  above it.

### OctantTabs

- **Purpose.** True page tabs.
- **Tokens.** List 28px, 4px between tabs; a tab 24px, 8px inline padding,
  `--oct-radius-sm`, 14/500; the panel 8px under the list.
- **States.** Hover a light fill and the primary ink; `data-active` the control
  fill; disabled 0.75.
- **Accessibility.** `tablist`, `tab`, `tabpanel`; arrows move.

### OctantTextarea

- **Purpose.** A multi-line field. At least 52px, 8px padding, the field paint
  and type of `OctantInput`; it grows with its content.
- **Composer.** Given `composer-input` it drops the field recipe; `.composer-input`
  owns its 12px padding, its one-line 44px minimum, its 180px maximum and its
  placeholder in the meta ink.

### OctantToast

- **Purpose.** A transient acknowledgement or a failure to notice.
- **Anatomy.** `title`, `detail`, `tone` (neutral, success, warning, danger),
  `action`, `onDismiss`.
- **Tokens.** 12px padding, 8px gap, `--oct-radius-lg`, the float and
  `--octant-shadow-pop`; a 16px semantic mark; title 14/500 on a 24px line; detail 13px muted;
  Dismiss a 24px icon button with a 14px glyph. The stack (`.toast-stack`) is
  fixed 12px under the title rail and 16px from the trailing edge, at most 380px
  wide, at `--oct-z-toast`.
- **States.** Long text wraps. Glass: dense float.
- **Accessibility.** `role="alert"` for danger, `status` otherwise; Dismiss is
  "Dismiss notification"; the stack takes no press outside its notices.

### OctantToggleGroup

- **Purpose.** The enclosed track for two to seven exclusive values.
- **Tokens.** A 28px track (2px padding, `--oct-radius-sm`, the muted fill)
  holding 24px items (8px padding, a 6px corner, 13px secondary ink). Markup
  that still names the `.segmented` and `.segment` recipe (Agents, Automations,
  the Project and Rewind dialogs) draws these same measurements, so no page
  has a taller or bordered track of its own.
- **States.** Hover the primary ink; `data-pressed` the raised soft fill and the
  primary ink; disabled 0.75. Glass: the track is ink 7%, the pressed item ink
  12%.
- **Accessibility.** Each item is a toggle with `aria-pressed`.

### OctantTooltip

- **Purpose.** A short label, or a card of content on hover.
- **Anatomy.** The trigger as children, `label`, `side`, `align`, `surface`
  (`inverted` or `card`).
- **Tokens.** Inverted: the ink as a fill with the surface colour on it, at most
  280px, 8 by 12px padding, `--oct-radius-sm`, 14px. Card: at most 320px, 12px
  padding, `--oct-radius-lg`, the float and `--octant-shadow-overlay`. 8px from
  the trigger, after 350ms, at `--oct-z-popup`.
- **States.** Opens on hover after 350ms and on keyboard focus-visible (a key
  that moves focus: Tab, an arrow, Home, End), never on focus a click caused or
  a sheet or menu handed back to its trigger. Closes on pointer leave, on a
  press of its trigger (without fading over what opened) and on Escape.
- **Rail.** A rail button's tooltip is a compact one-word chip (13px, 4px by 8px padding) that opens to the right of the rail, centred on the button; it lies over the sidebar and covers as little of it as it must.
- **Icon buttons.** `OctantIconButton` keeps the native `title` for its label
  rather than this tooltip: the system draws a native title above a native
  Browser page, where this tooltip would open underneath it. Tooltips are not
  counted as overlays that move a Browser page out of the window, because any
  hover would make the page flash.
- **Accessibility.** `role="tooltip"`; opens on keyboard focus-visible. Never the only
  place an essential word appears.

### OctantAlert

- **Purpose.** An inline notice: mark, tone, live region, message, optional
  title and actions.
- **Anatomy.** `children`, `title`, `action`, `tone` (neutral, accent, success,
  warning, danger), `role`, `label`, `id`.
- **Tokens.** The callout is a small floating glass card: the float fill
  (`--octant-float-glass`, frosted on an opaque window and dense with no blur on
  glass), `--oct-radius-lg`, one 1px `--oct-border-faint` outline, 8px by 12px
  padding, 8px by 12px gaps, 13px primary ink, title 500. The tone is one
  property, `--callout-tone`: a 16px icon on a 24px round dot of the tone at 20%
  and nothing else, so no tone tints the fill or the edge. A second part of the
  message (a reset time) is the secondary ink (`.callout__second`); the action is
  a small secondary button at the trailing edge. A notice above the composer and
  one in a thread column also lift on `--oct-shadow-float` and enter with a fade
  and a 4px rise over `--oct-motion-base`, none under reduced motion. Those two
  hug their content (icon, message, second part, action) at the left edge, no
  wider than 480px: a longer message wraps onto a second line, and several
  notices stack, each as wide as its own content.
- **Row layout.** `layout="row"` is a notice inside a dock tool or pane: one
  quiet line at the panel's 12px inset with no fill, no outline and no card. The
  tone's 16px icon is the only colour, the sentence is the secondary ink, and an
  action (a ghost or secondary small button) follows the words and wraps under
  them when there is no room. A notice in a panel is always this layout; the
  card is for the thread column and the composer. Words are for the person: a
  host message written for an agent (a call to make, a profile to pass) is
  mapped to one short sentence and an action ("This Private page expired." with
  Open again), never shown as the host wrote it.
- **A pane's state.** A tool pane (in the dock or the bottom panel) that has
  nothing to show, is unavailable or failed as a whole shows one state in its
  middle and nothing else: a 16px mark in the muted ink (never a warning
  colour), one line in the primary ink at the detail size and medium weight,
  one muted line with the reason, and the way out as one secondary button named
  for what it does ("Try again"). A state never shares the pane with a second
  message, a split column or an empty header row: Files whose checkout cannot
  be read is that one state with no tree, no viewer column and no tab row, and
  Review whose checkout cannot be read is one state with no findings notice
  under it. The reason is in the person's words and the same wherever one
  cause shows: a thread whose folder the host can no longer open (moved,
  renamed, deleted, or no longer granted to the window) says so in Files,
  Review and the Terminal alike, where the host's own sentence spoke of its
  "authority" in two wordings. A notice is for a pane that still has its content (part of a
  listing failed, a diff is truncated) and keeps the row layout above. A
  loading line is not a state: one quiet line at the pane's top inset, where
  the content it stands in for begins.
- **States.** On glass the fill is the dense 96% float; increased contrast and
  reduced transparency make it opaque.
- **Accessibility.** Warning and danger are `alert`; the others `status`.

### OctantApprovalCard

- **Purpose.** An inline provider, extension or Browser permission request.
- **Anatomy.** `label`, `summary`, `detail`, `context`, `actions`, `error`.
- **Tokens.** The card: 1px hairline, `--oct-radius-md`, `--octant-card`, 8 by
  12px padding, 8 and 12px gaps, 14px at 1.45; a 14px pending mark in muted ink;
  detail 13px muted; actions 4px apart at the trailing edge.
- **States.** Glass: ink 4%. Increased contrast: strong border.
- **Accessibility.** `role="group"` named by `label`; a failure is `alert`. The
  host decides whether an action may proceed.

### Native menus

The code editor's right-click menu (`code/nativeEditorMenu.ts`) is the one
system menu: it carries text editing, where a Mac person expects the system's
own items. Every other menu, dropdown and select is Octant's own.

### Helpers

`radioGroupKeys.ts` (`moveWithinRadioGroup`) gives a radio group its keys.
`useLeavingFocus.ts` returns focus as an exit starts. Neither draws.

## Patterns

### Menus

**One menu row.** Every in-page pick-list draws the row from
`ui/shadcn/menu-row.ts`: 28px (`--oct-menu-row-h`), 44px with a second line
(`--oct-menu-row-two-h`), an 8px inset (`--oct-menu-row-inset`) in a popup
padded 4px (`--oct-menu-inset`), a 16px icon column and 8px gap
(`--oct-menu-row-gap`), words in the menu option role, group labels in the
navigation group role. Words stand 36px from the popup's edge with an icon, 12px
without; a menu where any row has an icon reserves the column for all. The
separator is one hairline as wide as the rows. A choice is a check at the row's
end, never a fill; a fill means only that the pointer or keyboard is on the
row. The command palette, the `#` and `/` typeaheads and the composer's pickers
take the same tokens: a palette row is the 13/500 menu option, its group labels
the navigation group role (12px, sentence case, muted, never mono), and the row
the keyboard is on takes `--oct-fill-4` with no border; the Enter hint says
what it will do.

**Native menus.** Every menu, dropdown, select and right-click menu is
Octant's own, in the desktop app as in a browser and on the phone, so a row
keeps its description, icon and colour mark everywhere and there is one menu to
build and test (maintainer decision, 2026-11-15). A system menu showed a row's
label alone and ran label and detail together. The code editor's text-editing
right-click menu stays the system's.

**Composer popups.** Every popup the composer opens (Project, base branch,
checkout, Create from…, access, model) is the float at `--oct-radius-lg` with
`--octant-shadow-pop`. A search field (`.octant-popover-search`) is a filled 32px
field with a 14px leading glyph and no border; rows (`.octant-popover-option`)
are the 28px menu row with trailing detail in meta ink; group headings
(`.octant-popover-group`) 12px medium meta; status lines
`.octant-popover-empty`. A popup is capped to the room on its side and only its
list scrolls; add actions stay pinned under the list.

### Title band

See [Window frame](#window-frame). Open in is the one band control with an
edge (outline, 28px, control corner). In native full screen macOS hides the
traffic lights, so the desktop reports the change and no traffic-light width is
reserved there. Behaviour of the tool row and toggles is
in [Workspace: Shell grid and tool row](docs/design/workspace.md#shell-grid-and-tool-row).

### One tile bar

Every pane in the dock has one bar as tall as the title band and the thread's
header (44px, `--oct-title-rail-h`), the same whether the tool is shown alone or
among tiles: its name (a 16px icon and a 14px medium label) or its own tabs, its
controls, then Minimise (a Browser, a Terminal) and Close, on insets of 12px
leading and 8px trailing, 4px between controls, on the bar surface (the
sidebar's fill, a step off the pane) with its hairline drawn inside it. The
dock has no head of its own over its panes: a top pane's bar stands in the
title band, on the thread header's line, on the band's ground with no fill or
rule of its own, and the pane's fill starts under it; the last column's top bar
ends before the window's toggles. Controls are 24px with 16px glyphs; a view
choice is a 28px word tray of 24px segments; an action everyone knows is an icon
button with a tooltip. A bar carries no Arrange button: a pane is arranged by
dragging its bar, and the same moves are the bar's context menu (right click,
the menu key, or Shift+F10 on any control of the bar). The bar is a Tab stop
where there is something to arrange, and Enter or Space on it opens that menu. At most one 32px secondary row
holds content (a filter, a status line) on the bar's insets, and a pane's
content starts on the same 12px. When the controls do not fit, word switches
fold to a named control, then actions into one More menu; status text and
must-read cues never fold. A tool alone used to have a 36px tab row inset 8px,
a 32px control row or no bar, and a tiled one a 32px bar inset 12px, so a
second tool moved every tab and control of the first (measured 2026-11-15).
The bottom panel's toolbar is the same bar: the same height, its tabs 28px and
every control 24px (Add tool and Hide included), centred on the row.
The folding order is in [Workspace: Tool tiles](docs/design/workspace.md#tool-tiles).

Panel tabs (the tool strip, the Browser's pages, a Code thread's open files)
draw one recipe (`.content-tab`, with `PanelTabStrip` and `PanelTab` for a
panel's own row): a 28px tab in the control radius with a leading mark (a
tool's icon; a Browser page's 16px favicon, or the globe when it has none; a
file tab has no mark and shows its name alone), a 13px label that
ellipsises at 180px, and a 16px × that always keeps its slot. The open tab
(`aria-selected`) is clearly filled (`--oct-fill-1`) in the primary ink; a tab
at rest keeps a quiet tab shape of its own (`--oct-fill-4`, secondary ink) and
the pointer's fill sits between the two (`--oct-fill-2`), because bare text
beside one filled tab read as a label and a link, not as tabs. A Browser tab is
named for what its page shows (the title, else the host, "New tab" before a
page loads). The × shows on the open tab, on hover and
on focus by opacity alone, so a label never shifts. A tab with unsaved edits
shows a dot in the × slot until it is hovered or focused. In a pane the tabs
(the Browser's pages, a shell's sessions, Files' open files) stand in the pane
bar in place of the tool's name; where no pane bar hosts them (the bottom
panel) a panel's own tab row
is a 36px bar (`.panel-tabs`) a step off the pane with a hairline under it; it
scrolls sideways without a scrollbar and moves only its own scroll to keep the
open tab in view. It is a tablist: arrows, Home and End move between tabs, a
middle click, Delete, Backspace or Cmd+W closes a closable one, and a "+" icon
button follows the last tab where a new one makes sense. A Files preview tab is
italic. A segmented view switch (Review's Working tree, Local commits, History)
stays a segmented control and sits in the same 36px row. A tab strip is never
drawn a second way in a panel: reuse `.content-tab`. A bar or toolbar row is
`flex: none`: it never shrinks, and the content under it scrolls inside itself
(`min-height: 0`), so nothing covers a bar. A row too narrow for its controls
wraps to a second line (or, in a tile's bar, folds into the ⋯ menu); no control
is cut off. Selecting, opening or closing a tab never reorders the others, and
closing the selected tab selects its right neighbour, else its left. Closing a Files tab, or
the Files tool, with unsaved edits asks "Save changes to <name>?" with Save,
Don't save and Cancel (Cancel is the default and Escape); several dirty files
ask once each, in order.

### Composer row

Every composer (a start screen or a thread, in Chat, Work and Code) is one box
and two quiet rows, at the reading measure; in a split every composer takes the
narrowest pane's width.

- **The box** is the one resting surface that floats: the frosted float fill
  with its blur in a browser, the float colour at 96% with no blur in the desktop
  app, and the control wash (ink 7%) under glass in a browser,
  one faint outline (`--oct-border-faint`, ink 5%), `--oct-shadow-float`. At one
  row it is a full pill 44px tall (`data-shape="pill"`); once the prompt grows
  past one line, or a queue or chips stand above it, it takes `--oct-radius-lg`
  and the prompt takes the full width on top with the controls in one row along
  the bottom: attach at the leading edge, the microphone and send at the
  trailing edge. A grown box returns to a pill only when the prompt is empty, so
  the wider layout cannot flip it back and forth. Over an application ground in
  a browser it is the glass surface (floor, thick tint, blur); in the desktop app
  it is the float colour at 96%.
- **Inside**: attach, the frameless prompt, then the microphone and send at the
  trailing edge. They are round 28px buttons (`--oct-composer-cell`), 8px
  (`--oct-composer-inset`) from the box's edge, the one place a control is a
  circle, because the box is a pill. Their glyphs are 16px at the shared 1.5 stroke. Attach is a quiet fill (ink 6%) with a hover
  step (11%). The microphone is a ghost with a round hover fill (8%). Send is the
  ink as its fill (`--octant-text-primary`) with the page colour as its arrow, at
  20% opacity while there is nothing to send, and it grows to 106% on hover (not
  under reduced motion); Stop takes the same round shape.
- **The row under the box**: 28px, 4px below, no fill or edge, on the box's
  columns, the context ring last under send. On a start screen it names the
  Project where the prompt's text starts (44px in). Under a thread's box it
  holds only how the next message runs: the model, the mode and the ring, plus
  the outside-content mark, a 16px globe in the warning ink with no words
  immediately before the mode control, only while the thread is below Full
  access (at Full access nothing shows; it opens the same review as the
  Environment panel's "Outside content · read N times" row). The thread's
  Project, branch, folder, pull requests and plan usage live in the Environment
  panel, and its info and plan proposal are items of the + menu: a full row
  truncated every label in a thread's column. Labels 12px meta, icons 16px,
  nothing filled at rest.
- **The row above the box** (start screens): where the work runs, as quiet
  chips (meta ink, no fill at rest, 24px).
- **Notices** are never in the box: each is the callout's compact card directly
  above it, 8px from it, at its left edge and as wide as its own content (no
  wider than 480px), most severe first. Passing progress is
  one meta line above the notices that takes no layout room.
- What each control says and does is in
  [Thread view](docs/design/thread-view.md).

### Page shell

Every list, board, reader and preference page is a `Surface`:

```
Surface (measure 880px, or wide)
  SurfaceHeader   40px toolbar: Back · title · detail · actions
  surface-toolbar search · filters · view switch
  SurfaceSection  section label over a hairline
    surface-row   label + detail left, control right
  OctantEmpty layout="line"
                  a 20px mark, one line, one outline button
  SurfaceLoading  the page in outline
```

- The header is the page title role, the large one (26px, 600), on every
  destination, with its detail beside it on the same baseline in the detail
  role (13px, secondary). The page starts 24-32px under the window controls.
  Detail is a fact that changes (a count, a time zone), never a sentence about
  the page.
- At rest the header has no fill; once a row passes beneath it takes the opaque
  workspace colour (under glass too, so a row never reads through).
- Back is a 28px ghost icon control at the leading edge.
- A destination's cards are the card fill with no hairline, in two columns
  where the pane allows;
  Settings groups keep their hairline because their rows have dividers.
- A page with nothing on it is the empty state alone, centred; search and
  filters appear only once there is something to filter.
- **Page edges.** A page is laid out on one grid, and its header sits on the
  content's edges, never beside them:
  - The page title's text and the first row of content start on the content's
    left edge (Back's glyph stands on it, the title 30px after).
  - The header's last action, the search field and the toolbar's last control end
    on the content's right edge.
  - A card's label, its rows' glyphs and text, and its notes stand on one inset
    (16px), and its trailing items (counts, statuses, times, menus) end on the
    inset's other side, 16px in.
  - Sibling destinations end their content on the same right edge, so the
    Inbox and To-dos open to the same width, and a list page whose header holds
    an icon cluster ends it on the search field's right edge (Issues as Pull
    requests).
  - A thread's header starts the mark 20px in, on the transcript's and the
    composer's own edge at ordinary widths. Its tool row ends on one line for a
    window: 8px in from where the thread's box ends at its narrowest
    (`--octant-thread-box-min` from the pane's left edge; see
    [Workspace: How the width is shared](docs/design/workspace.md#right-dock-and-bottom-panel)).
    Nothing that opens or closes beside the thread moves that line, so the row
    is not at the header's end where the box is wider. A pane narrower than the
    line ends the row 8px in from its own edge.
  - A tile's blocks keep 12px between them, including the blocks a component
    nests inside one block.

### Settings page

The kit is `settings/primitives.tsx`; contents are in
[Settings](docs/design/settings.md).

- **Header**: the `h1` in the page title role; at most one line of 12px
  secondary description. The header is the same on every sub-tab and in every
  load state: a page with sub-tabs (Skills & Extensions) draws its switch in
  one strip under the header, and the views below take no actions of their
  own. Content that loads reserves its space (`SettingsSkeletonRows`, rows at a
  Settings row's height); a command's raw output is a `SettingsOutputWell`,
  collapsed, 160px tall and scrollable.
- **On this page**: one rule. Pages of four sections or more (General,
  Appearance, Providers & Models, Octant Harness, Code, Computer use, GitHub,
  Permissions, Data & storage, Sync; the list is `SETTINGS_OUTLINE_PAGES`) carry
  a single-line row of quiet chips: 24px, 12px text, `--oct-fill-4`, a hover
  wash, the section in view marked as the page scrolls. It never wraps: it
  scrolls sideways under a fade at the edge that has more. Its slot is a fixed
  28px on those pages, so chips arriving as sections mount move nothing. Other
  pages, and any page whose sections change with a sub-tab, have no row.
- **Section**: a heading (13/600 primary, so it never reads as the 12px
  secondary description under it), an optional one-line note, then one
  group: `--oct-radius-md`, `--oct-settings-card-fill` (ink 2%), one hairline
  outline inside the box, `overflow: visible` (the first and last rows round
  themselves). Rows are divided by a hairline inset 16px.
- **Row**: at least 52px, 12 by 16px inset, label 14px, detail 13px, control at
  the trailing edge at 28px (`--oct-settings-control-height`). A compact row is
  36px, one line.
- **Rhythm**: a 32px gutter, 24px between sections, 48px under the last, 12px
  under a label and under a note.
- **Actions**: the secondary button; one main action may be primary; extras
  ghost; destructive rows last, in their own group. No outline buttons.
- **Rail**: 16px icons; the open page takes `--oct-wash-selected`, never the
  theme's selection hue.
- **Glass**: the rail and gutters are the frame, the page clear on the coat, the
  groups ink 2%.

### Dialogs and sheets

Every dialog is `OctantDialog`: 16px inset, the dialog title role, answers in
one row at the trailing edge (the dismissing answer outlined first, the acting

- **Buttons**: an action with words is a button with a fill at rest
  (`secondary`, or `ghost` resting on `--oct-fill-4` inside Settings); never
  bare text. Only an inline link in a sentence is text: the accent ink, an
  underline when pointed at (`variant="link"`).
  answer filled last, both 28px). A dialog that draws to its edges sets its inset
  with one class. A sheet is for a page-sized surface with the app live behind it;
  a non-modal glass panel anchored in its surface (Zen) stays a panel. Dialogs and
  sheets share `--oct-z-floating`; popups stand above them.

### Toasts and notices

- **Inline notices** are `OctantAlert`; a raw `role="alert"` or `role="dialog"`
  in feature source fails `ui:check` unless recorded (the recipe owners,
  `OctantAlert`, `OctantToast`, `OctantApprovalCard`, `FieldError` and
  `OctantEmpty`, set the role themselves).
- **Product notices** are `OctantToast`, stacked at the top trailing corner
  under the title band (at the bottom they would cover the composer).
- **Field errors** stay by their field; a warning to review stays inline.
- **A lost host connection** is one `OctantAlert` above the transcript; other
  surfaces dim rather than repeat it (wording in
  [Thread view](docs/design/thread-view.md)).
- **Panel layout.** A dock tool is a column of blocks that never overlap at any
  width from 320px up. A block keeps its own height or scrolls inside itself (a
  pane's flex child with a set `min-height` shrinks below its content, so every
  non-scrolling block is `flex: none`). A header row is flex with `min-width: 0`:
  the title ellipsises and the controls wrap to a line of their own; a status
  sentence is a full-width line under the title in the meta ink. One left edge,
  the panel's 12px inset; no centred text block; a section heading is the
  section-label role; buttons are the standard secondary or ghost recipes.
  A tool's empty or loading state is one line, left-aligned at the inset: a
  16px spinner or icon and the title, with a meta-ink sentence under it.
  `styles/panels.css` holds these rules and a contract test pins them.
- Use Badge for status labels, Empty for empty states, Skeleton for loading; add
  no other toast package.

### Empty, loading and whole-window states

- A destination still loading shows its outline (`SurfaceLoading`); the sheen
  stops under reduced motion.
- A route or tool still loading is one quiet line on the page, never a card.
- A state inside a pane is `OctantEmpty`'s card layout.
- A new, empty Code thread is one composed start block, never a bare sentence
  over separate cards. It is aligned to the thread column's edges, so its left
  and right edges are the composer's, and it sits low in the column, resting
  above the composer. A 17/500 heading (the thread's title, else "Start this
  thread") has the one-line hint in the meta ink beneath it. Below is one quiet
  surface: the card fill, `--oct-radius-md`, one hairline, no shadow. It holds
  two groups separated by a hairline, "Set up this workspace" and "Start from a
  template", each headed by the section label (`oct-section-label`). The groups
  are list rows, not nested boxes: a 16px muted glyph on one shared icon column,
  the name at 14/500 in primary ink, a 13px description in the meta ink cut to one
  line, and a hairline between rows. A two-line row is 52px. A template row is
  one button with a trailing chevron and the `--oct-wash-hover` fill under the
  pointer; a template this machine cannot run says "Needs ..., which is not on
  this machine" as its description in `--oct-warn-fg`. A preset row ends with a
  secondary (outline) Apply aligned to its first line, and what it opens is a
  quiet 12px meta line of tool glyphs and words (Overview, Browser, Side chat),
  never ids, which makes that row 72px. There is no accent, no tinted tile and no
  bold in the block. Nothing moves on hover, focus or load.
- A section with nothing in it inside a card (an Inbox list, an Environment
  card) is one line in the detail role with at most one button, never an
  `OctantEmpty` card inside the card.
- A state that is the whole window is `OctantEmpty`'s page layout
  (`layout="page"` with a `state`): centred, a 96px dot-grid
  mark in the primary ink, a title at `--oct-text-xl`, one secondary line, the
  way back as an accent-ink link.

### Transcript rows

What a thread shows is in [Thread view](docs/design/thread-view.md); the paint
of its rows is here.

- **Agent text** is bare prose at the transcript size, 1.6 leading.
- **The person's message** is a bubble at the trailing edge, as wide as its
  text up to 80% or 620px: `--oct-radius-md`, 12 by 16px padding, the card
  colour and no hairline (ink 4% under glass, the strong border under
  increased contrast).
- **A tool row** (`.toolrow`) is one line: a 16px glyph in the meta ink, the
  words in the body size (13px) and the secondary
  ink, 8px padding, `--oct-radius-sm`, `--oct-wash-hover` under the pointer, a chevron that rotates when open. Its body is
  indented 24px.
- **A thinking row** (`.thinking`) is a 12px meta summary over a 1px rule in
  the strong border at its leading edge, with 16px between rule and text; its
  body is 14px secondary ink.
- **Cards in a reply** (a file change, a subagent, an approval) are the card:
  `--oct-radius-md`, the card colour, one hairline.

### Lists and rows

Two row families share this section, each used the same way everywhere. A
**page row** (Projects, Inbox, Settings, a Project's thread list, an
automation card) has the row label (14/500) over a detail or meta line (13
secondary or 12 meta). A **list row** (the sidebar, Home's lists, the pull
request list, the work lists) has a 13/400 title over a 12px meta line, a state
glyph at its start, and sits under a group heading in the navigation group
role (12px muted, the count at the right edge). A section's heading on a page
or in a card (Settings, Inbox, Automations, a Project's Threads and its cards)
is always the section label (14/600 secondary), never the primary ink or a
lighter weight; Settings' own section heading is the exception (13/600 primary). An empty page or section is one line and at most one outline
button. Chips above a composer are 24px; the start screens' suggestion chips
are the one borderless 28px chip (see Start screen).

Rows are hairline rails, never cards. They reserve stable gutters for marks;
hover actions fade in over a slot already kept for them (a thread row's slot
holds its age; a section head's actions keep their width), so nothing beside
them moves when the pointer arrives. The row a list shows is `--oct-wash-selected`, the row under
the pointer `--oct-wash-hover`, no border.

### Tabs and segmented choices

`OctantTabs` is a flat rail with a selected fill; `OctantToggleGroup` is the
enclosed track. A tray segment is 24px inside 2px of padding, so every tray is
28px. Pane tabs are in [Workspace: Content tabs](docs/design/workspace.md#content-tabs).
Feature CSS may size these but never restore a local track, underline or
persistent active border. A tray, a chosen segment and a ghost or outline
button's hover, expanded and pressed states are washes of the theme's own ink
over whatever they sit on (`--oct-fill-4` 4% for a tray and a hover,
`--oct-fill-2` 8% for a chosen segment and a press), never the control colour: a
tinted preset's control colour carries a hue its black or graphite surfaces do
not, and read as a different background beside them.

### Home with the drawn ground

A start screen (the welcome screen, Code Home, a new thread) stands on the
application ground; every other page covers it with the reading veil.

- **Layout**: the question (the hero role, the 32px mark above it at 8px) centres
  in the free height; the composer docks 12px above the pane's foot, so a start
  screen beside a thread puts its composer on the same line. The column is
  `min(100% - var(--oct-thread-gutter), var(--oct-composer-width))`, 64px or 8vh
  from the top, 16px between parts. The hint is 12px meta, centred.
- **Where a ground shows.** Every ground shows behind the start screens by
  default (`scope: welcome`). A person may put it behind every page
  (`scope: everywhere`, which includes the sidebar); then every
  surface that shows text or information lies under the reading veil (the sheet
  colour at 94%) and only the start screens stay open on the ground.
- **The grounds.**

  | Ground                | What it draws                                                                                                                                                                                                                                                                  | Home readability                                                                                                                                                                                                                                                                                                                               |
  | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | ASCII field (default) | `A-Z a-z 0-9` in a 10px monospace face on 7 by 13px cells, primary ink at most 15%, only in drifting patches (smoothstep 0.52 to 0.82); three patterns every 20 seconds with a 4-second cross-fade; a click sends a ring, now and then a heart, through it                     | Dims itself to a fifth (a sixth on a light page) behind the start screen's content column (its full width and height) and under the sidebar when it runs there (on a start screen the one ground runs on under the sidebar panel as the same picture, so its 94% fill shows it faintly), full strength 140px past their edges; no ellipse mask |
  | Pixel ground          | Square cells through the 4×4 ordered dither in the ink (at most half opaque in dark, two-fifths in light) with the accent as one glow. Scenes: Ridges, Burst, Drift, and a person's photo printed in the same two tones; Still, or Wave for a slow drift and a ring on a click | The same column rule: a fifth of its strength (a sixth on a light page) behind the content column, a third behind the sidebar (Ridges runs at full strength outside the text, and calmed to a fifth only at the foot where the composer sits), back to full 140px past them                                                                    |
  | Dithered picture      | A first-party picture or the person's photo, `effect: dither` (or pixelate), cell 2 to 16px, 2 to 16 tones                                                                                                                                                                     | The 560 by 240px ellipse behind the question and the foot fade (full to 55% of the height, nothing at the foot)                                                                                                                                                                                                                                |
  | Flowing colour        | Soft colour from four accent stops, half resolution, 30 fps, a static grain                                                                                                                                                                                                    | Ellipse and foot fade; light stops clear AA against primary text                                                                                                                                                                                                                                                                               |
  | Picture               | A first-party picture (the three Gradient pictures carry a light and a dark print) or a photo, shown plain                                                                                                                                                                     | Ellipse and foot fade                                                                                                                                                                                                                                                                                                                          |
  | Plain page            | Nothing                                                                                                                                                                                                                                                                        |                                                                                                                                                                                                                                                                                                                                                |

- **Rules for every ground.** It is drawn on a canvas behind the content, with no
  pointer events except a wave a moving print sends from a click on empty
  space, and hidden from assistive technology. It stops while the window is
  hidden or it is off screen, caps its backing store at twice the display ratio
  and 5 million pixels, waits for idle time and fades in over
  `--oct-motion-ground-in`. Text never sits on it bare: the composer box is
  opaque on an opaque window, Home masks or dims behind its text, a tool's pane (a
  dock tile, the Environment section, the bottom panel) is solid wherever a
  ground is on, every other
  page lies under the veil. The Home ground fades to the stage colour over the lower 45% in both modes. Reduced
  motion holds a still frame. Increased contrast turns the ground off. Under
  glass the ground lies on the coat, the composer keeps its wash, and the
  characters or cells show beside the box and never through it. A glow stays
  outside the quiet band behind the question.
- Effect, motion and scope fields, and how an old row replays, are in
  [Application ground](docs/design/application-ground.md).

### Guided tour

A card beside the real control with a 2px accent ring around that control;
nothing else dims. The card is the floating recipe (`--oct-radius-lg`, the
float, `--octant-shadow-pop`), 336px wide, at `--oct-z-floating`. It holds a
picture of the feature drawn from rows, chips and lines over a faint dot grid
in ink and the accent; a label "n of N · Topic" in 12px accent text; a title in
the dialog-part role (15/600); one or two lines of detail; progress dots; a
ghost Back (absent on the first step), a default Next (Done last) and a 24px
Close. It is a non-modal dialog: focus starts on Next, Escape closes, Left and
Right step, Tab stays in the card, and it fades in over 150ms (none under
reduced motion). Steps and offering rules are in
[Workspace: Guided tour](docs/design/workspace.md#guided-tour).

## Enforcement

**Source of truth.** One runtime theme authority and one control layer:

| Layer             | Responsibility                                               | Files                                                    |
| ----------------- | ------------------------------------------------------------ | -------------------------------------------------------- |
| Semantic theme    | Persisted settings, presets, contrast validation, typography | `packages/theme/src/`, `packages/contracts/src/theme.ts` |
| Renderer fallback | Values before the theme applies                              | `apps/web/src/styles.css` (`--octant-*`)                 |
| Static system     | Type, space, radii, motion, layers, shell tokens             | `apps/web/src/styles/octant.css` (`--oct-*`)             |
| Runtime bridge    | Maps theme roles to `--oct-*`; the glass washes              | `apps/web/src/styles/octant-bridge.css`                  |
| Shell material    | Frame, panes, coat, translucency gates                       | `apps/web/src/styles/shell.css`                          |
| Floating material | Floats, overlay motion, forced colours                       | `apps/web/src/styles/components.css`                     |
| shadcn projection | `--background`, `--primary`, `--radius` and friends          | `styles/shadcn-theme.css`, `styles/tailwind.css`         |
| Owned recipes     | Recipes and the adapter API                                  | `apps/web/src/ui/shadcn/`, `apps/web/src/ui/base/`       |
| Native projection | React Native colours                                         | `apps/mobile/design-system/`                             |

Import order in `styles.css` is load-bearing: Tailwind, `octant.css`,
`octant-bridge.css`, `shadcn-theme.css`, then feature stylesheets, which position
but never repaint a shared control.

**Checks.**

| Check                                                                                | Pins                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run ui:check` (`scripts/check-ui-stylesheets.ts`)                               | No raw colour in a rule (except `/* ui-style-exception: fixed-scheme */`); no off-scale font size, duration, spacing or radius; no weight above 600 outside the title roles; no paint on a class handed to an Octant primitive; no fixed recipe height off 20/24/28/32; no new raw `role="alert"`; ratchets against `scripts/ui-stylesheet-baseline.json` |
| `scripts/check-ui-component-boundaries.ts`                                           | Feature code imports adapters only and renders no raw button, input, select or textarea                                                                                                                                                                                                                                                                   |
| `bun run tokens:check`                                                               | `packages/theme/tokens/tokens.css` and `tokens.json` match the stylesheets (`bun run tokens:export` writes them)                                                                                                                                                                                                                                          |
| `theme/visualLanguageContract.test.ts`                                               | Radii from tokens; the framed panel's outline, gap, clip and pane lines; flat resting surfaces; one hairline and one drop on floats; the composer pill, outline and float shadow; one focus edge                                                                                                                                                          |
| `theme/roundThingsContract.test.ts`                                                  | The pill token only on round things                                                                                                                                                                                                                                                                                                                       |
| `theme/sharedControlPaintContract.test.ts`                                           | Composer-row controls quiet; the composer and a Settings group flat                                                                                                                                                                                                                                                                                       |
| `theme/surfaceLanguageContract.test.ts`                                              | Faces; each type role defined once; one page shell                                                                                                                                                                                                                                                                                                        |
| `theme/alignmentContract.test.ts`                                                    | Band gaps and insets, rail faces, dock bar, Settings rhythm, the one hairline                                                                                                                                                                                                                                                                             |
| `theme/composerColumnsContract.test.ts`, `theme/interfaceTypographyContract.test.ts` | Composer columns; interface typography reach                                                                                                                                                                                                                                                                                                              |
| `ui/iconScaleContract.test.ts`, `ui/focusOwnershipContract.test.ts`                  | Icon sizes and stroke; focus ownership                                                                                                                                                                                                                                                                                                                    |
| `theme/translucencyContract.test.ts`                                                 | One coat on the shell and clear panes under glass; dense float with no backdrop filter under host glass; no backdrop filter on a surface inside a translucent shell; opaque under reduced transparency and increased contrast; the coat floors computed from the role colours                                                                             |
| `gallery/Gallery.test.tsx`                                                           | Every adapter appears in the component gallery or is listed with a reason                                                                                                                                                                                                                                                                                 |

**Component gallery.** `apps/web/component-gallery.html` (source in
`apps/web/src/gallery/`), served by the Vite dev server only, draws the type
roles, colours, spacing, radii, icons, every adapter in its states and a few
composed patterns under the real stylesheet and theme provider, with switches
for dark and light, window glass and the interface size. Read it before changing
a shared control.

**Packaged verification.** A change to a fill, a coat, a float or the frame is
judged in the packaged app under glass on the person's own theme as well as in
the browser: the browser has black behind the window and hides both slabs and
read-through.

**Checklist.** Read the relevant foundation, component and pattern and the
owning topic file; reuse an adapter and a token before adding CSS; add a focused
behaviour test for meaningful interaction; run the nearest tests, typecheck,
build, `ui:check` and `git diff --check`; for shell, dock, Settings or material
work, verify rendered at the relevant width and material.

**Exceptions.** Feature styles position surfaces and adapters paint controls;
when migrating an old control, delete the replaced paint. Blur is limited to the
surfaces listed in [Translucency](#translucency). Zen's windows and the activity
picture-in-picture keep an inset top highlight on their glass; no other surface
draws one.
