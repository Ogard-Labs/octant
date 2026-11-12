# Octant design system

This is the current visual specification for Octant surfaces: desktop and web,
mobile, public documentation, and marketing material. [Workspace behavior](docs/design/workspace.md)
owns navigation and pane interactions; [architecture](docs/architecture.md) owns
system and authority boundaries. Use the [design workflow](docs/design/README.md)
to update this document in place with an approved design change.

Read the relevant section rather than the entire document:

- [Typography](#typography), [colour](#colour-system), and [materials](#spacing-shapes-and-depth)
  for visual defaults and safe theme behavior.
- [Transcript](#transcript) and [welcome/composer](#welcome-and-composer) for reading and input surfaces.
- [Shell and layout](#shell-and-layout) for sidebar, Settings, dock, and responsive presentation.
- [Component ownership](#component-ownership-and-composition) for shared controls.
- [Accessibility](#accessibility-and-reliability) and the [implementation checklist](#implementation-checklist)
  for verification of changed surfaces.

## Product character

Octant is a local-first desktop workspace for supervising Chat, Work, and Code
threads, providers, Projects, agents, changes, and delivery. Its visual north
star is a calm, colourful workbench that shows what is happening at a glance —
counts, running work, and whose thing is whose. Colour is the default; a person
who prefers grey chooses Mono (Settings › Appearance › Style):

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
  its thread (see [Shell and layout](#shell-and-layout)). Neither region
  fabricates a tab or repeats another pane's content.
- Hierarchy comes from typography (size first, then weight), spacing, cards
  for discrete objects, and selection fills. Colour is a normal tool: a real
  accent, status hues (amber warning, red failure, green success), coloured
  count tiles, board marks, Project and Canvas hues, and brand marks on
  connectors. It carries meaning, so a mark that names a state also has a shape
  or a word, and colour never stands alone. Long reading text in the transcript
  stays neutral for comfort. The Mono style draws the same app in greys. The
  context ring and the parts of the context window keep their hues, amber then
  red, in every style.

  _Rationale._ The app first shipped grey so that status and identity colour
  would stand out, and a calm default suited a review tool. In use it read as
  unfinished: nothing said what was running, warned, or belonged to what.
  Colour is now the default for everyone and grey is one click away, so the
  rules that remain are the ones that protect readers: colours come from the
  theme, text stays readable, and keyboard focus stays clear.

- Controls are familiar, compact, keyboard reachable, and honest about
  loading, stale, unavailable, permission, and error states.

Avoid dashboard walls (counts belong in a few tiles, not a grid of them),
neon developer styling, permanent low-frequency controls, oversized setup
cards, pill-shaped everything, and invented data. Gradients and depth are
ordinary tools used with judgment: the application ground, a count tile's face,
a Project's letter tile, and a raised card are fine; a gradient that carries no
meaning, or decoration on a control that already reads, is not. A feature that is not available must explain why and offer the
next useful action, or stay out of the primary layout. The one thing allowed
to be decorative is the application ground: a first-party picture or a
person's photo, shown plain or through one print effect, or the field of
Pulsing characters, Dithered pixels, or Flowing colour, behind the start
screens or behind every page.

## Language

This section is the part of the system that travels: every app surface, the docs
site, and the marketing site use the same words, the same face, and the same
hierarchy. Platform adapters may express the system through CSS or React Native,
but they do not own a second palette or visual language.

### Voice

- **Crafted, not vibed.** Hierarchy comes from size, then weight, then
  colour — never capitals. One title per page. Section labels are
  sentence-case and quiet. Nothing is uppercase except a monospace identifier
  that already is. Weights follow the one ladder in [Scale](#scale).
- **Sentence case everywhere**: titles, labels, buttons, tabs, menu items.
  Product nouns keep their capital (Project, Chat, Work, Code, Environment).
- **Say what happens.** A mode name never promises more than the runtime
  does. Where a thread's provider has no reviewer, a thread set to Auto reads
  "Ask first" and says why; Full access says it has no sandbox and no
  prompts.
- **One sentence of help.** A section note or row description is one sentence
  that says what the thing does. Longer explanations move to the docs.
- **Numbers read in English.** Counts, sizes, and token figures use the
  English separators whatever the system locale ("1,024", "4.1k"), because
  the words around them are English: on a Norwegian Mac the dock read "4,1k
  of 1 mill." beside a stats line reading "7.9k". A short token count in the context meter and Usage is
  `compactTokenCount` ("41.2K", "1.2M"). Dates
  and times still follow the locale, and a Canvas block keeps its own format.
- **Empty states are short phrases.** An empty state's title has no closing
  period ("Nothing archived", "No Projects match this view"); its detail line
  is a sentence and keeps one.
- **Name the host's computer from the host.** Copy about where something is
  kept or runs on the host says "this Mac" and "Keychain" only when the host
  reports macOS, and "this computer" and "credential store" otherwise. The
  window's own platform never decides it: a browser on a Mac can drive a Linux
  host. Until the host has reported, the neutral words show. Steps that
  differ by platform, such as a browser's key setup, show only the host's
  own platform's steps once it has reported, and every platform's before
  then. The platform is
  a host fact (see "Host platform in copy" under
  [Security and authority](docs/architecture.md#security-and-authority)).
- **Vocabulary.** `Project`, `thread`, `checkout`, `worktree`, `base branch`,
  `Environment`, `mode` (Auto / Ask first / Accept edits / Plan / Full access),
  `delivery` (Investigation / Local implementation / Pull request / Merged).
  The word "target" does not appear in the interface.

### Face

Interface text uses the platform face by default (SF Pro on a Mac):
`system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`. It is
what makes Octant read as a native app; with bundled Geist and antialiased
smoothing the interface read as a web page, thin and grey beside the apps
around it. Geist stays bundled as an explicit Appearance choice. Code, paths,
branches, identifiers, and terminal text use the monospace stack. Default
subpixel-style smoothing (no `-webkit-font-smoothing: antialiased`, which thins
light text on a dark ground), `text-rendering: optimizeLegibility`, no synthetic
bold.

### Scale

This table is the one statement of the type roles; sizes are at the default
13px interface size. Everything scales together with the Appearance interface
size through `--oct-text-step`; nothing is authored at 11.5 or 12.5, and
nothing essential sits under 12px at the default. The roles live in
`styles/surface.css`; the size tokens are listed under
[Typography](#typography).

| Role          | Size           | Weight | Leading | Colour      | Where                                                                                                   |
| ------------- | -------------- | ------ | ------- | ----------- | ------------------------------------------------------------------------------------------------------- |
| Hero          | 26             | 400    | 30px    | primary     | Welcome question only (`oct-title--hero` with `welcome__question`, `--oct-text-2xl`; 20 at phone width) |
| Title         | 28             | 700    | 1.15    | primary     | A page about one thing: a Project, a thread under review (`oct-title`; a role size, not a size token)   |
| Page title    | 14             | 600    | 1.35    | primary     | A destination or Settings page, on a toolbar's row (`oct-page-title`)                                   |
| Dialog title  | 17             | 600    | 1.3     | primary     | What a dialog is about (its `h2`); a part of a dialog is headed at 15 / 600 (its `h3`)                  |
| Reply heading | 20, 17, 15, 14 | 600    | 1.3     | primary     | Markdown `#` to `####` in a reply, with 24px above and 12px below                                       |
| Section label | 14             | 600    | 1.3     | secondary   | Group heading over a hairline (`oct-section-label`), and a Settings section's label                     |
| Row label     | 14             | 500    | 1.35    | primary     | Setting, list row, menu option                                                                          |
| Body          | 13             | 400    | 1.5     | primary     | Interface text and the transcript (the interface size, `body`)                                          |
| Detail        | 13             | 400    | 1.45    | secondary   | Row description, menu detail (`oct-row-detail`)                                                         |
| Meta          | 12             | 400    | 1.4     | muted       | Timestamps, counts, hints (`oct-meta`)                                                                  |
| Identifier    | 12             | 400    | 1.4     | muted, mono | Paths, branches, ids (`oct-meta--mono`)                                                                 |

Weights are one ladder, as tokens in `octant.css`: 400 (`--oct-weight-regular`)
for reading text, 500 (`--oct-weight-medium`, `--oct-weight-display`) for
labels, controls, and every name in navigation (thread titles, sidebar rows,
Settings sections), so a name stands apart from the facts under it by weight
rather than size, 600 (`--oct-weight-strong`) for emphasis (section labels,
card titles, counts, `strong`, the app's name, a destination's page title), and
700 (`--oct-weight-title`) only for the large title. The welcome question is a prompt to answer, so it is regular weight. `bun run ui:check` counts a
weight above 600 outside the title roles in `styles/surface.css` as a
`heavy-weight` finding and ratchets it against the baseline.

A title is never the size and the weight of the text it heads. It is
larger, heavier, or both, and has more room above it than below, so a reader
finds the parts of a page, a dialog or a long reply without reading them. A
fact in a list is its name in muted ink and its value in primary ink. (A
dialog's title was the body's 15px, and a reply's headings were 15/14/14 at
medium weight: each was one more line of the text under it.)

Titles and the welcome question use `--oct-tracking-tight` (-0.025em); section labels use `--oct-tracking-snug`;
body and detail use none.

### Colour

Neutral graphite grounds, a blue accent, semantic statuses (amber warning, red
danger, green success), and one neutral keyboard focus edge: that is the default
preset. The bundled colour presets lean every surface toward one hue and carry
their own accent. Text is three greys (primary, secondary, muted) and never a
fourth; the primary ink is near-white (`#f5f5f7`) in dark and near-black
(`#141414`) in light.

_Rationale for the accent._ Blue was rendered against Purple on both grounds.
Blue clears 4.5:1 as text and 3:1 as a fill on the light and the dark page with
the same hue, and it stays distinct from the amber warning and the green
success. Purple's light-page text value had to be darkened until it read close
to the plain ink, which loses the point of an accent.

Appearance › Accent offers a one-click accent colour: Blue (the theme's own),
Sky, Teal, Green, Lime, Amber, Orange, Clay, Rose, Pink, Purple, Indigo, the
neutrals Steel, Slate, Silver, Graphite, Carbon and White, or Mono. Mono is the
grey look: it sets Style to Mono and its ink accent. A swatch overrides the
accent fill and the ink on it (`accent-foreground` and `primary-foreground`):
dark ink on most, white on Slate, Graphite and light-mode Carbon, each clearing
normal-text contrast on its fill (`accentSwatches.ts`). A fill is also a switch
track, a usage meter and a primary button, so on the light card it must reach
3:1: the chromatic swatches and Silver take a deeper step in light, the dark
value with only its OKLCH lightness lowered (Lime measured 1.74:1 on the card
before, 3.03:1 after), and the dark values are unchanged. The Appearance chips
show the fill the current mode uses. An accent chosen before the light fills
were deepened is read as the same swatch, at paint time, with no write to the
saved settings. Accent text stays on the
preset's ink, because no swatch clears normal-text contrast on the light page.
White would vanish on the light page and Carbon on the dark one, so each takes a
silver in that mode, written as a mode-only override: an override's optional
`mode` limits it to the light or the dark theme.
The accent colours switches, selected states, and sliders;
status colours stay their own. Hairlines separate; fills select. Selected and expanded fills carry
state; keyboard focus follows the rule in "Accessibility and reliability". See
"Colour system" for the token table. On the marketing site the same three
greys and the same hairline carry the hierarchy on a white or graphite ground.

Settings › Appearance › Style chooses between **Colour** (the default) and
**Mono**. Colour lets the places that name something carry colour: the accent,
the sidebar's count tiles, board column marks, a Project's accent, connector
brand marks, and a thread's Canvases, which take the hue of what they hold (a
plan purple, a chart or figures amber, a diagram teal, a mockup pink, a table
or document blue). Colour draws every hue from the preset's palette roles
(`--octant-palette-*`, read through the `--oct-colour-*` aliases in
`styles/colour.css`), so it follows the light or dark theme and any tinted
preset. Mono is the grey app the product shipped before colour became the
default: the ink accent and the neutral warning trio (`MONO_STYLE_TOKENS` in
`packages/theme/src/tokens.ts`, swapped in only for roles a preset left at the
colour default), grey tiles and marks, and connector marks in the ink.

Vivid, the earlier name for the colourful look, is folded in: a stored `vivid`
or `default` value, or none, draws Colour, and `mono` draws Mono, so old rows
decode and everyone moves to Colour unless they choose Mono. The root carries
`data-octant-style="colour"` or `"mono"`. Increased contrast always publishes
`mono` and resolves the Mono roles, as it did before, so it is exactly as
readable as it was. Plain empty, loading, and informational messages draw their
mark in neutral ink in both styles; a yellow icon on a message that is not a
warning is wrong.

### Shapes and depth

Radius has one number per role. This table is its one statement; elsewhere
this document names the token, not the number.

| Token                   | Value  | Role                                                                                   |
| ----------------------- | ------ | -------------------------------------------------------------------------------------- |
| `--oct-radius-sm`       | 8px    | A control or a row; a composer context chip                                            |
| `--oct-radius-inset`    | 8px    | An object resting inside a card or well: a board card in its column                    |
| `--oct-radius-md`       | 12px   | A card, panel, or well; a Settings section card; the window-frame cards; a user bubble |
| `--oct-radius-lg`       | 14px   | A dialog; an inset inside the composer's pill                                          |
| `--oct-radius-composer` | 22px   | The composer's pill: half its one-line height, so the empty composer has round ends    |
| `--oct-radius-pill`     | 9999px | Compact chips, meters, and circular icon controls only                                 |
| `--radius` (`md`)       | 6px    | The recipes' compact step: xs and sm buttons, menu items (`rounded-md`)                |
| `--radius-lg` / `-xl`   | 8 / 12 | The recipes' control and card steps (`rounded-lg`, `rounded-xl`): a menu and a popover |

The `--oct-radius-*` tokens live in `octant.css`. The shadcn recipes derive
their scale in `tailwind.css` from `--radius`, which `shadcn-theme.css` sets to
`--oct-radius-sm` less 2px, so `rounded-lg` lands on the control's 8px and
`rounded-xl` on the card's 12px, and a menu shares a corner with the popover
beside it. Phone-only surfaces in the web renderer use the mobile radii
(`--oct-radius-bubble`, `--oct-radius-card-m`, `--oct-radius-sheet`). The
native phone app follows this table and adds only a 20px bottom sheet, and it
draws its chrome with the system's own patterns (tab bar, large titles, inset
grouped lists, segmented controls); `apps/mobile/design-system/README.md`
holds that projection.

Depth is one material in five levels. Every surface takes a fill one step
lighter than what it sits on, a rim that is brighter along its top edge (two
inset shadows: a line along the top, then a ring around), and a shadow that
seats it, so an object is never told from the surface under it by an outline
alone. Each level has its tokens in `styles.css`; a surface consumes them and
never writes its own colour.

| Level      | What it is                                                                                            | Fill                                                                  | Rim and shadow                                                                                                                                   |
| ---------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0 Ground   | The window frame: the title band and the sidebar's area. Sidebar rows sit on it, with no panel behind | the sidebar colour (the ground; in light a step darker than a panel)  | none                                                                                                                                             |
| 1 Panel    | The thread stage, each dock tool tile, the bottom panel; 12px corners                                 | `--octant-panel-surface`, with `--octant-panel-sheen` in its top 72px | `--octant-shadow-panel`: top rim, ring, a hairline, a short and a long seat shadow                                                               |
| 2 Card     | An object on a panel: a tool card, an approval or decision card, a user bubble, a Settings group      | `--octant-card`                                                       | `--octant-shadow-xs`, `-sm`: top rim, ring, a sheen at the top, a short drop (`--octant-card-drop`)                                              |
| 3 Control  | A filled button, a chip, the selected list row, a segmented switch's thumb, the composer pill         | `--octant-control` and the control lift (lighter on top)              | `--octant-shadow-control`, `-md` (the pill, with a longer shadow), `-selected`: light top line, dark low line, ring, a short drop; pressed sinks |
| 3 Well     | A segmented switch's track, a capsule of history buttons, a command block                             | `--octant-well`                                                       | `--octant-shadow-well`: an inner top shadow and a light line under the bottom edge                                                               |
| 4 Floating | A menu, popover, hover card, toast, dialog, the Settings sheet                                        | `--octant-float-glass` over a blur, with `--octant-float-sheen`       | `--octant-shadow-overlay`, `-pop`: the brightest rim, a hairline outside it, a short shadow that seats it and a long one that lifts it           |

- **The light an edge catches is the rim** (`--octant-rim`,
  `--octant-rim-top`, `--octant-rim-float`, and the control's
  `--octant-control-top`, `-low`, `-rim`). In dark a shadow cannot be seen on a
  near-black page, so the fill and the rim carry the lift (on an OLED preset
  the panel is a step toward the ink and the sheen lifts its top) and the
  shadow helps only where the surface crosses something lighter; in light the
  top line is white and the shadows carry it. A panel's own content paints
  over an inset shadow on its box, so the rim is drawn by a pseudo-element
  above the content and the box keeps only the seat shadow. A surface that also drew a
  border or a second ring on the same edge showed two lines, so the rim is in
  the shadow token and the border is gone.
- **A control is a raised tile.** A filled button (default, solid, outline,
  secondary), a chip, the selected row and a switch's thumb take
  `--octant-shadow-control`: a lighter top, a light line along it, a dark line
  under the bottom edge, a ring, and a short drop; pressing inverts it and
  sinks it (`--octant-shadow-control-pressed`). The gradient is drawn as an
  inset shadow (`--octant-control-lift`), so a recipe that sets its own fill
  still gets it. The primary button is the accent as a gradient with a soft
  accent glow under it (`--octant-accent-sheen`, `--octant-shadow-primary`);
  the composer's send is the primary once there is something to send. Ghost,
  link, bare and the suggestion chip stay flat until pointed at, as do the
  quiet controls of a row (the line under a composer, the microphone). A
  toggle that is on (the dock and bottom-panel buttons in the title band, a
  tile's open menu) is a control pressed in: a filled tile with the sunk
  shadow, told apart from the pointed-at wash and from the deeper press.
- **A well is cut in**: darker than what it is in, an inner top shadow, and a
  light line under its bottom edge. What is chosen in a well is a raised control
  again (the thumb of the Work and Code switch).
- **Floating surfaces are frosted.** The fill is the float colour at 88% over
  a blur and saturation lift of what is behind it in the page. The blur is not
  asked to frost the desktop: a packaged window's native material is not
  re-blurred by a backdrop filter, so Glass tints the panels instead (below).
  Reduced transparency and increased contrast take the opaque float.
- **The inverse tooltip takes no bevel.** It is the primary text as a fill, and
  the raised elevation's white top line drew as a light seam on the dark pill
  in light, so it takes the two shadows alone in both modes.
- **What sits on a floating surface is based on that surface.** Its control
  fills, its pointed-at row and its hairlines step up from `--octant-float`
  (`--octant-float-control`, `-hover`, `-pressed`, `-line`); the page's own
  control fills are darker than a lifted menu and showed there as dents.
- **The row a list is showing is a raised control** (`--octant-shadow-selected`,
  the control's shadow), on the thread list, the sidebar and the Settings
  rail. The row under the pointer stays a flat
  wash, so "here" and "pointed at" are two states.
- **On Window glass** the panels are a tint of the theme colour over the
  window's native material (more opaque for the thread, so text stays on a
  quiet ground), and a card takes a light rim and a shadow that can be seen on
  the desktop behind it (`--octant-shadow-raised-glass`); the opaque border is
  near black and drew a heavy outline there.
- **Where contrast matters the paint stays flat.** Increased contrast drops the
  lift and the sheen and keeps the rims; Mono keeps the same material.
- A shadow or a rim never decorates a flat row: plain lists, empty states
  and headers stay on the page.

(Every card and popup drew the theme's one floating colour, a hair off the
page, inside a hairline. On an OLED preset a menu was a black box outlined on
black, and a pointed-at row could not be seen.) A card is for a discrete object a person acts on
as a whole: a count tile, a live running-thread card, an action tile, a board
card, a provider, a Settings group of rows (see "Page shell"). Plain lists, empty states, and
headers are never cards. A button shaped like a card asks the shared button
recipe for its `bare` variant, which draws nothing, and the feature stylesheet
owns its face; every other button keeps the recipe's paint.
A row of suggestions to type or pick takes the `chip` variant (an outlined pill
that is quiet until hovered); a one-off kind beside its recurring siblings takes
the badge's `dashed` variant; and a field whose frame a feature draws (a search
box inside a toolbar, a stepper's middle segment) passes `unstyled` to the input
recipe, as the composer prompt does for the textarea.
Single-line inputs, text areas, and selects share one field paint, defined once
in `apps/web/src/ui/shadcn/field-paint.ts`: the strong border and no fill at
rest, the muted-text border on hover, and the control hover fill on keyboard
focus; an invalid field keeps its danger border in every state. A feature's
stylesheet lays a field out (width, height, type size) and never repaints it,
so the three react alike in light and dark. A search or name field a feature
draws for itself still takes its edge from the same role (`--input`, the strong
border), not from the hairline or a control fill.

The window is a frame and its panels. The title band and the sidebar are the
frame (level 0): the window surface, painted once, with the sidebar's rows
sitting on it and no panel behind them. The thread stage, each tool tile in
the dock, and the bottom panel are separate rounded panels (level 1,
`--oct-radius-md`) under the title band, with the frame's 8px gap between them
and 8px short of the window's right and bottom edges. A tile is a panel of its
own, with the same gap between tiles as between the stage and the dock, on the
same top and bottom lines as the stage; the gap is also the divider's hit
area, and its line shows only while it is pointed at. The gap is the frame
showing through, which is why a panel reads as an object seated on the ground
and why the glass shows between panels. (The window was once one sheet divided
by hairlines, which read as flat; before that, cards on a back of the
sidebar's material, which the glass reached only in a sidebar strip.) The
sidebar's own corner and edge went with the sheet. Pane headers and dock tabs
stay in the title band. With Glass on, the ground and the panels are the Tint
over the window's native material: the panels are a lighter tint than the
ground; every panel (the thread, a tile, the bottom panel, the dock's
overview) is the same one fill (`--octant-panel-fill`), over a ground that is
itself a tint, so text reads on a saturated desktop. Reader pages inside the
stage are clear. Behind every page the application ground lies on the
thread's panel, under the content, taking the panel's corners. A pane header
and the dock head share the title rail (`--oct-title-rail-h`). A native
Browser page inside a tile is placed by the tile's measured rectangle and is
square; the corner of the page inside the tile belongs to the web renderer
only. At 680px and below the workspace sidebar is an overlay drawer and the
frame stays flat, with no panels, and a scrim (`--octant-scrim`) dims the
page behind it. The drawer
starts closed on every load, closes on Escape, on a tap outside it, and on
choosing somewhere to go, and never changes the saved wide-window choice.
Settings keeps its own narrow layout, a drawer with a flat page, at 960px and below (see [breakpoints](#breakpoints)).

Settings opens as a sheet over the app (`OctantSheet`): a floating surface
at most 1040 by 760px, on the float fill with the pop shadow, over a light
scrim through which the window stays drawn. The app behind it is mounted and
live, so a change to the theme, the accent, the type or the sidebar shows
where it lands while the control is still under the pointer. As a page that
replaced the window, Settings showed none of what a change did until a person
went back. The sheet holds the Settings rail and the page, divided by one
line; the rail is 232px wide there and is not resized (the saved sidebar
width is the full-window page's). A section's card steps up from the sheet's
own fill. A native Browser page leaves the window while the sheet is up, as it
does for a dialog. It closes with the
close control in its corner, with Escape, or with a press on the window behind
it, and focus returns to where it was. It carries no "Back to app": the person
never left. The presentation is decided when Settings opens and kept until it
closes. The sheet arrives and leaves with the shared
[overlay motion](#motion-and-interaction); it stays mounted while Settings is
closed so that its leaving can be seen. While Settings loads, the sheet shows
Settings in outline on its own fill, inside its own box: a rail and a page of
skeleton bars (`SettingsLoading`), styled with the shell and not with
Settings, whose own stylesheet is part of what is still loading. In a window at the narrow breakpoint Settings covers the window, as
before, with "Back to app"; a sheet open while the window is made narrow
fills the window and keeps its page. The Usage page still covers the
workspace at every width.

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
columns may use all of it. Settings is the same shell with a 920px measure and its own
navigation rail; the rail names each group of pages with a quiet label and
draws no hairline between groups. There are six groups, each one question a
person brings to Settings, and a group lists its pages in this order: General
(General alone: who you are, app-wide defaults, and what Octant tells you), Look &
feel (Appearance, Sidebar, Keybindings), AI (Providers & Models, Octant Harness,
Voice & images, then Chat, Work and Code: which provider or model answers each
job, and how each mode starts), Tools (Skills & Extensions, Computer use, Device
tools, GitHub, Linear: what a running agent may reach), Safety (Permissions,
Secret stores, Memory: what an agent may touch, reach and remember), and
Data & devices (Data & storage, Sync, Remote access, Host, Usage: what this
computer stores and the other machines it talks to). An earlier Privacy & data
group had grown to seven pages answering three different questions, Modes stood
apart from the models its pages choose, and Advanced held two pages. General
opens on Your identity (the profile) and ends on Notifications (what Octant
sends while a person is away); Permissions holds the files no agent may touch,
then the network places and servers agents may reach (Network limits, Safe
networks, Servers), then what a person has already allowed (remembered
websites, remembered tool approvals, public links). Profile and Notifications
were pages of one and two controls, and Access was the other half of the
question Permissions answers, so the rail listed three pages a person rarely
needed alone; links to those pages open the page that holds them now. Data &
storage holds what the host keeps (data map, caches, backup, recovery, export,
retention, purge). AI
lists each provider kind on the page of what it serves: Providers & Models
holds the agent runtimes Octant drives (ACP agents, CLIs, the Agent SDK, RPC
runtimes), and its manual add form offers only those kinds. It opens on the
person's providers and their Defaults, then Find providers and Octant's own
OpenCode copy, with the Provider catalog under them; Octant Harness
opens with Model endpoints, every endpoint Octant calls over an API itself
(OpenAI-compatible, Anthropic-compatible, Ollama, Azure AI Foundry), followed
by model roles, helper agents, and Navigator's models; with no endpoint yet it offers three ways
in instead (Sign in with ChatGPT, Sign in with OpenRouter, Add endpoint), each
sign-in one click with its terms as a consent line under the button. Voice &
images holds speech, transcription, the image profiles, and custom image
sources. The Provider catalog lists every bundled driver of both kinds and
sends each one to the page that configures it. A sign-in
endpoint's row says who is signed in, its detail page offers sign out and
sign in again, and its configuration fixes the base URL and asks for no key. The
instances, commands, and credentials are the same on every page. A setting lives
on the page of the thing it changes, and a moved setting keeps answering links
to its old page. Look & feel holds Appearance (theme, window glass, background,
text, accessibility, and Reading: transcript text size and width, Reply detail,
the stats line and the usage bars) and a separate Sidebar page (layout, destinations, sidebar
background, and a thread-row grid of detail by list). A page names its scope once, under its title, and a row names
its own only when it differs. Settings folds long choices it does not need
open: the built-in background pictures sit behind the current one and a
Change action, and the pattern dials appear only while the pattern is drawn.
Rows in Settings are `SettingRow`; rows everywhere else are `surface-row`. Both
draw the same hairline.

Every Settings page is built from one kit, in `settings/primitives.tsx`:

Selecting a page replaces its controls as well as its heading. Plugin pages
resolve the currently selected entry point; a missing entry point shows an
error instead of retaining another integration's account controls.

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
- **Search.** The search field is always shown at the top of the rail, under
  the "Settings" heading, with its shortcut (Cmd/Ctrl+F) at its trailing edge
  until something is typed. Every typed word must match the start of a word in
  a row's name, keywords, or page, in any order; filler words ("my", "the")
  are ignored, and everyday words map to the rows' own (dark mode → colour
  scheme presets, password → credentials, delete → purge, telemetry → what
  leaves this machine, connector → MCP). Results rank a row named by the query
  above one that only lists it as a keyword, mark the matched part of each
  name in weight rather than a fill, and name the page. Enter opens the top
  result, Down moves into the list, and Escape clears the field, then leaves
  it. Every Settings row a person can see is indexed; a test fails when a new
  row is not.

### Content tabs

Workspace content and dock tool tabs share a compact 26px recipe for height,
spacing, selected fill and edge, and close controls. A pane's conversation tabs
then become a row of equal soft pills, 28px tall at a shared 196px (never
narrower than 112px), 8px apart: every tab carries a faint wash of the ink, the
hovered one a little more, and the open one the brightest wash with a hairline
edge, so the row reads as a set of open conversations rather than a line of
links with one highlighted. A pane tab's own button spans the whole pill with
the × laid over its end, so the shared keyboard focus edge outlines the whole
tab: drawn on the label alone it boxed the title and left the × outside. A tab whose
thread runs shows a spinner in place of its provider mark; one waiting on the
person ends in a small dot in the warning ink. A tab picked for side by side (Cmd/Ctrl- or
Shift-click) sits a step between the two, with a fainter edge. Dock tool tabs
keep the bare recipe. Close controls retain their
width; inactive controls appear on hover or keyboard focus and stay visible on
touch devices. Thread tabs retain provider marks when enabled. The pane's drag
handle stays quiet: an environment mark (a 20px neutral tile, laptop for this
computer, cloud for another host), the thread title at the sm step in medium
weight, a pill chip naming the Project in meta ink, and in Code a second
chip naming the checkout's branch in the mono identifier face — no provider
mark. The two chips shrink before the title does. While the host projects the
thread as executing, a "Running" pill with a small spinner follows the chips.
The host reports that a turn is executing but not when it began, so the pill
names the state and claims no elapsed time. A thread parked on the agent's own
approval, or on a question its turn asked, shows "Needs you" in its place,
without the spinner. See
[Workspace](docs/design/workspace.md).

### Welcome and composer

A thread's subagents sit in a card attached above the composer's message
surface, edge to edge with it so the two read as one stack. The card
participates in normal layout so expansion cannot cover the preceding task list
or transcript. Cross-context notices share the same flow;
they never hide failed children or results needing review. The card starts
collapsed and remembers the viewer's fold choice. Its head names every state
the children are in as counts of that state ("1 failed · 1 to review · 1
working · 2 done"), attention states first, with no unexplained total. A result
counts as to review only while a person can still act on it: one the host has
already delivered to the parent, or the parent consumed through its own tool,
is done, because it sits in the thread as a child-result card. A truncated list
says earlier children are not retained. While a Chat thread's host cannot be
reached the card dims and withholds Stop; the thread's connection notice says why.
Task-plan completion is never counted as child completion. View all opens the
full Agents list even when every child has finished. Expansion previews at most
three active or unresolved children; longer history stays in Environment and
Agents. Compact rows show task, semantic status, recorded model and available
activity. Age is explicitly time since the last update or first observation,
never inferred execution duration. Raw identifiers and workspace paths belong
in details. Rows open the child in Agents. Only managed active children offer
Stop; Stop all asks first and names its managed scope. Headers and rows wrap at
narrow widths, disclosures work with the keyboard and retain visible focus,
and expanded lists have bounded height.

A result the host delivers into the parent thread is a turn the person did
not write, so it never renders as their right-aligned bubble. It is a
left-aligned child-result card in the thread's measure: a status mark and
"<Role> subagent finished" (or the state it stopped in), the provider and
model, the task in meta ink, then the reply as Markdown, folded after about
eight lines behind Show full result. A subagent that stopped gives the host's
recorded reason in place of a reply. Run ID, generation and provider ID sit
behind a Details disclosure. The card is one component in Chat, Work and
Code; a delivery the card cannot read is shown as its text under a plain
"Subagent result" head.

Provider-observed children remain separate from managed runs. Their detail shows
reported activity, observation timing, available lineage and explicit partial,
truncated or conflicting history. An unknown model stays unknown. Observations
have no managed conversation, execution controls, workspace authority or result
acknowledgement.

Managed result previews identify their execution generation and recorded model.
The result detail leads with the reported summary, files, checks and blockers;
exact run, parent, provider and workspace attribution is available in a separate
disclosure. Earlier generations keep their own attribution and evidence. Missing
or truncated results stay explicit. Provider-reported files remain unverified;
recorded tool output is inspectable without claiming that tool completion means
a check passed. A recorded Code generation offers Review changes and links its
captured paths into the existing Review surface. The saved comparison identifies
the child, generation, workspace and capture time; its partial and binary content
states stay explicit. It offers no staging, discard or parent-checkout editor
controls. Unavailable capture stays unavailable. Evidence references are disclosed
on request rather than presented as unsupported navigation links.

A reply's suggested follow-ups sit as cards at the foot of the thread, just
above the composer, so the next task reads as the last thing the agent offered.
Each card is the radius-md bordered card on the surface fill: a small meta line
naming where it would run ("New task", "New task · own worktree", "Next step
here"), a dismiss control, the title at medium weight, two clamped lines of the
prompt in secondary ink, and one outline **Start…** (or **Use here…**) button.
Start… expands that card into a preview sentence of exactly what it would
create, with Cancel and **Start** (or **Use prompt**); nothing is created
before that. The same open suggestions also stand in a "Suggested tasks" card
at the top of the thread's Environment panel, without a second border, so an
offer the conversation has scrolled past stays in reach; it shows only while a
suggestion is open. A thread started from a suggested task nests one step in
under the thread that suggested it in the sidebar, joined by a thin hairline
elbow, even when it runs on its own worktree; the host remembers that link
past later replies and restarts, and answers it to a window only for threads
its sidebar already lists. A task whose parent is not in the same list stays
where it is. Side-task offers stack above them as hairline cards: a target icon
(branch for a worktree, new-message otherwise), the title, a dismiss control,
the one-line reason, a collapsed "Prompt" disclosure, and one primary
**Start in new worktree** / **Start in new thread** button.

A thread's stats line sits under the follow-up composer, on the page rather than
in the box, where a person reads the last turn's figures after sending. Above the
box, one strip holds where the thread runs (Project and branch) on the left and
the plan meters described below on the right, so the box holds only the message
and its controls. The stats are one row of figures at the 12px meta step in the
meta ink, separated by middle dots, with no hue on any number and no fill on the
row: the thread's turns, input and output tokens, thinking tokens when the
provider reported them (part of the output), the cache hit, speed, first token,
and cost. The turn count never stands alone. Where the plan meters have no strip
of their own, they lead the row. It wraps at narrow widths rather than scrolling,
and a trailing quiet icon button hides it. A figure
that is approximate carries a leading tilde and a dotted underline that explains it on
hover; a figure the provider did not report is absent, never zero. The whole line is one
button that opens the per-turn detail dialog, a plain definition list of tokens, timing,
and cost with Previous and Next turn controls.

**Plan meters.** Remaining plan usage stands beside the composer, right-aligned on
the same row as where the work runs: the row under a thread's box, and on a
start screen the end of the context-chip row above the card (it drops to its
own right-aligned line when the chips leave no room). A meter is a bar and the
share **left**: `▬▬▬ 28%`. The bar is a 56px groove 6px tall with a raised
fill (the pressed-control inset on the track, the bevel's highlight on the
fill); the figure is in the primary ink at medium weight, in tabular numerals,
at the 12px meta step, with no fill behind the row. One meter carries no name:
the bar and its figure say what it is, and its tooltip and accessible name say
which window ("7-day limit, 28% left"). When a provider reports two windows
the shortest and the longest stand side by side, and only then does each lead
with a quiet name in words, `5h ▬▬▬ 85%  week ▬▬ 43%`, because two bare
figures cannot be told apart. (The single meter read `wk ▬ 28%`: a code to
look up beside a hairline.) They describe the
provider the composer will send to (a start screen follows the model menu's
choice) and read the same host observation as the rail's rings, picked by window
length (`windowSpan`). A provider that reports no window gets no meters, never
an empty bar. The fill is the theme's accent role (`--oct-accent`, the ink under
Mono); a window with a fifth or less left takes the warning ink and
a spent one the danger ink. The Appearance setting **Usage bars** (`usageBars`,
Settings › Appearance › Reading) chooses the bar: **Smooth** (default) is a
three-pixel rounded line; **Pixelated** is a 17 × 3 grid of 2px square cells with
1px gaps, lit in the same accent, whose last four columns thin out in steps (two
thirds, a checker, a third, a stipple) so the fill dissolves at its leading edge.
Neither animates, so reduced motion needs no variant. The composer row keeps its
controls: the access chip carries its shield icon beside the label, the model
button names the model with a chosen effort in muted ink, the microphone sits
just before send, and send is the round accent-filled button with an up arrow.

**Usage-limit warning.** On a start screen, when the chosen account has a window
that is spent or at 80% used (the same levels the meters colour), a warning
callout takes the full row above the context chips, in the row above the
card: which account, that it has
reached or is close to its usage limit, and the reset time the provider gave.
For each other ready account that has room (an observed window below the near
level; an account with no observed window is never offered as having room) up to
three `Use <account>` buttons follow, each choosing that account and its model
(the current model when it lists it) exactly as the model menu would. Nothing
switches on its own and the warning never blocks sending: the provider's own
limit decides whether a turn runs. The model menu's rail lists accounts with
room first and the ones at their limit last, in the person's own order within
each, and marks a limited account with the danger dot and "Usage limit reached"
(a near one with the warning dot and "Near usage limit"); a readiness problem
takes the dot first.

Work follow-up composers use the same attached context strip as Code, showing
the project and working folder instead of Git controls. Full paths require a
matching project binding revision; missing metadata never borrows another root.
The strip stays mounted while metadata loads, and full paths are available in
tooltips. Code retains its checkout, branch, diff, and pull-request controls.
Pane headers show thread titles without repeated project labels.

Chat, Work, and Code open on the same screen: one question in the middle of
the page and one raised composer docked at its foot, where it stays once the
thread starts, so the first message is typed where every later one is. Above
the question sits the Octant aperture mark (`icons.svg#aperture`) at 22px,
drawn in the primary ink and set 2px closer to the question than the
heading's usual gap. The hero asks "What are we building today?" (the hero
role: regular weight, -0.012em tracking, the primary ink in every style and
never the accent). The approved size is 24px on a 30px line; the type scale
has no 24px step and `ui:check` refuses a raw size, so the nearest token,
`--oct-text-2xl` (26px), carries it on the 30px line, and phone width uses 20px.
One quiet line under it, at the detail step in muted ink, says
"Pick a project, or just start typing". The start screen names no time of day
and counts nothing: what is running and what waits for review live in the
sidebar. Once a Code start screen has a Project chosen, its quick tools are
the Project's own Terminal and Browser (a server Project's Terminal only) as plain rows in the right dock's body,
above one muted line, "Other tools open once the task starts". They live only
in the dock: a column beside the start screen squeezed the composer off centre
and contradicted the dock, so with the dock closed the start screen stands
alone. Each opens in the dock without starting a thread, the same window-local
Project terminal and browser Zen uses, which no agent can see or reach;
"Quick tools" returns to the list, and closing the terminal (or leaving the
start screen) stops its shell, since nothing else could reopen it. The
composer never remounts when the Project is chosen, so the draft stays. Send
on a Code start screen with no Project chosen stays live and answers with one
line directly under the composer, "Choose a Project first. A Code task works in a
folder.", rather than greying out with no reason. Every
start screen's composer asks "Ask anything…", and the message field keeps its
accessible name.

The question belongs to a new task only. When the same composer serves a
decision, such as reviewing a planner's proposal, the caller replaces the mark,
question, and quiet line with a heading that names the decision ("Review the
planner's proposal") and the proposal's title, set at the dialog's top-left with
the fixed proposal text directly under them in the composer. Rendered review
showed the question above a fixed proposal read as an invitation to write a
different task.

Every composer has one shape, on a start screen or under a thread, in Chat,
Work, and Code: the same width, corner (`--oct-radius-composer`), hairline ring
and mid shadow, the same insets, and the transcript's own type size, so a
message looks the same in the box as in the bubble it becomes. The empty
prompt is one line everywhere and grows as the person types: one line with
12px above and under it is a 44px pill with half-circle ends, and a longer
message keeps the same 22px corner. Its width is the reading measure; in a split every
composer takes the narrowest pane's room, so composers side by side match
instead of each filling its own pane. A start screen's composer docks 12px
above the pane's foot, where a thread's sits, so the two line up across a
split; a start screen's card is the same box, with its row of where-it-runs
chips above it. Nothing about the box changes while a turn runs.
The composer is the pill and two quiet lines. The pill is the one raised
surface: the raised card's fill, the hairline ring and the mid shadow. The
start row above it and the line under it stand on the page with no fill or
edge, as the figures of the last turn do, so the pill is the one thing a
person aims at. Over an application ground the pill is the glass surface
(floor, thick tint, blur, and the glass stroke as its ring). Under Window
glass it keeps the blur and the stroke and takes the control tint in place of
the floor: the floor made it darker than the glass around it, a well where a
raised surface should be.
A held thread has no pill. (A tray drawn around the rows and the pill made
the composer a block three rows tall, with the pill a box inside a box.)
The pill holds what acts on the message being written and nothing else: attach
at its leading edge, the prompt, then the microphone and send (with Stop while
a response streams) at its trailing edge, the controls riding the prompt's
last line. They are 28px circles, 8px in from the pill's ends, so each is
concentric with the half circle it stands in; a square tile there left a wedge
of the pill between its corner and the curve. Attach is a plus on the quiet
control fill: it adds to the message, by more than one route in the desktop
app. Send is a quiet circle in the control fill until there is something to
send (the fill stays at full strength and only the arrow is dimmed: at half
strength the circle measured 1.07:1 on the page in light and vanished), then
the pill's one solid control: the primary text colour as its fill, with the
page colour on it. It is not the accent: a filled accent circle was the
loudest thing on the page under an empty prompt. The microphone is in the
pill because it writes into the prompt; in the line under it, it read as a
fact about the thread. A notice about sending stays in the pill, under the
prompt. How the
thread runs is one quiet line under the pill, with no fill or edge
of its own, in reading order: a thread's own context (Project, branch,
checkout), the surface's row (image and access leading; the model and then
the context ring trailing), the plan meters, and the Thread info icon
button. The context ring ends the row's run: it is the one figure there, and
at the end it does not move when the model's name changes length. Icon
controls in the line stay square tiles with the control corner; only the
pill's own controls are round. The line is one row in a split pane as narrow as 520px: a Work
Project made from a folder names that folder once, not as Project and folder
both, and a context with nothing in it holds no place. At a phone's width the
line is two rows, the context with Thread info at its trailing edge and the
surface's row under them. A thread with no place to name is two rows there too: the
surface's row on two lines, with Thread info at the end of the second. Only the
surface's row gives its controls the row's one quiet treatment; the checkout's
actions and the info panel's fields keep their own. With that row inside
it the card was a third taller than its prompt and read as a form; an empty
composer now stands 44px tall, where a reply box stood 114px before the prompt
went to one line.
The model button names a chosen reasoning effort after the model in muted ink
("GPT-6 Astra Medium"); the provider default names none. Where the thread runs
(Project, working folder, base branch, checkout, Environment, repository) is
one row just above the pill, as quiet chips set together from the
left: meta ink and no fill at rest, a fill only under the pointer or while the
chip's menu is open, the same as the access and model controls under the
pill. Plan meters keep the right end of that row. The pill itself holds only
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
arrives and leaves with the shared [overlay motion](#motion-and-interaction).
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

**New task**, in every mode, is the question and the composer and nothing
else; Chat and Work add one row of outline starter chips only before the
mode's first thread. **Code Home** is where Code lands with nothing chosen:
the same question and composer, then Code's prompt suggestions, the card area
(a **Customize** control and the cards, on by default), and Code's agent home
(Up next and Continue). There the page scrolls and the composer sits under
the question. The cards appear on no other start screen. Neither screen has
tabs or action tiles: adding a folder lives in the composer's Project picker. Their anatomy is in
[Start screen: presentation](docs/design/start-screen.md#presentation); their
behavior is in [Workspace](docs/design/workspace.md#start-screen-cards).

First-run setup asks only what a first task needs — a usable provider, a
Project folder, a model, and the
[mode](docs/architecture.md#security-and-authority) new threads start in
(Auto pre-selected and marked Recommended, then Ask first, Accept edits, Plan,
and Full access, in that order; Full access reads "No sandbox, no prompts"
and is never pre-selected; Auto uses the provider's own reviewer or
[Octant Shield](docs/architecture.md#octant-shield), so it is listed for every
runtime, and where no reviewer can run the picker shows it unavailable with
the reason; the pick becomes the default for every new Work and Code thread
until changed in Settings › Work or Settings › Code, or for one Project) — and ends in one primary action, Start a task,
that opens the new-task composer in that Project. Every step is optional from
the first one. Opening setup focuses the current step's heading so a long
provider list does not scroll past its introduction; Tab then reaches the
step's controls. Skipping preserves settled answers, waits for pending writes,
grants no authority, and creates no thread: provider, Project, model, and
permission readiness are checked again when work is requested. After Skip, or
in a later session with no ready instance, the New task composer in Work and
Code shows a primary **Set up a provider** action that opens Providers &
Models and returns to the same draft. The action leaves once any instance is
ready; the model picker takes its place. Profile,
appearance, the mode switches, and Navigator are not first-run steps: Profile
lives in Settings › General, Appearance in Settings › Look & feel, and
Navigator's models in a section of Settings › Octant Harness. No display name is inferred from the OS account. Continue retains
compact recent-task rows and their status and Git cues.
Empty Code entry offers folder setup and a direct route to Code settings; opening
that setting never turns on projectless threads.
A Work or Code pane with no thread and no Project asks one centred question
("Pick a folder to work in"), says in one sentence what choosing a folder
means, and offers Choose a folder… as the primary action with starting
without one beside it; once a Project exists the new task leads instead.
Start-screen composers ask in plain words ("Ask anything…"); a thread's
follow-up composer says "Reply…" in Chat, Work, and Code, and shows no rotating
tip. When the latest reply suggested a next message for this thread ("Next
step here"), the empty follow-up composer shows it in place of "Reply…", with a
quiet Tab key cap at its top-right, and a bare Tab puts it in the draft and
marks the suggestion used; once anything is typed, or with a modifier held,
Tab keeps its ordinary meaning.

The compact model picker uses explicit horizontal provider selection, sub-provider
grouping, search, Favorites, and Recent. Source tabs are marks alone and name
themselves in a tooltip. The picker of a thread whose model can no longer
change (a completed Work thread, which passes `locked`) keeps the name in the
ordinary meta ink (the blanket disabled opacity left it at 2.11:1) and looks
unpressable by its dimmed chevron, default cursor and absent hover; a picker
disabled for any other reason, such as a running turn or no ready provider,
keeps the ordinary disabled look. The chosen model carries a check, not a
filled row; a row's star shows on hover, on focus, or once it is on; and a
provider mark leads each row only in a list mixed from several providers.
Choosing a model keeps the menu open, since the
reasoning level beneath is often the next choice. Its reasoning control shows
the full track, discrete stops, and filled range, with the reading ("Reasoning
High") and reset above, and Faster and Smarter at the track's two ends. The fill
is a dot grain that grows denser, brighter, and more purple, with a soft glow,
the higher the level; a chosen level shows at once and never snaps back while
it saves. Explicit model and reasoning choices are remembered
locally for new threads; model settings are keyed by provider/model and restored only
while supported. Existing thread selections remain authoritative. The same picker
shows every declared model setting in Chat, Work, and Code. Paired model families
show Lead and Sidekick selectors drawn from available catalog entries; choosing
one preserves the other choice and carries still-supported explicit effort and
speed settings. Devin's Speed selector offers Standard and Fast where the CLI
supports Fast Mode, plus Default to use the provider's choice. The settings area
scrolls within the bounded popup at narrow or short viewport sizes.
Model choices and settings wait for an asynchronous model change to finish before
accepting another edit, so the next configuration choice uses the confirmed pairing.

The screen sits on the application ground, set as two plain
choices. What: one of the first-party Zen pictures, a person's photo, a field
of pulsing characters, a field of dithered pixels, a flowing colour field, or
the plain page. A fresh install starts on Soft glow, one of three Gradient
pictures (Soft glow, Graphite, Sunset) that each carry a light and a dark
print, so the ground follows the window's scheme; the stylesheet swaps them
by `data-octant-theme-mode`. A settings row written before the ground
existed replays as the plain page it showed. Effect: the picture is shown as it is, pixelated, or
dithered, at a chosen pixel size and colour count; an animated picture is
printed from its still frame. A printed picture is still unless a person sets
its Motion to Wave: then a click on a start screen pushes a ring outward
through its cells, each cell sampled from a little further in as the ring's
edge passes and lit toward the accent through the same dither, so the ring
stays in pixels; between clicks the print rests and draws nothing. A ground
saved with the retired dot pattern resolves to the plain page. Dithered pixels
is a drawn ground of square cells in the theme's primary ink, at most about
two-fifths opaque, whose brightness drifts in slow overlapping waves at twelve
frames a second and prints through a 4×4 ordered dither (or plain pixels) at
the chosen pixel size and number of shades; a click on a start screen sends
the same pushing, accent-lit ring through it at twenty-four frames a second,
for under two seconds. Flowing is a drawn ground of large, soft, edgeless
colour that drifts like ink in water, and only when a person picks it. Four
stops are taken from the theme's accent in OKLCH — a near-black deep tone, a
dark saturated reading of the accent, a brighter accent tone, and a vivid glow
with a slight hue shift — so a change of accent recolours the field over about
600 ms. Dark mode is predominantly dark: near-black at the top-left, the dark
accent through the middle, and one luminous corner at the bottom-right, never
a pastel wash. Light mode inverts that ramp into a pale wash whose every stop
still clears WCAG AA against primary text. The field is painted in one GPU pass at about half
resolution and thirty frames a second, paused while the window is hidden or
the ground is off-screen, and falls back to a few blurred radial gradients
that use the same stops when that path is unavailable. A static grain at a few
percent of opacity and a quiet vignette sit on top of either path so the wash
does not band. It answers no clicks. Motion Still holds it on one frame; Wave
lets the colour keep drifting. Reduced motion holds it still. Pulsing characters is the other drawn ground, and only when a person
picks it: a grid of monospace letters and digits in the theme's primary ink,
at most half opaque, whose brightness drifts in slow patches and breathes as
a whole at twenty-four frames a second while a few glyphs swap. The field is
drawn on the GPU in one pass, because painting each lit cell from the CPU was
the cost (ten to sixteen milliseconds a frame at the larger window sizes,
against a fraction of a millisecond on the GPU). A click over it
on a start screen (behind every page, only there; a click in a thread or a
list sends nothing) sends out an uneven ring of glyphs in the theme's accent whose edge wobbles as
it grows, trailed by a fainter echo, and about one click in six draws a heart
instead, and fades within two seconds. With the Mono style the ring
is the ink, only brighter; the accent colours it otherwise. It carries no picture, so the effect controls do not apply, and it
pauses while the window is hidden. Reduced motion holds it on one still frame
and takes no rings. Behind a
start screen the ground is masked away behind the composer and fades out below
it, so the prompt and the recent-thread list read on the plain page; in the
light theme it fades out sooner, because dark text over a pale picture has
less contrast headroom than light text over a dark one. A person
may instead put the ground behind every page, from the workspace's leading
edge, and under the sidebar too when they ask for it (see Shapes and depth). Every
surface that shows text or information softens it beneath one continuous
reading veil, the sheet colour at 80%, so it shows at about a fifth of its
strength and agent replies remain bare prose: a thread, every other pane
(a Project's page, Settings, a file, a preview), and every destination page
(Inbox, Board, Archive, Review, Projects, Agents, Automations, Artifacts, Image
generator). A start screen (a welcome or a new thread) is the one exception and
stays open on the ground. The veil is one rule in `surface.css` keyed on the
pane kind and the destination layers, never a colour per screen; a page drawn
over the panes clears their veil so the two never stack. Increased contrast turns the ground off; reduced motion
shows an animated picture's still frame. It is chosen in Settings ›
Appearance › Background. The phone shares the same pictures and print effect under
Appearance › Background.
When the ground runs behind everything, a start screen's reading column
carries a soft wash of the page colour that fades out before the edges (under
Glass the ground steps down instead, and the question and its hint carry a
thin glow in the page colour), and a
conversation pane's title rail shares the conversation's reading surface, so
no text sits straight on a busy photo.

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
denser controls, except that recipes paint no focus ring (the global
`:focus-visible` rule is the only keyboard focus treatment) and the badge and
the card keep the shape and elevation set in this document. This
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

### Turn header

Every assistant reply in Chat, Work, and Code opens with the same line: who
answered (provider and model as the picker names them), how the turn stands
(Working…, Waiting for approval, Completed with how long it took, Failed with
the host's sanitized reason on the line below), and when it last changed at the
right edge. It is set in the interface face at the detail size; only the status
word carries colour. `TurnHeader` in `apps/web/src/transcript/` is the one
recipe; a mode maps its own lifecycle onto its vocabulary and adds nothing of
its own.

### Transcript

The rest of the thread view is one set of recipes in `octant.css` and the
reply prose in `chat.css`, worn by Chat, Work, and Code alike; a mode positions
them and repaints nothing. The scroll frame (`transcript-scroll`) keeps 20px
between rows. A person's message is a right-aligned bubble (`turn-user`,
`bubble`: control fill, hairline, `--oct-radius-md`, no shadow) with its time beneath
it (`turn-time`: detail size, muted, right edge), and carries 12px more air
above it than the reply before it. A reply (`turn-agent`) is bare prose at the
transcript size with 1.5 leading, with no card of its own: only the work a turn
produced is boxed. Over the application ground, the conversation supplies one quiet,
continuous reading veil below the title band: the sheet colour at 80%, so the
ground stays faintly visible behind the transcript. Replies remain bare prose, including on translucent
workspaces; user bubbles and the composer retain glass over the application
ground. Under Glass the thread's container stays clear, the ground steps down to an eighth of its strength while a thread is on screen, and keeps a quarter of it under the sidebar, so it never reads as letters behind text. Reduced transparency keeps the reading background opaque.
Under window Glass the page is the desktop seen through the window, so nothing
inside the shell is filled with one of the theme's opaque colours: the control
fill (a secondary button, a segmented control, a select, a chip, a ghost
button's hover) is the primary text at 7%, 11% hovered and 15% pressed, the
step the theme's control sits above its own page, and the composer and the
person's messages are a 30% veil of the page colour under the primary text at
6%, with the glass hairline. What is chosen (the mode in the switch, a
selected row) is the primary text at 12%; a switch's track at rest is the
pressed control tint and its thumb, off, the primary text at 62%, so it is
never the page's black on a dark track; a toned notice's ground is its tone at
14%, and a plain notice takes the control tint. The shell's own loading state
(Opening Settings) is clear on the shell's surface, where the opaque page
colour turned the whole window black for the moment Settings took to load. The
window's own loading state, before any shell exists, is clear on the document's
ground (the page colour in a browser, the app ground in a native window, the
desktop through the glass once the host's glass is on), and the first frame is
drawn in the mode the last window used, remembered in the renderer's storage,
so a light theme never opens on the dark default. A native window is shown
only when its first frame is ready; a glass window is created clear, and an
opaque one keeps the window's own dark fill until the renderer paints. On an OLED
preset over a bright desktop the opaque fills stood as near-black blocks on
mid-grey glass: every Settings button, each message and the composer. Menus,
popovers and dialogs sit outside the shell and stay opaque, and reduced
transparency keeps the theme's own fills.
The follow-up composer has 24px of space above it outside the transcript
scroll frame, so a reply never touches the input. Running text, tables and code
blocks all run the column's width, which is the reading width the person chose,
and end on the same edge as the divider, the bubble and the composer (a 72ch cap
on prose stopped paragraphs at about 635px at every width past Narrow, so the
setting only ever moved tables); markdown headings inside it are headings on
the type scale (20/17/15/14 at weight 600, 24px above and 12px below), lists
sit 4px apart, and a fenced block is a
`CodeBlock`: a 28px header strip naming the language with a ghost copy control,
then detail-size mono on the application ground. Tool rows are 28px each, the
name at the body size and the state at the right as detail text with a 12px
mark (spinner, check, cross), parted by hairlines and indented together; at
the default Reply detail (below) a settled turn folds them behind "N tool
calls". An approval Octant Shield
answered is a 28px line among them, not a disclosure: a 14px shield mark
(check, alert, or cross, the cross in the danger ink), "Octant Shield
allowed", "asked you", or "denied", the call in detail-size mono, the
one-sentence reason in the muted ink, and the rule or model and the latency
at the right as detail text. It always names Shield, never the provider, and
does not count as a tool call. A Code turn that changed files ends with one card, the only card in a reply: "N files changed while this ran", then a 28px row per path with the folder in the meta ink, the name in the primary ink, and the added and removed line counts in the diff inks at the right. It folds after five rows, says "Showing n of N" when the record is incomplete rather than summing rows it never saw, and never says who wrote a file. A turn paused on the person uses a neutral composer-adjacent request row with
an icon and explicit answer controls. Follow-up composers use one compact
hairline message surface across Chat, Work, and Code. Feedback above the toolbar
appears only when it has content; empty feedback consumes no space. A held
message queue with items still waiting shows a compact **Follow-up paused**
chip and **Resume** next to the composer; the expandable queue still lists
the items and the specific hold sentence. Long notices
remain accessible and scrollable. The access menu holds the optional provider
approval-review choice and starting-profile detail. The Code checkout strip is
attached underneath, rather than floating above the input. It keeps its height
and border when checkout metadata is unavailable: missing project, branch and
diff values stay blank, and unavailable checkout actions are not shown. Input growth from
extra typed lines and visible notices is intentional. Repository, branch
and PR actions stay visible below the input. Utility panels keep one resize
boundary and a compact tab row without a second horizontal divider.

**Reply detail** chooses how much of a turn's work the transcript shows open.
Settings › Appearance › Reading › Reply detail (`replyDetail`) is the default
every thread starts at: one `OctantToggleGroup` of three levels whose
description reads "Where every thread starts unless it sets its own." followed
by the chosen level's sentence. A thread may set its own level, which then
stays with that thread: it survives a reload, every window and paired device
of the host draws it, and changing the default never moves it. A thread that
never chose follows the default. The levels apply the same in Chat, Work, and
Code, wherever `TurnActivityRows` and `AssistantMessageBody` draw a turn:

- **Low** (default): "Thinking stays folded, and a finished turn's tool calls
  fold behind one line." Thinking is shut, tool rows are listed while the turn
  runs and fold behind "N tool calls" once it settles, and each row's detail is
  shut. This is the transcript as it was before the setting.
- **Medium**: "Thinking stays folded with its first line showing, and tool
  calls stay listed." A shut Thinking row carries the reasoning's first line
  after its name, as plain words in the muted ink, clipped to the row with an
  ellipsis; it goes away while Thinking is open. A settled turn's "N tool
  calls" fold starts open, and each row's detail stays shut.
- **High**: "Thinking, tool calls, and each call's recorded result stay open."
  Thinking, the fold and every row start open on the summary the transcript
  already holds, still clipped behind Show all past 1,200 characters. While a
  reply streams, its thinking is open and grows as it arrives, and a running
  turn's tool rows are open; Settings › Chat › Stream replies still alone
  decides whether the partial answer shows, at every level.

The thread's own choice is a row of the thread's
[info panel](docs/design/workspace.md#thread-info) in Chat, Work, and Code. The
row reads "Reply detail" with the level in effect ("Low") at its trailing
edge, and its accessible name also says whose the level is ("Reply
detail: High, this thread's own" or "Reply detail: Low, the default"). As a
bare glyph in the composer row it read as one of two unexplained list icons.
Its radio items are **Use default (Low)**
(naming the current default; "Follow the level in Settings") and the three
levels, with short descriptions that fit a phone-width menu: "Thinking and
finished tool calls folded", "Thinking's first line, tool calls listed",
"Thinking, tool calls, and results open". A client that cannot change the
level, a paired browser, shows no menu.

**Change reply detail in this thread** (`reply-detail-cycle`, Mod+Shift+D by
default, remappable in Settings › Keyboard shortcuts) steps the thread in front
through Low, Medium, High and back to Low, setting its own level, and says so
in a status toast ("Reply detail: Medium" over "This thread:" and the level's
sentence). A thread is in front only while it is on screen: behind Settings,
Usage, Review, Zen, or any other page that covers the workspace, the chord does
nothing and is left to the browser, and the palette offers only the default's
commands. Mod+Shift+D is held by no other default, no desktop menu item, and no
macOS or Windows system chord; in a browser it is Bookmark all tabs (Safari:
Add to Reading List), which the page takes only when it changes a thread. The
command palette offers the same cycle (showing the chord), each level not in
effect for this thread, **Use the default reply detail in this thread** when the
thread has its own, and **Set the default reply detail to …** for the default.

The level is presentation only. It never changes what a model is asked or what
a client fetches, and a row with no recorded summary says so rather than
showing more. Every disclosure stays native, with `open` and `aria-expanded` in
step, so a person can open or close any one by hand; that choice holds for that
disclosure while the turn stays mounted and the thread's level is unchanged,
and a change of that level (its own, or the default it follows) puts every
disclosure where the new level puts it. The first line beside Thinking is
hidden from assistive technology: the button's name stays "Thinking", and the
same words are read from the body once it opens. Nothing animates beyond the
chevron's turn, which reduced motion stills.

The default and the threads' own levels live in the host's shell settings
(`replyDetail`, `threadReplyDetail`), the document that already holds every
other per-person presentation choice, keyed maps included. That is the
narrowest home that keeps it a preference: it is written only by the shell
route, which only a window on the host reaches; it is not part of any thread's
journal, so forks, exports and provider context never see it; and host export
does not carry it. Code's pin is the one per-thread presentation choice kept on
a thread's own record, and Chat and Work have no such record to share, so a
level on three mode journals would have put a presentation choice where thread
authority lives. Purging a thread, alone, with its Project, or past the
retention window, removes its level in the same pass, so no level outlives its
thread; the host writes that change itself, with no window to name. The list
also holds at most 500 threads, and setting one more drops the longest-standing
choice, a backstop should that write lose a race. The host has no settings push,
so another open window picks up a change when it regains focus: it re-reads the
shell settings behind any edit it is still saving. The phone and a paired browser read the two fields, and nothing
else from the settings document, through `GET /api/reply-detail`
(`settings.read-non-secret`, read-only, at most 128 KiB): the phone when a
thread opens and when the app returns to the foreground, a paired browser when
its workspace opens, when the mode changes, and when the window regains focus.
Until an answer arrives, or if none can, they draw Low. On the phone the
reasoning panel opens at High and shows its first line at Medium, and a
finished tool card opens at High; a change of level remounts them.

The displayed partial answer coalesces updates on a fifty-millisecond beat, or
one hundred milliseconds for long answers (at least sixteen thousand text
units). The first content, a replacement and the finished answer appear
immediately. Coalescing happens before parsing the whole answer, so Markdown
references and code fences keep their document-wide meaning; it does not delay
provider data, journal writes or copy/export.

A thread opens on its newest messages. When earlier ones exist, one row above
the oldest loaded message offers **Load earlier messages** as a ghost button;
while a page loads it reads "Loading earlier messages" and stays focusable, a
failed page says "Earlier messages could not be loaded." with **Try again**,
and once the start is reached it says "No earlier messages" in the meta ink.
The row is 32px tall in every state, because it sits above what the reader is
looking at, and an arriving page keeps the reader's row where it was. A thread
that never had earlier messages shows no row. Only a new last message is
announced; earlier messages arriving above are not.

Chat, Work, and Code all open at the end and follow new output while the
reader is there; a reader who has scrolled up stays on their row while turns
arrive below. A Code fork's own messages come first; below them the row goes on
into the messages it was forked from, at the fork point, and up the thread it
came from, so a fork reads as one conversation. Coming back to a thread puts
the reader back on the row they left when its loaded messages still start where
they did, and at the end otherwise.

A jump to a Chat message that is not loaded, such as a search hit, shows the
run of messages that ends with it in place of the newest ones, with the Load
earlier row above it. One row below that run holds **Load later messages** and
**Jump to latest** as ghost buttons, 32px tall in every state; while a page
loads the first reads "Loading later messages" and stays focusable, and a
failed page says "Later messages could not be loaded." with **Try again**.
Load later keeps the reader's row in place rather than following the new
rows to their end. Once a later page reaches the newest messages the two runs
become one and the row goes away, with the reader's row where it was; Jump to
latest, or sending a message, returns to the newest messages at the end. A
jump happens once: after its message has been shown, nothing jumps back to it.

A thread's Browser captures are a plain list of rows under a sentence-case
section label (`oct-section-label`, "Browser captures"), not a card group: each
row is a hairline-ringed object with a 72 x 48 picture, the page title in the
medium weight, and the origin as mono meta, and the whole row is one `bare`
button that opens the full picture. It uses the neutral hairline and surface
tokens only, adds no colour, and draws no fill on hover or when open. A
recording's picture is its first frame, still, with a play mark in its lower
left corner: a filled triangle and the length ("2.5 s") in extra-small
tabular figures on a pill of the card surface with a hairline ring, so it
reads by shape and word, never by colour. It moves only once opened, where a
ghost **Stop**/**Play** sits before the caption; reduced motion opens it on
its first frame.

Attachment and model controls sit on the left; access, context usage and send
stay together at the right edge even when the controls wrap. Menus use compact
interface text, and model choices stay in a bounded scrollable popup.
Sent messages do not repeat an access caption; the underlying history remains
authoritative.

## Colour system

The default runtime palette is neutral graphite. The following values are the
`System` defaults in `packages/theme/src/tokens.ts` and the matching renderer
fallback; `Dark` and `Light` are the same values pinned to one mode.

### Semantic roles

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
| Strong divider         | `--octant-divider-strong`                           | `#808080` | `#6f6f6d` | An off switch's edge, an unchecked checkbox, rare dividers |
| Primary text           | `--octant-text-primary`                             | `#f5f5f7` | `#141414` | Body and control text                                      |
| Secondary text         | `--octant-text-secondary`                           | `#bcbcc2` | `#45454a` | Supporting copy                                            |
| Muted text             | `--octant-text-muted`                               | `#949494` | `#666666` | Metadata and hints at 12px; AA on the control fill         |
| Primary foreground     | `--octant-primary-foreground`                       | `#171717` | `#ffffff` | Text on primary fill                                       |
| Focus role             | `--octant-focus-ring`                               | `#4d9ec8` | `#1f6f96` | Theme compatibility and accent tints                       |
| Selection              | `--octant-selection` / `--octant-surface-selected`  | `#2c2c2c` | `#ebebea` | Selected rows and active controls                          |
| Accent fill            | `--octant-accent`                                   | `#f5f5f7` | `#141414` | One primary action or active mark                          |
| Accent foreground      | `--octant-accent-foreground`                        | `#171717` | `#ffffff` | Text on accent fill                                        |
| Accent text            | `--octant-accent-text`                              | `#f5f5f7` | `#141414` | Accent used as text; normal-text contrast                  |
| Scrim                  | `--octant-scrim`                                    | `#000000` | `#000000` | Opaque by contract; the bridge mixes it to a wash          |

The ladder is deliberate: in dark the page is near-black, the sidebar a step
darker, the reading surface a step lighter, and cards lift one more step. In light the sidebar and the page share one near-white ground and the
reading surface is white; a hairline, not a grey fill, separates the sidebar
from the workspace. Every hairline registers on the surface it separates
(about 1.3:1 in both modes); inputs and outline buttons use the strong border
so an edge is never guessed. An off switch and an unchecked checkbox are the
exception: they must be found at a glance on a card, so they take the strong
divider (4.4:1 on a card and 4.9:1 on the page in light; the strong border
measured 1.65:1 and 1.85:1 there).
The renderer fallback in
`apps/web/src/styles.css` mirrors these values exactly.

The code editor and its diff draw from the same resolved roles through the
editor projection in `packages/theme/src/editorColors.ts`: the workspace
ground, primary ink, muted line numbers, the selection role, floating
widgets, and the two border roles of its scrollbar thumb. Under increased contrast it takes the same high-contrast ink as the
rest of the window. Syntax colours come from the editor's own light or dark
base, because the palette roles are checked only for interface contrast. A
theme, mode, contrast, or system appearance change repaints open editors in
place.

The terminal draws from the terminal projection in
`packages/theme/src/terminalColors.ts`: the workspace ground (the Glass plate
under translucency), primary ink, the selection role, the two border roles of
its scrollbar thumb, and the palette roles as its ANSI hues, with ANSI black and white kept dark and light in either
mode and bright black as the muted ink. Because the palette roles are only
checked as interface marks, the projection also sets a contrast floor the
terminal engine enforces per cell against the background it is drawn on:
4.5:1 normally and 7:1 under increased contrast, half that for dim text.
Increased contrast also swaps in the same high-contrast ink as the rest of the
window. A theme, mode, contrast, or system appearance change repaints an open
terminal in place, keeping its scrollback, and so does a change in the sidebar
material (opaque or Glass, including Glass the host resolves after the terminal
opened) or in reduced transparency, which moves the cells onto or off the Glass
plate.

Status roles are paired to the surface where they render. Use the text role
for labels and the surface role for a background; never rely on hue alone:

Routine Waiting, idle, and unselected states use neutral text and marks.
Pending approval requests use a neutral surface and muted icon, without a
warning stripe. Warning colour is reserved for an actionable warning, not
every thread that can be resumed. A state, empty, or error message draws its mark in neutral ink, whatever went
wrong: its glyph and title carry the meaning, and the message recipe offers no
coloured tone. Success, failure, diffs, provider marks,
and categorical data may retain semantic colour alongside a label or shape.

| Meaning       | Surface                                                      | Text/border                                                                                 |
| ------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Success       | `--octant-success-surface` (`#16281f` dark, `#bfd8cc` light) | `--octant-success-text` (`#6bb299` dark, `#0f6144` light)                                   |
| Warning       | `--octant-warning-surface` (`#2b2b2b` dark, `#f0f0ef` light) | `--octant-warning-text` (`#f5f5f7` dark, `#141414` light); border `--octant-warning-border` |
| Danger        | No default surface                                           | `--octant-danger-text` (`#e17d96` dark, `#a8102f` light)                                    |
| Diff addition | No default surface                                           | `--octant-addition-text`                                                                    |
| Diff deletion | No default surface                                           | `--octant-deletion-text`                                                                    |

The default preset's warning role is amber (surface, a border that reads at 3:1
on it, and text that clears 4.5:1 on the surface). The Mono style swaps in the
neutral trio: the control fill, a border that reads at 3:1 on it, and the
primary ink. A warning is told apart by its mark and its words in both.

The eight palette roles (`red`, `orange`, `yellow`, `green`, `teal`, `blue`,
`purple`, `pink`) are for Project View identity, chart marks, and provider or
runtime status where a categorical distinction is needed. Pair every mark with
a label, icon, pattern, or border style. The static chart series and dash
patterns live in `octant.css`.

The original warm charcoal-and-brass `Octant` preset remains an optional
theme. It is not the default neutral system. Custom themes may override only
validated semantic roles; incomplete or low-contrast imports fall back safely.

## Data visualisation

Charts, metric blocks, tables, and timelines are one visual system: hue lives on
the mark and never on the chrome, every mark pairs its hue with a second
channel, one formatter reads every number, and a block that cannot be drawn
falls back to its plain reading and disclosed table. The marks, scales, block
kinds (treemap, heatmap, bar list, comparison matrix, math, metric tiles, KPI
dashboards, tabs and columns, diagram marks, the Gantt view, tables, funnel,
radar, sankey), and their states are specified in
[Canvas visuals](docs/design/canvas-visuals.md).

## Typography

Typography has distinct jobs:

| Job        | Default                                                                                             | Usage                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Interface  | `system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`                              | App-wide shell, navigation, controls, settings, headings, transcript, and composer |
| Display    | inherits Interface                                                                                  | Wordmark, section headings, selected navigation labels                             |
| Transcript | inherits Interface                                                                                  | Long-running conversation and composer; readable at 13–16px, 13px by default       |
| Editor     | `'Geist Mono Variable', 'SF Mono', 'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', monospace` | Code, diffs, paths, identifiers, aligned technical values                          |
| Terminal   | Geist Mono, SF Mono, Nerd Font fallbacks, monospace                                                 | Terminal output and prompt glyphs                                                  |

The default interface is the platform face at 13px and weight 400; transcript
text defaults to 13px. Geist and Geist Mono are bundled
(`@fontsource-variable/geist` and `geist-mono`): Geist Mono sets code by
default and Geist is an Appearance choice. The stylesheet's own first-paint
defaults are the same faces as the settings defaults, so nothing swaps when
settings load. The editor defaults to 13px, line height
1.5, and enabled ligatures. The terminal defaults to 12px, line height 1.4,
and disabled ligatures.

A saved stack that only ever meant "the default" reads as today's default
(`savedUiFamily` in `packages/theme/src/typography.ts`): the old system
interface stack beginning `-apple-system, BlinkMacSystemFont`, the bundled-Geist
default stack that began `'Geist Variable', -apple-system`, and the JetBrains
code and terminal stacks. The old Geist entry's unbundled
`Geist, system-ui, sans-serif` was an explicit pick, so it reads as bundled
Geist.
The Geist entry now saves `'Geist Variable', system-ui, sans-serif`, so a Geist
pick made from here on stays distinct; a Geist pick saved under the old
default's identical string cannot be told apart and moves to the platform face.
System interface saves the default's own stack.

The persisted typography schema supports independent UI, editor, and terminal
family, size, weight, line height, and ligatures. Families are sanitized: no
URLs, imports, remote assets, executable payloads, or control characters. Missing
fonts fall back to the safe stack. UI/editor/terminal sizes are bounded to
8–32px; weights to 300–700; line height to 1–2.5.

Appearance controls update the renderer optimistically and queue their
server-authoritative save immediately. There is no separate Apply step. A
slower earlier response never replaces a newer visible choice.

The runtime UI projection is absolute for ordinary application chrome. The
bridge maps `--oct-font-display`, `--oct-font-body`, and
`--oct-font-transcript` to the selected UI family. There are no compatibility
aliases such as `--oct-font-ui` or `--oct-font-sans`, and feature styles must
not declare a raw interface stack. A repository contract test scans shell,
Settings, dock, navigation, pane tabs, and board selectors for violations.
Monospace is limited to editor/terminal content and literal code, paths,
branches, identifiers, or serialized theme source.

Static type tokens in `octant.css` are:

- `--oct-text-xs: 12px`, `--oct-text-detail: 13px` (declared in
  `surface.css`), `--oct-text-sm: 14px`, `--oct-text-base: 15px`, each
  multiplied by `--oct-text-step` so the Appearance interface size moves the
  whole ladder. Feature CSS reads these tokens; it does not author
  `calc(N * var(--oct-text-step))`, so the 12px floor for meta text is one
  definition.
- `--oct-text-lg: 17px`, `--oct-text-xl: 20px`, `--oct-text-2xl: 26px`,
  `--oct-text-3xl: 36px`, `--oct-text-4xl: 72px`. The large title's 28px is the
  `oct-title` role's own size, not `--oct-text-2xl`.
- Body leading `1.5`, snug `1.3`, heading `1.14`, tight `1.1`, code `1.7`.
- Weights are the ladder in [Scale](#scale). Avoid bolding whole paragraphs.
  The type roles in `styles/surface.css` (`oct-title`, `oct-section-label`,
  `oct-row-label`, `oct-row-detail`, `oct-meta`) are the only heading and
  label recipes; feature CSS does not author a new size.
- Mono metadata uses positive tracking (`--oct-tracking-wide`); display
  headings use restrained negative tracking.

Transcript settings are explicit and centered on the body size: Small is
13px, Medium 14px, Large 16px; Narrow is 680px, Medium 800px, Wide 1040px. A
fresh install reads Small and Narrow, so a question, its reply, and the
composer under them all read at 13px, never under the chrome around them. The column uses
`width: min(100% - 40px, measure)` with automatic horizontal margins. Welcome composers share a 768px maximum so
Chat, Work, and Code start from the same prompt geometry independently of the
reading-width preference. Canvas documents use the `--oct-canvas-measure`
(62ch) measure; mockups and designs inside a Canvas follow
[Canvas visuals](docs/design/canvas-visuals.md#mockups-and-designs).

### Design frame kit

A design drawn in the workspace theme receives the workspace's semantic tokens,
scheme, and bundled faces, plus a first-party `oct-` class kit that sets no
colour of its own. The kit's contents are in
[Canvas visuals](docs/design/canvas-visuals.md#design-frame-kit).

## Spacing, shapes, and depth

Spacing is a 4px base scale: 4, 8, 12, 16, 20, 24, 32, and 48px. Off-scale pixel spacing in a stylesheet is ratcheted by `bun run ui:check` against the recorded baseline; a change may lower a file's count but never raise it. Use `gap-*`
for stacks and groups; do not reintroduce `space-x-*` or `space-y-*` utility
chains. Radii are the tokens in [Shapes and depth](#shapes-and-depth). Product
chrome uses those tokens and nothing else: a `border-radius` is a token, `0`,
`50%`, or the 1–4px of a chart bar, mark, or status dot, never a rem or a
bare pixel literal. A rem corner also shrinks with the interface font size,
which a token does not. Adapters own button paint.

Controls are 44px by default and 34px compact. Recipe controls (buttons, tabs,
toggles, comboboxes, badges) size in rem so they grow with the interface size;
at the default 13px a button is 20, 24, 28, or 32px tall. A quarter-rem step is
3.25px at that root, so a recipe never uses an odd step bare: it rounds it to a
whole 2px (`h-[round(1.75rem,2px)]`), or a control lands between pixels. The shell frame runs on one
grid, named by the `--oct-title-rail-h`, `--oct-rail-tab-h`,
`--oct-rail-button-h`, `--oct-nav-head-h`, `--oct-nav-row-h`, and
`--oct-nav-inset` tokens in `octant.css`: the title band, the window
controls, the right dock head, and the bottom panel toolbar share one title
rail (44px), on which a rail tab and a rail icon control sit on one centreline and
the band's hairline meets the dock's; the sidebar's header row is its part of
that rail (`--oct-title-rail-h`), so its controls share the window controls'
centreline, and below it the sidebar runs navigation, Project, and
thread rows at the nav row height down to a 40px account row (`--oct-nav-head-h`),
with every leading icon on the nav inset and its section labels at 12px in the
meta ink with a 20px gap above, so a label never reads as one more row. A
thread row that carries a facts line is two lines of type and takes 8px above
and below them (about 56px). Hover-only actions (add, more, pin, archive,
and a tab's pin and close) take no width until their row is hovered or
focused. A section heading's add and more controls are the exception: the
list's view and filter controls share that row, so they keep their width while
hidden and only fade in, and nothing beside them moves. Icon sizes are 16/19/22px for small/medium/large actions; touch
surfaces keep 44px targets. The workspace and Settings share the saved sidebar
width, defaulting to 280px (wide enough to read a thread's title rather than
guess it); narrow Settings layouts retain their responsive
rail clamp or drawer. The workspace sidebar supports resizing.

**Icon rail.** By default (Settings › Sidebar › Icon rail: Always) an icon
rail stands in its own column in front of the open sidebar. It is exactly as
wide as the title band is tall (44px), open or collapsed, so the frame's two
arms match. In the desktop app the traffic lights sit in the title band above
it, and the sidebar's head, or with the sidebar hidden the window chrome,
keeps the rest of their width clear. Beside the sidebar it
carries the places: the count tiles as icons with badges (under Colour the
four icons take the tiles' hues, Inbox blue, Running amber, To review purple,
and Done green, from the same palette roles; the hover and current fills and the
count badge stay neutral, and under Mono and increased contrast the icons stay
grey), the destination
rows the person keeps shown (Settings › Sidebar › Sidebar destinations decides
which and in what order, for the rail as for the sidebar), the Activity feed,
Projects, a tile for each Project the person pinned (its icon or initial on the
same 32px face, after the divider; a context menu on the tile unpins it; the
collapsed rail lists pinned Projects first and draws six Project tiles at most
so Settings and the rings stay in the window), More (the menu-only destinations and Customize sidebar), the usage
rings, and Settings. The sidebar keeps its header (modes, search, new thread,
hide), the Project list with its view, filter, and Activity controls, the
threads, and the profile, so nothing is offered twice. Rail icons are 16px on
a 32px face; every rail control names itself in its accessible name and in a
label that opens beside the rail on hover or keyboard focus. Destinations
have their own marks: Inbox a tray, Running a spinner, To review a checked
clipboard, Done today a double check, Board a kanban, Issues the issue dot,
Pull requests the pull-request arrow, Linear a checklist, Projects stacked
folders, Agents a bot, Automations a calendar clock, Artifacts layers, Image
generator images, Plugins blocks, and the Activity feed a pulse line.

**Sidebar header width.** The mode tray never shrinks. Where the sidebar header
(modes, Home when no rail stands beside it, Search, New thread, Hide, Back and
Forward) cannot fit one row, which is a sidebar of 220-236px (also the width a
1100px window leaves it beside an open dock), the actions wrap to a second row
under the tray instead of sliding beneath it. The tray's row stays first at the
top of the sidebar, and the header keeps its full wrapped height however long
the thread list is, so the list always starts under both rows.

**Usage rings.** Above Settings, at the foot of either rail, each provider
that reports a plan window with a figure gets a ring in its identity colour
around its 12px logo:
the outer arc is what is left of the longest window (the week), the inner arc
what is left of the shortest (five hours), chosen by each window's length, and
a window near or at its limit takes the danger ink. Hovering or focusing a
ring opens a card with every window, its share left, and when it resets;
clicking opens Settings › Usage. A provider with no figure gets no ring,
because an empty ring would claim a limit nobody reported. The rings read the
host's last observation every few minutes, never a fresh provider call. The
host keeps that observation across restarts, so the rings are there on launch;
when the reading is more than a few hours old the card says "Last read 5h ago".

**Back and forward.** Back and Forward sit in the title band beside the
sidebar control (beside Show sidebar while the sidebar is hidden, with or
without the icon rail, and in the sidebar's header in a browser). They step
through the pages (Inbox, Board, Pull requests, Projects, the other sidebar
places, Review, and the archive) and the tabs (threads, drafts, canvases) this
window opened. A step in another mode switches to that exact mode (Chat and
Work keep separate layouts though they share one visible mode) and opens the
page or tab once that mode is on screen, without the home landing a person's
own mode switch makes. The history belongs to the window and is never stored; it holds
the last 50 steps, a new place drops the steps ahead of the current one, and
a step whose tab was closed since is skipped. Each button stays in place,
disabled, at its end of the history.

**Hiding the sidebar.** Hide sidebar, or Mod+\ (rebindable, "Show or hide
the sidebar", answered in text fields too and leaving focus where it was),
collapses the sidebar to the rail alone, which then also shows New thread and
Search at the top, the modes (with the same marks as the sidebar's mode switcher, so Work keeps one icon), and up to six Project letters (outlined at icon
size in the icons' muted ink) with a Projects button for the rest; Show sidebar, Back, and Forward move into the
title band, so the rail stays one icon wide. Icon rail: When hidden shows the
rail only in that state; Never removes the sidebar completely when hidden and
leaves Show sidebar and New thread in the native title rail. Neither rail
appears below the narrow-window breakpoint (960px): there the width belongs to
the page, and below the drawer breakpoint a collapsed sidebar is a closed
drawer.

The right dock defaults to 640px when open, and opening a Browser or a
Terminal widens a narrower dock to 640px once (the person can drag it back;
the next such opening widens it again). A terminal in the dock is an inset,
rounded plate rather than an edge-to-edge slab; under Glass the plate and
its cells are the page colour with 12% of the ink, a grey that sits with the
frosted panels instead of a black slab. A fresh window
starts with it
closed; choosing a tool or restoring an explicit prior choice opens it. The
pane/title control rail is `--oct-title-rail-h` in the native host and the status
bar is `--oct-statusbar-h`.
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
Chat, Work, and Code welcome composers share the composer's pill (`--oct-radius-composer`,
`--octant-shadow-md`) and one first-read hierarchy: one question, then the
composer. Starter actions appear only when recent work does not already give
the person a next step. In light the card is workspace white on the
`--octant-app-background` well, not the grey floating fill — that fill reads
as a sunken field. Code welcome keeps one stable question while Project and
Environment sit on the context row above the composer
(`.composer-tray--start`, rendered before the card inside `.composer-stack`),
on the page ground with no band chrome. The base-branch chip joins that row
once a Project is chosen. Environment is the
create-facing presentation of Octant's authoritative host federation: its
dropdown selects This computer, devbox, or another healthy capable host without
creating a second environment model. Every create composer shows Environment
only when more than one host is known. With one host there is nothing to
choose, so no Environment control or label appears. With several, an existing
Project's fixed host reads as a label instead of a dropdown. Workspace remains on that rear card after the three primary choices;
nothing about delivery is asked up front (see "Language"). The Project
control is one menu: saved Projects to search, then New Project from folder
and New Project from GitHub repository. Choosing GitHub swaps the menu's body
for the managed-clone flow in place, so there is no second repository control
beside the Project. Access is
a titled menu in the row under the prompt card, and carries the
"Remember for this Project" switch.
Every composer's row under the card is two groups with the row's free space
between them, in one order on a new task and in the thread it becomes: what
the person adds on the left (Create image in an open thread once an image
profile is ready, access, a surface's own extras such as Web or Task actions),
then how the turn runs on the right (the context meter, the model,
dictation). Attach and send are in the card. A control never changes sides
between the two composers.
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
The Code start screen's agent home (suggested prompts, Up next, Start something
new, and Continue) is laid out in
[Start screen: Code agent home](docs/design/start-screen.md#code-agent-home). The start screen has no image-generation control: a job needs a thread to
land in, and the Image generator surface serves everything else. Attaching an
image is a composer affordance and is available here.
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

- the window's optional glass, which is the tint over the native window
  material behind the whole window;
- a thread's user bubbles and composer over the application ground or window
  glass, one material either way (agent replies stay bare prose; see
  [Transcript](#transcript));
- Code Home's cards and its Up next and Continue cards, which stand on the
  start screen's ground beside the composer and wear its material, so the
  ground reads evenly behind every surface on the screen (with the plain card
  fill its characters ran through the cards at full strength while the
  composer beside them was frosted);
- Zen's windows, dock, pills, and sheets (glass cards);
- the floating activity picture-in-picture, and the Browser's live preview,
  which shows the page itself and frosts only its caption, count, and close
  control, never the page;
- the phone's glass surfaces.

Its tint, stroke, and highlight are theme roles, and its floor is the theme's
page colour at 66%, so a neutral or tinted preset gets no fixed warm cast under
the composer. The thick and chrome tints poured over that floor are the theme's
raised surface at 56% and 48%: as a fixed neutral grey they made the composer a
flat grey slab on a black or tinted preset. Together the floor and tint are
dense enough that the ground stays quiet behind text where the engine does not
blur it (the packaged window over the ground). Under window Glass the floor and
the tints are lighter, as the conversation rule on Glass says: a 30% veil of
the page colour under the primary text at 6% (4% for chrome), because over the
desktop the dense pair read as a near-black slab. Reduced transparency and unsupported `backdrop-filter` resolve
every one of them to an opaque surface.

Window glass is the `sidebarMaterial` shell setting with the theme's vibrancy
level, shown as the Window section's Glass control (Off, Subtle, Strong) and
its Tint slider. It takes effect only when the host resolved the material
translucent, so every accessibility, performance, and host-support gate
applies; then the frame (the sidebar colour) and the panels (the workspace
colour) are each at the Tint's opacity over the native material, and reduced
transparency or an unsupported host leaves them opaque. A browser is such a
host: with no native material behind the page, Glass would leave the frame and
the panels as the page colour and take the sidebar's own colour away, so a
browser window always paints the theme's opaque surfaces. Menus, dialogs, popovers, and other controls drawn
over it stay opaque semantic surfaces. The older `workspaceMaterial` setting
is still read and stored but no longer changes anything: the whole window is
glass or none of it is.

Under Glass nothing inside the shell paints the theme's opaque page,
workspace, or card colour over a panel; every layer takes one of the shell's
surfaces (`--octant-window-surface` for the frame and `--octant-panel-surface`
for every panel, the thread's included), defined once on every shell in
`shell.css`:

- **Settings** wears the same frame and panels: the navigation and gutters are
  the frame, the page is a panel, and a section card is the card step below.
- **Destination pages** (Inbox, Board, Archive, Review, Projects, Agents,
  Automations, Artifacts, Image generator) are clear over the panel, and their
  cards drawn with the raised step (`--oct-surface`) take the card step. The
  Inbox is the model: a display-size page title (the `oct-title` size) with its one line of state
  on the baseline, then raised cards in a 980px left-aligned column, two
  columns by container query and one when narrow, rows without rules (see
  [Inbox page](docs/design/workspace.md#inbox-page)).
- **A card** (`--octant-card`, the recipe's `bg-card`) is one step of ink over
  the panel: the primary text at 4%.
- **An outline button** rests on that card step instead of the page colour
  (`--octant-outline-rest`); its hover and pressed fills stay the control
  fills.
- **Quick tools** for a Code start screen are clear in the body of the dock.
- **The Browser** is clear on its own start page, whose rows take the card
  step; a loaded page keeps its opaque canvas.

A filled button and a switch that is on keep their own fills. The control fill (a
secondary button, a segmented track, a select, a chip, a ghost button's hover)
is a tint of the primary text at 7%, 11% hovered and 15% pressed, as the
conversation rule on Glass says; menus, popovers, and dialogs keep the opaque
floating surface. Increased contrast and reduced transparency return cards and
outline buttons to their opaque colours. The ground behind it all steps down
by what is on screen: a fifth of its strength behind any surface that shows
text (a thread, any other pane, or a destination page), and only a start
screen keeps more of it.

Shadow tokens are `--octant-shadow-hairline`, `--octant-shadow-xs`,
`--octant-shadow-sm`, `--octant-shadow-md`, `--octant-shadow-lg`,
`--octant-shadow-overlay`, and `--octant-shadow-pop`. Use the smallest level
that establishes a genuine layer: navigation panes and open form layouts stay
unshadowed; the card recipe and a Settings group use `--octant-shadow-xs`; a
filled button uses `--octant-shadow-control`;
compact state and grouped surfaces use `--octant-shadow-sm`; welcome composers
and follow-up composers use `--octant-shadow-md` over a hairline ring; focused or promoted raised
objects may use `--octant-shadow-lg`; overlays use only their overlay or pop
token. A shadow must explain depth, not decorate a flat row.

## Shell and layout

The shell is a CSS grid: sidebar, central workspace, optional right dock, and a
full-width status bar. A horizontal bottom panel is an optional sibling below
the central workspace. The central pane remains the thread, board, Project
overview, or Project-level list. An unsplit conversation uses the title band
for the Project/thread breadcrumb and compact thread strip, so the transcript
does not repeat a second title block. Split panes and utility surfaces retain
their own pane headers and lifecycle controls. Capability-gated toggles for
Open in, bottom panel, and right dock remain window chrome. Above the right
dock, in the same title band, sit its tools: while none is open, Environment by
name and Terminal, Browser, Files, and the device tools as icons (each only
where the thread can open it); once tools are open, the tab strip, where every
open tool shows its icon and name, a long name ellipsizing at 10rem, and the
tools that do not fit gather behind a count. Several Browsers are one Browser
tab there: their pages sit in a row of their own at the top of the Browser,
with a + for a new page, and closing the Browser tab closes every page. The
Browser's toolbar groups back, forward, and reload in one rounded capsule
beside a pill-shaped address field, followed by the driver indicator and a
quiet ghost **Take over** button (secondary **Hand back** while the person has
the page), both extra-small, which drop their words below 720px and keep their
names. Environment is opened from that band or Add tool. Zen
remains in the bottom-left identity menu.

Zen is a desk. Every card is a window: its title bar moves it, every edge and
corner resizes it, the arrow keys nudge it and Alt with the arrows resizes it,
and it stays exactly where it was left. There is no pan or zoom; everything is
on the one screen. **Tidy**, top right, re-tiles every window in reading order
into the room the surface has, leaving the spaces pill and the Navigator bar
their own edges; the column count follows the window count and drops when the
area is too narrow for a readable measure. A space that has never been arranged
is tiled once when it opens and that tiling is written down as each window's
own geometry, so nothing jumps when a person first drags one.

A window's title bar is one quiet line: a small mark for its kind, its name,
how long ago it moved for a thread, and two icons, minimize and remove, that
brighten on hover. The corner handle shows a small bracket on hover so a person
can tell windows resize. Windows are glass panes: the regular step of the glass ladder over a lighter
floor, so the ground's colour reads through the blur, with a one-pixel light
edge along the top, a hairline stroke, and a long soft shadow; the window in
front takes a brighter edge and a stronger lift, and reduced transparency or
increased contrast turns them opaque. A new space stands on a first-party picture rather than
a flat colour, and a space still carrying the old flat default is shown on that
picture too. Add terminal and Add browser list the threads they can open in,
the focused card's first: a terminal runs in a Code thread's checkout and a
browser in a Work or Code thread's browsing context, under that thread's
authority. The browser is a window too; it moves by its bar and resizes from
the edges away from its anchor, for the session.

A card is a reading of one thread. Its head carries the thread's name in the
interface face at the body size, and beside it how long ago that thread last
moved; the editor face and the metadata ink are for code, paths, and
identifiers, not for the one label that says which thread this is. A card that is not streaming
reads its host, mode, Project, and the model that answers, in that order. It
does not print a stored ISO timestamp or a provider instance id.

Zen's own chrome is one dock and one sheet. The dock is a row of icon keys,
each named in a tooltip and to assistive technology: Threads, Add, Navigator,
Appearance, then Hide and Exit Zen after a divider. Asking the Navigator lives
in the Navigator panel, which has the field and shows the answer. Putting
something on the desk is one destination, not two: the Add sheet shows each
kind of window as a tile (Thread, Terminal, Browser, Notes, Checklist) and the
two that take a value, a timer's minutes and a link, as one line each. A panel
is a page in a sheet, so its title is the page title and its close is an icon,
and it stops above the dock. The dock, the pills, the sheets, and the empty
space's guidance wear the windows' glass one step lighter and with a larger
radius, the same step for every floating object. The Appearance sheet reads
Look (one Dim dial that darkens every ground, window opacity, picture fit),
Effect (Off, Pixelate, or Dither, with pixel size and tones), then Background
as one grid of pictures that opens on App background and Your picture. Pixelate
and Dither print a picture ground at one canvas pixel per cell and upscale it
without smoothing; dither quantizes each cell through the same ordered
threshold as the application ground. They print pictures only; the app ground
keeps its own dither in Settings. Escape closes the open panel and only leaves
Zen when none is open. Pinning shows no notice: the card that arrives says the
same thing, and the notice landed on top of it.

The app has three server-enforced modes—Chat, Work, and Code—shown as two:
**Work**, which lists Chat and Work threads together and whose new-thread
composer opens with a Chat / In a folder switch in its context tray, and
**Code**. Work reopens on the kind last used. Mode switching is two compact icon buttons at the top of the sidebar, never in the title band, when Work
and Code are both on: a conversation mark for Work and a code mark for Code.
A tooltip names the mode on hover and keyboard focus; the label is clipped
from view and stays the button's accessible name. The active mode carries
`aria-current="page"` and a fill plus hairline, not colour alone. The fill is
the primary text at 12%, one step over the tray's 6%: the selection role drew
as the tray itself (1.01:1 in light). With one
mode enabled the header is a single label and no control. Settings still
offers a dropdown that names the current mode; a host that stored that choice
keeps it. Code and Work keep separate Project View sets. The
sidebar keeps Projects as a first-class destination alongside the active mode's
compact thread list. When Work has no Chat or Work Projects but Code does, the
empty Projects line says "Your Projects are in Code." with a Switch to Code
link; starting a Work Project stays on the section header. Code does not
mirror that hint. The Projects directory and the selected Project overview
occupy the main workspace in turn, following the
[workspace navigation rule](docs/design/workspace.md#navigation-and-projects).
The directory provides search and All, Chat, Work, and Code filters. Project
detail is thread-first, with memory, provider access, and canvases in compact
expandable rows below the primary work; its layout is in
[Workspace](docs/design/workspace.md#navigation-and-projects). A Work Project other than the default
folder also has a **Status file** row whose switch sits in place of the expand
control: off by default, its copy says what turning it on keeps in the folder. Threads without a listed Project appear once in **No Project**, a collapsible
folder row in the Project tree with the same nested-thread layout as Projects.
It has no horizontal divider or separate section heading and is absent when empty.
It is a navigation group, not a persisted Project. Rows are hairline rails, never cards;
provider marks are fixed-size inline and can be hidden without changing row
height or indentation. What a thread row carries — its Project
attribution, branch, linked pull request, last updated, or status mark — is the
view's own choice, edited in Settings › Sidebar › Thread rows or the
view filter menu's Property visibility submenu; a hidden property is omitted
rather than left as a gap. The Project tree and the Activity feed draw the same
row: the provider mark in the icon column every navigation row uses, the title
alone on its line, and the shown facts on one line beneath it in a fixed order
(Project, pull request, branch, then the age at the end); with no facts shown
the age sits beside the status instead of opening a line of its own. Thread rows
are not indented under their Project, so every row's fill sits the same
distance from both edges of the sidebar. In Code, a Project whose threads run
in two or more checkouts nests them under one heading per checkout, primary
checkouts first: a branch glyph, the branch in a small mono chip, and a quiet
"Primary checkout" or "Worktree" label. The heading is inert text, not a
button, so keyboard focus skips it; its threads take one more step of indent on
their content, never on their fill, and drop the branch fact the heading already
states. A Project with a single checkout shows no heading. The Activity feed
and Status stay flat. A hovered row takes the soft ink wash and the row
the workspace is showing takes a stronger neutral ink wash (never the
theme-tinted selection or control fill, which drew a coloured slab on tinted
presets), the same two states the thread tab strip draws, so pointing never looks like
being there. Provider identity remains at the leading edge. A Project row leads with a 20px
rounded letter tile: the Project's first letter, white, on the colour the person
picked from the theme palette, or a neutral tile when none is set. The same tile
heads the Project overview, where it is the colour picker; the row's actions menu
offers Colour with a No colour choice, and an archived Project cannot change it.
A Project whose folder holds a favicon or app icon shows that picture, drawn as
an image at the same 20px, in place of the tile (and in place of the folder
glyph in lists); the tile and glyph remain for a Project without one.
The colour is identity, never status: it never stands in for a warning, a
selection, or an activity mark. One fixed trailing
status position shows a working spinner, an attention symbol, a clock when a
snooze ends, or a neutral unread dot, in that priority order. Its accessible
label and hover details retain overlapping states; a row never renders a
second activity dot or a separate "Woke" label. A list longer than eight rows folds behind one quiet "Show
more (n)" row that becomes "Show less"; the active thread stays visible while
folded. Under checkout headings each checkout folds its own list, so a worktree's
threads are never hidden behind the primary checkout's Show more. Project View and
Project Overview are real features, not
decorative shortcuts.

The sidebar header carries the mode switcher, Search, and New thread (New
chat in Chat, New task in Work and Code); no New thread row repeats it. Under the header sit four count tiles in a 2×2 grid: Inbox (the
threads that need the person: an approval, a question, a follow-up that is due,
or a subagent request waiting on them; a finished turn is not one, and the
dock badge counts the same threads), Running (threads the host projects as
executing), To review (finished turns not opened since), and Done today
(threads put away since local midnight). Each tile is one button whose name
carries its count ("Running, 2"); Inbox opens the Inbox, Running opens the
Board (the Activity feed in Chat, which has no board), To review opens the
Review page, and Done today opens the Put away shelf (see [Workspace](docs/design/workspace.md#thread-visibility-and-completion)). With the tiles on,
the Inbox and Board rows are left out because their tiles go to the same
place. Settings › Sidebar › Count tiles turns them off and brings the rows
back. Tiles show only where the sidebar stands without a rail in a window wider
than 960px, that is, when Settings › Sidebar › Icon rail is Never, or When
hidden while the sidebar is open. They are neutral faces under Mono; under
Colour each takes a palette hue, as a solid face with primary-foreground text in
the light theme and as a tint with a coloured count in the dark one. At 960px and
narrower, where no rail shows (the same breakpoint as the rail's own, one
number), and in the phone drawer, the four destinations are compact rows
instead: icon, name, and the count at the trailing edge, with no fill, so they
sit quieter than the thread list under them. The row's icon, like every icon in
the rail, stays in the sidebar ink in every style, and each count has one mark
wherever it shows (Inbox, a play circle for Running, an eye for To review, a
ticked circle for Done today); the name and the count stay in the sidebar ink. Each row keeps its name with its
count and its destination. The drawer itself paints the opaque sidebar surface
in every material, since it overlays the page and a transparent drawer let the
page's text show through it.

Primary sidebar destinations are Board and Pull requests when valid for the
active mode. The destinations a person placed under Menu
only wait in a More row that closes the destination list (the rail's More
button when the rail stands beside the sidebar) — an ellipsis opening a popup
beside the rail with those destinations and Customize sidebar; the
setting that turns the More row off returns them to the bottom-left identity
menu. The identity menu owns Settings, Navigator, Agents, Providers, Usage,
Plugins, Automations, Artifacts, and Zen entry points. The account menu opens
above its identity row, aligned to the
row’s leading edge. Search is a compact in-place filter for the current mode's visible
threads: the header's Search icon opens a Filter threads field under the
header, Escape or its close control clears and hides it, and Settings ›
Sidebar › Thread filter can keep the field always shown. Enter in the field
hands its text to the command-style overlay, which searches every thread of
the mode; the overlay also stays in the command palette. The list's three
arrangements, Status (the default), the Project tree, and the Activity feed,
are a visible Status/Projects/Activity switch on the row the Project view
picker uses, not an icon in the header. That row stands in the same place in
all three, with the Project tree's own Projects heading under it, so pressing
the switch moves nothing but the list. Status headings carry their count in
meta ink after the label ("Needs input 2"), the same face as the feed's folded
Earlier count. A row whose pull request's checks pass adds a 12px check in the
success ink after the PR number.

Settings is a grouped form page. The shared resizable navigation rail
stays fixed while one centred, bounded 920px reading column scrolls. A 32–64px
workspace gutter protects the content at narrower widths. The page title,
section labels, and row labels have distinct roles; sections follow a
consistent 28px rhythm. Navigation groups use quiet sentence-case labels
without hairlines between groups. A section is a label and its one-line
description over one grouped card of hairline-divided rows (see "Page shell"
for the kit). Discrete editors and install reviews keep their own boundaries
inside a section. Everything inside takes the card's 16px inset, including
content that is not a row. Keybindings have their own destination and raw JSON
stays behind an advanced disclosure. Inline profile and provider editors keep
their aligned row edges, measured from the card's inset. Ready providers
open onto a bounded model list with search, shown counts, and shared visibility
switches. Routine connection diagnostics and capabilities use a separate
disclosure; setup and authentication guidance remains visible. Visual theme
previews and confirmation dialogs retain their discrete boundaries. A
destructive group is its own section at the end of its page, marked by that
placement and by its confirm control, not by heading colour. Labels and
descriptions align left, controls align right, and compound editors may expand
below. A row's "more" (a custom font stack, network details, what an update
check sends) sits behind one `.settings-disclosure` recipe: a 12px summary with
the app's chevron, never the browser's marker. Loading and status lines are one
quiet sentence; only an error keeps a box. Essential labels and explanatory
text are at least 12px at the default interface scale. Every control uses the
owned Octant/shadcn adapter, inherits the interface typography projection, and
either saves immediately or uses a compact Save action for a compound form.
Save controls retain a contextual accessible name. Model visibility changes keep
the open editor, filter, focus, and drafts stable; hiding the last model does not
trigger provider discovery.
Scope metadata remains available to assistive technology but does not compete
with the setting label.

Chat and Navigator defaults use the same compact model chooser as composers,
with the current selection in the row and the searchable catalog in a bounded
popup. Unconfigured defaults say Choose model.

Operational settings use progressive disclosure. Provider and skill lists lead
with compact readiness counts. On Providers & Models each provider group is
one aligned list on the Settings grouped-row surface, one row per provider,
rows divided by the surface's inset hairline and never filled. A row holds a
20px provider mark with no tile (the licensed bundled mark, or a monogram when
there is none, never an approximation of a brand mark), the name in the
row-label role, one status line in secondary ink (state, model count, maker
and runtime), and the details chevron and enable switch at the trailing edge.
The chevron is the row's disclosure (`aria-expanded`). A provider a person
opens becomes the page: its row and details stand alone, with every control and
fact, and the other rows, the group headings, the list's heading, the sections
around it and the page outline step away. One **Providers** Back control above
it, the chevron, or Escape returns to the list and puts focus back on the
row's chevron. The page opens at most one row by itself, in place in the list,
the first that needs attention (a sign-in, or a binary the scan found for a
broken runtime), and none when no provider does; a row that comes to need
attention while a provider's page is up waits, open, in the list. Remove is the
last thing in those details, alone under a hairline with one line saying what
it does, never among Check connection, Configure and the other routine actions.
A card per provider, two to a row, made the boxes the loudest thing on the
page; details expanded in place, one row at a time, still grew the page by a
provider's models and actions among rows that had nothing to do with them, to
about four screens. The state line
reads from a dot that carries the state without colour: a filled ink dot is
ready, a ring in ink needs setup or a sign-in, a muted ring is off or not
checked, and a failure keeps its red role. Only under Colour does ready turn the
palette's green and setup the palette's orange. The detected, supported-but-not-
detected, and other groups are Settings sections; the readiness summary is the
label's description. Ordering controls appear only in an explicit Reorder mode.
A runtime installed in an unusual location is fixed from its own row rather
than a manual form: the row's details carry a "Locate binary…"
action beside Check connection, shown only where the desktop's file picker
exists and only for a runtime whose version probe the host can run. Its
answer is one quiet line under the actions (the version the host read), or a
warning box saying why the host refused the file. A scan repairs a saved
binary that no longer exists by itself. A row whose saved binary is still
unusable, while the latest scan found that runtime elsewhere, says "Found at
~/.local/bin/claude (2.1.306)." on the row beside a "Use it" button,
visible while the details are closed; pressing it opens the details and gives
the same answer without the picker. See
[Providers and model endpoints](docs/design/model-endpoints.md).

Provider catalog and the Octant Harness model endpoints (rows, detail
sub-pages, and Add endpoint) follow
[Providers and model endpoints](docs/design/model-endpoints.md): one link per
row named with its state, the state in words beside a dot whose shape carries
it, one plain fix per problem, and precise protocol terms only in Diagnostics.
Skill rows show the source class and one effective state;
filesystem paths, qualified identifiers, hashes, requested/effective
breakdowns, and content size live behind Details. Usage opens on requests,
input, output, and measurement quality. Its thread table uses the same figures
as the line under the composer: cache, speed, and first token are columns,
omitted when unavailable, and opening a row lists that thread's turns. The
table stays a hairline table, not a card. Reasoning, cache, execution time, and
latency live in one Operational details disclosure; technical filters stay
collapsed in Settings. The standalone Usage destination also exposes provider
capacity independently of ledger loading. Each provider window leads with its
remaining percentage and an accessible meter, followed by its reset countdown.
Account, model, and provider-instance scopes remain distinct. An elapsed reset
shows Awaiting updated limits until a fresh reading arrives; it never implies
refilled capacity. Provider cards use the shared surface typography and tokens
and stack at narrow widths. Inside Settings, Usage has no title of its own: its
controls sit above kit sections (overview, token totals, provider limits,
breakdown), each a label over one card, and the Settings header is the only
title.

First run is a four-step wizard with a progress rail: Providers, Project, Model,
and Mode, in that order, followed by an uncounted readiness view titled Your first
task. Each step is pending, current, or completed: the current step is a filled
card, completed steps show a check, and pending steps show their number. The
Project step chooses the first task's mode (Work or Code; Code alone when Work
is off; Chat Projects have no folder and are not offered) and its folder with
`OctantToggleGroup`; Choose a folder… opens the same Project create surface as
the empty Work and Code pages, so making the folder a Git repository stays an
explicit choice there, and a folder created that way becomes the first task's
Project. The Model step writes to what a new task in that mode already starts
from: Work's default model in Work settings, and the composer's remembered
model for Code. The readiness view reports provider, Project, and model
separately; a missing fact opens its exact setup surface, and Start a task
appears only when all three hold. Its heading reads Ready to start only then and
otherwise names what is missing (Needs a provider and a model). Answers still write through to the settings
that own them. First run records its outcome only after every answer has landed. When
the host refused an answer, the first press of Skip setup or the primary action
says so in a warning notice and records nothing; the next press goes on without
that answer, so a refusing host can never leave the dialog impossible to leave.
A refused outcome is reported the same way and the dialog stays open.
The readiness view also offers an optional Explore capabilities card for Browser,
Computer use, helper agents and person memory. It reports current host settings,
uses labelled static examples and links to existing Settings controls. Computer use
shares the guided permission setup and working test from Settings, with saved
progress across relaunch. Setup is optional and never grants an agent app access. Dismissing
it changes no setting or readiness answer. It adds no step or progress count.
[Start screen](docs/design/start-screen.md#optional-capability-card-in-your-first-task)
owns its behavior.

File editors share a compact command toolbar and one Editor settings disclosure.
The primary Save and the unsaved/saving/error state stay visible above the
source; preferences are secondary. Source/preview switching retains selection
and undo, and a Markdown split stacks at narrow widths. Each source/preview
region owns its scrolling. Conflicts show a bounded disk-versus-draft comparison
with explicit keep-draft or discard actions. A selection proposal or replacement
review remains a separate disclosure above the editor, with its own before/after
comparison and an explicit apply action. Colors and typography come from the
existing editor projection and shared controls. Behavioral detail is in
[Workspace: File editing](docs/design/workspace.md#file-editing).

The right dock follows the active pane and never leaks another pane's content.
The dock and the bottom panel both step aside while a reader route (Board,
Inbox, pull requests, issues, Archive) holds the pane: a reader is a page about
many threads and shows none of them, so one thread's tools do not keep a
quarter of the viewport there. Both keep their tabs and their height and return
with the thread, and their toggle leaves the reader rather than closing a
region that was only stepped aside.
On wide windows it may use at most half of the workspace beside the sidebar
(`dockWidthCeiling`, never under the sidebar minimum or over its maximum), which
keeps the thread readable beside any tool, and the resize handle stops there
too; with two columns of tool tiles shown it may take all the thread's own
minimum leaves (the thread keeps 440px beside two columns from 1100px up and
360px below, which the stylesheet's grid mirrors as `--octant-tiled-primary-min`;
one column keeps 560px from 1100px up. At 560px two tools could never stand side by
side in a 1440px window, so a second column asks the thread for less); the bottom panel may use at most 38 percent of the
viewport height while preserving 320px for the primary workspace, and it hosts
exactly Review, Terminal, Browser, Files and Side chat. The dock can host
Review, Pull requests (open rows for a Code thread's Project), Files, Document
(only once a turn has written one), Browser, Terminal, Canvas, Plan (only for a
real plan artifact), Delivery (only for a configured target), Agents (when
children exist or explicitly invoked), Simulator, and Side chat. A Markdown or
text file a Code turn creates or rewrites, and a Canvas a Work or Code turn
authors, open in the dock beside the transcript once, the first time they appear: the
offer never moves focus from the composer, a rewrite never reopens a tab, and a
tab the person closed stays closed. Document
reads the file through the same host-authorized open the editor uses and
renders Markdown with the preview's own viewer. With no open tab, the dock
opens on a stack of cards, one fact group each and each omitted when the window
has nothing true to put in it. A card is the overview's own recipe: the surface
fill, a hairline, a medium-weight title, and rows at the 28px step, with a
figure or word in meta ink at the title's right. **Environment** names where
the thread runs (the host, the Project, the branch with Worktree when it runs
in one) and the mode at its right, and, in the desktop app's own window for a
thread on this computer, a **Remote access** switch read once from the host's
listener status: on turns the listener off through the same host action
Settings uses, and off opens Settings › Remote access, where the address and
certificate enabling needs are chosen and confirmed; **Local servers** lists the servers this
thread's checkout is serving, each a dot (the success ink when it answers) and
its name with the port, from one observation when the overview opens, never a
poll; both titles open the Environment tool. **Context** shows the share used
at its right beside a short neutral bar, with used of total under it, from the
composer meter's own source. **Changes** (Code only) shows the board's observed
`+`/`-` totals over the file count, never a stale observation, as the row that
opens Review, and the thread's pull request with its checks in words.
**Outputs** lists the documents and Canvases the window knows the thread has
(those it had when opened and those its turns wrote since, never a deleted
file), newest first and at most five, each a row that opens it in Document or
Canvas, with the count at the title's right. **Background tasks** lists the
runs the thread's agent handed work to, from the same read and cadence as the
Environment tab's Subagents row: each running one a spinner, task, and age,
with the running count at the title's right, and the finished ones folded under
one "N finished" row; a row opens that run in Agents.
**Running now** lists the other threads the window knows are working (any
mode, at most five, newest first, never the thread on screen), each a spinner,
title, Project, and age, and opens that thread. Model and access are not
repeated here: they are on the composer. Tools open from the dock's title band
(its quick tools or tab strip) or Add tool, which lists every tool that is not
open. Add tool opens a menu in a portal anchored to the plus
that was clicked, aligned to its start edge and kept inside the window by
collision handling; it takes focus on its first tool, closes on Escape or an
outside press, and returns focus to the plus. The bottom panel uses
the same compact tool-tab and Add tool model for Review, Terminal, Browser,
Files, and Side chat where supported. Opening a tool in the dock leaves the
bottom panel open: a Terminal below and a simulator and a page beside it are the
point of having both regions. Only a tool the panel is already showing moves out
of it, because one instance appears in one region at a time; Terminal
immediately attaches or starts and preserves one server session when moved.

Browser and Terminal are repeatable right-dock workspaces: Add tool creates a
new tab identity, an isolated Browser context or Terminal session, and a stable
numbered label when siblings are open. Files, Document, Review, Agents, Canvas,
Plan, Delivery, Simulator, and Side chat are singleton destinations. One instance
still appears in only one region at a time.

**Tool tiles.** The dock body shows one open tool by default. A maintainer
testing an app in the simulator beside the page it served had to choose between
them, so open tools can also be shown together as tiles, each one live, under
the one tab strip. At most two columns of at most three tiles are shown; a
request past either cap is refused, except that "beside" with two columns present
puts the tool below in the last column. A tile is a region named for its tool
with **one bar**, the tool's own header, 32px high in every tile so neighbouring
bars line up. Its leading edge names the tool once (the icon and name; for the
Browser the bar is its row of pages, each with its close, and the new-page
control, and with one page the page's title is the name) and its trailing edge
holds the tile's controls: an **Arrange <tool>** menu button and a **Close
<tool>** button that closes the tool as its strip tab's close does (every page
for the Browser). Stacked, a page showed four bars (the strip, a "Browser"
caption, the Browser's own page row and its toolbar) and named the tool three
times, so the strip no longer repeats a shown tool and a tile has no caption
over its bar. A tool alone has no bar of its own. The Arrange menu holds **Move
left**, **Move right**, **Move up** and **Move down**, each present only when
that move is possible within the caps (a one-column layout moved sideways makes the
second column, and a column left empty goes), then **Show alone** and **Hide
from view**; a move keeps every tool mounted and the native Browser page
follows its tile. The focused tile (the one whose tab is selected) is told apart by its bar
reading in the full ink, with no ring and no fill, so a see-through theme shows
through every tile; the dock's own surface is the tiles' ground. Dividers
between columns and between a column's tiles are hairline separators with a 7px
hit area, a hairline at rest, in the quiet strong-divider role while hovered or
held, and never an accent line after a click (only keyboard focus shows a mark,
the app's own focus outline), that resize by pointer drag or arrow keys (Home and End go to the ends
of the range the floors allow), each named for the two tools it sits between
("Resize Environment and Vitals") and reporting the range it can really reach; no tile
is shorter than 140px or column narrower than 280px (the dock's own minimum
width) while the dock has the room, and the columns stack when the tile area
cannot give two columns 280px each. Columns therefore stand side by side only
when the tile area has the width: at 1440px with the sidebar open a second
column widens the dock to about 620px and the columns stand side by side at about
306px each (they stacked at 500px while the thread kept 560px), and in a narrower
window "beside" stacks, which is why the head control promises no direction;
the strip menu keeps explicit Show beside and Show below. Stacked columns stay
resizable by a separator between them along the vertical axis, and no tile is
ever under its floor: when stacked tiles cannot all fit the dock, the tile area
scrolls with every tile at the floor. Choosing a tab that is shown
focuses its tile; choosing one that is not replaces the focused tile's tool.
All Browser tabs are pages of one Browser tool, so there is at most one Browser
tile and choosing another page changes that tile's page; the dock remembers the
page last shown and returns to it whenever the Browser is shown again, from its
strip entry, a menu or a drag. A tile clips its tool to its box (it has no fill of
its own), and gives the tool a definite height to scroll within, so one tool's
rows are never painted over the next tile. A tile resolves its own
tool: one that cannot be described for the active pane says so inside its tile,
never shows another pane's content, and leaves the other tiles on screen. The
single-tool view is the same tile area with one bar-less tile, and tiles are
positioned children of one element, so a tool is never remounted when a
neighbour joins or leaves, when it moves between columns, or when focus or a
divider moves; only choosing another tool for a tile replaces it.

With two or more tiles the strip lists only the open tools that are not
shown, then Add tool and **Show another tool**; with every open tool shown it
holds just those two controls, and with one tool shown it is the ordinary tab row.
Its roving focus keeps working with fewer tabs, and choosing a hidden tab
replaces the focused tile's tool. A hidden tab's context menu (right click, the
menu key or Shift+F10) offers **Show beside** and **Show below**. A **Show another tool** button in the dock head, before Close, opens a
menu of the same name that lists first the open tools that are not on screen and,
after a separator, the other tools the thread can launch; it shows the choice
with the focused tile in one step (opening it first when needed), beside it when
the columns stand side by side and below it when they stack, leaves Browser
out while a Browser is on screen, and is absent in the narrow dock and when the
tile caps are full. It exists because a strip with four tools open fits two tabs
at a usual dock width, and a tool in the overflow list has neither a menu nor a
drop target. Dragging a tab onto the dock body does the same: the right third shows it beside, the lower third below, and anywhere
else replaces the focused tile. With two columns shown and no width the person
has chosen, the dock widens to 840px (not saved), under the ceiling above;
showing a tool beside, which makes the second column, clears the person's
sizing the way opening a Browser or Terminal does, and a drag afterwards holds. The
narrow modal presentation has room for one tool and draws only the focused tile;
the layout stays stored. The layout is window-local presentation, stored with
each thread's open tools, and the bottom panel never has one. Tile changes are
made on the tools on screen, so a tool the bottom panel holds never counts
toward a cap or a divider's shares. A tool the bottom panel takes, or one that
becomes unavailable, loses its tile and comes back as a tab, not as a tile.

Without a saved show or hide choice, a wide window starts with the right dock open and a narrow window starts with it closed. The bottom panel starts closed. An explicit dock show or hide is restored per window; merely mounting the default records no choice, so an initial narrow frame does not become a saved close. The active-pane eligibility rules below still determine whether dock chrome is shown.

A welcome, Project, or other pane with neither a bound thread nor a valid
launchable tool keeps the dock closed and omits its toggle. A new Code task's
pane before its thread exists keeps the toggle but starts closed, whatever the
window's saved choice: it has nothing of a thread's to show, and opened by
default it covered a third of a blank start screen to say its tools were not
available yet. Opened there by the person, its title band shows the common
tools disabled ("Available once the task starts") and its body says so (or,
once the start screen has a Project, holds that Project's quick tools). That
show or hide belongs to the draft and is never saved as the window's choice;
once the task has a thread the window's own choice applies again. Restored presentation for another subject never makes unavailable
chrome visible.

Environment is a right-dock tool, opened from the dock's title band (its
quick tools or tab strip) or Add tool and nowhere else; the title band carries no second Environment button. It reads
top to bottom as cards in the Settings kit's grouped-card look: one header card,
then two captioned cards of rows. A card is a faint wash of the ink over the
dock with no ring (increased contrast adds one), so it never paints the opaque
page colour onto the glass. The header card names what the thread works
in: the name on its own line, then the branch glyph, the branch, a dot, and the
home-relative folder in mono, with the full summary (working folder, running
servers) kept as one sentence for assistive technology. Inside it, an inner
soft box says what the checkout holds (a file-diff glyph tile, Uncommitted
changes with its added and removed counts under it, and a chevron, opening
Review; No uncommitted changes when clean), a detached HEAD or separate
worktree when true, and Commit or push and Create pull request sit under it as
two equal buttons. The rows follow in two cards, Running (Local servers, open by
default only when this checkout is serving something; Subagents, one row with
its working / to review / done counts that opens the Agents tool — reading and
steering a subagent belongs there; Computer use) and Delivery (Pull requests,
Sources, Delivers, Working folder, and Usage, closed by default; totals, the
spend ceiling form for tokens, turns, hours, and US dollars, whose fields wrap
two by two in a narrow rail, and Open Usage dashboard inside). A card with no
rows to show is omitted with its caption. Every row has one grammar: a 26px
glyph tile, the name, the row's state as a small neutral pill, and a trailing
chevron where the row opens (a row's own action, such as All pull requests,
wraps under it when the dock is narrow rather than squeezing the pill). Rows are 44px, lift their ink on hover
rather than taking a fill, and an open row's content starts under its name.
Other servers stay behind a nested disclosure; none are stopped or removed by
hiding them. The cards sit one step above the dock's own background. Sources list the current thread's journaled image attachments when present.
Computer use offers Picture in Picture show/hide for its live activity card
that floats over the main conversation. The Browser's live preview is separate:
it follows the thread's Browser, not this control (see
[Workspace](docs/design/workspace.md#tool-lifecycles)). Neither preview occupies
Environment, and hiding one never stops its session. Computer-use approval and
stop controls stay with its card. It does not duplicate the Agents dock. Missing checkout context
is neutral explanatory text rather than a warning callout.

**Moving a thread starts in Environment and nowhere else in the thread.** The
behavior and its rules are in
[Hub and spokes: moving a thread](docs/design/hub-and-spokes.md#moving-a-thread-to-another-member);
this is how it looks.

- **Computer card.** Above the header card sits one captioned card, Computer,
  with one row in the row grammar: the environment mark's own glyph in the tile
  (a laptop for this computer, a cloud for another host), the host's name, a
  pill (This computer, or the host's name when the window shows another host's
  thread), and a chevron. It is the first thing Environment says, because where
  a thread runs is what a move changes. On a host that is not in a hub, the row
  opens to one neutral sentence, "Join a hub to move threads between your
  computers", with **Set up** opening Settings › Remote access › Hub. A paired
  screen without owner powers on the source sees the row without its move
  content.
- **Choosing a destination.** Opening the row lists the person's other
  computers from the roster under **Move to**, guests excluded, each a 36px row:
  its glyph, its name, and one pill for its state. Eligible members come first
  (Online, or Asleep when the hub's wake service could wake it). Members that
  cannot take this thread stay listed and disabled, with the reason as the pill
  (No matching repository, or No matching Project for Chat and Work; Not
  accepting moves; Offline), so the person learns why rather than wondering
  where a computer went. A member answers Move in off, Owners off, and a
  source it no longer lists in the same words, so they share one pill; a Mac
  that is not an owner there is told so at the unlock, in the move sheet. Choosing a
  member shows its Project under it: chosen for the person when exactly one
  Project fits, otherwise a compact picker listing only Projects that fit (for
  Code, each with its repository in mono). **Review move** is the row's own
  action, a full-width secondary button, disabled until a member and Project
  are chosen.
- **The move sheet.** Review move opens a dialog, 480px wide, a full-height
  sheet at phone width. Its title is "Move to" and the member's name, with the
  thread title under it in meta ink. A route line reads from the source to the
  destination: each host's glyph tile and name, an arrow between them, and the
  destination Project after a slash. **What moves** follows as rows with their
  sizes in tabular figures at the right: Conversation (the turn count), one
  row for the attachments, admitted inputs, generated images, Browser
  captures, and Canvases together (None when the thread has none), the
  branch name in mono with its commit count and uncommitted `+`/`-` counts
  (Code), and the files in its own folder with their size (Work, when the
  thread is that folder's only user; a Work thread whose folder the Project
  or another thread shares says, in their place, that only the thread moves
  and its files stay on this computer). A total line gives the size, every row included, and an estimate,
  and one meta sentence under it names what the estimate rests on: the speed
  earlier moves to that member reached, or the assumed rate when none has
  been timed. The sheet opens at once; the line reads Measuring… until the
  sizes arrive, and Size unknown when they cannot be read. A row whose parts
  could not be sized reads Size unknown in place of its figure, and the total
  counts the rest and ends "1 size unknown". Neither holds the move back. **Stays here** is a closed disclosure naming each part that
  applies (terminals, previews, Browser pages, ignored files with their count,
  Full access and grants, sign-ins, and for Work the folder's ignored files,
  links, and files holding a secret, with which the folder stays). When the worktree holds files that stay
  behind (refused by the Secret guard, or ignored), the disclosure opens by
  itself, lists them, and says the worktree folder stays on this computer
  with them. One sentence states the consequence in
  plain words, never a warning colour: "This thread is erased from this
  computer once" and the member's name "has it." A busy thread adds a two-way
  choice above the buttons, Move after this turn (selected) and Stop and move.
  Choosing Stop and move turns the consequence sentence's tail into "The
  running turn stops now, and its pending approvals and questions are
  cancelled." and the primary into **Stop and move with Touch ID**; until the
  turn has stopped, the Computer row's pill reads Stopping and its progress
  line "Stopping this turn, then moving to" the member's name.
  The primary button names the unlock it asks for: **Move with Touch ID**, or
  **Confirm on your phone** in a window with no Touch ID key. Beside Move with
  Touch ID, **Confirm on your phone** is an outline button, and one sentence
  above the buttons names the phone it means (one that is an owner on the
  destination). A browser passkey does not unlock a move, so no **Move with
  passkey** button is offered. Cancel sits beside them, and a Code thread has
  **Hand over instead** as a quiet text button at the sheet's start edge. Focus
  lands on the primary button, Escape cancels, and the unlock prompt is the
  platform's own.
- **Waiting for your phone.** Confirm on your phone closes the sheet and puts
  the Computer row's pill on Waiting for your phone. Its open content reads
  "Confirm on your phone to move this thread to" the member's name, with the
  time the wait ends, and **Don't move** as an outline button. The host
  freezes nothing while it waits, but the composer gives its place to the
  frozen bar titled Waiting for your phone, with the same sentence and Don't
  move, because a message sent then would start a turn the move would have to
  wait for. The phone app lists each waiting move under **Moves
  waiting for you** ("Move" the thread's title, or the thread count, "from"
  this computer "to" the member), with **Confirm move**, which asks for the
  phone's unlock once. A wait that ends unanswered becomes This thread can't
  move.
- **While it moves.** The sheet closes when the unlock succeeds. The composer is
  replaced by a frozen bar in its place and height: a determinate progress
  line, "Moving to" and the member's name, the moved and total sizes with the
  estimate in tabular figures, and **Cancel move** at the end. The transcript
  stays readable and every control that would change the thread is disabled
  with "Moving" as its reason. The Computer row's pill reads Moving with the
  percentage, and the title row's environment mark carries a small arrow
  badge. Assistive technology hears the start, every quarter, and the end
  through one polite live region, never each chunk. The same bar, without the
  progress line, holds the composer's place whenever something else holds the
  thread: "Moving to" the member "after this turn" with **Don't move** (a
  message sent then would start another turn and keep the move waiting),
  "Handed over on" the branch in mono with **Take back here**, and on the
  destination "Arriving from" the member, with **Activate anyway** once it is
  offered. A failed move holds nothing, so its composer returns.
- **Moved.** On `committed` the pane becomes the tombstone: the source and
  destination route line, "Moved to" and the member's name with the time, and
  **Open there**, which opens the thread on that member's own web page in
  the default browser and says under the button, in one polite line,
  "Opened on" the member's "own page in your browser." When that member
  serves no web page it copies the thread's link in the form an Octant phone
  opens instead and says "Link copied. This window can't open threads on"
  the member, "the Octant phone app opens this link." Nothing opens inside
  this window
  ([why](docs/design/hub-and-spokes.md#moving-a-thread-to-another-member)).
  The thread's
  sidebar row leaves this host's list; a window that reads both hosts shows it
  under the destination with the cloud glyph, so it appears to travel rather
  than vanish. One notification says the move finished. When the worktree was
  kept, the tombstone adds one row under the route line: the files that stayed
  with it in mono (the first 200, then "and" the rest counted), the folder,
  and **Remove worktree** as a quiet button that asks once before removing
  it, saying the files have no other copy and that the branch and its remote
  stay. Once removed, the row says so in one sentence. When a Work thread's
  own folder was kept, the row says "Its folder stayed on this computer at"
  the folder in mono, lists what stayed the same way, and offers no remove
  action, because the folder is the person's own; the Moved notice says its
  folder held files that stayed here and names the folder. Opening the moved
  thread again after its pane closed (an old link, a notification, or a
  search) opens the same tombstone in the active pane without changing the
  window's Project; a window that cannot read this computer's moves (a remote
  client) shows the pane without the tombstone. When a part of the thread
  could not be read and stayed, the tombstone and the Moved notice name each
  one in a sentence after the time (the first 1,000, then "and" the rest
  counted).
- **This thread can't move.** A failed move unfreezes the composer and puts an
  inline notice above it and in the Computer row's open content: the title
  "This thread can't move", the reason in one sentence, and its recovery as
  buttons (**Try again**, **Choose another computer**, and for Code **Hand over
  instead**). It uses the warning ink, because the person is about to switch
  this computer off and must not mistake the thread for moved; it stays until
  dismissed or the thread moves.
- **Arriving.** On the destination the thread's row and pane show an Arriving
  pill, a neutral wash, with the source's name. When the source has been
  unreachable for five minutes, the pane's notice offers **Activate anyway**
  with one sentence saying the source froze before it went away.
- **Handover sheet.** Hand over instead opens the same dialog shape titled
  "Hand over through Git": the branch in mono (or the new
  `octant/handover/` branch it will create), the remote it pushes to, a
  read-only note preview closed to its first lines, the Ask the agent to
  summarize switch (on) with one muted sentence saying one turn of the
  thread's agent adds where the work stands and what comes next and that the
  note goes without it if the turn fails or takes over two minutes, and
  **Commit and push** as the primary button, or **Commit** when there is no
  remote, with a sentence saying the work then stays on this computer. While
  the summary turn runs, a status line reads "Asking the agent to
  summarize…" and the switch is disabled.
- **Prepare to shut down.** One dialog, 640px wide and at most 80% of the
  window's height, with its list scrolling between a fixed head and foot. It
  reads as a decision already made for the person, which they can glance at
  and confirm:
  - **Head.** The title "Prepare to shut down", one meta sentence ("Move your
    threads to another computer before this one goes off."), and the **Move
    to** control: a compact menu button with the destination's glyph, name,
    and state pill, listing every member with its own pill (eligible ones
    first, ineligible ones disabled with their reason).
  - **Rows.** One 44px row per thread in the list's order (running and waiting
    threads first, then newest activity): the mode glyph, the title (truncating
    first), the Project in meta ink, the size in tabular figures, and the row's
    choice as a trailing menu button showing its current word (Move, After this
    turn, Stop and move, Hand over, Leave here). Its menu lists the row's own
    choices, then **Move to** each other member that can take the thread ("Move
    to" the member's name, with "after this turn" for a busy one). A row moving
    somewhere other than the head's destination names that member in the
    button, and drops the head's reason pill. A row that cannot move shows
    its reason as a small neutral pill before the button. A running thread
    carries the spinner the sidebar uses; a waiting one, the warning dot.
    "Older threads" is one closed disclosure row with its count.
  - **Foot.** One summary line that updates as choices change, in plain words
    with tabular figures ("8 move to Mac mini · 1 hands over · 2 stay here ·
    1.4 GB, about 2 min"), with the estimate's basis under it as one meta
    sentence, as in the move sheet; a row whose size cannot be read says
    Size unknown and still moves, and one whose bulk parts alone could not be
    sized says "At least" what was measured, counted in the total as one size
    unknown. Then the buttons: Cancel, and the primary, which
    names the count and the unlock (**Move 9 threads with Touch ID**; **Move 9
    threads** when more than one destination needs its own unlock, asked in
    turn; **Hand over 2 threads** when only handovers are set, which need no
    unlock). **Confirm on your phone** sits beside it as an outline button, and
    is the primary in a window with no Touch ID key: every destination's rows
    are held for the phone at once, one confirmation per destination on the
    phone, and a row it holds reads Waiting for your phone until the phone
    confirms. With nothing set to move, the primary is disabled and the summary
    says why. When a destination's unlock is declined or its request fails,
    the foot's alert names it, the other destinations still move, and each of
    its rows reads Stays here with a small neutral pill saying why (Not
    unlocked, Not an owner there, Offline, Not accepting moves, Couldn't
    start, or Moves next past one unlock's limit). A row the host did not take
    from a batch it started reads Stays here with Already moving (another move
    or wait holds it) or Can't move (its thread is gone), and the batch never
    waits on it.
  - **While it runs.** The dialog stays and becomes the progress view: a
    determinate bar under the head for the whole batch, and on each row a thin
    progress line and a state word in place of its choice (Waiting, Moving with
    its percentage, After this turn, Stopping, Moved with a check, Handing
    over, Handed over, Handed over, not pushed, Can't move, Can't hand over).
    A handover that left files out because they hold a secret reads "Handed
    over · 2 files stayed here", with the file names in mono meta ink after it.
    Escape or closing hides the dialog without stopping anything; the menu bar
    shows the batch's progress as the ended and total counts beside its glyph
    ("3/9") and a disabled "Moving threads · 3 of 9" line above **Prepare to
    Shut Down…**, which brings the dialog back in the window that runs the
    batch. The menu bar lists Prepare to
    Shut Down… while the window last saw this host in a hub with another
    member, or while a batch runs. Each moving thread also shows the single-move frozen bar
    in its own pane. Assistive technology hears the start, each thread that
    finishes or fails, and the end, through one polite live region.
  - **Done.** The head becomes a success check and **Safe to shut down**, with
    the count moved and where ("8 moved to Mac mini, 1 to Desktop, 1 handed
    over."). When a handover left files out, the head reads "Safe to shut
    down; 2 files stay on this computer" and the meta sentence adds "Left out
    because they hold a secret:" with their names, never a plain Safe to shut
    down. Opened from Quit, the primary is **Quit Octant**;
    otherwise **Done**. With failures, the head instead reads how many threads
    stay on this computer in the warning ink, failed rows rise to the top with
    their reason and recovery buttons (Try again, Hand over for Code), and the
    buttons are **Done** and, from Quit, **Quit anyway**.
  - **Nothing to decide.** With no listed threads the dialog says "Nothing to
    move" and Safe to shut down at once. On a host outside a hub it says
    "Join a hub to move threads between your computers" with Set up. With no
    member able to take any thread, every row reads Leave here with its reason,
    and Code rows still offer Hand over.
  - **Keyboard.** Focus opens on the primary button, so Return accepts the
    defaults; Tab reaches Move to, then each row's choice, then the foot. Each
    row's choice is named for its thread ("Choice for" and the title), and its
    menu opens on Space or Return.

Rationale: Environment already answers "where does this thread run", so the
control that changes the answer belongs beside it, and a person looking for
it in a menu finds the one place that also shows what will and will not
travel. The dialog is where the consequence is stated, because a move erases
the source, and the frozen bar keeps that state on screen where the composer
was, the first place the person would try to type.

The Board is an operational reading surface with four fixed,
server-authoritative statuses: Ready, In Progress, Waiting, and Done. All
four lanes show by default as soft wells: a faint tint of the text ink (3%)
over the workspace colour, one soft hairline, `--oct-radius-md`, 8px of inner
padding, and 12px between wells. A well's head names it once by mark, name,
and count, with no rule under it: the name at the section-label step in the
secondary ink and the count pinned to the trailing edge in the meta ink. The
mark is told apart by shape, not hue: Ready a hollow ring, In Progress a small
turning arc while any card in the column is executing and a filled dot when
none is, Waiting a filled dot, Done a check. Under the Colour style the marks
take palette colours (Ready stays grey, In Progress orange, Waiting purple,
Done green). A Board/List toggle leads the toolbar, and every control on it
(the segmented choices, search, Filters, Refresh, View) is one rail control
(`--oct-rail-button-h`). A card is a raised object inside its well: the card fill, a hairline,
`--oct-radius-inset`, and 12px of padding. It carries the Project as an
eyebrow, the title, and, while the thread is executing, a live line under the
title (a small turning arc and the latest sub-agent line in the mono meta voice,
or "Working…" before one reports). Under that come what the thread waits on,
active runs and failing checks, and each linked pull request as a compact
preview box (the PR mark and title, then the repository, state, and checks).
The card ends with a footer row: the provider mark (the same glyph as the
sidebar's, 16px, named for assistive technology), the worktree branch in a mono
chip and the diff size in the existing green and red roles (Code only, and only
when the tree changed), and the age at the trailing edge. Checkout, plan, and
review facts live on the list view and the thread. Waiting does not become a
warning wall. Labels and facts use the selected
interface typography. Thread listing, pull-request snapshot, and per-thread
runtime reads overlap where independent.

Usage totals sit in the Settings kit's card inside Settings. Provider create
forms, individual extension objects, and artifact cards use the same raised
recipe; in Settings, the extension and skill collections are kit cards too, and
the Installed and Marketplace switch rides the first section's label line. The
command palette
groups results and shows a shortcut badge when a row maps to a user-bindable
chord. Shared dialogs keep `--oct-radius-lg` and overlay shadow.

The context meter is a circular composer control, not a dock tab: a 16px
gauge with a full track and a 2px round-capped arc filled clockwise from
twelve o'clock by the used share. It is the one composer mark that carries
colour in every style: the arc is the palette's amber with its track a faint
step of the same hue, and from 80% the ring turns red, so how full the window
is reads at a glance. It
opens an opaque 320px popover: a header with the used and
maximum figures and share, one 4px segmented bar whose empty track is the free
space, a breakdown folded behind a chevron each time the popover opens, the
provider's limits as a name, a reset countdown or weekday, the share left, and a thin
bar each, and a footer action to the fuller surface (the context inspector, or
Usage for a provider the host does not plan). The breakdown lists only the
parts the data attributes: planned threads show their manifest categories,
overhead, reserve, and free space; a provider-run window shows the parts its
runtime reported (system prompt, system and MCP tools, memory files, skills,
agents, messages), or, for a runtime that reported none, the parts Octant can
count itself (Octant instructions, Octant tools, skills, attachments), and in
either case one `Other (provider)` remainder so the parts add up to what the
window holds. When Octant sent instructions, skills or attachments it cannot
count (the runtime does not say what it keeps, it compacted, or a turn went
uncounted), a line under the key says why they are in the remainder. With no parts it shows used and
free. The thread's input and output totals stay apart because they are sums over
turns, not parts of the window. A part Octant counted is marked `Estimated`,
with its accuracy (the existing exact tokenizer, model-family estimate and
conservative estimate labels) in the part's tooltip and in a line under the key;
the remainder after an estimate is marked the same way. Counts (tools, MCP, memory
files, skills, agents) use the harness breakdown's row style; tools the runtime
knows but has not loaded read `N deferred` and take no share of the bar.

Categorical colour: the parts of a
context window are categorical data, so they carry hue in every style, Default
included, beside the context ring as the second colour exception in that
style. Each category has one tone, taken from the palette roles in seven hues
and a second, darker step of each (the same hue mixed toward the ink, which only
raises contrast against the panel in either theme), and keeps it wherever it
appears: the popover's bar and key, and the swatch on the context inspector's
entries. Categories are listed in one fixed order (the contract's category order
for a planned thread, a fixed part order for a provider-run window) and the
tones are chosen against that order, so neighbours differ clearly. A category
that is the same thing in both kinds of window (conversation and messages, MCP
and MCP tools, Octant tools and system tools, provider framing and system
prompt, a profile's instructions and Octant instructions, workspace context and
attachments, what nothing accounts for) shares one tone. Neighbour contrast is
measured, not judged by eye: every tone holds at least 5.2:1 against the popover
in light and dark, and every neighbouring pair stays clearly apart in OKLab.
Adjacent lightness ratios stay under 2:1, because seven hues that each clear 5:1
cannot also sit 3:1 from one another; the one-pixel gap and the name beside every
swatch carry the rest. `visualLanguageContract.test.ts` computes both from the
stylesheet and owns the enforced floors. Red is left to the ring's near-full warning. **Free space and Reserved stay
neutral**: no hue, the panel's ink mixed into its ground, with Free space drawn
as the bar's empty track. Every part is named beside its swatch and carries its
tokens and share, so hue never stands alone. The exception is scoped to these
segments in `visualLanguageContract.test.ts`: in `context.css` palette colour
may appear only on the tone rules, the ring and the limit bars. Limit bars fill
in blue, by the share left. A limit near its cap is marked on its row and in its bar's value text,
never by ink alone. Unknown or stale data is labeled as such and never rendered as zero.
Where a provider runtime compacts the session by itself and has said where, one
secondary line under the window bar reads `N until auto-compact` in the bar's
compact token format (the room between that point and the latest request's
fill, or `At the auto-compact threshold` once none is left). The line is
shown only for automatic compaction with a reported point, never derived from the
window, and it leaves the ring and the bar's colours alone.

The task visualizer is a compact composer-adjacent chip backed by the thread's
journaled plan. It appears only when a real plan exists, shows proposed review
or `Step n / total`, and opens a popover with title, step states, evidence, and
start/finish/reopen/drop actions when approved. It must not invent progress from
assistant prose or display an empty plan form.

A Code thread without a current journaled plan offers Propose plan beside the
composer's attachment controls. It opens the existing plan form in a labeled
dialog, with keyboard focus restored on cancellation. Submission records a
proposed artifact and does not approve it or change execution access. The
entry returns after withdrawal; the dock stays artifact-only.

The provider's recorded task list is a separate group. It is open while the
turn that recorded it runs, so the step in hand reads without a click, and
folds to its header once the turn settles; a person's own open or fold wins
over both. The header keeps completed/total progress and failed or waiting
counts visible while folded. An unfinished list after a settled turn says
Incomplete; it does not claim that the agent is still running. The open list
shows the recorded ordered steps in a bounded, scrollable list: the running
step at Medium (500), finished steps struck through in secondary ink, and no
fill on any row. Neither this list nor the journaled plan borrows progress,
completion, or authority from the subagent group.

### Breakpoints

The shell has two breakpoints, both `max-width` queries, so each names the
widest viewport its behavior applies to:

| At or below | Source                                                     | What changes                                                                                                                                                                                                                                     |
| ----------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 960px       | `useNarrowViewport` (`useShellPresentation.ts`), shell.css | The right dock opens as one narrow modal sheet over the page (a titled dialog, no resize handle, Escape closes it and returns focus) instead of a column; the bottom panel is unavailable; the sidebar stops resizing; Settings uses its drawer. |
| 680px       | `useSidebarDrawerViewport`, shell.css (`min-width: 681px`) | The workspace sidebar becomes an overlay drawer, the window frame goes flat, and pane headers drop the Project step of their breadcrumb.                                                                                                         |

Inside a surface, layouts reflow at component breakpoints rather than shell
ones: `--oct-bp-lg` 920px (two-to-four column grids and the Project overview gutter),
`--oct-bp-md` 720px (Settings fact lists and gutters, issue rows), and `--oct-bp-sm` 560px (start-screen
tiles and cards to one column, compact Settings title bars, 44px Project
rows and always-visible thread row actions). Other widths in feature stylesheets are local to that
surface. The mobile app has a separate design system under
`apps/mobile/design-system`.

### Tabs and segmented choices

True page tabs, segmented choices, and pane identity are intentionally
different. `OctantTabs` owns a flat rail with selected fill and keyboard tab
semantics. `OctantToggleGroup` owns the enclosed track used for mutually
exclusive values. Each split pane keeps its close action on the trailing edge of its header;
only a pane underneath the window controls reserves space for that cluster.
The split-pane drag handle alone owns active-pane paint. Feature
styles may size or scroll these primitives but may not restore a local tab
track, underline recipe, or persistent active border.
The Project browser's agent-page strip is one `OctantTabs` rail whose tabs hold
two lines (the page, then the thread that owns it, with an "Agent active"
badge). In a narrow dock it wraps onto further rows rather than scrolling, so
no tab hides past an edge.

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
  when the title is visually hidden. Dialogs and floating popups share one
  layer, so the one opened last paints on top: a menu or popover opened inside
  a dialog or the narrow dock sheet appears above it, and Escape closes the
  innermost surface first.
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

Pull requests and usage surfaces use explicit loaded, refreshing, stale,
rate-limited, empty, unavailable, and error states. GitHub refresh is user
triggered and asks `gh` only for open/draft rows. Connected repositories refresh
with at most four concurrent reads, then reconcile in stable Project order under
the global preview bound. Known closed or merged identities are recovered
separately. Stale cached data is visibly stale. Provider usage follows the same
provider-neutral context/limit model and preserves unavailable values.

The Issues surface reads like GitHub's issue list: one toolbar with a
repository chooser (All recent repositories, or one repository, from the same
popover), state, sort, and search; then a bordered two-pane card with rows on
the left (state glyph, `#number title`, repository and author beneath) and the
reader on the right (kicker, title, state and dates, labels, Start a Code
thread, the body and each comment in their own cards). With no recent
repository the page asks for one in a single panel rather than opening on the
whole catalogue. Start a Code thread leaves the surface with the issue
attached to a new draft as its Create from context.

## Iconography and provider marks

Lucide is the product icon library. Use 14–16px for compact controls and
1.5–1.8px strokes. In a Button, pass icons with the shadcn `data-icon`
convention and let the recipe size them. Icons clarify labels and do not
replace an essential label without an accessible name.

Provider identity uses locally bundled, licensed provider logos selected by
`ProviderGlyph`. This is the explicit identity-asset exception to the
originality rule; it does not permit copying another application’s UI assets or
implementation. Keep source and license provenance with each mark. Never fetch
a logo at runtime, use emoji, or draw an approximate brand mark. Unknown or
private providers keep a truthful fallback. The same marks appear in Settings,
model pickers, and thread metadata.

Message timestamps and direct Copy controls share one reserved row. They appear
on message hover or keyboard focus and stay visible on touch and high-contrast
interfaces. Revealing them must not move the transcript.

## Motion and interaction

Functional feedback uses 120–160ms transitions; the base system duration is
200ms. Use standard easing and no decorative entrance animation. There is no
ambient motion behind the work by default; an animated built-in picture, the
Pulsing characters, Dithered pixels, and Flowing grounds, and a printed picture
set to Wave are the moving grounds a person may choose, and reduced motion holds
each on a still frame. Running state
must have a textual or shape distinction in addition to motion. `prefers-reduced-
motion` and the persisted reduced-motion setting disable transitions and
animations without removing state information.

**Overlays.** Everything that opens over the window arrives and leaves one
way, declared once (`components.css`, Overlay motion): a menu, a context
menu, a select or combobox list, a popover, a tooltip, a hover card, a dialog,
Settings' sheet, and the scrim under a dialog or a sheet. It fades in over
150ms (`--oct-dur-base`, `--oct-ease-motion`) and out over 100ms
(`--oct-dur-fast`, `--oct-ease-color`): nobody waits for a thing to leave. A
popup settles from 98% at the point it is anchored to and a dialog from 98%
about its centre; the sheet rises 8px instead, since a surface that size reads
a scale as a zoom. Only opacity, scale and translate change, on the overlay
alone, so nothing behind it is laid out again, and no overlay rests on a scale
of its own. This is feedback, not a decorative entrance: before it a menu and
a popover settled in while a context menu, a select, a tooltip, a dialog and
the sheet appeared and vanished in one frame. A tooltip or hover card the
library closes at once, on a press of its trigger, does not fade over what the
press opened. Under reduced motion, from the system or from the setting, there
is no transition at all: an overlay is there or it is not. A recipe carries no
arrival or departure classes of its own. A dialog that a feature renders only
while it is open arrives the same way (`@starting-style`). A stylesheet cannot
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

A dialog that is leaving is only there to be seen. Its scrim and its controls
take no press and no key (`inert`), so the page under it answers at once and a
second press cannot repeat what the first did. Focus goes back to the opener
as the exit starts, not when it ends, and when the exit ends focus is left
where it is if the person, or a command they ran from the dialog, has moved it
in the meantime.

A press darkens a control's fill and moves nothing: no sink, no scale, on any
control. Words in the chrome do not select when the pointer drags across them,
controls keep the arrow cursor, a disabled control keeps it too, and the hand
is for a real link. Pictures and links do not lift off as drag ghosts. Reading
matter opts back in, so a message, a diff, a value, and an error can still be
copied. The keyboard focus edge shows only while a person is moving focus by
keyboard (`data-octant-input`): a dialog handing focus back to its trigger paints
no ring after a pointer press, and a focused field shows its caret and a brighter
border.

The right dock has one width whatever it shows, so a click inside it moves
nothing: the launcher and every tool use the width the person last dragged it to.
It never takes more than half the workspace, and its handle stops at the same
half. A Browser or Terminal tab that needs more holds 640px while that tab stays
open, including one restored after a restart, and does not save it. A width the
person drags to stands until the next Browser or Terminal opens.

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

Inline provider, extension, and Browser permission requests use
`OctantApprovalCard` in the thread column. It owns the neutral card material,
pending icon, readable summary and detail, wrapping action row, and inline
failure announcement. The requesting feature supplies the scope, choices, and
callbacks; the existing host or server still decides whether an action may
proceed. Native Code approvals keep their isolated host-owned document. The
extension tool request names the plugin, its server, and the tool, and adds
"Always allow in this Project" only when the host marks the call rememberable
and the window is a local one. Settings › Permissions lists those answers by
Project, each with Revoke, beside Remembered websites. Settings › Work and
Settings › Code show the global guardrail level with one-click change,
which governs Work and Code alike; a Work or Code Project overrides it from
its overview (Default mode), and each thread's header shows the level in force
and the scope it came from, in one quiet line ("Auto · set by this Project").
The levels, top to bottom, are Ask first,
Accept edits, Auto, and Full access; Full access is the lowest, and there is
no separate switch below it. The first time a machine or a Project picks Full
access, a one-time warning asks to confirm, in the warning role: "Agents can
change any file and run any command without asking, with no sandbox. Protected
files, such as SSH and cloud keys, are guarded by Octant's own tools and
redaction only, and a shell command can read them." It
offers Cancel (focused) and Use Full access, and is not shown again for that
scope. **Protected files** opens Settings › Permissions, above Remembered
websites: one row per built-in group (SSH private keys, cloud credentials,
and so on) whose description lists the paths it covers on this host and the
channel that replaces them, with a secondary **Remove** button; a removed group
reads "(not protected)" and offers **Protect again**. Remove opens
`OctantConfirmDialog` in the destructive role ("Stop protecting …?", Cancel
focused, **Remove protection**), because every agent can then read those
files; the host journals the confirmed removal. Paths the person added follow
as rows with Remove (no confirmation), then one "Protect another path" row with
a text field and an **Add** button; a refused path is said in the section's
feedback line. A paired device sees the section as set on the host machine.
**Worktrees** in Settings › Code, above Open in applications, lists the managed
worktrees archived threads still keep, largest first: the thread's title, then
a line of Project, branch in mono, and size ("more than" when the count stopped
early), then the folder in mono. Each row's secondary **Remove** opens
`OctantConfirmDialog` in the destructive role ("Remove this worktree?", Cancel
focused, **Remove worktree**), saying the folder and its ignored files go and
the branch and its commits stay. A refusal (uncommitted changes, or a turn
still running in the thread) is said in the
section's feedback line and the row stays. With none kept it says so in one
line; a paired device sees the section as managed on the host machine
([rules](docs/architecture.md#modes-chat-work-and-code)).
A Code, Chat, or Work tool row whose result was outside content carries an
"Outside content" tag, followed by what Octant Shield's Watcher found in it in
the warning role, and a Code thread's board card a small mark; at Full access
the tag stays quiet. A call Octant refused because it named a protected secret
file carries the same tag, naming that finding.
Neither prompts. The section also shows, each
as an account default a Project
may override: **Auto reviewer** (Provider's own / Octant Shield), **Safe
networks** (trusted hosts, domains, address ranges, and private-network tags),
and **Servers** (registered SSH hosts, each with a Read-only, Operate, or Admin
profile and an optional notes file), and, with the memory distiller's model, the account choices under **Automatic
model calls** (each thread's provider with its smallest model, or one configured
account and model). The rules behind them are in
[Octant Shield](docs/architecture.md#octant-shield). Built for Code: Auto
reviewer in Settings › Code › Access, **Automatic model calls** in Settings ›
Providers & Models (a section with one select per job, a plain note of where the
work goes, and the account's problem when it has one; the second opinion on
decisions starts at **Off** and is the only job with no default account), and the reviewer
override as a select on a Code Project's overview; **Servers** is built below
Safe networks in Settings › Permissions as an account list and a **Project**
picker that says whether the chosen Project uses the account's servers or
its own list, which starts as a copy of the account list and is edited with
the same rows and form. **Safe networks** is built on Settings › Permissions, after
Protected files: a **Network limits** panel with a
switch that is on by default, a sentence saying plainly whether limits are on
(and, when on, that they hold sandboxed runtimes only),
and a note that a change applies to the next runtime started; then an intro
sentence, the **Every
Project** list, a **Project** picker that says whether the chosen Project
follows the every-Project list or has its own (with **Use its own list** and
**Follow every-Project list**), and **Recently refused**. A place row shows its
kind in the meta role, its value in the code font, an optional port, and a
quiet Remove; the add row is Kind, value, optional Port, and Add place, and
Save sends the whole list. A refusal from the host shows inline in the alert
role and marks the refused row; nothing decides validity in the renderer
beyond a port's range. Each refused host row shows `host:port`, the runtime,
its count and age, and a quiet **Trust**, which adds that host and port to
the list being edited. While limits are off, or when the host cannot route
runtimes through these rules, a plain note says the lists are saved but not applied
([Provider runtime network](docs/architecture.md#provider-runtime-network)).
**Servers** opens with a sentence saying agents reach these servers with the
person's SSH agent or a key Octant makes and keeps for one server, and Octant
never reads key files, a quiet note when no SSH agent is running, one line per
profile (Read-only, Operate, Admin) and one saying lock-out and destructive
actions always ask. A server row shows `user@alias` in the code font, its
profile, its runbook path, how many deploys it has, and "Key Octant keeps"
when it signs in with one, with quiet Change and Remove, and **Show key** for
such a server. Show key opens a line under the row: "Add this line to
`~/.ssh/authorized_keys` for <user> on <alias>.", the public key in the code
font, wrapping, and a quiet Copy that reads Copied once it has; a refusal
shows there in the alert role. The form is Alias, User, Profile, Sign in with
(Your SSH agent, the default, or A key Octant keeps), Deploy commands (one per
line, shown for Operate and Admin), and Runbook path. A refusal from the host shows inline in the alert role.
Below it, **Projects on your servers** lists each server Project as its
name and its kind and `alias:folder` (`Work · web-1:/srv/notes`) in the code
font with a quiet Remove, and a form of Project kind (Code, the default, or
Work), Project name, Server (`user@alias`), and Folder on the server whose button
reads **Bind folder** and **Checking the folder…** while the host checks it
over SSH; with no registered server the form is replaced by a line asking for
one ([Server Projects](docs/design/server-projects.md)).
A Work Project's **Developer tools** switch is presentation, not a
permission, so it lives on that Project's overview, not here
([Workspace](docs/design/workspace.md)). A Browser request from a
CLI in a Code thread's terminal names the origin and the thread and says a
program in the terminal asked, not the thread's agent
([Terminal Browser grant](docs/design/terminal-browser-grant.md#the-window)).

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

Settings connection removal uses the same confirmation while retaining its
host command and GitHub's explicit local-logout confirmation.

Remote device-key rotation uses the same confirmation. It remains limited to
the paired browser and requires its own explicit choice after opening the
dialog; cancellation leaves the key untouched.

The pull-request merge warning stays inline and nonmodal. Opening it focuses
Cancel; Tab can leave the warning to continue reviewing. Escape within the warning
or Cancel returns focus to Merge (or the review heading if Merge is unavailable).
An attempted merge keeps its existing freshness and reviewed-head checks, and
focus moves to its result when the attempt completes. It is not a trusted task
approval surface. Who may merge (a person, or a Code thread the person
allowed) and what the host checks are owned by
[architecture](docs/architecture.md#modes-chat-work-and-code).

A dialog with a visible heading uses that heading as its accessible name through
`labelledBy`; specialized palettes and dock dialogs without one retain the hidden
title. Do not add a second visible header. Shared dialog popups and backdrops
suppress entrance motion under the persisted reduced-motion setting as well as
the OS preference.

Sidebar operation progress and results stay visible until dismissed or replaced
by a later operation, rather than expiring while work is still running. The
compact notice has a keyboard-accessible Dismiss action. Export files remain in
downloads and hand-off documents remain in the dock; this single latest-result
surface is not a notification history or queue.

When a verified app update finishes downloading, its notice offers a direct
link to the Updates control; applying the update still requires an explicit
request from the person.

## Accessibility and reliability

- Every product-owned scroll surface inherits one scrollbar, declared once
  in `styles.css`: a thin thumb in a theme token and no painted track, in a
  pane, a menu, a popup and a sheet alike, with a forced-colors fallback.
  Where the system floats scrollbars over content the thumb floats; where it
  keeps a strip for them the strip is clear. The two standard properties are
  the rule; the `::-webkit-scrollbar` parts beside them speak only for an
  engine that does not know the properties. Feature CSS may reserve the strip
  (`scrollbar-gutter`) so a page does not shift when it starts to scroll, and
  hides a scrollbar only on the named strips of tabs and icons that scroll
  sideways; it never sets a scrollbar colour or another width.
- The code editor and the terminal draw their scrollbars as elements of their
  own, out of reach of that rule, and are set to the same picture through each
  library's own options and theme colours: a thumb 6px wide with round ends,
  standing 2px in from the edge, in the strong border role. The role travels
  through the editor and terminal projections, so both modes and a custom
  theme reach it.
  Nothing else is painted at the edge: no track, no shadow where the text has
  scrolled, no outline or cursor mark on the editor's ruler, and no strip
  beside a comparison for a map of its changes. The editor's ruler still marks
  errors and search matches under the thumb. Where the system floats
  scrollbars the thumb shows while the surface scrolls or the pointer is over
  it and hides at rest; where the system keeps a strip for them the editor's
  thumb stays for as long as its text overflows. Three things still differ
  from a pane, because neither library has an option for them. The thumb
  cannot widen under the pointer as a floating system thumb does, so it takes
  the strong divider role there and while it is dragged. The terminal's thumb
  hides at rest even where the system keeps scrollbars on screen. And the
  terminal keeps its engine's 14px lane clear of text, where a pane's text
  runs under a floating thumb: the one option that narrows that lane stops the
  terminal opening where a canvas is refused. A fourth is not built: under
  forced colours a pane's scrollbar falls back to the system's, and theirs
  keeps the theme's roles. The measurements are in
  `apps/web/src/code/scrollbarTreatment.ts`; the two rules that shape the
  thumb where no option exists are in `styles/code.css` and name the library
  classes they hold on.
- Normal text targets 4.5:1 contrast; large text 3:1; non-text UI marks 3:1.
- Status, diff, provider, and activity states always include text, shape,
  pattern, or an accessible label in addition to colour.
- Pointer targets are at least 24px on desktop and 44px on touch.
- Keyboard users can reach every primary action, open/dismiss every overlay,
  navigate menus/selects, and recover focus after closing a popover or dialog.
- A panel a turn's menu opens inline (a checkpoint's name, the question before
  files are restored) takes focus once the menu has closed, the safe answer
  first, and hands focus back to that turn's More actions control when it ends.
- A control that opens a panel moves focus into it, and a control that is
  replaced by what it did hands focus to the next logical control instead of
  letting it fall to the page: a Tools tile focuses the tool it opened, applying
  a working folder returns to its Working folder row (to the failure, when
  the re-read fails) and cancelling returns to Change working folder, and Check and add focuses the result's heading as every
  other Add endpoint step does.
- A menu opened from the keyboard starts on its current choice, not its first
  item; ArrowUp still opens on the last item. A group of radios is one set of
  choices: the arrow keys move to the neighbour and select it, wrap past either
  end, and Home and End jump to the ends. A resize separator takes Home for its
  minimum and End for its maximum as well as the arrows.
- Tab order follows reading order from the left: the navigation sidebar comes
  before the window chrome, so the first Tab stop on load is never the controls
  at the right edge. A live region that holds text and a button keeps a space
  between them, so assistive technology does not read the two as one word.
- Keyboard focus draws one indicator, declared once in `octant.css`: a 2px
  inset outline in `--oct-focus-edge`, the foreground at 62% so it holds about
  4.5:1 or better against the control's fill and the surface around it in
  both schemes, and it follows the control's own radius.
  It is `:focus-visible` only, so a pointer press paints nothing, and it is
  never the hover fill, so focus and pointer read as different states. A
  control filled with the accent inverts it to `--oct-focus-edge-on-accent`; an
  SVG mark or inline text link moves it just outside itself. A container that
  only holds the keyboard (menu, dialog, listbox, preview card) shows no edge;
  the item inside it does, and menu items keep their highlighted fill. A text
  field set inside a frame that is itself the field (the composer, an inline
  search) shows its caret inside that frame; the composer frame draws no focus
  edge. Feature CSS never suppresses,
  recolours, or adds a second ring, and the `--octant-focus-ring` theme role is
  never painted as the indicator.
- A surface that takes Tab and Escape for its own use is never a keyboard trap.
  The terminal sends every key to its shell, so it has one documented way out:
  `Mod+Escape` moves focus to the next control and `Mod+Shift+Escape` to the
  previous one (Command on Apple hardware, Control elsewhere), sending nothing
  to the shell, and both are remappable under Settings › Keyboard shortcuts.
  Chosen because a shell reads a bare Escape and Control letters but nothing
  distinctive from a modified Escape, Command chords never reach a shell on
  Apple hardware, and no application-menu accelerator claims it; Windows and
  KDE take Control+Escape and Control+Shift+Escape for the OS, which is why the
  chord can be rebound. The terminal draws the chord in a muted line under its
  output only while it holds the keyboard (the row keeps its height, so
  focusing never moves the output) and always lists it in the terminal's
  accessible description. Tab, Shift+Tab, a bare Escape and function keys still
  reach the shell.
- Every app-owned form declares `noValidate`; Octant owns validation copy,
  field association, focus, and recovery instead of browser-specific bubbles.
- Loading, unavailable, stale, denied, empty, and error states keep stable
  geometry and explain the next action. Never turn a refused server command
  into a silent no-op.
- Increased contrast is one state with two triggers: the Appearance setting
  or the system's `prefers-contrast: more`. `ThemeSettingsProvider` publishes
  either as `data-octant-increased-contrast="true"` on the root, and every
  high-contrast rule keys off that attribute rather than the media query, so
  both triggers draw the same rules: the text roles take their
  `--octant-text-*-high-contrast` values and hairlines step up to
  `--octant-border-strong`. Script that adapts to contrast reads
  `useIncreasedContrast()`, not the media query.
- Theme, typography, density, translucency, contrast, and reduced-motion
  settings are persisted through the server-authoritative journal and applied
  through the providers. Renderer state is presentation only.
- The macOS status menu always offers **Fully quit Octant**. Ordinary Quit and
  Fully quit share one guarded shutdown: refresh current host activity, ask for
  confirmation when provider sessions remain open or the desktop cannot confirm
  what the host is running, then stop only the
  desktop-owned host and its child resources. Cancellation leaves both app and
  host running. The session count can include idle sessions kept for another turn;
  the warning names open sessions without claiming they are executing turns.
  When this host is in a hub and another member can take one of its threads,
  the confirmation adds **Move threads first…**, which opens Prepare to shut
  down (above) instead of quitting; Cancel stays the default.
  Once the person confirms, quitting never waits on a person: a
  failed or stalled window-state save or host stop is logged rather than shown
  in an alert, and a fixed deadline ends the app (after force-stopping the
  managed server) if shutdown has not finished.
- The **⌘Q keyboard shortcut** needs a second press within 1.5 seconds. The
  first press quits nothing and shows a short "Press ⌘Q again to quit Octant"
  toast in the focused window; the second enters the guarded shutdown above
  unchanged, including its session confirmation. With no window open, the first
  press quits directly. Choosing Quit with the pointer (app menu, Dock, status
  menu's Fully quit), OS shutdown or logout, updater restarts and signals stay
  immediate. A menu accelerator cannot tell a held key from a tap, so a
  double press stands in for hold-to-quit.

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
  [Spacing, shapes, and depth](#spacing-shapes-and-depth); it is a different
  material, not a second palette. Do not copy mobile atmosphere or phone radii
  into a flat desktop pane, and do not bring a blur onto a pane that has no
  ground under it.

## Surface behavior

### Settings stability

Background refresh preserves already loaded controls and active drafts. Use the
initial loading view only before a surface has data. Provider and theme feedback
occupy bounded, scrollable status slots; a changed status must not push the form
below it. A provider row's status line keeps its place under the name and shows Checking during probes.
Last observed model facts are presentation only and never authorize selection
or execution. Saved Chat/Code revisions reconcile untouched fields without
remounting the form. Keep deliberate section expansion, text growth, and manual
resizing distinct from unsolicited layout movement.

### Secret stores

Settings › Secret stores sits with Permissions under Safety and is
host-scoped. It has two cards. **Linked secret stores** is a plain row per
tool: the tool's name, one line saying whether it is linked and whether the
store is ready, locked, not installed, or unreachable, and one button, Link or
Unlink. Unlink waits for a confirmation that says which providers stop getting
their key and that nothing in the store is changed. A refusal (a locked store,
a missing tool) appears in the card's feedback slot, in the host's own words.
**Check an item** takes an item reference and answers Found, locked, missing, or
unreachable; it never shows what an item holds. On a host with no credential
broker the card says so and offers no button.

A provider's key from a store lives on the provider's own card, under **Key from
a secret store**, beside the API keys. It appears only when a store is linked or
the provider already points at an item, so a card never carries a section most
people do not use. It shows the item reference in code type with Check, Change
item, and Remove, or one reference field with Use this item. No control on
either surface has a field for a key, and nothing on them shows one.

### Optional Settings details

Keep common preferences and host health visible. Use the shared
`SettingsDisclosure` for optional inventories or specialist controls; it keeps
its contents mounted so closing it does not discard an unfinished field.
A deep-linked setting reveals its enclosing details before receiving focus.
Appearance keeps interface typography visible, with editor and terminal fonts
in named disclosures. Host data inventory lives under Stored data. Installed
skills and collision diagnostics scroll within a bounded collection while
search, counts, and Show all remain outside that scroller.

The legacy `--oct-fg-2` alias maps directly to `--octant-text-secondary`; primary,
secondary, and metadata remain the only text strengths. The theme schema keeps
its focus compatibility role for imports, but Appearance does not expose a
Focus ring color control because the focus indicator is the neutral edge,
never the theme's focus role.

### Save diagnostics

Host › Maintenance holds Save diagnostics beside the failure report. The row's
button, **Save diagnostics…**, saves nothing: it opens a plain list in place,
headed "This file will include", with one row per section (name, how many
entries it holds now or "Not available", and one sentence on what it holds),
then "It never includes" and its plain lines. Only **Save file** asks the host
to build the bundle; **Cancel** closes the list. In the desktop app Save file
opens the native save dialog, offering `octant-diagnostics-<date>.zip` in
Downloads; dismissing it returns to the list with nothing written. A browser or
paired client downloads the zip instead. The saved line names the file and says
nothing was sent. A host that cannot list or
build the bundle shows one error sentence and keeps the button. The list is
text and tabular counts on the page ground, with a hairline between rows and no
cards. The rule for what the file holds is in
[Architecture: persistence](docs/architecture.md#persistence).

### Shell edge cases

- The native window is transparent; the shell root paints the one window
  surface, so no column may leave its own opaque backing. Without Cover the
  sidebar, the application ground starts at the workspace's leading edge, and
  covers the whole window when the sidebar is collapsed.
- Dock tab fitting subtracts window-control padding and measures actual tab
  widths. Overflow and Add tool controls must never sit under window controls.
- A selected Project pull request may keep Review open beside its list. Other
  global destinations hide unrelated dock content and are mutually exclusive.
- PR readers own a compact, scrollable hierarchy. Descriptions and discussion
  use shared Markdown without executing HTML or fetching remote images. The
  original description remains available when unsupported HTML is omitted;
  diffs use the shared code block.
- Surface actions wrap before titles are squeezed into narrow columns. Settings
  navigation remains a vertical, full-width list inside its narrow drawer.

### What's new card and announcement

After an update the person chose finishes applying, the full sidebar shows one
small raised card above the profile row. A 64px band carries the Octant
aperture on a soft wash of the theme's ink with a hint of the accent, so the
card is depth and not an accent banner. Under it sit a "New · v{version}" line,
the notes' first line as a one-line strong headline, the next paragraph as a
muted two-line summary, and a quiet "Find out what's new" button with a
trailing arrow that opens the notes dialog. A "Dismiss" icon button sits top
right. Either one acknowledges
the update, so the card shows once. The collapsed icon rail never draws the
card and does not acknowledge it; it waits for the sidebar to open. A browser
or remote client has no card.

A release may bundle one announcement beside its notes. It replaces the card as
a modal dialog laid out as a poster: a 200px picture running to the dialog's
edges at its top (the aperture band with the mark at 56px when there is none),
then a title, a body and the two answers, all centred. "Not now" is the quiet
filled button and the primary button opens the notes, labelled "See what's
new" unless the release names its own; the dialog opens with focus on the
primary button. (With the picture inset and the text ranged left it read as a
settings dialog that happened to hold an image.) Any answer acknowledges the
update and the card is not shown afterwards. The announcement is a bounded file
and an optional bundled picture; an invalid one is simply absent. The rule is in
[Decisions and requirements](docs/design/decisions.md#whats-new-after-an-update).

### Mode-specific utility chrome

Chat admits only the Agents dock when helpers exist, it was explicitly requested,
or its tab is retained; see the [workspace rule](docs/design/workspace.md#subagents).
Chat has no bottom panel. With the dock closed, the conversation uses the available
workspace width. A Chat
Canvas opens as a content tab beside the thread (**Open Canvas**). Work shares
Code's quiet transcript edge: Browser is a dock tool and completion lives in the
composer's compact Task actions menu, preserving its confirmation flow.

### Readability and scroll containment

Activity group labels align with their thread titles at the same content inset.
Titles use primary text; project attribution uses secondary text and a separate
line with comfortable leading. Native document scrolling is clipped: Settings
occupies a fixed viewport while content and navigation scroll independently.
A terminal turn cannot present an unresolved tool call as still running; it
shows Unfinished unless the tool has its own recorded outcome. Usage resolves
known provider and task names locally, with original identifiers in tooltips.

### Draft continuity and composer notices

A new-task composer keeps its identity while its Project binding changes.
Message text and local input state reset only for an explicit New task action.
A refused binding keeps the prior authorized Project and draft. Cross-Project
notices appear once beside the active draft composer, with a separate-window
action when available, and reveal upward behind the message surface.
Authority confirmations appear beside the owning composer in a trusted surface
owned by the desktop main process;
ordinary notice content cannot issue an approval receipt.

## Usage surface ownership

The Usage destination opens local provider history by default when that host
supports it. Octant records remain a separate source; the two totals are never
added. A period change replaces the query, cancels the previous read, and cannot
render a late result under the new period. A refresh keeps the previous reading
visible. Resumable imports continue in bounded batches; read errors and hard
limits remain visibly partial.

History leads with the total and provider list beside a daily chart, followed
by processed, cached, uncached, output, and estimated cache-savings totals.
Cost and Tokens share the same geometry. Model and Day breakdowns are compact
read-only tables. Individual chart readings also have a disclosed table.
Unknown prices and missing quota measurements are unavailable, never zero.
API estimates, provider-recorded costs, pricing revisions, and measured-record
coverage remain distinguishable.

Diagnostics is the third source in the same toggle group, offered when the host
answers turn diagnostics. It reads how turns went across every provider and mode
([architecture: reading how turns went](docs/architecture.md#context-and-usage-accounting))
and has its own Range (24 hours to all recorded turns), Mode, Provider, and
Trend-by controls. It opens as a dashboard drawn with the Canvas visuals, so
every chart has hover readings and a disclosed table: headline tiles (turns, finished share, failed and stopped turns, turns cut at
the output limit, tool failure rate, typical and slow first token, typical
speed, typical and slow turn length, retries, provider-reported cost, likely
cache misses), each
with a sparkline and, for a bounded range, its change against the same span
before, toned by which way is good; How turns ended (finished, stopped, and
failed stacked by day or hour, failures in the alarm hue, beside the share that
failed or stopped); Speed over time (typical first token and speed); Model
comparison (ranked bars of typical and p95 first token and speed, full model
names); and What fails most (failed turns by cause, failing tools). A tile's
change is shown only beside the reading whose span it was measured against.
Details follow: Benchmarks by model with p50 and p95 first-token, speed, and turn
length; Turns by day or hour as a disclosed table of every bucket's turns,
failures, stops, tool failures, retries, first token, and speed; Failures by
cause with the newest redacted message; Tools, most failures
first; Retries, limits, and waits; Turns to investigate, whose Open button
leaves Usage for that thread; Likely prompt-cache misses, worded as a
likelihood; and Host health, one small chart per measure on its own scale
(memory in use, event-loop stalls, longest stall, slow database statements,
request p95, database size), each with its peak and when, a restart note, and a
disclosed table. A figure no turn measured is left out or reads Unavailable,
never zero. The header copies the whole report as JSON for offline analysis and benchmarking.

Benchmarks is the fourth source in the same toggle group, offered where the host
answers the benchmark routes, in Settings' Usage page as well. It compares
models on the same prompts
([model benchmarks](docs/design/model-benchmarks.md)). Suites lists each suite
with its case count and last run, and offers New suite, Import suite (a file or
pasted JSON, read through the contract, a failure worded as one sentence), and
per-row Edit, Export as JSON, and Delete. The editor holds the name and
description; cases of kind prompt or Code (a Code case adds the Code Project and
branch or tag), each with a title, prompt, reference answer, rubric line, and a
checks list for every check kind; and an optional judge model with its rubric.
A refusal names the case and check. Only a window on this Mac writes, and when
the host refuses a write the page says so in a sentence. The run builder
picks contenders from the enabled provider accounts and their models, the same
list the composer offers, then repetitions (1 to 5), a token or cost budget, and,
only for a suite with Code cases, the execution level. It shows an estimated cost
before Start (cells times each model's mean cost per turn from earlier turns),
and reads No estimate yet when none has history. The live grid is cases by
contenders with each cell's state as an icon and a word (queued, running,
answered, failed, blocked, cancelled, skipped), its time and tokens, a Cancel run
action, and an End reason line; it reads again every 3 seconds while the run
runs and stops when it ends or the page closes. The leaderboard has one row per
contender (check pass rate, judge score, stars, typical and slow first token and
speed, tokens, cost, tool failures, failures), every column sorts with a missing
figure always last, a row opens that contender's cells, and a headline names the
best pass rate, the fastest first token, and the cheapest. Pass rate, speed, and
cost also draw as Canvas ranked bars with their tables. A score no one gave
reads as a dash, never zero. Case compare puts each contender's answer for one
case side by side, read from the cell's own thread and never from a copy in the
run, with its figures, check results, judge score and reason, and Open thread.
The runs list shows the suite's runs newest first with their status, and Purge
asks first, saying it erases the run's threads. Tables scroll inside their own
container at a phone width.

The following canonical map applies to the Usage flow and its Settings entry:

| Capability      | Canonical owner                                                             | Source of truth                                 | Allowed variants                                                                | Verification                                 |
| --------------- | --------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------- |
| Table Selection | UsageWorkspace, ProviderUsageHistoryWorkspace, and TurnDiagnosticsWorkspace | Usage contracts and this document               | Read-only model/day/detail tables; no bulk selection                            | Usage component tests and narrow rendered QA |
| Select/Listbox  | OctantSelectField and OctantToggleGroup                                     | Shared UI adapters                              | Select fields for filters; toggle groups for source, metric, and period         | Shared-control and Usage interaction tests   |
| Date            | ProviderUsageHistoryWorkspace period controls                               | LocalUsageHistoryRequest                        | Past 24h, 7, 30, and 90 days; explicit viewing timezone                         | Range and stale-response tests               |
| Form            | UsageDashboard filters and shared field adapters                            | UsageQueryFilter                                | App-owned validation; retained filter values                                    | UsageDashboard tests                         |
| Scrollbar       | Usage workspace viewport and table scroll regions                           | usageWorkspace.css and providerUsageHistory.css | One page scroller; horizontal table overflow and disclosed chart-data scrolling | Narrow viewport and keyboard QA              |
| Toast           | Inline usage status and error regions                                       | Query and provider-limit state                  | Retained stale readings and inline recovery; no critical toast-only feedback    | Failure, refresh, and client-switch tests    |
| CRUD            | UsageDashboard in Settings                                                  | Usage client and retention/export contracts     | Main Usage is read-only; retention and export stay in Settings                  | Existing usage action tests                  |

## Git history in Review

History uses the existing interface face and monospace identifiers, semantic
text/status tokens, and shared `OctantInput`, `OctantSelectField`,
`OctantToggleGroup`, and `OctantButton` controls. A semantic commit table owns
its vertical scroller and virtualizes fixed-height rows. Author, date, and SHA
columns progressively give space to the commit message in narrow docks.

A row opens an immutable commit comparison inside Review. Back restores the
history list and keyboard focus; search, branch choice, and loaded pages stay
within that thread/checkout presentation, not the URL or journal. Search results
show individual nodes rather than inventing graph edges across omitted commits.
Loading, unavailable, no-result, shallow, and truncated states remain explicit.
Historical file inspection is read-only. Existing unified diffs and Monaco own
diff presentation; file disclosures mount only their open preview. Unified and
Side by side are a compact Settings row on Code, used only until this window
stores a layout for that thread.

### Compact task controls

The right Tools launcher starts directly beneath the window control rail, without
an extra top spacer. While a turn runs, its composer keeps a **Queue message**
action and shows a
**Stop turn** control beside it; that control stays disabled until the host has
admitted the turn. Accepted messages appear in the queue count. The idle action
sends normally when there are no pending messages or queue holds.

Accepted messages appear in a compact, initially collapsed queue above the
composer in Chat, Work and Code. Its header shows the message count and status;
expanding it reveals pending text, edit, move and remove controls, plus pause
and resume. A held reason remains visible when collapsed. Controls operate on the
host's current version; conflicting edits refresh the list and preserve the
person's unsent text. A failed enqueue leaves the draft and attachments in the
composer. Reopening a thread reads the accepted queue from the host without
resending it. Queue controls remain keyboard accessible and wrap at narrow
widths. A running-turn steering control is separate and appears only where the
runtime supports it.

A one-use credential request appears inline at the end of the Code conversation.
It uses a compact rounded card with a small lock mark, the credential label,
visible destination and one-use scope, followed by one short explanation and a
masked input. A keyboard-accessible reveal control returns to masked on submit.
The footer has a quiet privacy disclosure and right-aligned Decline and primary
action controls, using the shared native-density recipes. At narrow pane widths
the actions wrap beneath the disclosure, even in a wide application window.
Submitting once authorizes only the displayed operation; no second confirmation
repeats it. There is no remember checkbox. Enter in the credential field submits
this bounded integration request, except during text composition. The input
clears on submission, decline or cancellation. Accepted submissions stay disabled
until the host publishes an outcome; busy labels do not resize the action.
An uncertain response never resends automatically. Host-settled requests collapse
to a quiet status row; an unavailable status disables entry rather than trusting
a stale card.
The card is not an administrator-password dialog and is not a saved sign-in.

Native Code approvals use a compact 216px surface above the composer, with a
scrollable action and scope description, collapsible authority details, and a
fixed Cancel/Allow row. Duration remains in the host description; the button
does not imply a one-shot grant when the action grants access for the session.
Enter never implicitly grants access.
The isolated host document draws the same compact notice anatomy (semantic
marker, heading, readable detail, quiet border, and dismissive safe action)
using the owning window's resolved palette. It retains its own host-owned
markup and IPC; shared renderer components never grant Code authority. Long
paths and scope details wrap within the scrollable region rather than being
silently clipped.

The Pull requests page is a dense list in a 720px reading measure at the
page's leading edge: a title band with the count and Sort, Filter, Repository
settings and Refresh icon buttons; rows of a medium-weight title (two lines at
most) and one 12px meta line (state glyph, repository, author, age, and the
number in tabular numerals at the trailing edge); one quiet chip or a success
check at the trailing edge of the title line instead of three chips; no hairline
between rows and the control hover fill with the row radius under the pointer.
Grouping by repository gives each group a slim header with a "..." menu holding
Auto-refresh, Agents may merge and Refresh. A Project that is not on GitHub is
one notice at the foot, never an empty block. Where agents may merge is on, the
group shows a quiet chip and the Repository settings button a dot. The Issues
place uses the same row, group head and Sort menu. The dock packs its search,
freshness and rows at the top of its scroll area in the same row anatomy, one
flat list with no menus.

Main-pane content opens in a closable tab beside its conversation. Files, previews,
and canvases retain navigation references, and selecting one uses the ordinary
host-authorized open command. Image creation is a pane-owned view that retains
its draft while the user switches back to the conversation. The strip occupies
the existing pane title row rather than adding a second header.
