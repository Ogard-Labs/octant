# Octant design system

This is the visual specification for Octant surfaces: desktop and web, mobile,
public documentation, and marketing material. It holds three things:

1. [Foundations](#foundations): type, colour, spacing, radii, heights, icons,
   depth and material, motion, focus, and accessibility. Each value is a token,
   defined once.
2. [Components](#components): one specification for each shared adapter in
   `apps/web/src/ui/base`.
3. Patterns: arrangements that several screens share.

What one screen or tool shows and does lives in the topic file that owns it.
This document is the system those files build with; they never define a
second palette, type scale, or control.

| Screen or tool                                                                                                                                                | Owner                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Shell grid, tool row, content tabs, sidebar, icon rail, right dock, tool tiles, Environment, Browser toolbar, Board, Zen, pull requests, What's new, quitting | [Workspace: Presentation](docs/design/workspace.md#presentation)        |
| Turn header, transcript, Reply detail, subagent and follow-up cards, plan meters, model picker, context meter, message queue                                  | [Thread view](docs/design/thread-view.md)                               |
| Welcome screen, Code Home, first run                                                                                                                          | [Start screen](docs/design/start-screen.md)                             |
| Settings sheet, groups and pages, Permissions, Usage                                                                                                          | [Settings](docs/design/settings.md)                                     |
| The picture or drawn field behind pages                                                                                                                       | [Application ground](docs/design/application-ground.md)                 |
| Canvas charts, tables, mockups, and designs                                                                                                                   | [Canvas visuals](docs/design/canvas-visuals.md)                         |
| Moving a thread and Prepare to shut down                                                                                                                      | [Hub and spokes](docs/design/hub-and-spokes.md#moving-a-thread-screens) |
| Browser captures strip and Draw on page                                                                                                                       | [Browser captures](docs/design/browser-captures.md)                     |

[Workspace behavior](docs/design/workspace.md) owns navigation and pane
interactions; [architecture](docs/architecture.md) owns system and authority
boundaries. Use the [design workflow](docs/design/README.md) to update this
document in place with an approved design change. The tokens a website or
another app consumes are generated from the same stylesheets and described in
[Design tokens and the app feel](docs/design/design-tokens.md).

## Product character

Octant is a local-first desktop workspace for supervising Chat, Work, and Code
threads, providers, Projects, agents, changes, and delivery. Its visual north
star is a calm, colourful workbench that shows what is happening at a glance:
counts, running work, and whose thing is whose. Colour is the default; a person
who prefers grey chooses Mono (Settings › Appearance › Style).

- One active thread, board, Project overview, or Project-level list is the
  primary work surface.
- The main title band is a Project/thread breadcrumb plus window-local thread
  navigation. One unpinned conversation is the current preview; pinned
  conversations remain within reach. Selecting one reopens it through the
  authoritative shell command rather than keeping a hidden transcript alive.
- Navigation is a compact destination and thread rail. Projects is a first-class
  destination that opens the complete Project collection; low-frequency actions
  live in the bottom-left identity menu or an accessible overflow menu.
- The right dock and bottom panel are contextual working regions for the active
  pane. A capable region with no selected tool shows a compact launcher; a pane
  with no valid tool exposes no dock toggle, except a new Code task waiting for
  its thread (see [Workspace: Right dock and bottom panel](docs/design/workspace.md#right-dock-and-bottom-panel)).
  Neither region fabricates a tab or repeats another pane's content.
- Hierarchy comes from typography (size first, then weight), spacing, cards for
  discrete objects, and selection fills. Colour is a normal tool: a real accent,
  status hues (amber warning, red failure, green success), coloured count tiles,
  board marks, Project and Canvas hues, and brand marks on connectors. It carries
  meaning, so a mark that names a state also has a shape or a word, and colour
  never stands alone. Long reading text in the transcript stays neutral for
  comfort. The Mono style draws the same app in greys. The context ring and the
  parts of the context window keep their hues, amber then red, in every style.
- Controls are familiar, compact, keyboard reachable, and honest about loading,
  stale, unavailable, permission, and error states.

_Rationale._ A grey app read as unfinished in use: nothing said what was
running, warned, or belonged to what. With colour the default and grey one
choice away, the rules that remain are the ones that protect readers: colours
come from the theme, text stays readable, and keyboard focus stays clear.

Avoid dashboard walls (counts belong in a few tiles, not a grid of them), neon
developer styling, permanent low-frequency controls, oversized setup cards,
pill-shaped everything, and invented data. Gradients and depth are ordinary
tools used with judgment: the application ground, a count tile's face, a
Project's letter tile, and a raised card are fine; a gradient that carries no
meaning, or decoration on a control that already reads, is not. A feature that
is not available explains why and offers the next useful action, or stays out
of the primary layout. The one thing allowed to be decorative is the
[application ground](docs/design/application-ground.md): a first-party picture
or a person's photo, shown plain or through one print effect, or the field of
Pulsing characters, Dithered pixels, or Flowing colour, behind the start
screens or behind every page.

## Voice

The words, the face, and the hierarchy travel: every app surface, the docs site,
and the marketing site use the same ones. Platform adapters may express the
system through CSS or React Native, but they do not own a second palette or
visual language.

- **Crafted, not vibed.** Hierarchy comes from size, then weight, then colour,
  never capitals. One title per page. Section labels are sentence case and
  quiet. Nothing is uppercase except a monospace identifier that already is.
  Weights follow the one ladder in [Scale](#scale).
- **Sentence case everywhere**: titles, labels, buttons, tabs, menu items.
  Product nouns keep their capital (Project, Chat, Work, Code, Environment).
- **Say what happens.** A mode name never promises more than the runtime does.
  Where a thread's provider has no reviewer, a thread set to Auto reads "Ask
  first" and says why; Full access says it has no sandbox and no prompts.
- **One sentence of help.** A section note or row description is one sentence
  that says what the thing does. Longer explanations move to the docs.
- **Numbers read in English.** Counts, sizes, and token figures use the English
  separators whatever the system locale ("1,024", "4.1k"), because the words
  around them are English: on a Norwegian Mac the dock read "4,1k of 1 mill."
  beside a stats line reading "7.9k". A short token count in the context meter
  and Usage is `compactTokenCount` ("41.2K", "1.2M"). Dates and times still
  follow the locale, and a Canvas block keeps its own format.
- **Empty states are short phrases.** An empty state's title has no closing
  period ("Nothing archived", "No Projects match this view"); its detail line is
  a sentence and keeps one.
- **Name the host's computer from the host.** Copy about where something is kept
  or runs on the host says "this Mac" and "Keychain" only when the host reports
  macOS, and "this computer" and "credential store" otherwise. The window's own
  platform never decides it: a browser on a Mac can drive a Linux host. Until
  the host has reported, the neutral words show. Steps that differ by platform,
  such as a browser's key setup, show only the host's own platform's steps once
  it has reported, and every platform's before then. The platform is a host fact
  (see "Host platform in copy" under
  [Security and authority](docs/architecture.md#security-and-authority)).
- **Vocabulary.** `Project`, `thread`, `checkout`, `worktree`, `base branch`,
  `Environment`, `mode` (Auto / Ask first / Accept edits / Plan / Full access),
  `delivery` (Investigation / Local implementation / Pull request / Merged). The
  word "target" does not appear in the interface.

## Foundations

All sizes are at the default 13px interface size. Type and control heights
scale with the Appearance interface size; spacing, icons, and radii do not.

### Face

Interface text uses the platform face by default (SF Pro on a Mac):
`system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`. It is
what makes Octant read as a native app; a bundled web face with antialiased
smoothing read as a web page, thin and grey beside the apps around it. Geist
stays bundled as an explicit Appearance choice. Code, paths, branches,
identifiers, and terminal text use the monospace stack. Default subpixel-style
smoothing (no `-webkit-font-smoothing: antialiased`, which thins light text on a
dark ground), `text-rendering: optimizeLegibility`, no synthetic bold.

### Scale

This table is the one statement of the type roles. Everything scales together
with the Appearance interface size through `--oct-text-step`; nothing is
authored at 11.5 or 12.5, and nothing essential sits under 12px at the default.
The roles live in `styles/surface.css`; the size tokens are listed under
[Typography](#typography).

| Role                   | Size            | Weight | Leading | Colour      | Where                                                                                                                                                                                                         |
| ---------------------- | --------------- | ------ | ------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hero                   | 26              | 400    | 30px    | primary     | Welcome question only (`oct-title--hero` with `welcome__question`, `--oct-text-2xl`; 20 at phone width)                                                                                                       |
| Title                  | 28              | 700    | 1.15    | primary     | A page about one thing: a Project, a thread under review (`oct-title`; a role size, not a size token)                                                                                                         |
| Page title             | 14              | 600    | 1.35    | primary     | A destination or Settings page (`oct-page-title`)                                                                                                                                                             |
| Dialog title           | 17              | 600    | 1.35    | primary     | What a dialog is about (its `h2`, `.octant-dialog__title`, and the Settings rail's title); a part of a dialog is headed at 15 / 600 (its `h3`)                                                                |
| Reply heading          | 20, 17, 15, 14  | 600    | 1.3     | primary     | Markdown `#` to `####` in a reply, with 24px above and 12px below                                                                                                                                             |
| Section label          | 14              | 600    | 1.35    | secondary   | A heading inside content: over a hairline (`oct-section-label`), a Settings section's label, the Files tool's "In this folder"                                                                                |
| Row label              | 14              | 500    | 1.35    | primary     | A setting's row, a file row, an empty state's title                                                                                                                                                           |
| Navigation name        | 13              | 400    | 1.35    | primary     | A thread's title in the sidebar and in the title band, the account row's name, a Settings rail item and "Back to app" (`oct-nav-name`; a Settings item rests in the muted ink until hovered, focused or open) |
| Navigation group label | 12              | 400    | 1.3     | muted       | A sidebar group heading and a Settings rail group label, in sentence case (`oct-nav-group`; a group's count stays Meta)                                                                                       |
| Menu option            | 13              | 500    | 1.35    | primary     | Every menu's option row: dropdown, context menu, select and combobox options, the model menu's model names (`oct-menu-option`)                                                                                |
| Body                   | 13              | 400    | 1.5     | primary     | Interface text (the interface size, `body`)                                                                                                                                                                   |
| Reply text             | transcript size | 400    | 1.6     | primary     | A reply's paragraphs, list items and table cells (`--oct-leading-reading`); the size is the person's Appearance setting, and a list is indented 16px                                                          |
| Activity line          | 13              | 400    | 1.4     | muted       | "Worked for …" and a turn's time in a thread (`oct-activity-line`)                                                                                                                                            |
| Detail                 | 13              | 400    | 1.45    | secondary   | Row description (`oct-row-detail`); a menu's second line is Meta (`oct-menu-detail`)                                                                                                                          |
| Meta                   | 12              | 400    | 1.4     | muted       | Timestamps, counts, hints, the title band's Project and crumb, the status line under the composer's box (`oct-meta`)                                                                                          |
| Identifier             | 12              | 400    | 1.4     | muted, mono | Paths, branches, ids (`oct-meta--mono`)                                                                                                                                                                       |

Weights are one ladder, as tokens in `octant.css`: 400 (`--oct-weight-regular`)
for reading text and every name in navigation (thread titles, sidebar and
Settings rail rows, the account's name), 500 (`--oct-weight-medium`) for labels,
controls, a setting's row and a menu's options, 600 (`--oct-weight-strong`) for
emphasis (section labels, card titles, `strong`, the app's name, a destination's
page title, a dialog's title), and 700 (`--oct-weight-title`) only for the large
title. A count beside a label is Meta at 400; the one count at medium weight is
a plan meter's figure, which stands with no label of its own (see
[Thread view: plan meters](docs/design/thread-view.md#turn-figures-and-plan-meters)).
The welcome question is a prompt to answer, so it is regular weight. Avoid
bolding whole paragraphs. `bun run ui:check` counts a weight above 600 outside
the title roles in `styles/surface.css` as a `heavy-weight` finding and ratchets
it against the baseline.

_Rationale for the calm navigation._ Names in navigation at 14px and weight 500
to 600 read louder than the rest of the app, not clearer. At the interface size
and regular weight they read as a calm list, and the selected row's fill carries
selection, not its weight. A group label is a quiet caption (12px, regular,
muted), not a heading, so the rows it names stay the first thing read. An
activity line in a thread is the size of the text it sits between and is told
apart by its muted ink, so it does not read as a smaller second voice. A reply's
lines take 1.6 leading and its lists a 16px indent so long answers breathe; the
reply's size stays the person's own setting.

A title is never the size and the weight of the text it heads. It is larger,
heavier, or both, and has more room above it than below, so a reader finds the
parts of a page, a dialog or a long reply without reading them. A fact in a
list is its name in muted ink and its value in primary ink.

The large title and a dialog's title use `--oct-tracking-tight` (-0.025em); the
page title and section labels use `--oct-tracking-snug` (-0.01em), because tight
tracking on 14px type closes the letters up; the welcome question has its own
-0.012em; body and detail use none. Mono metadata uses positive tracking
(`--oct-tracking-wide`). The role leadings are tokens: `--oct-leading-label`
(1.35), `--oct-leading-meta` (1.4), `--oct-leading-detail` (1.45),
`--oct-leading-snug` (1.3), `--oct-leading-heading` (1.14),
`--oct-leading-tight` (1.1), `--oct-leading-body` (1.5),
`--oct-leading-reading` (1.6), and `--oct-leading-code` (1.7). A row whose height
is the sum of its lines sets them from the role leadings rounded to a pixel
(`--oct-line-label`, `--oct-line-detail`, `--oct-line-meta`, `--oct-line-snug`,
`--oct-line-tight`).

### Typography

| Job        | Default                                                                                             | Usage                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Interface  | `system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`                              | App-wide shell, navigation, controls, settings, headings, transcript, and composer |
| Display    | inherits Interface                                                                                  | Wordmark, section headings, selected navigation labels                             |
| Transcript | inherits Interface                                                                                  | Long-running conversation and composer; readable at 13–16px, 13px by default       |
| Editor     | `'Geist Mono Variable', 'SF Mono', 'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', monospace` | Code, diffs, paths, identifiers, aligned technical values                          |
| Terminal   | Geist Mono, SF Mono, Nerd Font fallbacks, monospace                                                 | Terminal output and prompt glyphs                                                  |

The default interface is the platform face at 13px and weight 400; transcript
text defaults to 13px. Geist and Geist Mono are bundled
(`@fontsource-variable/geist` and `geist-mono`): Geist Mono sets code by default
and Geist is an Appearance choice. The stylesheet's own first-paint defaults are
the same faces as the settings defaults, so nothing swaps when settings load.
The editor defaults to 13px, line height 1.5, and enabled ligatures. The
terminal defaults to 12px, line height 1.4, and disabled ligatures.

Size tokens in `octant.css`, each multiplied by `--oct-text-step` so the
Appearance interface size moves the whole ladder: `--oct-text-xs` 12px,
`--oct-text-detail` 13px (declared in `surface.css`), `--oct-text-sm` 14px,
`--oct-text-base` 15px, `--oct-text-lg` 17px, `--oct-text-xl` 20px,
`--oct-text-2xl` 26px, `--oct-text-3xl` 36px, and `--oct-text-4xl` 72px. The
large title's 28px is the `oct-title` role's own size, not `--oct-text-2xl`.
Feature CSS reads these tokens; it does not author
`calc(N * var(--oct-text-step))`, so the 12px floor for meta text is one
definition. The type roles in `styles/surface.css` (`oct-title`,
`oct-page-title`, `oct-section-label`, `oct-row-label`, `oct-row-detail`,
`oct-nav-name`, `oct-nav-group`, `oct-menu-option`, `oct-activity-line`,
`oct-meta`) are the only heading and label recipes; feature CSS does not author
a new size.

The persisted typography schema supports independent UI, editor, and terminal
family, size, weight, line height, and ligatures. Families are sanitized: no
URLs, imports, remote assets, executable payloads, or control characters.
Missing fonts fall back to the safe stack. UI, editor, and terminal sizes are
bounded to 8–32px; weights to 300–700; line height to 1–2.5. Appearance controls
update the renderer optimistically and queue their server-authoritative save
immediately; there is no separate Apply step, and a slower earlier response
never replaces a newer visible choice.

A saved stack that only ever meant "the default" reads as today's default
(`savedUiFamily` in `packages/theme/src/typography.ts`): the system interface
stack beginning `-apple-system, BlinkMacSystemFont`, the bundled-Geist default
stack beginning `'Geist Variable', -apple-system`, and the JetBrains code and
terminal stacks. The unbundled `Geist, system-ui, sans-serif` was an explicit
pick, so it reads as bundled Geist. The Geist entry saves
`'Geist Variable', system-ui, sans-serif`, so a Geist pick stays distinct; a
Geist pick saved under the old default's identical string cannot be told apart
and moves to the platform face. System interface saves the default's own stack.

The runtime UI projection is absolute for ordinary application chrome. The
bridge maps `--oct-font-display`, `--oct-font-body`, and `--oct-font-transcript`
to the selected UI family. There are no compatibility aliases such as
`--oct-font-ui` or `--oct-font-sans`, and feature styles do not declare a raw
interface stack. A repository contract test scans shell, Settings, dock,
navigation, pane tabs, and board selectors for violations. Monospace is limited
to editor and terminal content and literal code, paths, branches, identifiers,
or serialized theme source.

Transcript settings are explicit and centred on the body size: Small is 13px,
Medium 14px, Large 16px; Narrow is 680px, Medium 800px, Wide 1040px. A fresh
install reads Small and Narrow, so a question, its reply, and the composer under
them all read at 13px, never under the chrome around them. The column uses
`width: min(100% - 40px, measure)` with automatic horizontal margins. Welcome
composers share a 768px maximum so Chat, Work, and Code start from the same
prompt geometry independently of the reading-width preference. Canvas documents
use the `--oct-canvas-measure` (62ch) measure.

### Data visualisation

Charts, metric blocks, tables, and timelines are one visual system: hue lives on
the mark and never on the chrome, every mark pairs its hue with a second
channel, one formatter reads every number, and a block that cannot be drawn
falls back to its plain reading and disclosed table. The marks, scales, block
kinds, and their states are specified in
[Canvas visuals](docs/design/canvas-visuals.md). A design drawn in the workspace
theme receives the workspace's semantic tokens, scheme, and bundled faces, plus a
first-party `oct-` class kit that sets no colour of its own; its contents are in
[Canvas visuals: design frame kit](docs/design/canvas-visuals.md#design-frame-kit),
and mockups and designs follow
[Canvas visuals: mockups and designs](docs/design/canvas-visuals.md#mockups-and-designs).

### Colour

Neutral graphite grounds, a blue accent, semantic statuses (amber warning, red
danger, green success), and one neutral keyboard focus edge: that is the default
preset. The bundled colour presets lean every surface toward one hue and carry
their own accent. Text is three greys (primary, secondary, muted) and never a
fourth; the legacy `--oct-fg-2` alias maps directly to
`--octant-text-secondary`. Hairlines separate; fills select. Selected and
expanded fills carry state; keyboard focus follows [Focus](#focus). On the
marketing site the same three greys and the same hairline carry the hierarchy on
a white or graphite ground.

The default values are the `System` defaults in `packages/theme/src/tokens.ts`
and the matching renderer fallback in `apps/web/src/styles.css`, which mirrors
them exactly; `Dark` and `Light` are the same values pinned to one mode.

| Role                   | CSS variable                                        | Dark      | Light     | Use                                                        |
| ---------------------- | --------------------------------------------------- | --------- | --------- | ---------------------------------------------------------- |
| Application background | `--octant-app-background`                           | `#151515` | `#fafaf9` | Page ground: welcome, lists, Settings                      |
| Chrome                 | `--octant-chrome`                                   | `#151515` | `#fafaf9` | Title bars and shell chrome                                |
| Sidebar                | `--octant-sidebar` / `--octant-sidebar-opaque`      | `#101010` | `#fafaf9` | Navigation surface, on the page ground                     |
| Workspace              | `--octant-workspace`                                | `#1a1a1a` | `#ffffff` | Reading surface: transcript, editor                        |
| Floating               | `--octant-floating` / `--octant-surface-raised`     | `#232323` | `#fdfdfc` | Menus, popovers, dialogs                                   |
| Card                   | `--octant-card` (derived)                           | floating  | workspace | Raised objects: composer, setup, profiles                  |
| Control                | `--octant-control` / `--octant-surface-muted`       | `#2b2b2b` | `#f0f0ef` | Quiet control fill, secondary buttons                      |
| Control hover          | `--octant-control-hover` / `--octant-surface-hover` | `#333333` | `#e2e2e1` | Hover and highlighted rows                                 |
| Control pressed        | `--octant-control-pressed`                          | `#3b3b3b` | `#d3d3d2` | Pressed state                                              |
| Border                 | `--octant-border`                                   | `#303030` | `#e0e0de` | Hairline separation                                        |
| Strong border          | `--octant-border-strong`                            | `#4d4d4d` | `#bdbdbb` | Input and outline-button edges                             |
| Strong divider         | `--octant-divider-strong`                           | `#8a8a8a` | `#6f6f6d` | An off switch's edge, an unchecked checkbox, rare dividers |
| Primary text           | `--octant-text-primary`                             | `#f5f5f7` | `#141414` | Body and control text                                      |
| Secondary text         | `--octant-text-secondary`                           | `#bcbcc2` | `#45454a` | Supporting copy                                            |
| Muted text             | `--octant-text-muted`                               | `#949494` | `#666666` | Metadata and hints at 12px; AA on the control fill         |
| Primary foreground     | `--octant-primary-foreground`                       | `#141414` | `#ffffff` | Text on primary fill                                       |
| Focus role             | `--octant-focus-ring`                               | `#4d9ec8` | `#1f6f96` | Theme compatibility and accent tints, never the indicator  |
| Selection              | `--octant-selection` / `--octant-surface-selected`  | `#2c2c2c` | `#ebebea` | Selected rows and active controls                          |
| Accent fill            | `--octant-accent`                                   | `#5b9cf5` | `#1f5fc7` | One primary action or active mark                          |
| Accent foreground      | `--octant-accent-foreground`                        | `#141414` | `#ffffff` | Text on accent fill                                        |
| Accent text            | `--octant-accent-text`                              | `#5b9cf5` | `#1f5fc7` | Accent used as text; normal-text contrast                  |
| Scrim                  | `--octant-scrim`                                    | `#000000` | `#000000` | Opaque by contract; the bridge mixes it to a wash          |

The ladder is deliberate: in dark the page is near-black, the sidebar a step
darker, the reading surface a step lighter, and cards lift one more step. In
light the sidebar and the page share one near-white ground and the reading
surface is white; a hairline, not a grey fill, separates the sidebar from the
workspace. Every hairline registers on the surface it separates (about 1.3:1 in
both modes); inputs and outline buttons use the strong border so an edge is
never guessed. An off switch and an unchecked checkbox take the strong divider,
because they must be found at a glance on a card: 4.4:1 on a card and 4.9:1 on
the page in light, and in dark 3:1 or more on the lifted card the Settings sheet
draws (`#3d3d3d`, 3.15:1) and 5.3:1 on the page; every dark preset keeps the
same floor. The same role draws a scrollbar thumb on hover and rare dividers.

_Rationale for the accent._ Blue clears 4.5:1 as text and 3:1 as a fill on the
light and the dark page with the same hue, and it stays distinct from the amber
warning and the green success. Purple's light-page text value had to be darkened
until it read close to the plain ink, which loses the point of an accent.

**Accent swatches.** Appearance › Accent offers a one-click accent colour: Blue
(the theme's own), Sky, Teal, Green, Lime, Amber, Orange, Clay, Rose, Pink,
Purple, Indigo, the neutrals Steel, Slate, Silver, Graphite, Carbon and White,
or Mono. Mono is the grey look: it sets Style to Mono and its ink accent. A
swatch overrides the accent fill and the ink on it (`accent-foreground` and
`primary-foreground`): dark ink on most, white on Slate, Graphite and light-mode
Carbon, each clearing normal-text contrast on its fill (`accentSwatches.ts`). A
fill is also a switch track, a usage meter and a primary button, so on the light
card it reaches 3:1: the chromatic swatches and Silver take a deeper step in
light, the dark value with only its OKLCH lightness lowered (Lime reaches 3.03:1
on the card), and the dark values are unchanged. The Appearance chips show the
fill the current mode uses. An accent saved before the light fills were deepened
is read as the same swatch, at paint time, with no write to the saved settings.
Accent text stays on the preset's ink, because no swatch clears normal-text
contrast on the light page. White would vanish on the light page and Carbon on
the dark one, so each takes a silver in that mode, written as a mode-only
override: an override's optional `mode` limits it to the light or the dark
theme. The accent colours switches, selected states, and sliders; status colours
stay their own.

**Colour and Mono.** Settings › Appearance › Style chooses between **Colour**
(the default) and **Mono**. Colour lets the places that name something carry
colour: the accent, the sidebar's count tiles, board column marks, a Project's
accent, connector brand marks, and a thread's Canvases, which take the hue of
what they hold (a plan purple, a chart or figures amber, a diagram teal, a
mockup pink, a table or document blue). Colour draws every hue from the preset's
palette roles (`--octant-palette-*`, read through the `--oct-colour-*` aliases in
`styles/colour.css`), so it follows the light or dark theme and any tinted
preset. Mono draws the ink accent (`#f5f5f7` dark, `#141414` light) and the
neutral warning trio (`MONO_STYLE_TOKENS` in `packages/theme/src/tokens.ts`,
swapped in only for roles a preset left at the colour default), grey tiles and
marks, and connector marks in the ink. A stored `vivid` or `default` value, or
none, draws Colour, and `mono` draws Mono. The root carries
`data-octant-style="colour"` or `"mono"`. Increased contrast always publishes
`mono` and resolves the Mono roles. Plain empty, loading, and informational
messages draw their mark in neutral ink in both styles; a yellow icon on a
message that is not a warning is wrong.

**Status.** Status roles are paired to the surface where they render. Use the
text role for labels and the surface role for a background; never rely on hue
alone. Routine waiting, idle, and unselected states use neutral text and marks.
Pending approval requests use a neutral surface and muted icon, without a
warning stripe. Warning colour is reserved for an actionable warning, not every
thread that can be resumed. A state, empty, or error message draws its mark in
neutral ink, whatever went wrong: its glyph and title carry the meaning, and the
message recipe offers no coloured tone. Success, failure, diffs, provider marks,
and categorical data may retain semantic colour alongside a label or shape.

| Meaning       | Surface                                                      | Text/border                                                                                                                   |
| ------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Success       | `--octant-success-surface` (`#16281f` dark, `#bfd8cc` light) | `--octant-success-text` (`#6bb299` dark, `#0f6144` light)                                                                     |
| Warning       | `--octant-warning-surface` (`#33270b` dark, `#fbe9bd` light) | `--octant-warning-text` (`#f2c75c` dark, `#5c3d00` light); border `--octant-warning-border` (`#c99a2e` dark, `#8a6218` light) |
| Danger        | No default surface                                           | `--octant-danger-text` (`#e17d96` dark, `#a8102f` light)                                                                      |
| Diff addition | No default surface                                           | `--octant-addition-text` (`#6bb299` dark, `#0f6144` light)                                                                    |
| Diff deletion | No default surface                                           | `--octant-deletion-text` (`#e17d96` dark, `#a8102f` light)                                                                    |

The default warning role is amber: a surface, a border that reads at 3:1 on it,
and text that clears 4.5:1 on the surface. Mono swaps in the neutral trio: the
control fill, a border that reads at 3:1 on it, and the primary ink. A warning is
told apart by its mark and its words in both.

The eight palette roles (`red`, `orange`, `yellow`, `green`, `teal`, `blue`,
`purple`, `pink`) are for Project identity, chart marks, and provider or runtime
status where a categorical distinction is needed. Pair every mark with a label,
icon, pattern, or border style. The static chart series and dash patterns live
in `octant.css`. The parts of a context window are categorical data and keep
their hues in every style ([Thread view: context meter](docs/design/thread-view.md#context-meter)).

The warm charcoal-and-brass `Octant` preset remains an optional theme. Custom
themes may override only validated semantic roles; incomplete or low-contrast
imports fall back safely. The theme schema keeps its focus compatibility role for
imports, but Appearance offers no focus ring colour control, because the focus
indicator is the neutral edge, never the theme's focus role.

**Editor and terminal.** The code editor and its diff draw from the same
resolved roles through `packages/theme/src/editorColors.ts`: the workspace
ground, primary ink, muted line numbers, the selection role, floating widgets,
and the two border roles of its scrollbar thumb. Under increased contrast it
takes the same high-contrast ink as the rest of the window. Syntax colours come
from the editor's own light or dark base, because the palette roles are checked
only for interface contrast. The terminal draws from
`packages/theme/src/terminalColors.ts`: the workspace ground (the Glass plate
under translucency), primary ink, the selection role, the two border roles of
its scrollbar thumb, and the palette roles as its ANSI hues, with ANSI black and
white kept dark and light in either mode and bright black as the muted ink. The
projection sets a contrast floor the terminal engine enforces per cell against
the background it is drawn on: 4.5:1 normally and 7:1 under increased contrast,
half that for dim text; increased contrast also swaps in the high-contrast ink. A
theme, mode, contrast, or system appearance change repaints open editors and
terminals in place, a terminal keeping its scrollback, and so does a change in
the sidebar material (opaque or Glass, including Glass the host resolves after
the terminal opened) or in reduced transparency, which moves the terminal's
cells onto or off the Glass plate.

### Spacing

Spacing is a 4px base scale: 4, 8, 12, 16, 20, 24, 32, and 48px
(`--oct-space-1` to `--oct-space-6`, `--oct-space-8`, `--oct-space-12`). 1px and
2px exist only for hairlines and optical nudges (2px inside a segmented
control). Off-scale pixel spacing in a stylesheet is ratcheted by
`bun run ui:check` against the recorded baseline; a change may lower a file's
count but never raise it. Use `gap-*` for stacks and groups; do not reintroduce
`space-x-*` or `space-y-*` utility chains.

The recipes' spacing utilities (`p-*`, `gap-*`, `m-*`) are pixels, because the
theme sets Tailwind's spacing step to `--spacing: 4px` in
`styles/tailwind.css`: at every interface size `px-2` is 8px. A recipe names a
step that is on the scale (`gap-1`, `px-2`, `p-3`, `gap-4`) and never a half step
(`px-2.5` is 10px, not 8); a contract test scans every class string for one. A
width or height that follows the type (a menu's minimum width, a terminal's
height) is written in rem on purpose. _Rationale._ Leaving the step in rem and
rewriting every recipe in `--oct-space-*` tokens would have left two spacing
systems in one file, and a larger interface size would have padded a control
that already grew with its text, so a control at 16px would read as loose rather
than larger.

### Radii

Radius is two numbers and a round exception: a control's outline is
`--oct-radius-sm`, a container's is `--oct-radius-md`, and a thing that is
inherently round stays round. One number for a control and one for a container
make any two neighbours agree. This table is the one statement; elsewhere this
document names the token, not the number.

| Token                | Value  | Role                                                                                                                                                                                                                                                                                         |
| -------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--oct-radius-sm`    | 4px    | A control: every button of every size and variant, field, tab and segmented item, menu and option row, filled list or navigation row, chip and tag, and a capsule or track that only groups controls (the Browser's history capsule, a toggle group). The composer's attach and send buttons |
| `--oct-radius-md`    | 12px   | A container: a card, panel, or well; a menu, popover, tooltip card, and toast; a dialog and the Settings sheet; the composer; a bubble; a Settings section card; the window-frame cards                                                                                                      |
| `--oct-radius-inset` | 8px    | An object resting inside a container: a board card in its column                                                                                                                                                                                                                             |
| `--oct-radius-pill`  | 9999px | Only what is inherently round: a switch's track and thumb, an avatar, a status dot, a count badge, a spinner, a radio, a round colour swatch, a meter or progress bar, a slider's thumb. Never a control                                                                                     |

A one-line tooltip (`.octant-tooltip`, `.tooltip > .tip`) and a drag preview
(`.workspace-drag-preview`) take the control radius, because they are about 24px
tall and 12px would draw a pill. A tooltip card (`.octant-tooltip--card`,
`.octant-preview-card`) holds content and is a container. A menu, popover,
disclosure and filter menu are containers at 12px, with their rows at the
control radius, inset from the popup's corner.

A part inside a control takes the control radius less the padding between them,
never below 2px, so the outline of every control is 4px and the inner part is
concentric: a segmented switch's thumb inside its track, an item inside a toggle
group's padded track, a clear button inside a field. A control that sits inside a
container takes the control radius whatever the container's: the composer's
attach and send buttons sit 8px inside its 12px corner. An object that rests
inside a container takes the container's radius less the gap
(`--oct-radius-inset`). A corner that sits within one radius of a rounded
parent's corner is concentric with it: the parent's radius less the gap between
them, or square when the gap is at least the radius, never the same token again,
because two equal radii one inset apart leave a frame that swells at the corner.
The rule governs an object inside a rounded container (a card in a card, a tile
in a round end) and the narrow layout; from 681px up the panes are square and
have no corner to nest (see [Depth and material](#depth-and-material)).

Product chrome uses those tokens and nothing else: a `border-radius` is a token,
`0`, `50%`, or the 1–4px of a chart bar, mark, or status dot, never a rem or a
bare pixel literal. A rem corner also shrinks with the interface font size,
which a token does not. The `--oct-radius-*` tokens live in `octant.css`. The
shadcn recipes derive their scale in `tailwind.css` from `--radius`, which
`shadcn-theme.css` sets to `--oct-radius-sm`: `rounded-md` and `rounded-lg` both
land on the control's 4px, `rounded-xl` on the container's 12px, and
`rounded-sm` on the step for a part inside a control (the control radius less
2px, never below 2px), so a menu shares a corner with the popover beside it and
no recipe class needs rewriting. Phone-only surfaces in the web renderer use the
mobile radii (`--oct-radius-bubble`, `--oct-radius-card-m`,
`--oct-radius-sheet`). The native phone app follows this table and adds only a
20px bottom sheet, and it draws its chrome with the system's own patterns (tab
bar, large titles, inset grouped lists, segmented controls);
`apps/mobile/design-system/README.md` holds that projection.

### Heights

Controls are 20, 24, 28, or 32px, and rows 32 or 44px. Recipe controls (buttons,
tabs, toggles, comboboxes, badges) take their height in rem so they grow with the
interface size, rounded to a whole 2px (`h-[round(2.154rem,2px)]` is 28px at the
13px root): a quarter-rem step is 3.25px at that root, and an odd step drawn bare
lands between pixels.

| Height | Token or recipe                                                     | Used by                                                                                                                                    |
| ------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 20     | button `xs`, `icon-xs`                                              | The smallest button                                                                                                                        |
| 24     | button `sm`, `icon-sm`; `--oct-tray-segment-h`                      | A row action, a chip, a tab (`OctantTabs`), a segment in a tray, a tile bar's controls                                                     |
| 28     | button `default`, `icon`; `--oct-rail-button-h`; `--oct-menu-row-h` | A button, a field, a select, a combobox, a tray, a title band control, a panel head's icon button, a Settings control, a one-line menu row |
| 32     | button `lg`; `--oct-nav-row-h`                                      | A large button, a navigation row, the icon rail's face, a tile bar, a secondary row under it                                               |
| 44     | `--oct-title-rail-h`, `--oct-nav-head-h`, `--oct-menu-row-two-h`    | The title rail (title band, dock head, bottom panel bar), the account row, a two-line menu or navigation row, a touch target               |

A field, a select and a combobox take the default button's 28, and a tab takes
the small button's 24, so a row of them shares one height. A segment in a tray is
24px inside 2px of padding, so every tray is 28px. Other shell heights:
`--oct-rail-tab-h` 30px and `--oct-statusbar-h` 26px. Touch surfaces keep 44px
targets. `--oct-control-height` (44px) and `--oct-control-height-sm` (34px) are
the touch and compact field heights some surfaces still read; a new desktop
control takes one of the recipe heights above.

### Icons

Lucide is the product icon library. Every interface icon is drawn at one of four
sizes and at one stroke.

| Size | Token           | Where                                                                     |
| ---- | --------------- | ------------------------------------------------------------------------- |
| 12   | `--oct-icon-xs` | Disclosure chevrons and status marks inside a chip                        |
| 14   | `--oct-icon-sm` | Inside a 24px control and inline in 13px text                             |
| 16   | `--oct-icon-md` | The default: buttons, menu rows, navigation rows, tool buttons, tile bars |
| 20   | `--oct-icon-lg` | An empty state and a dialog header                                        |

The stroke is 1.5, set once for the whole app by `IconDefaults`
(`apps/web/src/ui/IconDefaults.tsx`) around every rendered surface. A call site
passes a `size` from the table and no `strokeWidth`. The exceptions are drawings
and not icons: diagram edges, the marks a person draws on a page, a glyph cut
into a dither mask, and provider marks, which are filled artwork. The stroke is
in the icon's own 24-unit grid, so it renders 0.75 to 1.25px across the four
sizes. A tick or dot of 16px or less drawn inside a filled or bordered mark (a
step marker, a done mark, a mock-up checkbox) takes `MARK_TICK_STROKE_WIDTH`
(2.5), because 0.75px on an accent fill falls under the 3:1 bar for graphics. A
check beside text or in a menu row is plain and takes the same 1.5. One lighter
stroke reads as one drawing hand. `iconScaleContract.test.ts` fails on a size or
stroke outside this section; avatars and provider marks are sized by their own
components.

In a Button, pass icons with the shadcn `data-icon` convention and let the
recipe size them: it takes 12, 14 or 16 from `--oct-icon-xs`, `-sm` and `-md` by
control height (20, 24, 28px and up), in pixels, because a rem size would follow
the interface text size and land between the steps. Icons clarify labels and do
not replace an essential label without an accessible name.

Provider identity uses locally bundled, licensed provider logos selected by
`ProviderGlyph`. This is the explicit identity-asset exception to the
originality rule; it does not permit copying another application's interface
assets or implementation. Keep source and license provenance with each mark.
Never fetch a logo at runtime, use emoji, or draw an approximate brand mark.
Unknown or private providers keep a truthful fallback. The same marks appear in
Settings, model pickers, and thread metadata.

### Depth and material

Depth is one material in five levels. Every surface takes a fill one step
lighter than what it sits on, a rim that is brighter along its top edge (two
inset shadows: a line along the top, then a ring around), and a shadow that
seats it, so an object is never told from the surface under it by an outline
alone. Each level has its tokens in `styles.css`; a surface consumes them and
never writes its own colour.

| Level      | What it is                                                                                            | Fill                                                                       | Rim and shadow                                                                                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 Ground   | The window frame: the title band and the sidebar's area. Sidebar rows sit on it, with no panel behind | the sidebar colour (the ground; in light a step darker than a panel)       | none                                                                                                                                                              |
| 1 Pane     | The thread stage, each dock tool tile, the bottom panel, the dock's overview: square, sharing edges   | `--octant-panel-surface`, with `--octant-panel-sheen`: a sheen across 96px | one 1px line (`--octant-pane-line`) on its top and left edges; no rim, no seat shadow, no corner at any width (a narrow window's sheet holds one square tile)     |
| 2 Card     | An object on a panel: a tool card, an approval or decision card, a user bubble, a Settings group      | `--octant-card`                                                            | `--octant-shadow-xs` (the card recipe), `-sm` (a Settings group, an empty state): top rim, low rim, ring, a sheen at the top, a short drop (`--octant-card-drop`) |
| 3 Control  | A filled button, a chip, the selected list row, a segmented switch's thumb, a composer button         | `--octant-control` and the control lift (lighter on top)                   | `--octant-shadow-control`, `-md` (the composer's box, with a longer shadow), `-selected`: light top line, dark low line, ring, a short drop; pressed sinks        |
| 3 Well     | A segmented switch's track, a capsule of history buttons, a command block                             | `--octant-well`                                                            | `--octant-shadow-well`: an inner top shadow and a light line under the bottom edge                                                                                |
| 4 Floating | A menu, popover, hover card, toast, dialog, the Settings sheet                                        | `--octant-float-glass` over a blur, with `--octant-float-sheen`            | `--octant-shadow-overlay`, `-pop`: the brightest rim, a low rim, a hairline outside it, a short shadow that seats it and a long one that lifts it                 |

- **The light an edge catches is the rim** (`--octant-rim`, `--octant-rim-top`,
  `--octant-rim-low`, `--octant-rim-float`, and the control's
  `--octant-control-top`, `-low`, `-rim`). A card and a floating surface carry a
  fainter line inside the bottom (`--octant-rim-low`; none in light, where it
  cannot show on a white fill). A pane carries none of it: it is flat, and its
  edge is the one line it shares with its neighbour. In dark a shadow cannot be
  seen on a near-black page, so the fill and the rim carry the lift (on an OLED
  preset the panel is a step toward the ink and the sheen lifts its top) and the
  shadow helps only where the surface crosses something lighter; in light the
  top line is white and the shadows carry it. A narrow window's panel content
  paints over an inset shadow on its box, so its rim is drawn by a
  pseudo-element above the content and the box keeps only the seat shadow. The
  rim is in the shadow token and a surface draws no border or second ring on the
  same edge, which would show two lines.
- **A control is a raised tile.** A filled button (default, solid, outline,
  secondary), a chip, the selected row and a switch's thumb take
  `--octant-shadow-control`: a lighter top, a light line along it, a dark line
  under the bottom edge, a ring, and a short drop; pressing inverts it
  (`--octant-shadow-control-pressed`). The gradient is drawn as an inset shadow
  (`--octant-control-lift`), so a recipe that sets its own fill still gets it.
  The primary button is the accent as a gradient with a soft accent glow under
  it (`--octant-accent-sheen`, `--octant-shadow-primary`). The gradient moves the
  fill away from the label's colour for any accent: the direction is taken from
  the published `--octant-primary-foreground` (`--octant-accent-away`), not from
  the mode, so no stop is less legible than the flat accent. Ghost, link, bare
  and the suggestion chip stay flat until pointed at, as do the quiet controls
  of a row (the line under a composer, the microphone). A toggle that is on (the
  dock and bottom-panel buttons in the title band, a tile's open menu) is a
  control pressed in: a filled tile with the sunk shadow, told apart from the
  pointed-at wash and from the deeper press.
- **A well is cut in**: darker than what it is in, an inner top shadow, and a
  light line under its bottom edge. What is chosen in a well is a raised control
  again (the thumb of the Work and Code switch).
- **Floating surfaces are frosted.** In dark the fill is the float colour at 66%
  over a blur that also lifts saturation and dims what is behind it to under
  half (`--octant-float-blur`), so the meta ink on a menu reads at 4.54:1 over the
  app's own dark page and the whole menu at 2.97:1 with a white page behind it.
  In light the fill is 78% and the blur draws what is behind toward a pale grey
  first, since a black page behind a white menu cannot be dimmed away: 5.64:1
  over the app's own page and 4.11:1 with a black page behind it. A packaged
  window's native material is not re-blurred by a backdrop filter, so Glass tints
  the panels instead (see [Glass](#glass)). Reduced transparency and increased
  contrast take the opaque float. The sheen is a strip along the lit top edge
  only (8px), above the first line of anything a surface holds, so the meta ink
  on a menu's top row or a dialog's title band sits on the plain fill.
- **What sits on a floating surface is based on that surface.** Its control
  fills, its pointed-at row and its hairlines step up from `--octant-float`
  (`--octant-float-control`, `-hover`, `-pressed`, `-line`); the page's own
  control fills are darker than a lifted menu and show there as dents.
- **The row a list is showing is a raised control** (`--octant-shadow-selected`,
  the control's shadow), on the thread list, the sidebar and the Settings rail.
  The row under the pointer stays a flat wash, so "here" and "pointed at" are two
  states.
- **The inverse tooltip takes no bevel.** It is the primary text as a fill, and
  the raised elevation's white top line draws as a light seam on it in light, so
  it takes the two shadows alone in both modes.
- **Edges that do not depend on a shadow.** Forced colours drops every shadow, so
  a popup, a card (user bubble, approval row, provider question) and a chip take
  a 1px system-colour border there, and a pressed chip the system highlight.
  Increased contrast takes the strong border and sets every rim to it, drops the
  lift and the sheen, and keeps the rims; Mono keeps the same material.
- **A shadow explains depth, never decoration.** Shadow tokens are
  `--octant-shadow-hairline`, `-xs`, `-sm`, `-md`, `-lg`, `-overlay`, `-pop`,
  `-control`, `-control-pressed`, `-selected`, `-well`, `-primary`, and
  `-raised-glass`. Use the smallest level that establishes a genuine layer:
  navigation panes, plain lists, empty states in a page, headers, and open form
  layouts stay unshadowed; the card recipe uses `-xs`; a Settings group and the
  `OctantEmpty` box `-sm`; a filled button `-control`; welcome and follow-up
  composers `-md` over a hairline ring; focused or promoted raised objects may use
  `-lg`; overlays use only their overlay or pop token.

A card is for a discrete object a person acts on as a whole: a count tile, a live
running-thread card, an action tile, a board card, a provider, a Settings group of
rows. Plain lists, empty states, and headers are never cards. Navigation panes
stay compact hairline rails. Popovers, menus, dialogs, and hover cards use the
floating surface and the overlay shadow, and have exactly one 1px hairline edge:
the overlay shadow carries it for menus and popovers, and the shared dialog draws
it as a border. A feature stylesheet sizes and places a popup and never sets its
fill, border, or shadow.

**The window frame and its panes.** The window is a frame and a grid of panes.
The title band and the sidebar are the frame (level 0): the window surface,
painted once, with the sidebar's rows sitting on it and no panel behind them. The
thread stage, each tool tile in the dock, the bottom panel and the dock's overview
are square panes (level 1) under the title band that touch each other and the
window's right and bottom edges: no gap, no corner, no shadow. Between two
neighbours there is one 1px line (`--octant-pane-line`: a tenth of the ink, so it
shows on a near-black preset and on a glass tint as it does on the stock page;
the strong border under increased contrast, and a system-colour border in forced
colours), and one under the title band along the panes' top. Each pane draws only
its own top and left edge, so a shared edge is never drawn twice. The window's
own outer corners are the native window's; no pane rounds a corner. A tile is
told apart by its name, not by a ring that would double a divider. Pane headers
and the tool row stay in the title band; a pane header shares the title rail
(`--oct-title-rail-h`) with the tool row, and the dock's own header is an empty
spacer under the band, so the first tile's top line is the only line there. A
native Browser page inside a tile is placed by the tile's measured rectangle and
is square; the corner of the page inside the tile belongs to the web renderer
only. A dock tile is square with no seat shadow in a narrow window too: there the
dock is a floating sheet (12px corner) holding one tool, and the tile fills it
with no gap or corner of its own. Behind every page the application ground lies
on the thread's pane, under the content, square like the pane. At 680px and
below the workspace sidebar is an overlay drawer and the frame stays flat, with
no panels, and a scrim (`--octant-scrim`) dims the page behind it. The drawer
starts closed on every load, closes on Escape, on a tap outside it, and on
choosing somewhere to go, and never changes the saved wide-window choice.
Settings keeps its own narrow layout, a drawer with a flat page, at 960px and
below (see [Breakpoints](#breakpoints)). _Rationale._ Panes in a grid that is
dragged, aligned and resized share edges, and a corner and a gap on each one made
the grid read as loose cards.

**Dividers.** A divider handle (the sidebar's, the dock's, the bottom panel's, a
pane split's, a tile's) is a hairline in the border at rest, the strong border
under the pointer, and the meta ink at double width while it is grabbed; keyboard
focus draws the shared focus edge, on the visible handle when the focusable
element is an invisible input (a pane split). None of it is the accent. The hit
area is 8px wide and centred on the line, for the edge between the thread and the
dock, between two tiles, and above the bottom panel.

### Glass

Frosted material (a `backdrop-filter` blur) is used only where a surface has a
ground behind it to read through:

- the window's optional glass, which is the tint over the native window material
  behind the whole window;
- a thread's user bubbles and composer over the application ground or window
  glass, one material either way (agent replies stay bare prose);
- Code Home's cards and its Up next and Continue cards, which stand on the start
  screen's ground beside the composer and wear its material, so the ground reads
  evenly behind every surface on the screen;
- Zen's windows, dock, bars, and sheets (glass cards);
- the floating Computer Use activity picture-in-picture (the Browser's live
  preview is a card in the dock, drawn as the dock's other cards are, with no
  frosted parts);
- the phone's glass surfaces.

Glass is a different material, not a second palette. Do not copy mobile
atmosphere or phone radii into a flat desktop pane, and do not bring a blur onto
a pane that has no ground under it. Its tint, stroke, and highlight are theme
roles, and its floor is the theme's page colour at 66%, so a neutral or tinted
preset gets no fixed warm cast under the composer. The thick and chrome tints
poured over that floor are the theme's raised surface at 56% and 48%. Together
the floor and tint are dense enough that the ground stays quiet behind text
where the engine does not blur it (the packaged window over the ground).
Reduced transparency and unsupported `backdrop-filter` resolve every one of
them to an opaque surface.

**Window glass** is the `sidebarMaterial` shell setting with the theme's
vibrancy level, shown as the Window section's Glass control (Off, Subtle,
Strong) and its Tint slider. It takes effect only when the host resolved the
material translucent, so every accessibility, performance, and host-support gate
applies; then the frame (the sidebar colour) and the panels (the workspace
colour) are each at the Tint's opacity over the native material, and reduced
transparency or an unsupported host leaves them opaque. A browser is such a
host: with no native material behind the page, a browser window always paints
the theme's opaque surfaces. The `workspaceMaterial` setting is still read and
stored but changes nothing: the whole window is glass or none of it is. With
Glass on, the ground and the panes are the Tint over the window's native
material: every pane (the thread, a tile, the bottom panel, the dock's overview)
is the same one fill (`--octant-pane-fill`), a lighter tint than the ground, so
text reads on a saturated desktop. Reader pages inside the stage are clear.

Under Glass nothing inside the shell paints the theme's opaque page, workspace,
or card colour over a panel; every layer takes one of the shell's surfaces
(`--octant-window-surface` for the frame and `--octant-panel-surface` for every
panel, the thread's included), defined once on every shell in `shell.css`:

- **Settings** wears the same frame and panels: the navigation and gutters are
  the frame, the page is a panel, and a section card is the card step below.
- **Destination pages** (Inbox, Board, Archive, Review, Projects, Agents,
  Automations, Artifacts, Image generator) are clear over the panel, and their
  cards drawn with the raised step (`--oct-surface`) take the card step (see
  [Workspace: Inbox page](docs/design/workspace.md#inbox-page)).
- **A card** (`--octant-card`, the recipe's `bg-card`) is one step of ink over the
  panel: the primary text at 4%. On Window glass a card takes a light rim and a
  shadow that can be seen on the desktop behind it
  (`--octant-shadow-raised-glass`); the opaque border is near black and drew a
  heavy outline there.
- **An outline button** rests on that card step instead of the page colour
  (`--octant-outline-rest`); its hover and pressed fills stay the control fills.
- **Quick tools** for a Code start screen are clear in the body of the dock.
- **The Browser** is clear on its own start page, whose rows take the card step;
  a loaded page keeps its opaque canvas.
- **The control fill** (a secondary button, a segmented track, a select, a chip,
  a ghost button's hover) is the primary text at 7%, 11% hovered and 15% pressed,
  the step the theme's control sits above its own page. What is chosen (the mode
  in the switch, a selected row) is the primary text at 12%. A switch's track at
  rest is the pressed control tint and its thumb, off, the primary text at 62%. A
  toned notice's ground is its tone at 14%, and a plain notice takes the control
  tint. A filled button and a switch that is on keep their own fills.
- **The composer and the person's messages** are a 30% veil of the page colour
  under the primary text at 6% (4% for chrome), with the glass hairline: over
  the desktop the dense floor and tint read as a near-black slab. The thread's
  container stays clear.
- **Loading.** The shell's own loading state (Opening Settings) is clear on the
  shell's surface. The window's own loading state, before any shell exists, is
  clear on the document's ground (the page colour in a browser, the app ground in
  a native window, the desktop through the glass once the host's glass is on),
  and the first frame is drawn in the mode the last window used, remembered in
  the renderer's storage, so a light theme never opens on the dark default. A
  native window is shown only when its first frame is ready; a glass window is
  created clear, and an opaque one keeps the window's own dark fill until the
  renderer paints.

Menus, popovers and dialogs sit outside the shell and keep the opaque floating
surface. Increased contrast and reduced transparency return cards, outline
buttons, and every fill above to the theme's own colours. The application ground
behind it all steps down by what is on screen; its veil is in
[Application ground](docs/design/application-ground.md).

### Motion

Functional feedback uses 150ms (`--oct-motion-fast`) and geometry 200ms
(`--oct-motion-base`); an overlay leaves in 100ms (`--oct-dur-fast`). Ordinary
transitions use `--oct-ease-standard`; overlays arrive on `--oct-ease-motion` and
leave on `--oct-ease-color`. The spin (`--oct-motion-spin`, 900ms), pulse
(`--oct-motion-pulse`, 1.6s), and flowing (`--oct-motion-flowing`, 36s) cycles
are tokens too. One value with one meaning has one token: a duration, a weight
or a space is never defined twice under two names. There is no decorative
entrance animation and no ambient motion behind the work by default; an animated
built-in picture, the Pulsing characters, Dithered pixels, and Flowing grounds,
and a printed picture set to Wave are the moving grounds a person may choose, and
reduced motion holds each on a still frame. Running state has a textual or shape
distinction in addition to motion. `prefers-reduced-motion` and the persisted
reduced-motion setting disable transitions and animations without removing state
information.

**Overlays** arrive and leave one way, declared once (`components.css`, Overlay
motion): a menu, a context menu, a select or combobox list, a popover, a tooltip,
a hover card, a dialog, Settings' sheet, and the scrim under a dialog or a sheet.
Each fades in over 150ms and out over 100ms: nobody waits for a thing to leave. A
popup settles from 98% at the point it is anchored to and a dialog from 98% about
its centre; the sheet rises 8px instead, since a surface that size reads a scale
as a zoom. Only opacity, scale and translate change, on the overlay alone, so
nothing behind it is laid out again, and no overlay rests on a scale of its own.
A tooltip or hover card the library closes at once, on a press of its trigger, does
not fade over what the press opened. Under reduced motion, from the system or from
the setting, there is no transition at all: an overlay is there or it is not. A
recipe carries no arrival or departure classes of its own. A dialog that a
feature renders only while it is open arrives the same way (`@starting-style`)
and leaves through [OctantDialogPresence](#octantdialogpresence).

**Press and selection.** A press darkens a control's fill and moves nothing: no
sink, no scale, on any control. Words in the chrome do not select when the pointer
drags across them, controls keep the arrow cursor, a disabled control keeps it
too, and the hand is for a real link. A disabled control is drawn at one shared
opacity, `--oct-disabled-opacity` (0.75), so its label stays at 3:1 or more in
both modes while it still reads as unavailable: no hover fill, no pointer events.
A select's chevron is not dimmed while the select is enabled. Pictures and links
do not lift off as drag ghosts. Reading matter opts back in, so a message, a
diff, a value, and an error can still be copied.

### Focus

Keyboard focus draws one indicator, declared once in `octant.css`: a 2px inset
outline (`outline-offset: -2px`) in `--oct-focus-edge`, the foreground at 62%, so
it holds about 4.5:1 or better against the control's fill and the surface around
it in both schemes, and it follows the control's own radius. It is
`:focus-visible` only, and it shows only while a person is moving focus by
keyboard (`data-octant-input`): a pointer press paints nothing, and a dialog
handing focus back to its trigger paints no ring after a pointer press. In
pointer modality a focused field shows its caret and a brighter border
(`--octant-border-strong`). The indicator is never the hover fill, so focus and
pointer read as different states. A control filled with the accent (the default
button, a checked switch, a checked checkbox) inverts it to
`--oct-focus-edge-on-accent`; an SVG mark or inline text link moves it just
outside itself. A container that only holds the keyboard (menu, dialog, listbox,
preview card) shows no edge; the item inside it does, and menu items keep their
highlighted fill. A text field set inside a frame that is itself the field (the
composer, an inline search) shows its caret inside that frame; the composer frame
draws no focus edge. Recipes paint no focus ring, halo or second outline. Feature
CSS never suppresses, recolours, or adds a second ring, and the
`--octant-focus-ring` theme role is never painted as the indicator.

### Accessibility

- Normal text targets 4.5:1 contrast; large text 3:1; non-text marks 3:1.
- Status, diff, provider, and activity states always include text, shape,
  pattern, or an accessible label in addition to colour.
- Pointer targets are at least 24px on desktop and 44px on touch.
- Keyboard users can reach every primary action, open and dismiss every overlay,
  navigate menus and selects, and recover focus after closing a popover or
  dialog.
- A control that opens a panel moves focus into it, and a control that is
  replaced by what it did hands focus to the next logical control instead of
  letting it fall to the page: a Tools tile focuses the tool it opened, applying
  a working folder returns to its Working folder row (to the failure, when the
  re-read fails) and cancelling returns to Change working folder, and Check and
  add focuses the result's heading as every other Add endpoint step does.
- A menu opened from the keyboard starts on its current choice, not its first
  item; ArrowUp still opens on the last item. A group of radios is one set of
  choices: the arrow keys move to the neighbour and select it, wrap past either
  end, and Home and End jump to the ends (`moveWithinRadioGroup` in
  `ui/base/radioGroupKeys.ts`). A resize separator takes Home for its minimum and
  End for its maximum as well as the arrows.
- Tab order follows reading order from the left: the navigation sidebar comes
  before the window chrome, so the first Tab stop on load is never the controls
  at the right edge. A live region that holds text and a button keeps a space
  between them, so assistive technology does not read the two as one word.
- A surface that takes Tab and Escape for its own use is never a keyboard trap;
  it offers one documented way out (the terminal's is in
  [Workspace: Terminal keyboard exit](docs/design/workspace.md#terminal-keyboard-exit)).
- Every app-owned form declares `noValidate`; Octant owns validation copy, field
  association, focus, and recovery instead of browser-specific bubbles.
- Loading, unavailable, stale, denied, empty, and error states keep stable
  geometry and explain the next action. Never turn a refused server command into
  a silent no-op.
- Increased contrast is one state with two triggers: the Appearance setting or
  the system's `prefers-contrast: more`. `ThemeSettingsProvider` publishes either
  as `data-octant-increased-contrast="true"` on the root, and every high-contrast
  rule keys off that attribute rather than the media query, so both triggers draw
  the same rules: the text roles take their `--octant-text-*-high-contrast`
  values and hairlines step up to `--octant-border-strong`. Script that adapts to
  contrast reads `useIncreasedContrast()`, not the media query.
- Theme, typography, density, translucency, contrast, and reduced-motion settings
  are persisted through the server-authoritative journal and applied through the
  providers. Renderer state is presentation only.
- Every product-owned scroll surface inherits one scrollbar, declared once in
  `styles.css`: a thin thumb in a theme token and no painted track, in a pane, a
  menu, a popup and a sheet alike, with a forced-colors fallback. Where the system
  floats scrollbars over content the thumb floats; where it keeps a strip for
  them the strip is clear. The two standard properties are the rule; the
  `::-webkit-scrollbar` parts beside them speak only for an engine that does not
  know the properties. Feature CSS may reserve the strip (`scrollbar-gutter`) so a
  page does not shift when it starts to scroll, and hides a scrollbar only on the
  named strips of tabs and icons that scroll sideways; it never sets a scrollbar
  colour or another width. The code editor and the terminal draw their own; see
  [Workspace: Code editor and terminal scrollbars](docs/design/workspace.md#code-editor-and-terminal-scrollbars).

### Layers

Layers are tokens. Page chrome stays at or below `--oct-z-overlay` (40); sticky
parts of a page use `--oct-z-sticky` (20). Dialogs and sheets with their
backdrops stand at `--oct-z-floating` (50), a notice at `--oct-z-toast` (55), and
everything a person opens to aim at (menus, context menus, popovers, selects,
comboboxes, tooltips, hover cards) at `--oct-z-popup` (60). A notice sits above a
dialog or sheet because under its backdrop it could be neither read nor
dismissed, and under a popup because a notice once covered an open menu and took
the clicks meant for its items. A menu or popover opened inside a dialog or the
narrow dock sheet appears above it, and Escape closes the innermost surface
first. A new surface takes one of these tokens, never a number of its own, and
nothing in the workspace goes above z-index 7.

### Breakpoints

The shell has two breakpoints, both `max-width` queries, so each names the widest
viewport its behavior applies to:

| At or below | Source                                                     | What changes                                                                                                                                                                                                                                     |
| ----------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 960px       | `useNarrowViewport` (`useShellPresentation.ts`), shell.css | The right dock opens as one narrow modal sheet over the page (a titled dialog, no resize handle, Escape closes it and returns focus) instead of a column; the bottom panel is unavailable; the sidebar stops resizing; Settings uses its drawer. |
| 680px       | `useSidebarDrawerViewport`, shell.css (`min-width: 681px`) | The workspace sidebar becomes an overlay drawer, the window frame goes flat, and pane headers drop the Project step of their breadcrumb.                                                                                                         |

Inside a surface, layouts reflow at component breakpoints rather than shell ones:
`--oct-bp-lg` 920px (two-to-four column grids and the Project overview gutter),
`--oct-bp-md` 720px (Settings fact lists and gutters, issue rows), and
`--oct-bp-sm` 560px (start-screen tiles and cards to one column, compact Settings
title bars, 44px Project rows and always-visible thread row actions). Other widths
in feature stylesheets are local to that surface. The mobile app has a separate
design system under `apps/mobile/design-system`.

## Components

Feature code imports the adapters in `apps/web/src/ui/base`, never
`ui/shadcn` or `@base-ui/react` directly. The adapters wrap owned recipes in
`apps/web/src/ui/shadcn`, which follow the Base UI-native shadcn `nova` style and
its denser controls, except that recipes paint no focus ring, halo or second
outline (the global `:focus-visible` rule is the only keyboard focus treatment)
and the badge and the card keep the shape and elevation set here. A recipe's
heading (a card's or popover's title) takes the recipe's own type role: the
page's bare `h1` to `h4` defaults sit in the base layer, below every utility, so
they size reading content and never a component. A recipe styles the state
attribute the installed Base UI part writes (a selected tab is `data-active`, a
pressed toggle `data-pressed`, a checked switch `data-checked`), never one it
invents. Use `cn()` for conditional classes, semantic Tailwind tokens
(`bg-primary`, `text-muted-foreground`, `border-border`), `size-*` for equal
dimensions, and `truncate` for clipping. Feature classes position; recipe classes
paint. Every adapter that renders a control adds `window-no-drag`.

Each entry below gives the adapter's purpose, anatomy, sizes and tokens, states,
keyboard and accessibility, what to do and not do, and where it is in the
gallery. Values are at the default 13px interface size.

### Component gallery

A development-only gallery draws the system in one place: the type roles with
the size, weight and leading the browser computes for them, the semantic colour
roles, the spacing and radius tokens, the icon scale, every shared `Octant*`
adapter in its variants, sizes and states, and a few patterns composed only from
those pieces (a sidebar slice, a Settings row group, a card, an empty state, the
title band's buttons). It mounts the real adapters under the real stylesheet
entry and the real theme provider, with no host, thread or server behind it, so
what it shows is what the app ships. It has controls for dark and light, the
glass material, and the interface size. Read it to judge whether controls,
fields, menus and rows agree before a change to any of them.

The gallery is `apps/web/component-gallery.html` with its source in
`apps/web/src/gallery/`. Its sections, in order: Type roles, Colour roles,
Spacing scale, Radii, Icon sizes and stroke, Buttons, Icon button, Fields and
toggles, Labels, tabs and segments, Menu, select and combobox, Popover, tooltip
and preview card, Dialog, sheet, notice and toast, and Composed patterns. The
page is not an input of the production build, so it is served by the Vite dev
server only (`/component-gallery.html`) and is absent from the packaged app. It
is not a product surface: it has no entry in navigation, Settings or the command
palette. A new shared adapter in `apps/web/src/ui/base/` must appear in it, or be
named in the test's not-shown list with a reason; `Gallery.test.tsx` fails
otherwise.

### OctantButton and OctantIconButton

**Purpose.** Every button. `octantButtonClassName({ variant, size })` gives the
same paint to a trigger another adapter renders.
**Anatomy.** Variants `default` (primary), `solid`, `secondary`, `outline`,
`ghost`, `destructive`, `link`, `bare`, `rail`, and `chip`; sizes `xs`, `sm`,
`default`, `lg`, `icon`, `icon-xs`, `icon-sm`. `OctantIconButton` takes a
required `label` (its accessible name and title) and is the ghost `icon` size.
**Sizes and tokens.** `xs` 20, `sm` 24, `default` 28, `lg` 32; `icon-xs` 20,
`icon-sm` 24, `icon` 28 square. Corner `--oct-radius-sm`; 8px inline padding
(4px on the side of a `data-icon` glyph), 4px gap; label 14/500, 12px on `xs` and
`sm`; icons 12 on `xs`, 14 on `sm`, 16 otherwise. `default` is the accent with
`--octant-accent-sheen` and `--octant-shadow-primary`; `solid` is the primary
text as a fill with the page colour on it, for the one action a surface is for
where the accent would compete with the content beside it; `secondary` is the
control fill; `outline` rests on `--octant-outline-rest` (the page colour unless
the shell names another) with the border; all four take
`--octant-shadow-control`. `destructive` is a tonal fill (the danger role at
10%), not a solid one: a red slab reads as the page's subject rather than one
action on it. `chip` is a 24px outlined chip in the muted ink. `bare` and `rail`
draw nothing; `rail` also has no border, so the icon rail's button is exactly its
32px face.
**States.** Hover lightens or fills (`ghost` and `outline` take the control
hover fill); a press darkens the fill and sinks the shadow to
`--octant-shadow-control-pressed`, and moves nothing. `aria-expanded` and keyboard
focus fill `ghost` and `outline`. Disabled is 0.75 opacity with no pointer events;
`aria-invalid` takes the danger border.
**Keyboard and accessibility.** A native button. An icon-only button always has
an accessible label and a tooltip or title.
**Do and do not.** A button shaped like a card (a count tile, a rail entry, a live
card) asks for `bare` and the feature stylesheet owns its face; every other
button keeps the recipe's paint. A row of suggestions to type or pick takes
`chip`. A standalone icon-only control has two sizes and nothing between: the
28px rail button (`OctantIconButton`, `--oct-rail-button-h`) in a title band,
panel head, or toolbar, and a 24px square for an action inside a row; the
recipe's `icon` sizes drift with the interface size, so a panel control takes
`OctantIconButton`. Only a control that floats over content, such as the
terminal's actions button, keeps a fill and an edge. Do not repaint a button from
a feature stylesheet; pick a variant.
**Gallery.** Buttons; Icon button; Composed patterns.

### OctantBadge

**Purpose.** A compact status label.
**Anatomy.** A `span` with variants `default`, `secondary` (the default),
`destructive`, `outline`, `dashed`, `success`, and `warning`.
**Sizes and tokens.** 16px tall, 8px inline padding, 4px gap, 12/500, 12px icons;
round ends. `success` and `warning` use the status surface and text roles;
`outline` and `dashed` draw the border.
**States.** `aria-invalid` takes the danger border.
**Keyboard and accessibility.** No role; the words carry the state.
**Do and do not.** A one-off kind beside its recurring siblings takes `dashed`.
Use Badge for status labels rather than a styled span. Never let its colour stand
alone.
**Gallery.** Labels, tabs and segments.

### OctantCard

**Purpose.** A raised section for a discrete object or a grouped form.
**Anatomy.** `OctantCard`, `OctantCardHeader`, `OctantCardTitle`,
`OctantCardDescription`, `OctantCardContent`, `OctantCardFooter`; variant
`default` or `glass` (the glass material is defined in `octant.css`).
**Sizes and tokens.** Corner `--oct-radius-md`, 12px vertical and inline padding,
12px between parts; `bg-card` with `--octant-shadow-xs`. Title 15/500, snug;
description 14px muted.
**States.** Forced colours draw a 1px outline; increased contrast a ring in the
strong border.
**Keyboard and accessibility.** Real `section`, `header`, `h2`, `p`, and `footer`
elements.
**Do and do not.** Use the complete composition (Header, Title, Description,
Content, Footer). Use it only for an object a person acts on as a whole; plain
lists, empty states, and headers are never cards, and navigation lists use
compact rows and `OctantSeparator`.
**Gallery.** Dialog, sheet, notice and toast (default and glass).

### OctantCheckbox

**Purpose.** A checkbox, as a styled native input so a wrapping label names it.
**Anatomy.** `OctantCheckbox` (all input props but `type`).
**Sizes and tokens.** 14px square, `--oct-radius-sm`, 1px
`--octant-divider-strong` edge unchecked; checked fills with the primary and
draws a tick in `--primary-foreground`.
**States.** Checked, disabled (0.75), `aria-invalid`. A checked box's focus edge
is `--oct-focus-edge-on-accent`.
**Keyboard and accessibility.** Native checkbox semantics; Space toggles.
**Do and do not.** Put it inside its label or name it with `aria-label`. For two to
seven exclusive choices use `OctantToggleGroup` instead.
**Gallery.** Fields and toggles.

### OctantCombobox

**Purpose.** A searchable choice from a bounded list.
**Anatomy.** Re-exports the recipe's parts: Combobox, InputGroup, Input,
Trigger, Portal, Positioner, Popup, Empty, List, Item, ItemIndicator.
**Sizes and tokens.** The input group is 28px with the field paint and
`--oct-radius-sm`; its trigger is 24px with a 16px glyph. The popup is at most
320px tall, `--oct-radius-md`, 4px padding, `--octant-shadow-overlay`, at
`--oct-z-popup`, and as wide as its anchor. Items are the shared
[menu row](#menus); the indicator is 16px at the row's end.
**States.** A highlighted item takes the hover fill; disabled is 0.75; the group's
border brightens on focus in pointer modality, and the keyboard edge shows
otherwise. The frame draws no focus ring of its own.
**Keyboard and accessibility.** Base UI's `combobox` and `listbox` roles; arrows
move, Enter picks, Escape closes.
**Do and do not.** Use it, or `OctantSelectField`, for searchable or bounded
choices, never a custom dropdown.
**Gallery.** Menu, select and combobox.

### OctantConfirmDialog

**Purpose.** An ordinary confirmation: usage reset and retention, Git discard,
remote administration, Settings connection removal, device-key rotation.
**Anatomy.** Props `title`, body, `details`, `confirmLabel`, `cancelLabel`
("Cancel" by default), `destructive`, `pending`, `confirmDisabled`,
`restoreFocus`, `onCancel`, `onConfirm`; built on `OctantDialog`.
**Sizes and tokens.** Title 17/600 at 1.35; description 14px muted at 1.5; the
answers sit in one row at the trailing edge, 8px apart and 16px under the body:
Cancel as an outline button first, then the confirm answer filled (or
`destructive`), both at the default 28px.
**States.** `pending` disables both answers and ignores Escape and backdrop
dismissal.
**Keyboard and accessibility.** Labelled by its title and described by its body.
Initial focus is on Cancel; Escape, Cancel, and backdrop dismissal change no
data, and closing returns focus to the opener.
**Do and do not.** Destructive actions opt into the danger treatment explicitly;
ordinary confirmations use the standard action. Long paths wrap within the
dialog. The confirmation never replaces the host's approvals, receipts, and
observed-state checks. Rules for the frame are in
[Dialogs and sheets](#dialogs-and-sheets).
**Gallery.** Not shown live (modal and portalled); a button in Dialog, sheet,
notice and toast opens it.

### OctantContextMenu

**Purpose.** The same items as an action menu, opened from the context-menu
gesture (right click, the menu key, Shift+F10).
**Anatomy.** `OctantContextMenu` takes `items` (label, value, description, icon,
disabled), `onValueChange`, the trigger as children, and `triggerClassName`; the
compound parts `OctantContextMenuRoot`, `Trigger`, `Content`, `Group`, `Label`,
`Item`, `CheckboxItem`, `Separator`, `Sub`, `SubTrigger`, and `SubContent` build
a custom one.
**Sizes and tokens.** The popup is at least 12rem wide, `--oct-radius-md`, 4px
padding, the floating fill and `--octant-shadow-overlay`, at `--oct-z-popup`.
Rows are the shared [menu row](#menus); the check and submenu chevron are 14px.
**States.** No items opens nothing. A highlighted row takes the hover fill;
disabled is 0.75.
**Keyboard and accessibility.** The trigger carries `aria-haspopup="menu"` and the
adapter sets `aria-expanded`. An item's name is its label alone, with its
description as `aria-describedby`. In the desktop app the menu is the operating
system's own ([Native menus](#menus)), at the pointer, and focus returns to the
trigger before the action runs.
**Do and do not.** Project and split-workspace context menus use this adapter; do
not add a direct primitive import. Right click mirrors available actions but is
never the only route to an essential action.
**Gallery.** Menu, select and combobox; the compound parts are in the not-shown
list (they open only at the pointer).

### OctantDialog

**Purpose.** A modal dialog.
**Anatomy.** Props `open`, `onClose`, `label`, `labelledBy`, `describedBy`,
`className`, `initialFocus`, `restoreFocus`, `popupId`; classes
`octant-dialog__backdrop`, `__viewport`, `__popup`, and `octant-dialog__title`.
**Sizes and tokens.** 420px wide by default (`--octant-dialog-width`), at most
640px tall (`--octant-dialog-height`), each capped at the viewport less 48px;
16px content inset; `--oct-radius-md`; the page fill, a 1px strong border, and
`--octant-shadow-overlay`; a scrim backdrop; viewport padding 24px; at
`--oct-z-floating`.
**States.** While it leaves, its backdrop and popup are `inert`.
**Keyboard and accessibility.** Modal; Escape and an outside press call `onClose`.
With a visible heading it is labelled through `labelledBy`; without one it renders
a visually hidden title from `label`. Do not add a second visible header. Focus
returns to the opener as the exit starts (`useLeavingFocus`).
**Do and do not.** Use `OctantDialog` with a real label even when the title is
visually hidden. A dialog wider than the default says so with
`--octant-dialog-width`, never with a width of its own. A non-modal glass panel
anchored in its surface (Zen's thread picker, assistant, and add and appearance
panels) is not a dialog. See [Dialogs and sheets](#dialogs-and-sheets).
**Gallery.** Not shown live (modal and portalled); a static copy of its classes
is in Dialog, sheet, notice and toast.

### OctantDialogPresence

**Purpose.** Keeps a dialog a feature renders only while it is open mounted
through its exit, so it can leave the way every overlay does.
**Anatomy.** A wrapper with a `DialogPresenceContext` (`open`, `hold()`); it draws
nothing.
**Behavior.** A stylesheet cannot hold an element that is gone, so a surface
leaves only while it stays mounted and is told it has closed. Presence keeps the
last thing the feature rendered until the exit has finished and tells the dialog
inside it that it has closed: a confirmation still names what it asked about
after the feature has cleared that state, and the command palette keeps the rows
it showed. Settings' sheet and a dialog with an `open` of its own do this
themselves, and such a dialog keeps `open` apart from what it shows: one whose
words come from the state closing clears (a review, a comparison, Rewind) is
rendered only while that state exists. Every confirmation, the command palette,
the Code file search, the Navigator, the narrow dock, first run and the other
dialogs a feature mounts on demand leave this way. Two cases leave at once: a
dialog whose owner goes with it (a row removed by the confirmation it showed),
and one of two dialogs that share a presence when the other takes its place. In a
window nobody can see there is no exit to show, so a dialog closed there is
removed at once.
**Keyboard and accessibility.** A leaving dialog's scrim and controls take no
press and no key (`inert`), so the page under it answers at once and a second
press cannot repeat what the first did. Focus goes back to the opener as the exit
starts, and when the exit ends focus stays where it is if the person, or a
command they ran from it, moved it in the meantime.
**Gallery.** Not shown (it draws nothing).

### OctantEmpty

**Purpose.** An empty, connection, or error state inside a pane or panel.
**Anatomy.** Props `title`, `message`, `eyebrow`, `icon`, `action`, `role`
(`alert` or `status`); parts Root, Header, Content, Description, Eyebrow, Media,
Title.
**Sizes and tokens.** At most 480px wide, 16px padding, 8px gaps,
`--oct-radius-md`, the card fill and `--octant-shadow-sm`. The mark is a 24px
neutral tile; eyebrow 12px muted; title 15/600; message 13px muted.
**States.** One tone: the mark is neutral whatever went wrong.
**Keyboard and accessibility.** The title is a level-2 heading; the caller sets
`role` when the state is a live region.
**Do and do not.** Use Empty for empty states; do not recreate one with styled
spans. A page's own empty state follows [Page shell](#page-shell); a state that is
the whole window is `ShellState` ([Empty, loading, and whole-window states](#empty-loading-and-whole-window-states)).
**Gallery.** Composed patterns.

### OctantField

**Purpose.** Form layout that keeps labels, descriptions, and errors associated
with their controls.
**Anatomy.** `OctantFieldGroup`, `OctantField`, `OctantFieldLabel`,
`OctantFieldDescription`, `OctantFieldError`.
**Sizes and tokens.** A group stacks fields 12px apart; a field stacks its parts
4px apart; label 14/500; description 14px muted; error 14px in the danger ink.
**States.** Invalid uses `data-invalid` and `aria-invalid`; a disabled field is
0.75.
**Keyboard and accessibility.** The error is `role="alert"` and stays by its
field.
**Do and do not.** Use these for every form; a warning the person must review
stays inline, never only in a toast.
**Gallery.** Composed patterns.

### OctantInput

**Purpose.** A single-line text field.
**Anatomy.** All input props, plus `unstyled`.
**Sizes and tokens.** 28px, 8px inline padding, `--oct-radius-sm`, the field paint
from `ui/shadcn/field-paint.ts`: the strong border (`--input`) and no fill at
rest. Type is 15px under the `md` breakpoint and 14px from it; placeholder muted.
**States.** Hover takes the muted-text border; keyboard focus takes the control
hover fill; pointer focus brightens the border; invalid keeps its danger border
in every state; disabled is 0.75.
**Keyboard and accessibility.** A native input; the global focus edge for
keyboard.
**Do and do not.** A feature's stylesheet lays a field out (width, height, type
size) and never repaints it, so inputs, text areas, and selects react alike in
light and dark. A field whose frame a feature draws (a search box inside a
toolbar, a stepper's middle segment) passes `unstyled`. A search or name field a
feature draws for itself still takes its edge from the strong border, not from
the hairline or a control fill.
**Gallery.** Fields and toggles; Composed patterns.

### OctantMenu

**Purpose.** A dropdown menu of radio choices (the default) or actions.
**Anatomy.** Props `items` (label, value, description, icon, disabled), `actions`
(label, icon, onSelect, disabled), `value`, `onValueChange`, `trigger`,
`triggerLabel`, `triggerClassName`, `triggerDisabled`, `triggerTitle`,
`selectionMode` (`radio` or `action`); compound parts `OctantMenuRoot`,
`Trigger`, `Portal`, `Positioner`, `Popup`, `Group`, `GroupLabel`, `Item`,
`CheckboxItem`, `RadioGroup`, `RadioItem`, `Separator`, `Sub`, `SubPopup`,
`SubTrigger`.
**Sizes and tokens.** The popup is at least 12rem wide, `--oct-radius-md`, 4px
padding, the frosted float fill and `--octant-shadow-pop`, 4px below its trigger,
at `--oct-z-popup`. Rows are the shared [menu row](#menus); a group label is 24px
in the Navigation group label role; a separator is one hairline with 4px above
and below; the check is 14px.
**States.** A highlighted row takes the hover fill; a chosen radio carries a
check, never a fill; disabled is 0.75.
**Keyboard and accessibility.** Opened from the keyboard it starts on the current
choice; an item's name is its label, with its description as
`aria-describedby`; a pick closes the menu and returns focus to the trigger. In
the desktop app the menu is the operating system's own ([Native menus](#menus)).
**Do and do not.** A feature stylesheet may colour a menu's icons but gives its
rows no height, gap, padding, or font size.
**Gallery.** Menu, select and combobox (radio and action); the radio, submenu and
sub-trigger parts are in the not-shown list.

### OctantMenuIconSlot

**Purpose.** The empty 16px icon column for a hand-built menu row that has no
icon, so a menu where any row has an icon keeps one text edge.
**Anatomy.** An `aria-hidden` span, `--oct-icon-md` square.
**Gallery.** Menu, select and combobox.

### OctantNumberStepper

**Purpose.** A number with minus and plus.
**Anatomy.** Props `label`, `value`, `min`, `max`, `step` (1), `suffix`,
`onChange`.
**Sizes and tokens.** 28px with the field paint, `--oct-radius-sm`, and
`--octant-shadow-xs`; 30px ghost buttons at both ends with 14px glyphs; the
middle input is `unstyled`, 14px, centred, with the value and its suffix (12px
muted) in one column so steppers with and without a unit are one width.
**States.** The whole stepper takes the control hover fill while focus is inside
it; a button is disabled at its bound. Blur commits and clamps; typing commits
only an in-range value.
**Keyboard and accessibility.** "Decrease {label}" and "Increase {label}"; the
input is a native number field named by `label`.
**Gallery.** Fields and toggles.

### OctantPopover

**Purpose.** A controlled popover opened from a button.
**Anatomy.** Props `open`, `onOpenChange`, `trigger`, `triggerLabel`,
`triggerVariant` (`ghost`, `ghost-icon`, `outline`), `triggerTooltip`,
`triggerAriaPressed`, `triggerDescribedBy`, `triggerDataAttributes`,
`triggerDisabled`, `triggerClassName`, `title`, `titledBy`, `description`,
`side`, `align`, `sideOffset` (4), `collisionAvoidance`.
**Sizes and tokens.** `--oct-radius-md`, 8px padding, 14px type, the floating
fill and `--octant-shadow-overlay`, at `--oct-z-popup`. The trigger is a button
variant (`ghost-icon` is the 28px icon button).
**Keyboard and accessibility.** The trigger carries `aria-expanded` and, when
given, `aria-pressed`; the popup is labelled by `titledBy` or a visually hidden
`title`. Escape closes it and returns focus.
**Do and do not.** Searchable pickers and popovers with embedded controls stay
renderer surfaces in the desktop app. The composer's popups follow
[Composer popups](#composer-popups).
**Gallery.** Popover, tooltip and preview card.

### OctantPreviewCard

**Purpose.** A delayed, non-modal card the pointer can enter and press; not a
tooltip.
**Anatomy.** Props: the trigger as children, `content`, `label`, `side`
(bottom), `align` (centre).
**Sizes and tokens.** At most 320px wide, 12px padding, `--oct-radius-md`,
`--octant-float` and `--octant-shadow-overlay`, 8px from its trigger, at
`--oct-z-popup`. It opens after 350ms and closes 150ms after the pointer leaves.
**States.** Held closed while a native menu is open.
**Keyboard and accessibility.** `role="group"` named by `label`; the card itself
shows no focus edge.
**Gallery.** Popover, tooltip and preview card.

### OctantSelectField

**Purpose.** A select for forms and filters.
**Anatomy.** Props `options` (id, label, disabled, disabledReason, group),
`value` or `defaultValue`, `onValueChange`, `placeholder`, `name`, `id`,
`aria-label`, `className`, `triggerClassName`; parts `OctantSelectRoot`, `Group`,
`GroupLabel`, `Item`, `Popup`, `Portal`, `Positioner`, `Trigger`, `Value`. The
empty value is encoded as `octant-select:empty`.
**Sizes and tokens.** The trigger is 28px with the field paint, 8px gap, 14px
type, and a 12px chevron that is not dimmed while the select is enabled. The
popup is at most 18rem tall, at least its trigger's width, `--oct-radius-md`, 4px
padding, `--octant-shadow-overlay`, 4px from its trigger, at `--oct-z-popup`.
Items are the shared [menu row](#menus) with room at the end for a 14px check.
**States.** The field states of `OctantInput`; a highlighted item; disabled items
carry their reason.
**Keyboard and accessibility.** Base UI select semantics; the list opens beside
its trigger without covering it with the selected item. A form reset restores
it, and `name` writes a hidden input. In the desktop app it renders an
`OctantMenu` radio list behind a field-painted trigger, so the list is the
operating system's own.
**Do and do not.** Use it for bounded choices and filters; 2 to 7 choices that
should stay visible take `OctantToggleGroup`. Composer-row selects drop the field
chrome; feature CSS does not repaint them a third time.
**Gallery.** Fields and toggles; the open list in Menu, select and combobox; the
group parts are in the not-shown list.

### OctantSeparator

**Purpose.** A hairline between groups.
**Anatomy.** `OctantSeparator` (horizontal or vertical) and
`OctantSeparatorWithLabel`.
**Sizes and tokens.** 1px in the border role; the labelled form is two rules with
12px muted text between them, 8px apart.
**Keyboard and accessibility.** `role="separator"`.
**Do and do not.** Separate with a hairline or select with a fill, never both.
**Gallery.** Labels, tabs and segments.

### OctantSheet

**Purpose.** A page-sized floating surface over the window, with the app live
behind it (Settings).
**Anatomy.** Props `open`, `onClose`, `label`, `className`, `initialFocus`,
`restoreFocus`.
**Sizes and tokens.** At most 1040 by 760px, no padding, `--octant-float`, a 1px
`--octant-bevel` edge, `--oct-radius-md`, and `--octant-shadow-pop`, over a light
scrim (the scrim role at 34%) through which the window stays drawn; viewport
padding 48px above and 32px at the sides and below; at `--oct-z-floating`.
**States.** It rises 8px as it arrives and leaves; while leaving it is `inert`.
**Keyboard and accessibility.** Modal, with a visually hidden title from `label`;
Escape, its close control, and a press on the window behind close it, and focus
returns to where it was.
**Do and do not.** Settings' use of it is in [Settings](docs/design/settings.md#settings-sheet).
**Gallery.** Not shown live (modal and portalled); a button in Dialog, sheet,
notice and toast opens it.

### OctantSlider

**Purpose.** A range input.
**Anatomy.** A native range input (`octant-slider`).
**Sizes and tokens.** A 4px round track in the strong divider role, a theme role
held to 3:1 against the workspace, so the track is found on a card in dark and in
light; a 14px round thumb in the primary with a 2px page-colour ring carries the
value.
**States.** Disabled is 0.75; the cursor is a grab while dragging.
**Keyboard and accessibility.** Native range keys.
**Gallery.** Fields and toggles.

### OctantSwitch

**Purpose.** An on/off setting that saves immediately.
**Anatomy.** Props `checked`, `onCheckedChange`, `label`, `describedBy`,
`disabled`, `disabledReason`.
**Sizes and tokens.** A 38 by 22px round track in the control fill with a 1px
strong divider edge and a 16px round thumb in the page colour; on, the track and
its edge take the accent. The thumb travels over `--oct-motion-base`.
**States.** `data-checked`; an unchecked switch takes the control hover fill under
keyboard focus, and a checked one the on-accent focus edge; disabled is 0.75 and
names its reason as its description and title.
**Keyboard and accessibility.** `role="switch"`, named by `label`; Space toggles.
**Do and do not.** A switch that sends something off this computer carries the
fact a person must know as its section's description, above the switch
([Settings layout](#settings-layout)).
**Gallery.** Fields and toggles; Composed patterns.

### OctantTabs

**Purpose.** True page tabs: a flat rail with a selected fill and tab semantics.
**Anatomy.** `OctantTabs`, `OctantTabsList`, `OctantTabsTab`, `OctantTabsPanel`.
**Sizes and tokens.** The list is 28px with 4px between tabs; a tab is 24px, 8px
inline padding, `--oct-radius-sm`, 14/500; the panel starts 8px under the list.
**States.** Hover takes a light fill and the primary ink; `data-active` takes the
control fill and the primary ink; disabled is 0.75.
**Keyboard and accessibility.** `tablist`, `tab`, and `tabpanel` roles; the arrow
keys move between tabs.
**Do and do not.** See [Tabs and segmented choices](#tabs-and-segmented-choices).
**Gallery.** Labels, tabs and segments.

### OctantTextarea

**Purpose.** A multi-line text field.
**Anatomy.** All textarea props, plus `unstyled`.
**Sizes and tokens.** At least 52px tall, 8px padding, the field paint and type of
`OctantInput`; it grows with its content and does not resize by hand.
**States.** As `OctantInput`.
**Keyboard and accessibility.** A native textarea.
**Do and do not.** The composer prompt is frameless: given `composer-input` the
textarea drops the field recipe (border, corner, fill, shadow, ring), and
`.composer-input` in `octant.css` owns its 12px padding, its one-line 44px
minimum, its 180px maximum, and its placeholder in the meta ink. Feature CSS does
not repaint it a third time.
**Gallery.** Fields and toggles.

### OctantToast

**Purpose.** A product notice: a transient acknowledgement or a failure to
notice.
**Anatomy.** Props `title`, `detail`, `tone` (neutral, success, warning,
danger), `action` (label, onSelect), `onDismiss`.
**Sizes and tokens.** 12px padding, 8px gap, `--oct-radius-md`, `--octant-float`
and `--octant-shadow-overlay`; a 16px semantic icon; the title 14/500 on a 24px
line so the icon, the title and the dismiss glyph share a centre; detail 13px
muted; Dismiss is a 24px icon button with a 14px glyph whose box ends on the
toast's 12px padding. An inline action is link text, so its line is as tall as the
others. The stack (`.toast-stack`) is fixed at the top trailing corner, 12px under
the 44px title rail and 16px from the edge, at most 380px wide, at
`--oct-z-toast`.
**States.** Long filenames and messages wrap in both themes.
**Keyboard and accessibility.** `role="alert"` for danger, `status` otherwise;
Dismiss is "Dismiss notification" and reachable by keyboard; an action can open
the relevant destination without dismissing the notice. The stack takes no press
outside its notices.
**Do and do not.** See [Toasts and notices](#toasts-and-notices).
**Gallery.** Dialog, sheet, notice and toast.

### OctantToggleGroup

**Purpose.** The enclosed track for two to seven mutually exclusive values.
**Anatomy.** `OctantToggleGroup` and `OctantToggleGroupItem`, typed by value.
**Sizes and tokens.** A 28px track (2px padding, `--oct-radius-sm`, the muted
fill) holding 24px items (8px inline padding, the corner less the padding, 2px;
14/500 in the secondary ink).
**States.** Hover takes the primary ink; `data-pressed` takes the raised soft fill
and the primary ink; disabled is 0.75.
**Keyboard and accessibility.** Each item is a toggle with `aria-pressed`.
**Do and do not.** Use it for option sets of two to seven choices, not for page
tabs. See [Tabs and segmented choices](#tabs-and-segmented-choices).
**Gallery.** Labels, tabs and segments.

### OctantTooltip

**Purpose.** A short label for a control, or a card of content on hover.
**Anatomy.** Props: the trigger as children, `label`, `side` (bottom), `align`
(centre), `surface` (`inverted` or `card`).
**Sizes and tokens.** Inverted: the primary text as a fill with the surface
colour on it, at most 280px wide, 8 by 12px padding, `--oct-radius-sm`, 14px, no
bevel. Card: at most 320px, 12px padding, `--oct-radius-md`, the surface fill
and overlay elevation. 8px from its trigger, after 350ms, at `--oct-z-popup`.
**States.** It closes on a press of its trigger without fading over what the
press opened.
**Keyboard and accessibility.** `role="tooltip"`; it opens on keyboard focus as
on hover.
**Do and do not.** Never the only place an essential word appears.
**Gallery.** Popover, tooltip and preview card.

### OctantAlert

**Purpose.** An app-owned inline notice: the status mark, tone, live region,
message, optional title, and explicit actions.
**Anatomy.** Props `children`, `title`, `action`, `tone` (neutral, accent,
success, warning, danger), `role`, `label`, `id`.
**Sizes and tokens.** The callout: 20px padding, 16px gap, a 1px border,
`--oct-radius-md`, the surface fill, 14px type in the secondary ink, the title
at 500; a 16px mark. A tone is a tinted ground and hairline, never a stripe. The
mark is neutral ink for the neutral tone, composer notices included; the warning
tone draws it in the warning ink and the danger tone in the danger ink.
**Keyboard and accessibility.** Warning and danger announce as `alert`; neutral,
accent, and success as `status`.
**Do and do not.** Placement belongs to the feature; the callout recipe owns the
appearance. Use Alert for callouts, never a raw `role="alert"`
([Toasts and notices](#toasts-and-notices)).
**Gallery.** Dialog, sheet, notice and toast (every tone).

### OctantApprovalCard

**Purpose.** An inline provider, extension, or Browser permission request in the
thread column.
**Anatomy.** Props `label`, `summary`, `detail`, `context` (before the actions),
`actions`, `error`.
**Sizes and tokens.** The neutral card material: a 1px border,
`--oct-radius-md`, `--octant-card`, 8 by 12px padding, 8 and 12px gaps, 14px at
1.45; a 14px pending mark in the muted ink; detail 13px muted; actions 4px apart
at the trailing edge, wrapping.
**Keyboard and accessibility.** `role="group"` named by `label`; an inline failure
is `role="alert"`.
**Do and do not.** The requesting feature supplies the scope, choices, and
callbacks; the host or server still decides whether an action may proceed. Native
Code approvals keep their isolated host-owned document
([Thread view: Native Code approvals](docs/design/thread-view.md#native-code-approvals)).
**Gallery.** Dialog, sheet, notice and toast.

### Native menus

**Purpose.** `NativeContextMenu` and `NativeDropdownMenu` swap a web menu for the
operating system's own in the desktop app; the web path is unchanged.
**Behavior.** They render the menu's items into a hidden element, read their kind
(item, label, separator, checkbox, radio, submenu), and show the OS menu at the
pointer or anchored to the trigger (left and bottom, or right and top when the
menu opens to that side); a selection clicks the original element. The rules
for native menus are in [Menus](#menus).
**Gallery.** Not in the gallery: they are wrappers, not `Octant*` adapters.

### Helpers

`radioGroupKeys.ts` (`moveWithinRadioGroup`) gives a `radiogroup` its keys: the
arrows move to the neighbour and select it, wrapping, Home and End jump to the
ends, and modified keys and disabled radios are skipped. `useLeavingFocus.ts`
records focus when a dialog or sheet opens and returns it as the exit starts,
unless focus has already moved elsewhere. Neither draws anything.

## Patterns

The pattern sections below are rewritten in the next change.

### Page shell

Every list, board, reader, and preference page is a `Surface`:

```
Surface (reading measure 880px, or wide for boards)
  SurfaceHeader   one toolbar row: Back · title · detail · actions
  surface-toolbar search takes the slack · filters · view switch
  SurfaceSection  section label over a hairline
    surface-row   label + detail on the left, control on the right
  SurfaceEmpty    a quiet icon, one line of text, and a real outline button
                  for the next step; not a card
  SurfaceLoading  the page in outline while it loads: a title bar and rows
```

A destination that is still loading shows its own outline (`SurfaceLoading`):
a skeleton bar where the title will be and a few rows under it, in the frame
the page itself draws in, so nothing changes place when the page arrives. A
line of text in the middle of the pane ("Opening Inbox…") gave way to a title
in the corner, and the pane jumped. The words stay in a `status` region for
assistive technology and are not drawn; the bars are hidden from it. The
skeleton's sheen stops under reduced motion, from the system or from the
setting, and the shape stays. A page's own first read of its data keeps the
state that page already draws.

The header is a window toolbar, not a page heading: one 40px row at the Settings
page title's size (`oct-page-title`, 14px, weight 600). The sidebar row already
named the page, so the header does not describe it. It holds Back, the title,
and actions at the trailing edge: a labelled secondary button for the page's one
creation action ("Add Project", "New artifact") or a Refresh. Its one line of
detail, in the meta ink on the title's line, is only for a fact that changes and
that a person needs: a count ("3 finished threads"), a time zone. A count
belongs there, never in the title. A sentence about what the page is for is not
detail. Filters, including a single Project picker, sit in the toolbar under the
header, never among the actions, and actions that do not fit wrap to a second
row rather than squeezing the title.

The header stays in place while the body scrolls under it. At rest it has no fill,
so the page's ground runs unbroken behind the title; once a row passes beneath it
takes the opaque workspace colour, under Glass too, so a row never reads through. The page's scroller
stops at the title band, so a row never comes out above the header.

A page with nothing on it is the empty state alone under that header, centred
in the room left: no hero and no explanation around it. A page empty state
carries the destination's own sidebar icon at 20px, and its next step (Clear
filters, Add an image profile) is the outline button; a page whose next step
lives in Settings names the page by its rail label. Search, filters and tabs
show only once there is something to search or filter, and a chosen filter stays
as the way out of its own empty result.

Leaving a reader route is always the header's Back: a 28px ghost icon control at
the leading edge, its glyph on the content's left edge, named "Back to
workspace" for assistive technology and as its tooltip. A press shows in the
fill; the control neither sinks nor shrinks. The destination pages the sidebar
and its More menu reach (Inbox, Board, Issues, Linear, Pull requests, Projects,
Agents, Automations, Artifacts, Image generator, Archive, To review) share one
frame: the wide measure, so Back, the title, and the actions sit on the same left
and right edges from page to page. A list there runs the frame's width; a board's
columns may use all of it.
Every Settings page is built from one kit, in `settings/primitives.tsx`:

- **Page header.** Compact, as in a preference window: the selected rail row
  already names the page, and search is always in view. There is no
  breadcrumb above it and no icon tile. The page title is the h1, the only
  heading that names the page, in the page title role every destination uses
  (`.oct-page-title`: the section-label scale, 14px, weight 600, primary ink).
  Under it sits at most one line of
  description in the secondary ink: a longer one ends in an ellipsis with its
  full text as the tooltip, and the page scope follows outside the ellipsis.
  An optional ghost action sits at the far edge (Appearance's "Reset to
  default"). A sub-page (a Harness endpoint, a Provider catalog entry) hides
  the page header and brings its own heading and Back control.
- **On this page.** A page with four sections or more shows one row of plain
  text links to them under the header, in the secondary ink; links that do not
  fit wrap onto a second text line rather than hiding past the edge. A page
  with fewer shows none. They are links,
  not headings, so the page's heading outline is unchanged. Sections register
  themselves with the shell, so one that mounts late joins the row and the row
  never names one that is not drawn.
- **Compact row.** A long list (more than a handful of items: protected paths,
  registered servers, the Library's items) is drawn as one line per item, 36px
  tall and the same height all down the list, with no description: the name,
  a short state in the meta ink, and the one main control at the trailing
  edge (`SettingsCompactRow`). What the item guards or may be asked to do
  stays on the closed line, cut to one line with the full text in the detail:
  a protected group's paths ("Protected · ~/.ssh/id_*, …"), a server's profile
  and deploy-command count ("Operate · 3 deploy commands"). A list whose meta
  names a source that must not be cut off (remembered tool approvals) lets it
  wrap instead. The
  name is a button with `aria-expanded` that opens the row's own detail
  (paths, permissions, a longer sentence, secondary actions) in place; focus
  stays on it. A row that awaits a decision (a protection removed, a server
  that is not connecting, an item awaiting trust) leads its list and is drawn
  in the warning ink. The state is on the line, never only in the detail: a
  switched-on, trusted or protected item reads as such closed.
- **List head and cap.** A list over ten items has its filter field and the
  counts at its head (the Library's search, kind counts and group counts) and
  shows its first eight with "Show all N", but only for items not installed
  (the catalog and what was found): what a person has installed, switched on or
  off, is never capped, and items that await a decision lead.
- **Collapsed section.** Only reference material or an empty section folds
  (`collapse` on `SettingsSection`): its label becomes a button with
  `aria-expanded` and the closed line says what it holds ("None remembered",
  "2 refused, waiting for a decision"). Anything that sets what an agent may
  do (a switch, a trusted place, a protection) stays open as a row, and a
  section holding a remembered approval, a refusal or a removed protection
  starts open. A deep link, a search result or an "On this page" link opens
  the fold that holds its target, then scrolls and focuses.
- **Section.** A 14px label in medium weight, an optional one-line
  description in the secondary ink below it, then one grouped card: the
  `--oct-radius-md` card radius, the raised card's fill (`--octant-card`) and
  its shadow (`--octant-shadow-xs`), which carries the edge. The
  card never clips: a section keeps `overflow: visible` because its rows hold
  menus and popovers, so the first and last row round themselves instead.
  Rows are divided by a hairline inset 16px from the card's edges. A section
  label may carry ghost actions that act on the whole section on its own
  line; a primary never lives in a section head.
- **Row.** At least 52px tall with a 12px by 16px inset: a 14px row label and
  a one-sentence 13px detail on the left, the control at the right edge. A
  compound editor stacks its control under the label. Single-line controls
  stay 28px tall.
- **Saved.** Settings save as you change them. A slot of fixed width at the
  right of the top rail shows a check and "Saved" for about two seconds once
  a change resolves (a shell setting or a theme write), and holds its place
  when empty so nothing shifts. A host that refuses a change shows nothing.
  A Save button exists only for compound forms: a provider's or model
  endpoint's connection details and a sync bucket's connection details. A
  host setting that can be changed elsewhere (the harness model roles) is sent
  with the version it was read at; a refusal says it changed elsewhere,
  inline, and reloads.
- **Said before the switch.** A switch that sends something off this
  computer carries the fact a person must know as its section's description,
  above the switch and named as its description, and stays disabled until it
  has something to send to. Sync is the case: it says the storage provider can
  read the files, which are signed but not encrypted.
- **Destructive.** A page's destructive group (logging out of GitHub,
  disconnecting Linear, purging thread history, revoking paired devices) is
  its own section, last on the page, whose card holds the destructive row
  with the destructive button variant. The danger is carried by the
  placement and the confirm control; the label keeps its ink.
- **Actions.** A Settings action is the secondary button: the quiet control
  fill and no edge, the way a Mac push button is drawn. The page's one main
  action may take the primary button, a quiet or in-row extra the ghost
  button, and the destructive group its own variant. Settings does not use
  the outline button: the same kind of action was drawn filled on one row and
  outlined on the next (62 outlined beside 113 filled), so a page of rows read
  as two unrelated sets of controls.
- **Rail.** Each page keeps its icon (16px) in the navigation rail, and
  Device tools has its own, apart from Computer use. The open page takes the
  same neutral wash of the ink as the open thread in the workspace sidebar,
  never the theme's selection hue.

### Welcome and composer

Every composer has one shape, on a start screen or under a thread, in Chat,
Work, and Code: the same width, corner (`--oct-radius-md`), hairline ring
and mid shadow, the same insets, and the transcript's own type size, so a
message looks the same in the box as in the bubble it becomes. The empty
prompt is one line everywhere and grows as the person types: one line with
12px above and under it is a 44px box, and a longer
message keeps the same corner: the box grows, its corners stay a container's. Its width is the reading measure; in a split every
composer takes the narrowest pane's room, so composers side by side match
instead of each filling its own pane. A start screen's composer docks 12px
above the pane's foot, where a thread's sits, so the two line up across a
split; a start screen's card is the same box, with its row of where-it-runs
chips above it. Nothing about the box changes while a turn runs.
The composer is a box and two quiet lines. The box is the one raised
surface: the raised card's fill, the hairline ring and the mid shadow. The
start row above it and the line under it stand on the page with no fill or
edge, as the figures of the last turn do, so the box is the one thing a
person aims at. Over an application ground the box is the glass surface
(floor, thick tint, blur, and the glass stroke as its ring). Under Window
glass it keeps the blur and the stroke and takes the control tint in place of
the floor: the floor made it darker than the glass around it, a well where a
raised surface should be.
A held thread has no box. (A tray drawn around the rows and the box made
the composer a block three rows tall, with the box inside a box.)
The box holds what acts on the message being written and nothing else: attach
at its leading edge, the prompt, then the microphone and send (with Stop while
a response streams) at its trailing edge, the controls riding the prompt's
last line. They are 28px tiles with the control corner, 8px in from the box's
12px corner, so a control and its box read as one family. Attach is a plus on the quiet
control fill: it adds to the message, by more than one route in the desktop
app. Send is a quiet tile in the control fill until there is something to
send (the fill stays at full strength and only the arrow is dimmed: at half
strength the tile measured 1.07:1 on the page in light and vanished), then
the box's one solid control: the primary text colour as its fill, with the
page colour on it. It is not the accent: a filled accent tile was the
loudest thing on the page under an empty prompt. The microphone is in the
box because it writes into the prompt; in the line under it, it read as a
fact about the thread. A notice is never in the box. What the composer has to
say about its thread or about sending (a refusal, a failure, a status, a hint,
the Project offer, a failed dictation) is the system's callout in a card directly
above the box, in the box's width, and in its tone: the callout's own corner
(12px, as the box's own corner is), 8px between the last card and the box, the
words wrapping and the action at the trailing edge, dropping under the words
in a narrow composer. Each notice is a card of its own, the most severe first
(a refusal or failure, then a warning, then a plain fact), so three notices are
three short rows. A start screen's order from the top is the start row of
chips, the notice cards, the box, the line under it. A card is shown for as
long as its notice applies, so what an agent may do and what a thread read are
never less visible than they were in the box; it takes no focus when it
appears, and in tab order it comes before the prompt. A refusal is an alert and
a status is a status. A card is for something the person must read or act on
and that stays until it is resolved: a refusal, a failure, or an offer with an
action. It is the callout's compact form (the 12px meta step, tight padding,
one line where the text fits, its tone tint, the callout's own hairline) so
the box stays the one strong shape. With nothing of that pending, nothing
stands above the box. The composer is the box and one quiet row under it. A
standing fact about access is not a card: that a thread has read outside content
is a chip in that row, directly after the surface's own icons, a globe and the words
"Outside content" in the warning ink with no fill or edge at rest, shown for as
long as the fact applies. Pressing it opens a popover with the full sentence and
the Review action; in a narrow row (under 560px) the chip keeps the globe and
drops the words, and its name and tooltip keep them. A plain note that stays until the
person acts (a saved-draft sentence saying nothing was sent, a locked task, a
handoff or access note, what a newly picked provider will not carry over, a receipt) is still a card, one for each, wrapping whole,
never cut to a line and never hidden: only a surface marks a state as passing.
A card as heavy as the box, plus two rows under it, read as
four stacked layers for a note that was not an error. Progress that a surface marks as passing by itself
(sending, a response streaming, a provider check, a
session compacting, a first turn being prepared, a keyboard hint) is never a card and never changes the
composer's height: it is one quiet line of meta ink in the transcript's bottom
padding directly above the notice group, leading-aligned with the box, one
message at a time with the newest winning, and no line at all where a control
already says it (the Stop control during a response). A card for each passing
status made the transcript jump about 48px twice a message. The line lives in
one persistent polite status region that stays mounted, is the prompt's
description (why Send is held). Beside a subagents tray the line is clipped from
view and still said. A card that stays is read where it stands and is not
repeated in the region; a pending refusal's card is part of the prompt's description too, so
it is heard again when the prompt takes focus. Over an application ground or under Window glass the card
is the same glass as the box with its tone laid over it, not the callout's
opaque ground beside a translucent box. A tinted bar inside the box fought the
box's corners (a rounded bar in a rounded box, with thin uneven gaps), made the
box a tall lopsided shape, and read as part of the message being typed; with
the cards above it, the empty box is 44px tall in every state, and the
microphone's failure no longer has to be cut to fit beside it. The person's
own attachments and the message queue are not notices and keep their place. **The row under the box.** How the thread runs is one quiet row under the
box, with no fill or edge of its own, 28px high and one spacing token (4px)
below the box, so the space under a composer is the same on a thread, a start
screen, a side chat and a split pane. It repeats the box's columns. Both sides
have the box's own 8px inset. A leading cell as wide as attach (28px) holds the
Project's icon, centred under attach, and the Project's name starts where the
prompt's text does (44px in). The trailing cells are as wide as send (28px): the
context ring is last, centred under send, and the approval control stands under
the microphone where there is one. Measured in a render, the centres and the
text edge agree within half a pixel. Left to right the row holds the Project
control (its icon in the leading cell, then its name; in Code the checkout's
branch, diff and pull-request icon follow it), the surface's own icons (Create
image, Plan, Web research), then, right-aligned, the plan meters where there
are any, the model's name in meta ink with no chevron, the approval mode as one
icon-only button (Full access adds its words), and the context ring. The approval button's accessible name
and tooltip state the mode ("Mode: Ask first"); each mode has its own icon, and
Full access alone keeps its words beside it, in the warning ink (danger without
the sandbox), so it cannot be read as asking first. Labels are the 12px meta step
in the meta ink, icons are 16px, nothing is filled at rest, and the standard
hover fill answers the pointer. A long Project name ends in an ellipsis and
never pushes the right side under it. Where a Work thread names its Project,
the name is the Thread info button: the panel opens above it from its leading
edge, and "Review required" follows the name while a row waits. Chat and Code
keep the small info icon after the Project (a Code checkout has actions of its
own), in the leading cell where there is no Project. The overflow menu is gone:
Mark done and the document-delivery choice are a group of the add menu. Reading
order is visual order. A Work Project made from a folder names that folder once,
not as Project and folder both. At a phone's width the row is two rows, the
Project with Thread info beside it and the controls under them, still on the
same columns, so the ring stays under send. Only the surface's row gives its
controls the row's one quiet treatment; the checkout's actions and the info
panel's fields keep their own. A card as tall as the box plus two rows under it
read as four layers, and the row's old two lines of mixed icons and words read
as loose text.
The model button names a chosen reasoning effort after the model in muted ink
("GPT-6 Astra Medium"); the provider default names none. Where the thread runs
(Project, working folder, base branch, checkout, Environment, repository) is
one row just above the box, as quiet chips set together from the
left: meta ink and no fill at rest, a fill only under the pointer or while the
chip's menu is open, the same as the access and model controls under the
box. Plan meters keep the right end of that row. The box itself holds only
attach, the prompt, the microphone and send, so a start screen's composer and a thread's are
the same object with the same row under it. Inside the card the row stood
between the person and the prompt, and a control that was more than a label
grew the card: a Project with extra folders drew a select, a labelled field
and a paragraph there. That choice is one chip now ("Main folder", or "Main
folder / src"), whose two fields open over the page; a subfolder the host
would refuse stays on the chip in the danger ink until it is corrected. The
Project chooser is the row's first chip. Code's
base-branch chip is absent until a Project is chosen: with no Project it
would name a branch of nothing. The chip
is painted on the plain element that holds each control, never on the shared
trigger inside it. The row wraps rather than grows: a control that needs a
list ("Create from…") floats over the page. A thread's own follow-up
composer keeps its context strip beneath the card. Nothing about delivery is
asked up front; it is derived from the chips and shown on the thread once it
exists.

**Composer popups.** Every popup the composer opens (Project, base branch,
checkout, Create from…, access, model) uses one recipe. The face is the
popover fill with the overlay shadow and a 12px corner, a 6px inset, and it
arrives and leaves with the shared [overlay motion](#motion).
A search field is `.octant-popover-search`: a filled
32px field with a leading 14px icon and no border; it takes focus as the popup
opens, so it brightens rather than drawing the keyboard edge. Rows are
`.octant-popover-option`: one line at the shared menu row height (28px), an icon, the name, and any
detail (a folder, visibility, state) trailing in the meta ink and cut from the
end. A choice is a check mark at the row's end and never a fill; a fill means
only that the pointer or the keyboard is on the row. Group headings are
`.octant-popover-group` (12px, medium, meta ink, sentence case) and status
lines `.octant-popover-empty`. A control that acts on a field sits on the
field's row ("Use repository", the refresh icon), never under it. A popup is
capped to the room on the side it opens on; only its list scrolls, and the
ways to add something (New Project from folder…, from GitHub) stay pinned
under the list.

### Menu rows, shell frame, and alignment

_One menu row._ Every in-page pick-list (dropdown, context menu, select and
combobox options, the model list, the mode menu, the Add tool menu) draws the
same row from `ui/shadcn/menu-row.ts`: 28px tall (`--oct-menu-row-h`), 44px when
it carries a second line (`--oct-menu-row-two-h`, an `oct-menu-detail` span), an
8px inset on a popup padded 4px, a 16px icon column and an 8px gap
(`--oct-menu-row-gap`), the words in the Menu option role (13 / 500), and a
group label in the Navigation group label role (12 / 400, muted). A row's words
therefore stand 36px from the popup's edge when it has an icon and 12px when it
has none, in every menu. A menu where any row has an icon reserves the column
for every row, so it never has two text edges; a menu with no icons keeps the
words on the popup's own inset. The separator is one hairline as wide as the
rows (4px in from the popup's edge, the same inset the rows have), never a
negative margin. A feature stylesheet may colour a menu's icons but gives its
rows no height, gap, padding or font size. In the desktop app dropdown and
context menus can be drawn by the system; that path is unchanged and the OS owns
its spacing.

The shell frame runs on one
grid, named by the `--oct-title-rail-h`, `--oct-rail-tab-h`,
`--oct-rail-button-h`, `--oct-nav-head-h`, `--oct-nav-row-h`, and
`--oct-nav-inset` tokens in `octant.css`: the title band, the window
controls, the right dock head, and the bottom panel toolbar share one title
rail (44px), on which a rail tab and a rail icon control sit on one centreline and
the band's hairline meets the dock's; the sidebar's header row is its part of
that rail (`--oct-title-rail-h`), so its controls share the window controls'
centreline, and below it the sidebar runs navigation, Project, and
thread rows at the nav row height down to a 44px account row (`--oct-nav-head-h`),
with every leading icon on the nav inset and its section labels at 12px in the
meta ink with a 20px gap above, so a label never reads as one more row. A
thread row that carries a facts line is two lines of type and takes 8px above
and below them: 8 + an 18px title line + 1 + a 17px facts line + 8 is 52px, and a row stands 54px from the next with the list's 2px gap. Hover-only actions (add, more, pin, archive,
and a tab's pin and close) take no width until their row is hovered or
focused. A section heading's add and more controls are the exception: the
list's view and filter controls share that row, so they keep their width while
hidden and only fade in, and nothing beside them moves. Touch
surfaces keep 44px targets. The workspace and Settings share the saved sidebar
width, defaulting to 280px (wide enough to read a thread's title rather than
guess it); narrow Settings layouts retain their responsive
rail clamp or drawer. The workspace sidebar supports resizing.

**Alignment.** One value does one job, so no edge or gap has to be explained.
Each of these was measured off by a pixel or more in a render before it was a
rule:

- _The title band's icon buttons_ are 28px and stand 4px apart wherever the
  band shows a row of them: the window controls, the tool row, the sidebar's
  header actions. The band keeps one inset at both of its ends, 8px, so Show
  sidebar is as far from the left edge as the last toggle is from the right. A
  slot a Project fills only sometimes (Open in, Project actions) takes no room
  and no gap while it is empty.
- _A tile's bar_ ends on the band's 8px, and its Arrange and Close are 24px
  controls with one 14px glyph, centred on a whole pixel: the bar's hairline is
  drawn inside its 32px, not as a border that takes one off the controls'
  centreline. The Browser's row follows the bar's insets.
  The tool's own controls stand in the same bar on the same terms (24px
  controls, 14px glyphs, 4px gaps, a 28px word-switch tray of 24px segments),
  and a tool's secondary row and its first content text sit on the bar's 12px
  edge.
- _The icon rail's_ face is its button (32px in the column, 2px
  apart), and the first face is centred on the title rail's centreline, so it
  stands level with the band's controls beside it (6px down in the 44px rail).
- _A dock never clips._ The dock's own bar holds the same 8px at both ends at
  every width, 280px and up, and reserves nothing for the title band's
  controls: the tool row lives in the band, a wide dock's bar is an empty
  spacer under it, and a narrow dock is a dialog that stands away from the
  band. A reserve for the band's room left no content box at 300px.
- _A card's inset is exactly 16px_ (a Settings card draws its edge as an
  outline inside its box, not as a border) and a dock card's title and its rows
  stand on one edge: a title that is a button has no border, and a row's mark,
  whether an icon or a dot, takes one 14px slot, so every name starts on one
  column.
- _Rows are whole pixels._ A row whose height is the sum of its lines sets
  them from the role leadings rounded to a pixel (`--oct-line-label`,
  `--oct-line-detail`, `--oct-line-meta`, `--oct-line-snug`,
  `--oct-line-tight`): a Settings row, a thread row in the sidebar (two lines,
  52px) and a dialog's paragraph. The roles keep their sizes.
- _The composer's columns are the same in every mode._ The row under the box
  starts on the box's inset, so its first control stands under attach in Chat,
  Work and Code alike (an empty leading group takes no gap). The prompt's line
  is the transcript size times the body leading, rounded to the nearest even
  pixel (`--oct-composer-line`), so the 28px controls centre on whole pixels
  and the one-line box is 44px at the default 13px (46px at 14px, 48px at
  16px).
- _A foot ends where the rows above it end._ The account row's chevron stands
  on the navigation inset (12px), the edge a thread's status mark ends on.
- _At a phone's width_ the start screen's composer stands the panel's 20px from
  each edge, and so do a thread's composer and its text column. The panel is
  already padded 20px at 680px and below, so the thread's gutter token
  (`--oct-thread-gutter`, 40px for the two sides) is 0 there, and the column
  and composer take the panel's width: 390, 430 and 680px all show 20px, not
  the 40px the column's own gutter added inside the panel. Above 680px nothing
  changes.
- _The title's text stands on the thread column's edge._ The title band's text
  starts where the transcript's column starts, at the larger of a 20px gutter
  and half of the pane less the thread measure, so a centred, narrower column
  carries the title with it. What could precede the title (the environment
  mark, the pull-request chip) follows it, because the 20px gutter cannot hold
  a 20px mark; with content tabs open there is no title and they lead as before.
  The grip's own 4px padding and 1px border are taken off the start so the text,
  not the grip's hover fill, stands on the edge. Where the sidebar is collapsed
  the title clears the window controls instead (the larger of their width and
  the column's edge). With a Project step in the breadcrumb ("Project / title"),
  the breadcrumb starts on the edge and the title follows its slash.
- _Controls are 24, 28, 32 or 44px, and rows 32 or 44._ A segment in a tray is
  24px (`--oct-tray-segment-h`) inside 2px of padding, so every tray is 28px:
  the mode switch in the sidebar's header, the thread-list switch under it and
  the composer's Work and Code switch alike. A tray's inner corner stays the
  tray's corner less its padding, never under 2px. The icon rail's button takes
  its face's 32px in the column (it is the button's `rail` variant, which draws
  no border, so no negative margin gives one back), and the account row is 44px (`--oct-nav-head-h`), the row height a two-line row uses.
- _The account row's avatar and the Projects toolbar's folder sit on the icon
  column._ The 20px avatar is centred on the centre line of the 16px navigation
  icons (the 12px inset plus half an icon), not left-aligned with them, and the
  Projects toolbar's first button is centred on the same line so its 16px folder
  starts where the rows' glyphs do.
- _A toast's dismiss ends on its padding._ The 24px button's box ends on the
  toast's 12px padding, not 2px from its corner; the title line is 24px tall so
  the icon, the title and the glyph share a centre, and an action in the message
  (View host) is inline text, so its line is as tall as the others.
- _Settings has one rhythm._ The page's band takes the page's 32px gutter at
  both ends (the close button ends where the content ends), sections are 24px
  apart, the page ends 48px under its last section, and a section label and a
  section note each leave 12px under them (a label that carries a note has 12px
  between them too), with lines set from the role leadings rounded to a pixel.
- _One hairline._ A 1px dividing line or a quiet control outline on the title
  band, the thread's disclosures, the sidebar's tiles and the icon rail is
  `--oct-hairline` (10% ink): the environment mark's edge, the divider between
  a thread's tool rows, the rail's count badge and divider, and a count tile's edge. A
  deliberately stronger edge stays: a field's border, a focus edge, a status
  tint, and a Project tile's initial (22%, 40% on hover), which is an
  identity mark rather than a divider.
- _The rule beside reasoning_ is 1px, not a 2px bar, in `--octant-border-strong`:
  the hairline measured about 1.2:1 and was too faint to find.
- _A slider's track is the strong divider role_ (`--octant-divider-strong`), a
  theme role held to 3:1 against the workspace, so the track is found on a card
  in dark and in light. The hairline it used was 1.5:1 in dark and 1.3:1 in
  light. The thumb still carries the value.

While a route or tool is still loading, its state is one quiet line (spinner,
then the title) on the page ground, never a raised card: a card with a title
and a sentence reads as a finished empty state.
A state that is the whole window (a refused launch address, a launch session
that expired, Project authority that is unavailable, a lost connection, storage
recovery) is the page presentation of `ShellState`: centred on the page, a 96px
mark that is the state's glyph drawn as an open grid of dots in the primary ink
(a warning is a filled triangle with its mark cut out), a title at the
`--oct-text-xl` step, one line in the secondary ink, and the way back as a text
link in the accent ink, with no eyebrow. A state inside a pane or panel keeps
the compact layout: glyph, eyebrow, title, sentence, and a button.

Navigation panes stay compact hairline rails. Routine form layouts stay open
and unshadowed; setup objects and cards use the card recipe (`OctantCard`), and
a Settings section's group is the same hairline-ringed shape in its own fill,
and neither draws a shadow —
a card sits in the page, and shadow is reserved for something that floats
above it. Welcome composers keep their raised frame.
Every composer's row under the card is two groups with the row's free space
between them, in one order on a new task and in the thread it becomes: where the
thread runs and a surface's own icons on the left (Create image in an open
thread once an image profile is ready, Plan, Web), then how the turn runs on the
right (the model, the approval control, the context ring). Attach, dictation and
send are in the card, and the add menu holds the thread's own actions as a
group (Mark done). A control never changes sides between the two composers.
All six composers use `ComposerAttachButton` for their file chooser. The visible
button is the only tab stop; an unsupported model keeps the button reachable
and explains the refusal in the surface's status line. It never opens the file
chooser or uploads while refused. Model, access, and destination controls keep
one type scale. The mode picker reads the same in new and existing threads:
Auto (with "Recommended" wherever a reviewer can run, the provider's own or
Octant Shield, its description naming which; otherwise listed disabled with
the reason), Ask first, Accept edits, Plan, and Full access, each with a
one-line description. Choosing a mode is one click and
changes the thread; the first Full access pick on this machine or in a
Project shows the one-time warning first.
The prompt itself is frameless:
`OctantTextarea` drops the shadcn field recipe when it wears `.composer-input`.
Composer-row selects drop the same field chrome. Feature CSS must not
repaint those controls a third time. Select lists open beside their trigger
without covering it with the selected item. The model picker anchors to the
trigger's trailing edge, keeps its dimensions stable while filtering, and
scrolls its model list internally. Its catalog filters wrap onto short rows so
every catalog is visible (past three rows the block scrolls), and its level slider draws the whole track in ink, with the
reading above it and both ends named below. Popovers, menus, dialogs, and hover cards use
the floating surface and the overlay shadow, and have exactly one 1px hairline
edge: the overlay shadow carries it for menus and popovers, and the shared
dialog draws it as a border. A feature stylesheet sizes and places a popup and
never sets its fill, border, or shadow. Environment's cards on the dock and a Settings section on the page are
hairline-ringed cards, not floating objects. Frosted material (a
`backdrop-filter` blur) is used only where a surface has a ground behind it to
read through:

### Dialog presence and the title bar

A stylesheet cannot
hold an element that is gone, so a surface leaves this way only while it stays
mounted and is told it has closed. Settings' sheet and a dialog with an `open`
of its own do that themselves, and such a dialog keeps `open` apart from what
it shows: one whose words come from the state closing clears (a review, a
comparison, Rewind) is rendered only while that state exists, like the rest.
A dialog a feature renders only while it is
open is wrapped in `OctantDialogPresence`, which keeps the last thing the
feature rendered until the exit has finished and tells the dialog inside it
has closed: a confirmation still names what it asked about after the feature
has cleared that state, and the command palette keeps the rows it showed.
Every confirmation, the command palette, the Code file search, the Navigator,
the narrow dock, first run and the other dialogs a feature mounts on demand
leave this way. Two cases still leave at once: a dialog whose owner goes with
it (a row removed by the confirmation it showed), and one of two dialogs that
share a presence when the other takes its place. In a window nobody can see
there is no exit to show, so a dialog closed there is removed at once.

A dialog or a sheet that is leaving is only there to be seen. Its scrim and its controls
take no press and no key (`inert`), so the page under it answers at once and a
second press cannot repeat what the first did. Focus goes back to the opener
as the exit starts, not when it ends, and when the exit ends focus is left
where it is if the person, or a command they ran from it, has moved it
in the meantime.

Native Electron title-bar regions are a hard boundary. Interactive controls
must carry `window-no-drag` and render above the native drag target. Test title-bar
buttons in the packaged/native surface, not only with React/jsdom.

On macOS the desktop window keeps Electron's native frame and uses
`titleBarStyle: hiddenInset`; `frame: false` is not combined with that mode.
Do not set a custom `trafficLightPosition`: Electron then resizes
`NSTitlebarContainerView` to `buttonHeight + 2 * y`, and that native overlay
eats title-row clicks. One explicit blank drag strip reaches the physical top
edge after the traffic lights and, when the sidebar is collapsed, after the
measured leading cluster. Pane tabs and window controls share the compact
visual rail at a higher stacking layer; unused spans remain drag regions.
Collapsed-sidebar Show sidebar and New thread actions reserve their own no-drag
space after the same traffic-light width the sidebar uses.
Packaged smoke checks both compact geometry and real native state transitions
for Open in, Environment, bottom panel, right dock, and sidebar recovery.

### Confirmation and dialog behavior

Ordinary usage reset/retention, Git discard, and remote administration
confirmations use the shared `OctantConfirmDialog` over `OctantDialog`. The
remote listener confirmation shows the address, origin, network reach, and
certificate state without disclosing key material; revoking every device
requires a destructive confirmation. The safe action receives initial focus;
Escape, Cancel, and backdrop dismissal do not mutate data, and closing restores
focus to the opener. Git confirmations consistently offer **Keep changes** and
**Discard changes**. Destructive actions opt into the danger treatment explicitly;
ordinary confirmations use the standard action treatment. Long paths in the
description wrap within the shared dialog. Their existing host approvals,
receipts, and observed-state checks remain separate and mandatory.

Every dialog shares one frame. The shared popup insets its content 16px, the
title is the 15px body step at the strong weight, and the answers sit in one
row at the trailing edge: the answer that dismisses first, as an outline
button, and the answer that acts last, filled (or in the destructive role),
both at the default control height. A dialog that draws to its edges (the
command palette, a player, a sheet with its own head and foot) sets its own
inset with one class; no dialog sets its own title size or draws its answers
at another height. A dialog wider than the 420px default says so with
`--octant-dialog-width`, never with a width of its own: the shared popup caps
any other width at the default, which had opened the rewind, synced-artifact,
Continue elsewhere, planner-review, plugin-detail and thread-search dialogs
narrower than they were written. Before this, dialog titles ran from 14px to
17px at two weights, the dismissing answer was drawn bare, outlined or filled
depending on the dialog, and a confirmation's buttons were one step shorter
than every other dialog's.

Product notices stack at the top trailing corner of the window, under the
title bar. At the bottom trailing corner a notice covered the composer's model
picker and Send.

A dialog with a visible heading uses that heading as its accessible name through
`labelledBy`; specialized palettes and dock dialogs without one retain the hidden
title. Do not add a second visible header. Shared dialog popups and backdrops
suppress entrance motion under the persisted reduced-motion setting as well as
the OS preference.

## Shell and layout

**One bar holds the tool's controls.** A tool used to draw its own 40 to 44px
header under the tile's bar, with insets of 8, 12 or 16, so a tiled tool showed
two bars that disagreed. The tool now hands its header controls up to the bar and
draws no header of its own, so a tiled tool has exactly one 32px bar: the tool's
name, then the tool's controls, then Arrange and Close, on the bar's insets (12
leading, 8 trailing) with 4px between controls.

- _Navigation keeps its words._ A choice between a tool's views or places
  (Review's Working tree, Local commits and History, Agents' List and Graph, the
  Desktop's leases) is drawn as a word switch: a 28px tray of 24px segments,
  centred in the bar (2px above and below), the pressed segment marked. Words
  are never replaced by icons.
- _Actions are icons._ An action everyone knows (Refresh, Back, Home, Screenshot,
  Release) is a 24px icon button with a 14px glyph, a tooltip and an accessible
  name. An action that opens a list of actions (a terminal's, a device's More) is
  one such button with a menu. Status the tool says about itself (a test run's
  state, a pull-request count, a device's state) is quiet text after the name.
- _The bar folds in a fixed order._ When the controls do not fit beside the
  name at the tile's width, each word switch first becomes one control showing
  the current view's name with a menu of the views, so the current place is
  always readable in words; then the actions fold into one **More <tool> actions**
  menu; a control the tool draws itself (Canvas's version popover and menu) moves to the one secondary row under the bar when even the folded bar cannot hold it; the tool's name is cut last. Status text (a count, a device's state with its mark) never folds either, and its full text is its tooltip: the actions fold first. A cue a person must be able to read (View only, a billed Desktop's provider and place) is never cut to an ellipsis: when the bar cannot hold it beside the tool's name even with the actions folded, it moves, without being drawn again, to the one secondary row, which is inside the same toolbar and exists only while something has moved to it. It follows the bar's actions in the page, so Tab, the arrow keys and the eye all meet the controls in the same order. The row wraps onto further 32px lines when its contents are wider than the bar and the bar reserves the height it has; a cue has no cap, no ellipsis and does not shrink. The bar measures a control the tool draws itself as it is drawn, not by a declared width, and reads its own insets. In the bottom panel, which has no second row, such a control, and a cue, scrolls within its own box, which takes focus so a keyboard can scroll it, with Hide beside it. Alt, Meta, Ctrl and Shift with an arrow key are left to the browser. A named control stops at 16em with an ellipsis and its full name as the tooltip. The controls stand in one labelled toolbar with arrow-key movement. A menu returns focus to its control after an
  action. The steps are decided from the bar's width, the name's natural width
  and the words' natural width, never from the folded controls, so the bar
  cannot flip between two states. At the 280px dock minimum Review's switch is
  already the named control.
- _A secondary row is for content, and there is at most one._ A field or path the
  tool shows to be read or typed into (Files' filter, Pull requests' search,
  Document's path, Side Chat's "About" line) is content, not chrome: it keeps one
  row under the bar, 32px, on the bar's insets and hairline, and the tool's
  first content text stands on the bar's 12px text edge. Anything that is a
  control goes in the bar. Canvas draws its own versions popover and menu, which
  go up as one control that does not fold.
- _A tool alone keeps no tile bar_, as before: the title band's tool row names
  it. Its controls stand in one row of the bar's height, insets and hairline,
  holding only them, and a tool without controls has no row. Where the tool has
  a content field as well (Files' filter and Refresh, Pull requests' search and
  count), the field and the action share that one row.
- _The same tool in the bottom panel follows the same rules._ Its controls stand
  in the panel's bar between the tool tabs and Hide, as 24px controls with 14px
  glyphs, 4px apart, ending on the 8px end inset, and fold the same way. The
  panel's bar stays the 44px band the tabs stand in; only the controls and
  insets are the tile bar's.
- _A control is never a drag handle._ Each carries `window-no-drag`, and a
  tool's controls come after its name in the keyboard order, before Arrange and
  Close.

### Tabs and segmented choices

True page tabs, segmented choices, and pane identity are intentionally
different. `OctantTabs` owns a flat rail with selected fill and keyboard tab
semantics. `OctantToggleGroup` owns the enclosed track used for mutually
exclusive values. A recipe styles the state attribute
the installed Base UI part writes (a selected tab is `data-active`, a pressed
toggle `data-pressed`, a checked switch `data-checked`), never one it invents. Each split pane keeps its close action on the trailing edge of its header;
only a pane underneath the window controls reserves space for that cluster.
The split-pane drag handle alone owns active-pane paint. Feature
styles may size or scroll these primitives but may not restore a local tab
track, underline recipe, or persistent active border.

## Component ownership and composition

### shadcn/Base recipes

Use the Octant adapter names in feature code. The owned recipe list includes
Button, Card, Badge, Input, Textarea, Field/FieldGroup, Select, Combobox,
Switch, Slider, Checkbox, ToggleGroup, Tabs, DropdownMenu, ContextMenu, Dialog,
and Tooltip. Composition rules:

- Buttons use `OctantButton` or `OctantIconButton`; variants are default,
  destructive, outline, secondary, ghost, and link. Destructive is a tonal
  fill, not a solid one: a red slab reads as the page's subject rather than one
  action on it. Sizes are xs, sm, default, lg, icon, icon-xs, and icon-sm.
  Icon-only buttons always have an accessible label and tooltip/title.
  A control in the title band is one shape whatever it holds: 28px
  (`--oct-rail-button-h`) with the control corner (`--oct-radius-sm`), icon-only
  controls square, a label or a label with a chevron the same height. The compact
  24px, 6px step drew the dock's tools and the Project actions beside 28px, 8px
  window buttons as three shapes. Open in is outlined, the one band control that
  keeps an edge, in the same 28px and control corner, not a card-radius tile.
  A standalone icon-only control has two sizes and nothing between: the 28px
  rail button (`OctantIconButton`, `--oct-rail-button-h`) in a title band,
  panel head, or toolbar, and a 24px square for an action inside a row. The
  recipe's `icon` sizes are rem and drift with the interface font size, so a
  panel control takes `OctantIconButton` rather than a recipe size. Only a
  control that floats over content, such as the terminal's actions button,
  keeps a fill and an edge.
- Form layouts use `OctantFieldGroup` and `OctantField`; labels, descriptions,
  and errors remain associated with their controls. Invalid state uses
  `data-invalid` and `aria-invalid`.
- Use `OctantSelectField`/Combobox for searchable or bounded choices, not a
  custom dropdown. Option sets of 2–7 choices use `OctantToggleGroup`.
- Use complete Card composition (`Header`, `Title`, `Description`, `Content`,
  `Footer`) for discrete objects and grouped forms. Use compact rows and
  `Separator` for navigation lists.
- Menus, popovers, dialogs, and overlays are opaque, keyboard dismissible, and
  titled for assistive technology. Use `OctantDialog` with a real label even
  when the title is visually hidden. Dialogs and sheets share one layer and
  popups stand above it: a menu or popover opened inside a dialog or the
  narrow dock sheet appears above it, and Escape closes the innermost surface
  first.
- Layers are tokens: page chrome stays at or below `--oct-z-overlay` (40),
  dialogs and sheets with their backdrops stand at `--oct-z-floating` (50), a
  notice at `--oct-z-toast` (55), and everything a person opens to aim at
  (menus, context menus, popovers, selects, comboboxes, tooltips, hover
  cards) at `--oct-z-popup` (60). A notice sits above a dialog or sheet
  because under its backdrop it could be neither read nor dismissed, and
  under a popup because a notice that said the app had stopped unexpectedly
  once covered an open menu in the right dock's header and took the clicks
  meant for its items. A menu opened inside a dialog stays above the dialog.
  The `.toast-stack` column takes no press outside its notices. A new surface
  takes one of these tokens, never a number of its own, and nothing in the
  workspace goes above z-index 7.
- A list a person picks from draws one row. One line is 28px
  (`--oct-menu-row-h`), its words stand 8px in from the row's edge
  (`--oct-menu-row-inset`), and the rows stand 4px in from the popup's edge
  (`--oct-menu-inset`). The menu, context menu, select and combobox recipes
  share that row (`ui/shadcn/menu-row.ts`), and the command palette, the `#`
  and `/` typeaheads and the composer's picker rows take the same tokens. A
  row with a description under its label grows to two lines; no row is shorter
  than the height. The tokens are pixels on purpose: the recipes' rem steps
  followed the interface size, and one line of text was 24px in a menu, 26px
  in a context menu and a select, 30px in a combobox and a picker, 34px in the
  palette and 24px in a typeahead, on a 6.5, 8 or 12px inset. A feature sizes
  no row of its own.
- Use Badge for status labels, Alert for callouts, Empty for empty states,
  Skeleton for loading, and the shared `.toast-stack` notification owner for
  transient acknowledgements. Do not add another toast package or recreate
  these with styled spans or animated divs.
- App-owned inline notices use `OctantAlert` for the status mark, tone, live
  region, message, optional title, and explicit actions. Warning and danger
  announce as `alert`; neutral, accent, and success announce as `status`.
  Placement belongs to the feature; the callout recipe owns its appearance.
  The mark is in neutral ink for the neutral tone, composer notices included;
  the warning tone draws it in the warning ink and the danger tone in the
  danger ink.
  Permission decisions and confirmation side effects stay with the host and
  their existing dialog callers. A new raw `role="alert"` or `role="dialog"` in
  feature source fails `bun run ui:check` unless it is a recorded exception:
  an inline field error tied to its input, a compact status row that already
  owns its mark or switches between status and alert, a screen-reader-only
  announcement, a positioned banner whose placement is not a callout, an
  empty-state live region owned by `ShellState` or `OctantEmpty`, or a
  non-modal glass panel. Zen's thread picker, assistant, and add/appearance
  panels stay anchored in the surface; `OctantDialog` would add a backdrop,
  focus trap, and portal. The recipe owners (`OctantAlert`, `OctantToast`,
  `OctantApprovalCard`, `FieldError`, and `ShellState`) set the role themselves.
- A lost host connection is one condition with one voice. A Chat thread shows a
  single `OctantAlert` in plain words ("Can't reach the host" with Retry now),
  above its transcript in the thread's own measure; it becomes a success alert,
  "Reconnected", for a few seconds when the host answers, then goes quiet. The
  thread's other surfaces (the subagent card, the message queue, the composer's
  status line) never repeat the loss: they dim and disable their controls. Use
  no other wording for it, and never show internal vocabulary such as "the
  authoritative transcript". A failure unrelated to the connection keeps its own
  alert. Work and Code threads keep their own connection messages until they
  adopt this notice.
- Product notices use `OctantToast`: a semantic icon, short title, supporting
  detail, and an explicit Dismiss button. An optional inline action can open the
  relevant destination without implicitly dismissing the notice. Success and
  waiting announcements use `status`; errors that need attention use `alert`.
  The shared recipe owns the opaque floating material, compact spacing, shadow,
  and wrapping of long filenames or messages in both themes. A feature may
  choose placement and content, not paint another notice. A field error stays
  by its field, and a warning that the user must review stays inline.
- Use `cn()` for conditional classes, semantic Tailwind tokens (`bg-primary`,
  `text-muted-foreground`, `border-border`), `size-*` for equal dimensions,
  and `truncate` for clipping. Feature classes position; recipe classes paint.

### Product-owned surfaces

`octant.css` and the feature stylesheets own shell grid, Project/thread tree,
composers, transcript measure, boards, review, terminal, Monaco, Canvas,
Environment, context/task popovers, and dock geometry. These surfaces compose
the adapters for controls instead of recreating their interaction behavior.

Thread and Project rows reserve stable gutters for status and provider marks;
hover/focus actions remain in flow or use an overflow menu so the list does not
jump. Right-click mirrors available actions but is never the sole route to an
essential action.

## Source of truth and CSS layers

There is one runtime theme authority and one owned control layer:

| Layer                 | Responsibility                                                                                                    | Files                                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Semantic theme        | Persisted theme settings, presets, contrast validation, typography, safe fallback, export/import                  | `packages/theme/src/`, `packages/contracts/src/theme.ts`                                                                    |
| Renderer fallback     | Startup values before the theme bootstrap is applied                                                              | `apps/web/src/styles.css` (`--octant-*`)                                                                                    |
| Static product system | Layout, shell geometry, type scale, spacing, motion, domain surface recipes, and `--oct-*` consumers              | `apps/web/src/styles/octant.css`                                                                                            |
| Runtime bridge        | Maps theme-resolvable `--octant-*` roles to the static system's `--oct-*` roles                                   | `apps/web/src/styles/octant-bridge.css`                                                                                     |
| shadcn projection     | Projects `--octant-*` roles into `--background`, `--primary`, `--border`, and the other shadcn/Tailwind variables | `apps/web/src/styles/shadcn-theme.css`, `apps/web/src/styles/tailwind.css`                                                  |
| Owned recipes         | Editable Base UI-native shadcn recipes and the product-facing adapter API                                         | `apps/web/src/ui/shadcn/`, `apps/web/src/ui/base/`                                                                          |
| Native projection     | Maps the same semantic defaults into React Native colors; mobile-only material and touch geometry stay local      | `apps/mobile/design-system/`                                                                                                |
| Public projection     | Emits the semantic defaults for public documentation and the marketing-site stack                                 | [octant-site guide projection](https://github.com/Ogard-Labs/octant-site/blob/main/docs/.vitepress/theme/semanticTokens.ts) |

The import order in `apps/web/src/styles.css` is load-bearing:

1. Tailwind v4 and its layered preflight.
2. `octant.css` static system.
3. `octant-bridge.css` runtime mapping.
4. `shadcn-theme.css` semantic projection.
5. Feature stylesheets, which may position a surface but must not repaint a
   shared control.

`--octant-*` roles own persistence and theme editing. `--oct-*` and shadcn
variables are consumption aliases. Do not add a new raw colour, radius, shadow,
or control recipe in a feature stylesheet.

The portable projection of these layers, for a website or another app, is
generated, not hand-kept: `bun run tokens:export` writes
`packages/theme/tokens/tokens.css` and `tokens.json` from the stylesheets above,
and `bun run tokens:check` fails when they are stale. How to load and use them,
and the app-feel rules a consumer follows, are in
[Design tokens and the app feel](docs/design/design-tokens.md).

`bun run ui:check` enforces this on every `.css` file under `apps/web/src`
(`scripts/check-ui-stylesheets.ts`). A raw colour in a rule fails closed; a
block that must depict one fixed scheme regardless of theme, such as the
light/dark preview swatches in Settings, carries
`/* ui-style-exception: fixed-scheme */` on the line before it. Off-scale
`font-size` values, raw `transition`/`animation` durations, and `!important`
outside an accessibility fallback, any `font-weight` heavier than 600 outside
the title roles (see [Scale](#scale)), and any paint
(colour, background, border, radius, shadow, outline) that a feature rule puts
on a class handed to an Octant primitive (place or size a shared control,
never repaint it; pick a recipe variant instead) ratchet against
`scripts/ui-stylesheet-baseline.json`: a file may not add one, and a fix must
re-record the lower count with `--write-baseline` so the baseline never
overstates.

The remaining control repaints are burned down by restoring each control to its
recipe, in small batches. Each batch is its own pull request with before and
after screenshots, and the maintainer approves the paint change before it
merges, because removing a repaint changes what the control looks like.

The `control-repaint` rule reads the classes feature code hands to an Octant
primitive. A control marked `unstyled` is feature-owned paint by design and is
skipped; `unstyled={false}` is not, and stays under the rule. The checker also
skips `composer-input`, the system prompt, because that surface is
already painted twice; the rule still holds for it — feature CSS must not
repaint it a third time — it is simply not machine-checked.

The shadcn registry metadata is in `apps/web/components.json` (`base-nova`,
Tailwind v4, CSS variables, Lucide). The checked-in recipes are owned source
and use `@base-ui/react` primitives behind the Octant adapters. They follow the Base UI-native shadcn `nova` style and its
denser controls, except that recipes paint no focus ring, halo or second outline
(the global `:focus-visible` rule is the only keyboard focus treatment, so a
combobox's frame draws none of its own) and the badge and
the card keep the shape and elevation set in this document. A recipe's heading
(a card's or popover's title) takes the recipe's own type role: the page's bare
`h1` to `h4` defaults sit in the base layer, below every utility, so they size
reading content and never a component. This
keeps the interaction backend accessible and editable while preserving the
shadcn composition and visual vocabulary. Feature code imports `ui/base`, not
`ui/shadcn` or `@base-ui/react` directly. Project and split-workspace context
menus use the shared `OctantContextMenu` adapter; do not add a new direct
primitive import.

Desktop context menus and ordinary dropdown menus (including More, the account
menu, action menus, plain select fields, Project/thread filters, and checkbox/radio choices) use Electron's native OS menus through that adapter.
The OS owns their font, material, spacing, highlighting, submenu behavior,
accessibility, and light/dark appearance; renderer theme tokens do not repaint
native menus. The account menu opens above its footer control and More beside
its sidebar row. Activity › Custom range opens a date-range dialog.
The existing action composition supplies labels, grouping,
disabled and checked states, and nested actions. Native menus dismiss after
a selection, including checkbox/radio changes; reopening reads the current state. Ordinary editable text and text selections
receive the platform editing/copy menu. The Code editor and both diff sides
use native editing/find actions that run through the existing editor commands. Browser clients retain the accessible
Base UI menus. Native menus use macOS accessibility. Verify their actual presentation and
selection through native accessibility in an isolated desktop fixture; renderer
keyboard and role checks cover the browser fallback. Searchable pickers and popovers with embedded controls remain
renderer surfaces.

## Implementation checklist

When adding or touching UI:

1. Read this file and, for system boundaries, the owning architecture section.
2. Reuse an existing adapter and semantic token before adding CSS.
3. Keep domain logic in its owning package; keep renderer components focused on
   presentation and user interaction.
4. Add a focused behavior test for meaningful interaction or accessibility.
5. Run the nearest web test/typecheck/build and `git diff --check`; broaden to
   the repository verification command for cross-package changes.
6. For shell, title-bar, dock, Environment, context, or settings work, perform
   rendered/native verification at the relevant viewport and capability state.
7. Record a deliberate exception here when a surface cannot yet use the shared
   recipe.

### Current exceptions and known migration edges

- `apps/web/src/ui/shadcn` is the owned recipe source; `components.json` is CLI
  registry metadata and does not describe the product's complete shell.
- `scripts/check-ui-component-boundaries.ts` is a blocking repository check.
  Production feature code cannot import Base UI or shadcn recipes directly and
  cannot render ordinary raw buttons, inputs, selects, or textareas. Controls
  compose through `apps/web/src/ui/base`. The only accepted raw categories are
  hidden native file inputs, explicitly documented native platform surfaces,
  and specialized editor surfaces that cannot be represented by an adapter.
  Tests and the owned `ui/shadcn`/`ui/base` implementation are not feature
  surfaces and are excluded from the inventory.
- Feature styles position product surfaces; adapters paint shared controls.
  When migrating an old control, remove the replaced paint rules rather than
  keeping a parallel recipe.
- Glass is limited to the surfaces listed under
  [Spacing, shapes, and depth](#glass); it is a different
  material, not a second palette. Do not copy mobile atmosphere or phone radii
  into a flat desktop pane, and do not bring a blur onto a pane that has no
  ground under it.
