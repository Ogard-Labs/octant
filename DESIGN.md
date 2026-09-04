# Octant design system

This is the implementation-authoritative visual contract for the shared
renderer in `apps/web`. It describes the system that is in the repository now;
it is not a proposal or a visual mood board. When this document and a touched
surface disagree, update the surface or record the intentional exception in
the same change.

## Product character

Octant is a local-first desktop workspace for supervising Chat, Work, and Code
threads, providers, Projects, agents, changes, and delivery. Its visual north
star is a quiet graphite workbench:

- One active thread, board, Project overview, or Project-level list is the
  primary work surface.
- The main title band is a Project/mode breadcrumb plus window-local thread
  navigation. One unpinned conversation is the current preview; pinned
  conversations remain within reach. Selecting one reopens it through the
  authoritative shell command rather than keeping a hidden transcript alive.
- Navigation is a compact Project and thread tree. Low-frequency actions live
  in the bottom-left identity menu or an accessible overflow menu.
- The right dock and bottom panel are contextual working regions for the active
  pane. A capable region with no selected tool shows a compact launcher; a pane
  with no valid tool exposes no dock toggle. Neither region fabricates a tab or
  repeats another pane's content.
- Hierarchy comes from typography, spacing, hairline borders, and selection
  fills. Colour is scarce and semantic.
- Controls are familiar, compact, keyboard reachable, and honest about
  loading, stale, unavailable, permission, and error states.

Avoid dashboard walls, decorative gradients, neon developer styling, permanent
low-frequency controls, oversized setup cards, pill-shaped everything, and
invented data. A feature that is not available must explain why and offer the
next useful action, or stay out of the primary layout.

## Language

This section is the part of the system that travels: the app, the docs site,
and the marketing site use the same words, the same face, and the same
hierarchy. Everything after it is renderer implementation.

### Voice

- **Crafted, not vibed.** Hierarchy comes from size and colour, not from
  weight or capitals. One title per page. Section labels are sentence-case
  and quiet. Nothing is uppercase except a monospace identifier that already
  is. Nothing is bold except the page title.
- **Sentence case everywhere**: titles, labels, buttons, tabs, menu items.
  Product nouns keep their capital (Project, Chat, Work, Code, Environment).
- **One sentence of help.** A subtitle or row description is one sentence
  that says what the thing does. Longer explanations move to the docs.
- **Vocabulary.** `Project`, `thread`, `checkout`, `worktree`, `base branch`,
  `Environment`, `access` (Plan / Approval / Auto-accept edits / Full access),
  `delivery` (Investigation / Local implementation / Pull request / Merged).
  The word "target" does not appear in the interface.

### Face

Interface text is **Inter** (variable, optical sizes on) with the system face
as fallback: `'Inter Variable', -apple-system, BlinkMacSystemFont, 'Segoe UI',
system-ui, sans-serif`. Code, paths, branches, identifiers, and terminal text
are the monospace stack. The app ships the Latin subset with the renderer, so
the face is the same on macOS, Linux, and Windows and on the marketing site.
Antialiased, `text-rendering: optimizeLegibility`, no synthetic bold.

### Scale

Eight sizes at the default 13px setting. Everything scales together with the
Appearance interface size; nothing is authored at 11.5 or 12.5.

| Role          | Size | Weight | Colour          | Where                                                     |
| ------------- | ---- | ------ | --------------- | --------------------------------------------------------- |
| Hero          | 28   | 500    | primary         | Welcome question only (`oct-title--hero`)                 |
| Title         | 20   | 600    | primary         | One per page (`oct-title`)                                |
| Section label | 13   | 500    | primary         | Group heading over a hairline (`oct-section-label`)       |
| Row label     | 13   | 500    | primary         | Setting, list row, menu option (`oct-row-label`)          |
| Body          | 13   | 400    | primary         | Transcript, paragraphs, controls                          |
| Detail        | 12   | 400    | secondary       | Subtitle, row description, menu detail (`oct-row-detail`) |
| Meta          | 11   | 400    | muted           | Timestamps, counts, hints (`oct-meta`)                    |
| Identifier    | 12   | 400    | secondary, mono | Paths, branches, ids (`oct-meta--mono`)                   |

