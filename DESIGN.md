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
- Navigation is a compact Project and thread tree. Low-frequency actions live
  in the bottom-left identity menu or an accessible overflow menu.
- The right dock and bottom panel are contextual working regions for the active
  pane. An open region with no selected tool shows a compact launcher; it never
  fabricates a tab or repeats another pane's content.
- Hierarchy comes from typography, spacing, hairline borders, and selection
  fills. Colour is scarce and semantic.
- Controls are familiar, compact, keyboard reachable, and honest about
  loading, stale, unavailable, permission, and error states.

Avoid dashboard walls, decorative gradients, neon developer styling, permanent
low-frequency controls, oversized setup cards, pill-shaped everything, and
invented data. A feature that is not available must explain why and offer the
next useful action, or stay out of the primary layout.

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
`System`/`Dark` defaults in `packages/theme/src/tokens.ts` and the matching
renderer fallback. The `Light` defaults are the paired values shown below.

### Semantic roles

| Role                   | CSS variable                                        | Dark      | Light     | Use                                        |
| ---------------------- | --------------------------------------------------- | --------- | --------- | ------------------------------------------ |
| Application background | `--octant-app-background`                           | `#171717` | `#f7f7f7` | Host ground behind shell surfaces          |
| Chrome                 | `--octant-chrome`                                   | `#181818` | `#fafafa` | Title bars and shell chrome                |
| Sidebar                | `--octant-sidebar` / `--octant-sidebar-opaque`      | `#202020` | `#f0f0f0` | Navigation surface                         |
| Workspace              | `--octant-workspace`                                | `#171717` | `#ffffff` | Main reading surface                       |
| Floating               | `--octant-floating` / `--octant-surface-raised`     | `#242424` | `#f3f3f3` | Cards, menus, popovers, dialogs            |
| Control                | `--octant-control` / `--octant-surface-muted`       | `#292929` | `#efefef` | Quiet control fill                         |
| Control hover          | `--octant-control-hover` / `--octant-surface-hover` | `#303030` | `#e7e7e7` | Hover and highlighted rows                 |
| Control pressed        | `--octant-control-pressed`                          | `#383838` | `#dedede` | Pressed state                              |
| Border                 | `--octant-border`                                   | `#2d2d2d` | `#dedede` | Hairline separation                        |
| Strong border          | `--octant-border-strong`                            | `#454545` | `#c5c5c5` | Focus-adjacent and draggable boundaries    |
| Strong divider         | `--octant-divider-strong`                           | `#6b6b6b` | `#8a8a8a` | Rare structural divider                    |
| Primary text           | `--octant-text-primary`                             | `#f2f2f2` | `#202020` | Body and control text                      |
| Secondary text         | `--octant-text-secondary`                           | `#b5b5b5` | `#5f5f5f` | Supporting copy                            |
| Muted text             | `--octant-text-muted`                               | `#8a8a8a` | `#707070` | Metadata and hints; not for essential text |
| Primary foreground     | `--octant-primary-foreground`                       | `#171717` | `#ffffff` | Text on primary fill                       |
| Focus ring             | `--octant-focus-ring`                               | `#f2f2f2` | `#202020` | Keyboard focus                             |
| Selection              | `--octant-selection` / `--octant-surface-selected`  | `#303030` | `#e7e7e7` | Selected rows and active controls          |
| Accent fill            | `--octant-accent`                                   | `#f2f2f2` | `#202020` | One primary action or active mark          |
| Accent foreground      | `--octant-accent-foreground`                        | `#171717` | `#ffffff` | Text on accent fill                        |
| Accent text            | `--octant-accent-text`                              | `#f2f2f2` | `#202020` | Accent used as text; normal-text contrast  |

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