Titles and the hero use `--oct-tracking-tight` (-0.025em); section labels use
`--oct-tracking-snug`; body and detail use none. Line heights: 1.2 title,
1.35 label, 1.45 detail and body, 1.7 code.

### Colour

Neutral graphite, a monochrome accent, a monochrome keyboard focus ring, four statuses. Text is three greys (primary,
secondary, muted) and never a fourth. Hairlines separate; fills select. The
focus ring is painted once, by the global `:focus-visible` rule, as a
two-pixel halo of the foreground at reduced opacity on every theme: a
coloured ring read as a website's link outline, not an app control. A field
recipe does not add a second border or halo of its own. See
"Colour system" for the token table. On the marketing site the same three
greys and the same hairline carry the hierarchy on a white or graphite ground.

### Shapes and depth

Radius is 10px for controls, 16px for cards and menus, 20px for the composer
and dialogs. A surface is flat by default. Elevation means one of three
things and nothing else: a raised discrete object (`--octant-shadow-sm`), the
composer (`--octant-shadow-md`), or an overlay (`--octant-shadow-overlay`).
Groups, lists, empty states, and headers are never cards.

### Page shell

Every list, board, reader, and preference page is a `Surface`:

```
Surface (reading measure 880px, or wide for boards)
  SurfaceHeader   title · one-line subtitle · actions · Back to workspace
  surface-toolbar search takes the slack · filters · view switch
  SurfaceSection  section label over a hairline
    surface-row   label + detail on the left, control on the right
  SurfaceEmpty    a quiet line of text, not a card
```

Leaving a reader route is always the ghost "Back to workspace" control in the
header. Settings is the same shell with a 680px measure and its own
navigation rail. Rows in Settings are `SettingRow`; rows everywhere else are
`surface-row`. Both draw the same hairline.

### Welcome and composer

Chat, Work, and Code open on the same screen: the hero question and one
raised composer. The composer is prompt first, four lines tall before it
grows; its toolbar row holds how the thread runs (attach and image on the
left; model and access on the right, next to send); its lower band holds
where it runs (Project, base branch, checkout, Environment, repository).
The band is part of the card, ruled off by a hairline, and it wraps rather
than grows: a control that needs a list ("Create from…") floats over the
page. Nothing about delivery is asked up front; it is derived from the band
and shown on the thread once it exists.

## Source of truth and CSS layers

There is one runtime theme authority and one owned control layer:

| Layer                 | Responsibility                                                                                                    | Files                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Semantic theme        | Persisted theme settings, presets, contrast validation, typography, safe fallback, export/import                  | `packages/theme/src/`, `packages/contracts/src/theme.ts`                   |
| Renderer fallback     | Startup values before the theme bootstrap is applied                                                              | `apps/web/src/styles.css` (`--octant-*`)                                   |
| Static product system | Layout, shell geometry, type scale, spacing, motion, domain surface recipes, and `--oct-*` consumers              | `apps/web/src/styles/octant.css`                                           |
| Runtime bridge        | Maps theme-resolvable `--octant-*` roles to the static system's `--oct-*` roles                                   | `apps/web/src/styles/octant-bridge.css`                                    |
| shadcn projection     | Projects `--octant-*` roles into `--background`, `--primary`, `--border`, and the other shadcn/Tailwind variables | `apps/web/src/styles/shadcn-theme.css`, `apps/web/src/styles/tailwind.css` |
| Owned recipes         | Editable shadcn New York recipes and the product-facing adapter API                                               | `apps/web/src/ui/shadcn/`, `apps/web/src/ui/base/`                         |

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

The shadcn registry metadata is in `apps/web/components.json` (`new-york`,
Tailwind v4, CSS variables, Lucide). The checked-in recipes are owned source
and currently use `@base-ui/react` primitives behind the Octant adapters. This
keeps the interaction backend accessible and editable while preserving the
shadcn composition and visual vocabulary. Feature code imports `ui/base`, not
`ui/shadcn` or `@base-ui/react` directly. Project and split-workspace context
menus now use the shared `OctantContextMenu` adapter; do not add a new direct
primitive import.

## Colour system

The default runtime palette is neutral graphite. The following values are the
`System` defaults in `packages/theme/src/tokens.ts` and the matching renderer
fallback; `Dark` and `Light` are the same values pinned to one mode.

### Semantic roles

| Role                   | CSS variable                                        | Dark      | Light       | Use                                                    |
| ---------------------- | --------------------------------------------------- | --------- | ----------- | ------------------------------------------------------ |
| Application background | `--octant-app-background`                           | `#151515` | `#fafaf9`   | Page ground: welcome, lists, Settings                  |
| Chrome                 | `--octant-chrome`                                   | `#151515` | `#fafaf9`   | Title bars and shell chrome                            |
| Sidebar                | `--octant-sidebar` / `--octant-sidebar-opaque`      | `#101010` | `#fafaf9`   | Navigation surface, on the page ground                 |
| Workspace              | `--octant-workspace`                                | `#1a1a1a` | `#ffffff`   | Reading surface: transcript, editor                    |
| Floating               | `--octant-floating` / `--octant-surface-raised`     | `#232323` | `#fdfdfc`   | Menus, popovers, dialogs                               |
| Card                   | `--octant-card` (derived)                           | floating  | workspace   | Raised objects: composer, setup, profiles              |
| Tray                   | `--octant-tray` (derived)                           | workspace | control mix | The rear context card behind the composer              |
| Control                | `--octant-control` / `--octant-surface-muted`       | `#2b2b2b` | `#f0f0ef`   | Quiet control fill, secondary buttons                  |
| Control hover          | `--octant-control-hover` / `--octant-surface-hover` | `#333333` | `#e8e8e6`   | Hover and highlighted rows                             |
| Control pressed        | `--octant-control-pressed`                          | `#3b3b3b` | `#dfdfdd`   | Pressed state                                          |
| Border                 | `--octant-border`                                   | `#303030` | `#e0e0de`   | Hairline separation                                    |
| Strong border          | `--octant-border-strong`                            | `#4d4d4d` | `#bdbdbb`   | Input and outline-button edges                         |
| Strong divider         | `--octant-divider-strong`                           | `#808080` | `#6f6f6d`   | Rare structural divider                                |
| Primary text           | `--octant-text-primary`                             | `#f0f0f0` | `#1b1b1b`   | Body and control text                                  |
| Secondary text         | `--octant-text-secondary`                           | `#a9a9a9` | `#4f4f4f`   | Supporting copy                                        |
| Muted text             | `--octant-text-muted`                               | `#8a8a8a` | `#6b6b6b`   | Metadata and hints; not for essential text             |
| Primary foreground     | `--octant-primary-foreground`                       | `#171717` | `#ffffff`   | Text on primary fill                                   |
| Focus ring             | `--octant-focus-ring`                               | `#4d9ec8` | `#1f6f96`   | Theme token only; the shell paints focus in foreground |
| Selection              | `--octant-selection` / `--octant-surface-selected`  | `#2c2c2c` | `#ebebea`   | Selected rows and active controls                      |
| Accent fill            | `--octant-accent`                                   | `#f0f0f0` | `#1b1b1b`   | One primary action or active mark                      |
| Accent foreground      | `--octant-accent-foreground`                        | `#171717` | `#ffffff`   | Text on accent fill                                    |
| Accent text            | `--octant-accent-text`                              | `#f0f0f0` | `#1b1b1b`   | Accent used as text; normal-text contrast              |
| Scrim                  | `--octant-scrim`                                    | `#000000` | `#000000`   | Opaque by contract; the bridge mixes it to a wash      |

The ladder is deliberate: in dark the page is near-black, the sidebar a step
darker, the reading surface a step lighter, and cards lift one more step. In light the sidebar and the page share one near-white ground and the
reading surface is white; a hairline, not a grey fill, separates the sidebar
from the workspace. Every hairline registers on the surface it separates
(about 1.3:1 in both modes); inputs and outline buttons use the strong border
so an edge is never guessed. The renderer fallback in
`apps/web/src/styles.css` mirrors these values exactly.

Status roles are paired to the surface where they render. Use the text role
for labels and the surface role for a background; never rely on hue alone:

| Meaning       | Surface                                                      | Text/border                                                                                 |
| ------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Success       | `--octant-success-surface` (`#16281f` dark, `#bfd8cc` light) | `--octant-success-text` (`#6bb299` dark, `#0f6144` light)                                   |
| Warning       | `--octant-warning-surface` (`#342b0e` dark, `#f0dea8` light) | `--octant-warning-text` (`#edbc26` dark, `#6f5300` light); border `--octant-warning-border` |
| Danger        | No default surface                                           | `--octant-danger-text` (`#e17d96` dark, `#a8102f` light)                                    |
| Diff addition | No default surface                                           | `--octant-addition-text`                                                                    |
| Diff deletion | No default surface                                           | `--octant-deletion-text`                                                                    |

The eight palette roles (`red`, `orange`, `yellow`, `green`, `teal`, `blue`,
`purple`, `pink`) are for Project View identity, chart marks, and provider or
runtime status where a categorical distinction is needed. Pair every mark with
a label, icon, pattern, or border style. The static chart series and dash
patterns live in `octant.css`.

The original warm charcoal-and-brass `Octant` preset remains an optional
theme. It is not the default neutral system. Custom themes may override only
validated semantic roles; incomplete or low-contrast imports fall back safely.

## Typography

Typography has distinct jobs:

| Job        | Default                                                                                  | Usage                                                                              |
| ---------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Interface  | `'Inter Variable', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif` | App-wide shell, navigation, controls, settings, headings, transcript, and composer |
| Display    | inherits Interface                                                                       | Wordmark, section headings, selected navigation labels                             |
| Transcript | inherits Interface                                                                       | Long-running conversation and composer; readable at 13–16px                        |
| Editor     | `'JetBrains Mono', 'SF Mono', Menlo, monospace`                                          | Code, diffs, paths, identifiers, aligned technical values                          |
| Terminal   | JetBrains/SF Mono, Nerd Font fallbacks, monospace                                        | Terminal output and prompt glyphs                                                  |

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

- `--oct-text-xs: 11px`, `--oct-text-detail: 12px`, `--oct-text-sm: 13px`,
  `--oct-text-base: 14px`, each multiplied by `--oct-text-step` so the
  Appearance interface size moves the whole ladder.
- `--oct-text-lg: 17px`, `--oct-text-xl: 20px`, `--oct-text-2xl: 26px`,
  `--oct-text-3xl: 36px`, `--oct-text-4xl: 72px`.
- Body leading `1.5`, snug `1.3`, heading `1.14`, tight `1.1`, code `1.7`.
- Only the page title uses 600; every other label uses 500. Avoid bolding
  whole paragraphs. The type roles in `styles/surface.css` (`oct-title`,
  `oct-section-label`, `oct-row-label`, `oct-row-detail`, `oct-meta`) are the
  only heading and label recipes; feature CSS does not author a new size.
- Mono metadata uses positive tracking (`--oct-tracking-wide`); display
  headings use restrained negative tracking.

Transcript settings are explicit and centered: Small is 13px, Medium 14px,
Large 16px; Narrow is 680px, Medium 800px, Wide 1040px. The default thread
measure is 760px and the column uses `width: min(100% - 40px, measure)` with
automatic horizontal margins. Welcome composers share a 768px maximum so
Chat, Work, and Code start from the same prompt geometry independently of the
reading-width preference. Canvas documents use a 62ch measure.

## Spacing, shapes, and depth

Spacing is a 4px base scale: 4, 8, 12, 16, 20, 24, 32, and 48px. Use `gap-*`
for stacks and groups; do not reintroduce `space-x-*` or `space-y-*` utility
chains. The desktop radius scale is 10px compact control, 16px panel and card, 20px
composer and dialog, and 9999px only for compact chips, meters, or circular icon
controls. Product
chrome uses those tokens. Pixel radii of 1–4px remain only for chart bars,
marks, and status dots. Leftover `.btn*` recipes are gone; adapters own
button paint. Phone-only
surfaces use the larger 22/26/30px mobile radii.