| Job        | Default                                                                    | Usage                                                                              |
| ---------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Interface  | `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif` | App-wide shell, navigation, controls, settings, headings, transcript, and composer |
| Display    | inherits Interface                                                         | Wordmark, section headings, selected navigation labels                             |
| Transcript | inherits Interface                                                         | Long-running conversation and composer; readable at 13–16px                        |
| Editor     | `'JetBrains Mono', 'SF Mono', Menlo, monospace`                            | Code, diffs, paths, identifiers, aligned technical values                          |
| Terminal   | JetBrains/SF Mono, Nerd Font fallbacks, monospace                          | Terminal output and prompt glyphs                                                  |

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

- `--oct-text-xs: 11px`, `--oct-text-sm: 14px`, `--oct-text-base: 16px`.
- `--oct-text-lg: 19px`, `--oct-text-xl: 22px`, `--oct-text-2xl: 26px`,
  `--oct-text-3xl: 36px`, `--oct-text-4xl: 72px`.
- Body leading `1.5`, snug `1.3`, heading `1.14`, tight `1.1`, code `1.7`.
- Strong labels use 600; display labels use 500. Avoid bolding whole paragraphs.
- Mono metadata uses positive tracking (`--oct-tracking-wide`); display
  headings use restrained negative tracking.

Transcript settings are explicit and centered: Small is 13px, Medium 14px,
Large 16px; Narrow is 680px, Medium 800px, Wide 1040px. The default thread
measure is 760px and the column uses `width: min(100% - 40px, measure)` with
automatic horizontal margins. Canvas documents use a 62ch measure.

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
28px navigation row and a 30px terminal toolbar while retaining at least 24px
pointer targets. Icon sizes are 16/19/22px for small/medium/large actions; touch
surfaces keep 44px targets. The workspace sidebar defaults to 232px, supports
resizing, and may collapse completely while leaving Show sidebar and New thread
in the native title rail. Settings uses a separate compact 248px navigation
rail. The right dock defaults to 320px when open. A fresh window starts with it
closed; choosing a tool or restoring an explicit prior choice opens it. The
pane/title control rail is 34px in the native host and the status bar is 26px.

Navigation panes stay compact hairline rails. Grouped forms, setup objects,
welcome composers, and cards use the raised card recipe (`OctantCard` /
`--octant-shadow-sm`). Chat, Work, and Code welcome composers share the `.composer` frame (20px,
`--octant-shadow-md`). In light the card is workspace white on the
`--octant-app-background` well, not the grey floating fill — that fill reads
as a sunken field. Code welcome names the Project in the heading. Checkout and branch sit
on a second raised card stacked behind the composer: slightly narrower,
slid under the prompt by one corner radius so the front card's bottom
corners hang over the checkout row. A wider back sheet reads as a tray.
Host, workspace, and the searchable ref list live on that back card,
not in the toolbar. Access is a titled menu on
the card, next to the model picker. GitHub and delivery stay a quiet strip
under the dock. The prompt itself is frameless:
`OctantTextarea` drops the shadcn field recipe when it wears `.composer-input`.
Composer-row selects drop the same field chrome. Feature CSS must not
repaint those controls a third time. Opaque shadcn
popovers, menus, dialogs, Environment, and forms use the floating surface and
overlay shadow. Frosted material is limited to native/optional sidebar
translucency and the floating activity picture-in-picture; reduced
transparency and unsupported `backdrop-filter` resolve to opaque surfaces.

Shadow tokens are `--octant-shadow-hairline`, `--octant-shadow-sm`,
`--octant-shadow-md`, `--octant-shadow-lg`, `--octant-shadow-overlay`, and
`--octant-shadow-pop`. Use the smallest level that establishes a genuine
layer; navigation panes stay unshadowed; grouped cards use `--octant-shadow-sm`;
composers use `--octant-shadow-md` so the card actually lifts in light.

## Shell and layout

The shell is a CSS grid: sidebar, central workspace, optional right dock, and a
full-width status bar. A horizontal bottom panel is an optional sibling below
the central workspace. The central pane remains the thread, board, Project
overview, or Project-level list. The title bar contains the pane title and
capability-gated toggles for Open in, Environment, bottom panel, and right
dock. Zen remains in the bottom-left identity menu.