Controls are 44px by default and 34px compact. Dense operating rails use a
28px navigation row; the title band, the right dock head, and the bottom panel
toolbar share one 34px rail so their tabs and hairlines sit on one level. Icon sizes are 16/19/22px for small/medium/large actions; touch
surfaces keep 44px targets. The workspace sidebar defaults to 232px, supports
resizing, and may collapse completely while leaving Show sidebar and New thread
in the native title rail. Settings uses a separate compact 248px navigation
rail. The right dock defaults to 320px when open. A fresh window starts with it
closed; choosing a tool or restoring an explicit prior choice opens it. The
pane/title control rail is 34px in the native host and the status bar is 26px.
While a route or tool is still loading, its state is one quiet line (spinner,
then the title) on the page ground, never a raised card: a card with a title
and a sentence reads as a finished empty state.

Navigation panes stay compact hairline rails. Routine form layouts stay open
and unshadowed; setup objects, discrete settings objects, welcome composers,
and cards use the raised card recipe (`OctantCard` / `--octant-shadow-sm`).
Chat, Work, and Code welcome composers share the `.composer` frame (20px,
`--octant-shadow-md`) and one first-read hierarchy: one question, then the
composer. Starter actions appear only when recent work does not already give
the person a next step. In light the card is workspace white on the
`--octant-app-background` well, not the grey floating fill — that fill reads
as a sunken field. Code welcome keeps one stable question while Project,
base branch, and Environment sit on the composer's lower band
(`.composer-tray`, rendered through the composer's `footer` slot), under the
prompt and its toolbar, on the tray fill with a hairline above. Environment is the
create-facing presentation of Octant's authoritative host federation: its
dropdown selects This computer, devbox, or another healthy capable host without
creating a second environment model. Workspace remains on that rear card after the three primary choices;
nothing about delivery is asked up front (see "Language"). The Project
control is one menu: saved Projects to search, then New Project from folder
and New Project from GitHub repository. Choosing GitHub swaps the menu's body
for the managed-clone flow in place, so there is no second repository control
beside the Project. Access is
a titled menu on the prompt card, next to the model picker, and carries the
"Remember for this Project" switch. The
Under the Code composer the start screen reads like GitHub Copilot's and
Cursor's agent homes: suggested prompts as small cards (a label and the
sentence they fill in), then three sections that share one card grid, two
across at the composer's width. Each card opens with a badge naming what it
is (Issue, Pull request, Review requested, Linear, or a thread's delivery
state: Running, PR #n, Merged, Done, Waiting), the repository or identifier
in mono, and the age at the trailing edge; then the title and one line of
facts. Up next holds what is in flight for the person (review requests,
their own open pull requests, assigned GitHub issues, assigned Linear
issues), each badge naming why it is there, and says "You're all caught up"
in a panel when empty, with Open Inbox at the section's trailing edge. Start
something new holds open GitHub and Linear issues nobody has picked up, with
Browse all issues beside it. Continue holds the latest Board cards: the badge
is the thread's own state (Running, Done, Waiting, In progress, Ready) with
changed lines, and the facts line names the Project, the branch (marked
worktree when managed), the linked pull request with its number and state as
a chip, and the provider last. Picking an item fills the prompt and attaches
the issue as the thread's Create from context. The start screen has no image control: image generation lives on
its own surface.
The prompt itself is frameless:
`OctantTextarea` drops the shadcn field recipe when it wears `.composer-input`.
Composer-row selects drop the same field chrome. Feature CSS must not
repaint those controls a third time. Opaque shadcn
popovers, menus, dialogs, Environment, and forms use the floating surface and
overlay shadow. Frosted material is limited to native/optional sidebar
translucency and the floating activity picture-in-picture; reduced
transparency and unsupported `backdrop-filter` resolve to opaque surfaces.

Shadow tokens are `--octant-shadow-hairline`, `--octant-shadow-xs`,
`--octant-shadow-sm`, `--octant-shadow-md`, `--octant-shadow-lg`,
`--octant-shadow-overlay`, and `--octant-shadow-pop`. Use the smallest level
that establishes a genuine layer: navigation panes and open form layouts stay
unshadowed; compact state and grouped cards use `--octant-shadow-sm`; composers
use the catalog-calibrated `--octant-shadow-md`; focused or promoted raised
objects may use `--octant-shadow-lg`; overlays use only their overlay or pop
token. A shadow must explain depth, not decorate a flat row.

## Shell and layout

The shell is a CSS grid: sidebar, central workspace, optional right dock, and a
full-width status bar. A horizontal bottom panel is an optional sibling below
the central workspace. The central pane remains the thread, board, Project
overview, or Project-level list. An unsplit conversation uses the title band
for the Project/mode breadcrumb and compact thread strip, so the transcript
does not repeat a second title block. Split panes and utility surfaces retain
their own pane headers and lifecycle controls. Capability-gated toggles for
Open in, Environment, bottom panel, and right dock remain window chrome. Zen
remains in the bottom-left identity menu.

The app has three server-enforced modes—Chat, Work, and Code. Mode switching is
available as a labeled selector, compact list, or icon presentation according
to the user's setting. Code and Work keep separate Project View sets. Project
rows and thread rows share one hierarchy: folders/Projects first, then indented
threads; provider marks are fixed-size inline and can be hidden without changing
row height or indentation. Project View and Project Overview are real features,
not decorative shortcuts.

Primary sidebar destinations are New thread, Board, and Pull requests
when valid for the active mode. The bottom-left identity menu owns Settings,
Navigator, Agents, Providers, Usage, Plugins, Automations, Artifacts, and Zen
entry points. Search is a compact in-place filter for the current mode's visible
threads, with a command-style overlay available for broader actions.

Settings is a grouped form page rather than a dashboard wall. A compact 248px
navigation rail and search remain fixed while one 680px reading column scrolls,
anchored to the navigation edge by a 32–56px workspace gutter instead of
floating in the middle of wide windows. Navigation groups use quiet separators
rather than competing labels. Routine related rows stay open on the application
ground with hairline separators. Keybindings have their own destination and raw
JSON stays behind an advanced disclosure. Profiles, provider instances, install
reviews, visual theme choices, and other discrete objects use raised cards
(`--octant-shadow-sm`). A destructive group is an open section at the end of
its page, marked by that placement and by its confirm control, not by heading
colour or a card. Labels and descriptions align left, controls align
right, and compound editors may expand below. A section label may carry the
ghost actions that act on the whole section on its own line; a primary never
lives in a section head. A row's "more" (a custom font stack, network
details, what an update check sends) sits behind one `.settings-disclosure`
recipe: a 12px summary with the app's chevron, never the browser's marker.
Loading and status lines are one quiet sentence; only an error keeps a box.
Essential labels and explanatory
text are at least 12px at the default interface scale. Every control uses the
owned Octant/shadcn adapter, inherits the interface typography projection, and
saves immediately.
Scope metadata remains available to assistive technology but does not compete
with the setting label.

Operational settings use progressive disclosure. Provider and skill lists lead
with compact readiness counts. Provider rows show identity, one effective
status, details, and enablement; ordering controls appear only in an explicit
Reorder mode. Skill rows show the source class and one effective state;
filesystem paths, qualified identifiers, hashes, requested/effective
breakdowns, and content size live behind Details. Usage opens on requests,
input, output, and measurement quality. Reasoning, cache, execution time, and
latency live in one Operational details disclosure; technical filters stay
collapsed and provider-capacity diagnostics follow the locally recorded
dashboard.

First run is a five-step wizard with a progress rail. Each step is pending,
current, or completed: the current step is a filled card, completed steps show
a check, and pending steps show their number. Mode choices on the readiness
step use `OctantToggleGroup`. Answers still write through to the settings that
own them.

The right dock follows the active pane and never leaks another pane's content.
On wide windows it may use at most 38 percent of the viewport, preserving a
560px primary workspace; the bottom panel may use at most 38 percent of the
viewport height while preserving 320px for the primary workspace. It can host
Review, Files, Browser, Terminal, Canvas, Plan (only for a real
plan artifact), Delivery (only for a configured target), Agents (when children
exist or explicitly invoked), Simulator, and Side chat. The dock launcher is
not a second thread switcher. With no open tab, it shows only capability-valid
tool rows; the head's Add tool action appears once a tab is open, since with
none open the body is already the list of tools to add. The bottom panel uses
the same compact tool-tab and Add tool model for Review, Terminal, Browser,
Files, and Side chat where supported. Selecting a tool removes that presentation from the other
region; Terminal immediately attaches or starts and preserves one server
session when moved.