The app has three server-enforced modes—Chat, Work, and Code. Mode switching is
available as a labeled selector, compact list, or icon presentation according
to the user's setting. Code and Work keep separate Project View sets. Project
rows and thread rows share one hierarchy: folders/Projects first, then indented
threads; provider marks are fixed-size inline and can be hidden without changing
row height or indentation. Project View and Project Overview are real features,
not decorative shortcuts.

Primary sidebar destinations are New thread, Thread board, and Pull requests
when valid for the active mode. The bottom-left identity menu owns Settings,
Navigator, Agents, Providers, Usage, Plugins, Automations, Artifacts, and Zen
entry points. Search is a compact in-place filter for the current mode's visible
threads, with a command-style overlay available for broader actions.

Settings is a grouped form page rather than a dashboard wall. A compact 248px
navigation rail and search remain fixed while one centered 760px reading column
scrolls. Navigation rows use the 10px control radius. Related rows sit in
raised cards (`--octant-shadow-sm`) with a title and short description;
section panels use the same card recipe. Labels and descriptions align left,
controls align right, and compound editors may expand below. Every control uses
the owned Octant/shadcn adapter, inherits the interface typography projection,
and saves immediately.
Scope metadata remains available to assistive technology but does not compete
with the setting label.

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
tool rows and a visible Add tool action. The bottom panel uses the same compact
tool-tab and Add tool model for Review, Terminal, Browser, Files, and Side chat
where supported. Selecting a tool removes that presentation from the other
region; Terminal immediately attaches or starts and preserves one server
session when moved.

Environment is a transient active-thread disclosure, at most 320px wide, with
the 20px overlay radius. Its
44px header, label/value repository rows, direct View changes action, and
collapsed 44px detail rows form one compact operating list on an opaque floating
surface. It summarizes Project, branch, clean/dirty state, working folder,
changes, local servers, pull-request
identity, sources, and compact active/completed subagent rows with lifecycle,
model, and retained final response when authoritative. It is not a permanent
stack of cards and does not duplicate the Agents dock. Missing checkout context
is neutral explanatory text rather than a warning callout. When the right dock
is open, the disclosure shifts over the central pane and never covers the dock.

The thread board is an operational reading surface with four fixed,
server-authoritative statuses: Ready, In Progress, Waiting, and Done. Columns
and compact cards use the raised card recipe; empty columns stay dashed.
Waiting does not become a warning wall. Labels and facts use the selected
interface typography. Thread listing, pull-request snapshot, and per-thread
runtime reads overlap where independent.

Usage totals and filters are raised cards. Provider create forms, extension
cards, and artifact cards use the same raised recipe. The command palette
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
layouts stack; below 560px compact spacing and single-column forms apply. The
mobile app has a separate design system under `apps/mobile/design-system`.

## Component ownership and composition

### shadcn/Base recipes

Use the Octant adapter names in feature code. The owned recipe list includes
Button, Card, Badge, Input, Textarea, Field/FieldGroup, Select, Combobox,
Switch, Slider, Checkbox, ToggleGroup, Tabs, DropdownMenu, ContextMenu, Dialog,
and Tooltip. Composition rules:

- Buttons use `OctantButton` or `OctantIconButton`; variants are default,
  destructive, outline, secondary, ghost, and link. Sizes are default, sm, lg,
  and icon. Icon-only buttons always have an accessible label and tooltip/title.
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

- Normal text targets 4.5:1 contrast; large text 3:1; non-text UI marks 3:1.
- Status, diff, provider, and activity states always include text, shape,
  pattern, or an accessible label in addition to colour.
- Pointer targets are at least 24px on desktop and 44px on touch.
- Keyboard users can reach every primary action, open/dismiss every overlay,
  navigate menus/selects, and recover focus after closing a popover or dialog.
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