Browser and Terminal are repeatable right-dock workspaces: Add tool creates a
new tab identity, an isolated Browser context or Terminal session, and a stable
numbered label when siblings are open. Files, Review, Agents, Canvas, Plan,
Delivery, Simulator, and Side chat are singleton destinations. One instance
still appears in only one region at a time.

A welcome, Project, or other pane with neither a bound thread nor a valid
launchable tool keeps the dock closed and omits its toggle. Restored presentation
for another subject never makes unavailable chrome visible.

Environment is a right-dock tool, opened from the dock's tab strip or Add tool
and nowhere else; the title band carries no second Environment button. Its
header names the thread's identity and facts (branch, clean or dirty, working
folder, running servers), and its body is a definition list of git facts,
row-styled actions, and collapsible groups on the dock's own ground. It summarizes Project, branch, clean/dirty state, working folder,
changes, local servers, pull-request
identity, sources, and compact active/completed subagent rows with lifecycle,
model, and retained final response when authoritative. It is not a permanent
stack of cards and does not duplicate the Agents dock. Missing checkout context
is neutral explanatory text rather than a warning callout.

The Board is an operational reading surface with four fixed,
server-authoritative statuses: Ready, In Progress, Waiting, and Done. All
four lanes show by default, each named once by mark, label, and count with no
rule under the head; a Board/List toggle leads the toolbar. A card is a flat
hairline-edged object on the card fill: the Project as an eyebrow, the title,
and one line of what the thread waits on or is doing, active runs and failing
checks, who runs it, and when it last moved. Checkout, branch, plan, and
review facts live on the list view and the thread. Waiting does not become a
warning wall. Labels and facts use the selected
interface typography. Thread listing, pull-request snapshot, and per-thread
runtime reads overlap where independent.

Usage totals and filters are raised cards. Provider create forms, individual
extension objects, and artifact cards use the same raised recipe; extension and
skill collection shells remain open. The command palette
groups results and shows a shortcut badge when a row maps to a user-bindable
chord. Shared dialogs keep the 20px overlay radius and overlay shadow.

The context meter is a circular composer control, not a dock tab. It opens an
opaque popover with attributed context segments, used/maximum/free values,
estimate/source labels, loaded/deferred capabilities, provider service limits,
quota state, and retry timing. Unknown or stale data is labeled as such and
never rendered as zero. Inspecting context opens the authoritative inspector.

The task visualizer is a compact composer-adjacent chip backed by the thread's
journaled plan. It appears only when a real plan exists, shows proposed review
or `Step n / total`, and opens a popover with title, step states, evidence, and
start/finish/reopen/drop actions when approved. It must not invent progress from
assistant prose or display an empty plan form.

Responsive breakpoints are 560px, 720px, and 920px. Below 920px the right dock
is removed rather than squeezing the transcript unreadably. Below 720px split
layouts stack, the workspace navigation sidebar becomes a dismissible overlay,
and Settings replaces its rail with a left drawer opened from the active page
header. Below 560px compact spacing and single-column forms apply. The mobile
app has a separate design system under `apps/mobile/design-system`.

True page tabs, segmented choices, and pane identity are intentionally
different. `OctantTabs` owns a flat rail with selected fill and keyboard tab
semantics. `OctantToggleGroup` owns the enclosed track used for mutually
exclusive values. The split-pane grip alone owns active-pane paint. Feature
styles may size or scroll these primitives but may not restore a local tab
track, underline recipe, or persistent active border.

## Component ownership and composition

### shadcn/Base recipes

Use the Octant adapter names in feature code. The owned recipe list includes
Button, Card, Badge, Input, Textarea, Field/FieldGroup, Select, Combobox,
Switch, Slider, Checkbox, ToggleGroup, Tabs, DropdownMenu, ContextMenu, Dialog,
and Tooltip. Composition rules:

- Buttons use `OctantButton` or `OctantIconButton`; variants are default,
  destructive, destructive-outline, outline, secondary, ghost, and link.
  Destructive-outline names a risky action on an ordinary page; the filled
  destructive variant is reserved for the final confirmation. Sizes are
  default, sm, lg, and icon. Icon-only buttons always have an accessible label
  and tooltip/title.
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
  when the title is visually hidden.
- Use Badge for status labels, Alert for callouts, Empty for empty states,
  Skeleton for loading, and the shared `.toast-stack` notification owner for
  transient acknowledgements. Do not add another toast package or recreate
  these with styled spans or animated divs.
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

Provider identity uses Octant-owned, bundled marks selected by `ProviderGlyph`.
Never fetch a remote logo, copy a product asset into Octant, use emoji, or draw
an approximate brand mark. Unknown providers use a compact truthful monogram.

## Motion and interaction

Functional feedback uses 120–160ms transitions; the base system duration is
200ms. Use standard easing and no decorative entrance animation. Running state
must have a textual or shape distinction in addition to motion. `prefers-reduced-
motion` and the persisted reduced-motion setting disable transitions and
animations without removing state information.

Native Electron title-bar regions are a hard boundary. Interactive controls
must carry `window-no-drag` and render above the native drag target. Test title-bar
buttons in the packaged/native surface, not only with React/jsdom. Focus rings
must be visible and must not move layout.

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

## Accessibility and reliability

- Every product-owned scroll surface inherits the global thin scrollbar
  baseline: a tokenized visible thumb, transparent track, hover state, and
  forced-colors fallback. Feature CSS may adjust gutter or density but does not
  hide the scrollbar or introduce a second theme.
- Normal text targets 4.5:1 contrast; large text 3:1; non-text UI marks 3:1.
- Status, diff, provider, and activity states always include text, shape,
  pattern, or an accessible label in addition to colour.
- Pointer targets are at least 24px on desktop and 44px on touch.
- Keyboard users can reach every primary action, open/dismiss every overlay,
  navigate menus/selects, and recover focus after closing a popover or dialog.
- Every app-owned form declares `noValidate`; Octant owns validation copy,
  field association, focus, and recovery instead of browser-specific bubbles.
- Loading, unavailable, stale, denied, empty, and error states keep stable
  geometry and explain the next action. Never turn a refused server command
  into a silent no-op.
- Theme, typography, density, translucency, contrast, and reduced-motion
  settings are persisted through the server-authoritative journal and applied
  through the providers. Renderer state is presentation only.
- The macOS status menu always offers **Fully quit Octant**. Ordinary Quit and
  Fully quit share one guarded shutdown: refresh current host activity, ask for
  confirmation when a turn is active or needs attention, then stop only the
  desktop-owned host and its child resources. Cancellation leaves both app and
  host running.

## Implementation checklist

When adding or touching UI:

1. Read this file and the owning decision record.
2. Reuse an existing adapter and semantic token before adding CSS.
3. Keep domain logic in its owning package; keep renderer components focused on
   presentation and user interaction.
4. Add a focused behavior test for meaningful interaction or accessibility.
5. Run the nearest web test/typecheck/build and `git diff --check`; broaden to
   the repository verification command for cross-package changes.
6. For shell, title-bar, dock, Environment, context, or settings work, perform
   rendered/native verification at the relevant viewport and capability state.
7. Record a deliberate exception here or in the owning ADR when a surface
   cannot yet use the shared recipe.

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
- Mobile visual tokens and glass surfaces are intentionally separate from the
  desktop renderer. Do not copy mobile atmosphere or phone radii into desktop
  panes.

## Evidence inspected

This document is maintained against the current shared renderer:
`packages/theme` token roles, `ThemeSettingsProvider` and
`ThemeTypographyProvider`, the `octant.css` static system and bridge,
shadcn/Tailwind projection, `apps/web/components.json`, all owned
`ui/shadcn` recipes and `ui/base` adapters, the production control-boundary
inventory, shell/settings/project/dock styles, the task visualizer, context
meter, usage surfaces, and decisions 0016, 0027, 0038, 0044, 0045, and 0046.
Values marked as defaults come directly from those files; layout guidance
follows the rendered contracts encoded by their selectors and tests.
