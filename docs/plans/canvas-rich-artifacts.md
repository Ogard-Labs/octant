# Rich Canvas artifacts in the thread

**Status:** Planning. This is not a current-design owner. Architecture,
Workspace, and DESIGN.md stay the owners until the maintainer accepts
[0165](../decisions/0165-a-canvas-in-the-thread-can-be-the-whole-answer.md).

A long agent answer should be able to appear in its thread as a finished,
navigable Canvas: tabs, metric cards, flowcharts, zone maps, and wide tables
with badges, browsed in place without a round-trip to the agent. This plan is
the order of work that gets there without reopening 0010's closed catalog or
0164's no-script design frame.

## Observed target

The prompt for this plan is a T3 Code clip
([tweet](https://x.com/dzhohola/status/2108728587142787375)): after a long
agent run, the thread showed a game design as an interactive mini-app.
Eight pill tabs switched content instantly on the client. The pages held
metric cards, a core-loop flowchart, a dark node-graph map of zones, and
wide tables with colour-coded badges. Nothing about that browsing left the
page.

Octant should match or beat that result on polish, safety, theming, share,
and accessibility. It should not copy a vendor's markup or runtime.

## What is already true

Verified in the tree, not inferred from the issue text.

| Surface | Today |
| --- | --- |
| Catalog | Closed, versioned (`CANVAS_SCHEMA_VERSION` is 12). Kinds include heading, rich-text, callout, metric, status, table (with `display: status` badges), chart, timeline, treemap, heatmap, bar-list, comparison-matrix, math, plan, mockup, design, and the diagram family. |
| Layout of the document | A flat block list. Consecutive metrics gather into a row. There is no tab, section, column, grid, or card block. Mockup has those as inert wireframe components of a screen, not as document chrome. |
| Inline thread | `InlineThreadCanvas` draws a read-only `CanvasView` at `placement="thread"`, capped at 560px, faded, with **Read the whole Canvas** opening the dock or a tab. Fold to card is remembered in the window. A nested scroller is refused so the wheel stays with the thread. |
| Inline policy | `canvasInlineRefusal` admits `inline` for at most 12 blocks and refuses `diagram`, `plan`, `mockup`, and `design`. Sequence, state, ER, swimlane, and mind map are already allowed inline. An over-bound create is recorded as `sidebar` with a `presentationNote`. |
| Diagrams | Generic `diagram` is nodes, edges, optional groups, `flow` down/right, optional `x`/`y`. Node `role` is an open token, not a shape. Edges have a label and no style. Sequence, state, ER, swimlane, and mind map have their own kinds and one domain layout each. Timeline is dated items, not a Gantt. Plan has checklist, status-board, and timeline views. Board zoom is ctrl/meta+wheel. |
| HTML | `design` (schema 9) is static HTML/CSS in an empty-sandbox `srcdoc` iframe, fragment links only, CSS-only interaction, refused in a share and in Markdown/HTML export. 0164 deferred script that would need an isolated origin and hang protection. |
| Mermaid | 0052 non-goal. Agent tool guidance already says to write structured blocks, not Mermaid, except a design frame's HTML/CSS. |
| Authoring | App-managed tool: `describe`, `create`, `revise`, `preview`. In-tree recipes cover plan, audit, review, research, postmortem, repository map, design prototype, slide deck, data model, architecture review, design spec, and dashboard. Trusted enabled skills may add recipes, not authority. |
| Theme | DESIGN.md owns marks, scales, and number format. Light/dark follow the workspace. Default chrome is monochrome; series hues live on marks. |
| Evidence pages | `apps/web/canvas-browser-evidence.html`, `canvas-inventory-browser-evidence.html`, `chart-visuals-evidence.html`. Capture: `scripts/capture-canvas-charts.ts`. Smokes: `canvasRendererBrowser.smoke.ts`, `canvasPreviewBrowser.smoke.ts`, `canvasInventoryBrowser.smoke.ts`. |

## Recommendation

**Grow the typed catalog and the inline presentation. Do not generate a
program to win the document.**

The clip's browsing (tabs, cards, flowchart, styled node graph, badge
tables) is document structure plus view state. Octant already has metrics,
tables with status badges, charts, and five diagram kinds. What it lacks is
document chrome, a thread that will show a long Canvas, and styled diagram
nodes. Those are contract and renderer work.

HTML generation is already supported for finished screens, sites, and decks
(`design`). Extend that block so an expanded thread can Play it. Do not
treat richer agent HTML — script, fetches, event handlers — as the way to
match the clip. A scripted-artifact tier is a different product: it needs
an isolated origin, a network policy the renderer does not have, hang
protection, and a share story that 0164 already refused for static markup.
The stub is
[canvas-scripted-artifact-threat-model.md](../security/canvas-scripted-artifact-threat-model.md).
It does not start in this order of work.

**Do not reopen Mermaid as a renderer.** 0052's non-goal stands. One
deterministic layout in `packages/domain` is the picture every surface
draws. A later translator from a Mermaid subset into typed blocks is an
import, not a second engine, and only if `describe` plus recipes still
leave agents writing Mermaid fences.

## Comparison with the observed clip

| Capability | T3 Code clip (observed) | Octant today | After this plan |
| --- | --- | --- | --- |
| Full answer in the thread | Interactive mini-app after the run | 560px faded preview, or a row that opens the sidebar | Person or author can show the whole navigable Canvas in the thread |
| Tabs / pills | Eight client-side tabs | None as document chrome (mockup tabs are inert) | `tabs` block; switch is view state |
| Metric cards | Styled tiles | `metric` tiles, gathered in a row | Same block, tighter card chrome and density |
| Flowchart | Core-loop flowchart | Generic `diagram`, one box shape | Closed node roles and edge styles on the same layout |
| Zone map / node graph | Dark styled graph | Groups exist; no tone, shape, or stroke | Theme-token styles on nodes, edges, and groups |
| Wide badge tables | Colour-coded badges | `table` + `display: status` | Keep; sit inside tabs/cards |
| Client-side browse | No agent round-trip | Charts and kind-diagrams already local | Tabs, expand, and board view state stay local |
| Finished-looking screens | Appears to be freeform UI | `design` in the sidebar only | `design` may Play in an expanded thread; still no script |
| Arbitrary script | Appears allowed | Refused | Still refused for documents |
| Share / export | Unknown | Share drops `design` and actions | Layout and styled diagrams travel; `design` and script still do not |
| Theme / a11y | Unknown | Tokens, forced-colours, text fallbacks | Same system; new blocks inherit it |

## Constraints that do not move

- Authority stays on the server. Opening or browsing a Canvas grants
  nothing. Chat Projects stay memory-scoped; Work and Code stay bound to
  their root. A layout block cannot name a path, a tool, or a command.
- The renderer never interprets agent HTML, CSS, or script except inside
  the existing 0164 `design` sandbox. No new dependency that executes
  markup (tldraw, Excalidraw, Mermaid, a foreign component runtime).
- One deterministic layout per diagram kind, in `packages/domain`. The
  screen, preview SVG, and Markdown/HTML export draw the same picture.
- Fail closed on unknown schema, unknown kind, and unknown style token.
- Inline thread: the wheel belongs to the thread until the person focuses
  a region that has a reason to scroll or zoom.
- Local-only use stays complete. Sharing stays optional and sanitised.

## Order of work

Do these in order. Each row is independently reviewable once its parent
has landed. Do not start a later row to "get ahead" of an unapproved
parent. Architecture, Workspace, DESIGN.md, and the user guide update in
the same PR as the behavior they describe.

### 1. Layout and navigation blocks

Give a long answer a spine: tabs, sections, columns, grids, cards, badges
and pills.

**Schema.** New block kinds, gated at the next `CANVAS_SCHEMA_VERSION`
(13 if nothing else lands first). A grouping block names child `blockId`s
that already sit in the document's block list — one level, no nested
trees — so `CANVAS_MAX_DEPTH` is untouched. A child may appear in at most
one group. Tabs name panes; each pane has a label and child ids. Columns
and grids name a track count from a closed set (2, 3, 4). Cards wrap
children and an optional title and tone. Badges and pills are a small
block of labeled tones, or a closed display on `status` / table cells;
do not add a second badge language.

**Policy.** Domain refuses a dangling or repeated child, a cycle of
groups, a pane without a label, and a document past the existing block
budget (128). View state (selected tab, collapsed section) is not
persisted in the definition.

**Renderer.** First-party components in `apps/web/src/canvas/blocks/`.
Tabs are a `tablist` / `tab` / `tabpanel` with arrow keys. Cards and
sections are regions. Badges pair tone with a label. Forced colours keep
the label when the fill drops.

**Share.** Layout kinds travel. Bump the share schema so an older share
decoder refuses them as a future version.

**Files.** `packages/contracts/src/canvas.ts`,
`canvasIdentity.ts`, `canvasShare.ts`; `packages/domain/src/canvasPolicy.ts`,
new layout policy next to it; `apps/web/src/canvas/blocks/` and
`canvas.css`; `DESIGN.md` (layout chrome); `docs/architecture.md` (catalog
paragraph); tests beside each of those.

**Acceptance.** An agent can author a Canvas whose first block is eight
tabs, each pointing at existing metric, table, and diagram blocks. Clicking
a tab switches the panel with no network and no journal write. A decoder
that still speaks schema 12 refuses the document. A share of that Canvas
round-trips the tabs.

**Verify.** Contract and domain policy tests (admit, refuse dangling
child, refuse unknown kind). Component tests for keyboard tabs and view
state. `bun run test` on contracts, domain, and web canvas suites.
Rendered QA on `canvas-browser-evidence.html` and
`chart-visuals-evidence.html` at light, dark, vivid, contrast, and forced
colours via `scripts/capture-canvas-charts.ts` (extend the harness with a
tabs fixture). `git diff --check`.

### 2. Inline thread presentation

Let the author or the person show a full, navigable Canvas in the thread.

**Policy.** Keep `presentation: inline | sidebar` on the definition.
`canvasInlineRefusal` still decides what an agent may *ask* to put inline
without a person expanding it. Raise or restate that bound so a tabbed
document of ordinary reading blocks (not a board the person edits) can be
asked inline — the 12-block cap is what makes today's inline a teaser.
A person's **Show in thread** / expand is a window view preference, like
today's fold-to-card, and may show a Canvas the agent stored as `sidebar`,
including a `diagram`, `plan`, `mockup`, or `design`.

**Frame.** Replace the 560px fade as the only inline body. Default inline
(agent-asked, modest) may keep a short cap. Expanded-in-thread grows with
content up to a large cap (about the thread viewport). Overflow scroll
starts only after the frame is focused, so an unfocused Canvas never
steals the wheel. Boards keep ctrl/meta zoom and do not zoom on a plain
wheel. **Show as card** and **Open in sidebar** / **Open Canvas** stay.
Editing, comments, and sharing stay in the sidebar; the thread drawing
remains read-only and cannot journal a version.

**Files.** `packages/domain/src/canvasPresentationPolicy.ts` and its
tests; `apps/web/src/canvas/InlineThreadCanvas.tsx`, `CanvasView.tsx`,
`canvas.css`; `docs/design/workspace.md` (the inline paragraph); 
`apps/docs/advanced/files.md` ("Small Canvases inside the thread");
`apps/web/src/canvas/CanvasCards.test.tsx`; server card tests in
`canvasService.test.ts`.

**Acceptance.** A tabbed design-doc Canvas expands in a Chat, Work, and
Code thread. Switching tabs does not scroll the thread away. Scrolling
the thread with the pointer over an unfocused Canvas moves the thread.
Focusing the Canvas, then scrolling, moves only the Canvas. A generic
diagram in an expanded thread pans and ctrl-zooms without taking an
unmodified wheel. Fold-to-card still remembers. Nothing drawn inline
writes a version.

**Verify.** Presentation policy tests for the new admit/refuse cases.
Renderer tests for expand, fold, and wheel routing. Manual or harness
pass on Chat (no dock: **Open Canvas**), Work, and Code (dock:
**Open in sidebar**). Capture the expanded frame in the browser evidence
page at a thread-width viewport (~720px) and a narrow one (~360px).

### 3. Diagrams, fully in the catalog

Close the gaps that make a flowchart or a zone map look unfinished. Keep
one layout.

**Flowcharts.** Close `CanvasDiagramNode.role` to a small set the layout
already reads (`process`, `decision`, `terminator`, and today's unlabeled
box). Layout draws the matching shape. Edges gain a closed `style`
(`line`, `arrow`, `dashed`) and an optional theme `tone`. Groups may take
the same tone so a zone map reads as regions, not eight identical boxes.

**Kinds that exist.** Sequence, state, ER, swimlane, and mind map: keep
the schemas; raise visual quality to the data-visualisation bar (token
ink, label fit, dark/light). Do not add a second sequence engine.

**Gantt / timeline.** Today's `timeline` is a dated list. Plan already
has dates, dependencies, and a timeline view. Prefer one typed Gantt
reading in domain — bars, dependency edges, a closed status tone —
either as a `timeline` layout mode or a `plan` view, not a third block
that restates the same tasks. Refuse overlapping identities and cycles
the way plan already does.

**Maps.** No geographic tiles, no remote map style. A "map of zones" is
the styled, grouped `diagram`.

**Mermaid.** Do not add a Mermaid or PlantUML dependency, renderer, or
fence. Tool guidance already tells the agent not to write Mermaid. If,
after milestone 5, agents still paste Mermaid, a later translator may
admit a bounded subset into `diagram` / `sequence` / `state` / `er` /
`mindmap` and then run Octant's layout. That translator is its own change
and still fail-closes on constructs it does not know.

**Files.** `packages/contracts/src/canvas.ts` (role, style, Gantt
fields); `packages/domain/src/canvasDiagramLayout.ts`,
`canvasKindLayout.ts`, plan/timeline layout; `apps/web/src/canvas/blocks/DiagramBoard.tsx`,
`KindDiagrams.tsx`, `StructuredBlocks.tsx`; `DESIGN.md` diagram marks;
`docs/architecture.md` diagram paragraph; snapshot tests for the layouts.

**Acceptance.** A core-loop flowchart and a grouped zone map drawn from
typed nodes look intentional in light and dark. A Gantt of plan-like
tasks lines up with the same data the checklist shows. Every surface —
thread, sidebar, preview SVG, Markdown/HTML export — places the same
nodes. An older runtime refuses the new roles as a future version.

**Verify.** Domain layout snapshots (red/green). Kind-diagram and board
component tests. Extend `scripts/capture-canvas-charts.ts` and
`chart-visuals-evidence.html` with flowchart, zone-map, and Gantt
fixtures. Re-run `canvasRendererBrowser.smoke.ts` when Chromium is
present; name `no-browser` as the residual when it is not.

### 4. Theming, density, and `design` in the thread

Make ordinary blocks look finished by default, and let a design Play
where the person is reading.

**Theme.** New layout and diagram chrome uses existing roles
(`--octant-card`, `--oct-fg`, `--oct-border-soft`, status tones, series
and scale tokens). No ad-hoc hex in block CSS. Comfortable density is
the default; do not add a second density setting unless DESIGN.md already
needs one for the rest of the app. Geist and the 62ch Canvas measure
stay.

**`design` inline.** Once milestone 2 exists, a person's expand may show
a `design` in the thread. Play still uses the empty sandbox, fragment
links, and `canvasDesignMarkupRefusal`. The frame stays hit-testable
(0164's Chromium inert-paint bug). Share, gist, and Markdown/HTML export
still refuse or title-only the markup. The agent's unprompted `inline`
request may keep refusing `design` so a huge frame does not land in the
transcript unasked.

**Files.** `DESIGN.md`; `apps/web/src/styles/canvas.css`, `vivid.css`;
`packages/theme` only if a new semantic role is required; `DesignBlock.tsx`;
`canvasPresentationPolicy.ts`; `canvasSharePolicy.ts` (no change to the
refusal); user guide design paragraph.

**Acceptance.** The game-design fixture from milestone 1 looks like one
document in Default light, Default dark, Vivid, Contrast, and forced
colours. Expanding a `design` Canvas Plays frames in the thread without
script or network. A share of that Canvas is still `unsafe-payload`.

**Verify.** Capture script scenarios above, plus a design-in-thread
fixture. Contrast warnings from `canvasPreviewWarnings` still fire.
Share policy tests unchanged except any new layout kinds from milestone 1.

### 5. Authoring guidance

Agents produce great artifacts only if the tool teaches them.

**`describe`.** List the new kinds. Keep the existing rule: structured
blocks, not HTML/JS/Mermaid, except a design frame. Add one creation
example that is a short tabbed brief (metrics, a flowchart, a badge
table), not only a flat heading list.

**Recipes.** Add in-tree recipes that need the new chrome, for example a
product or game design brief and a visual architecture note. Skeletons
still name kinds and roles, never invented readings
(`canvasRecipeStarterBlocks`). A contributed skill recipe cannot replace
an in-tree id.

**Preview.** Extend layout warnings: empty tab pane, clipped tab label,
inline/expanded overflow, diagram role/style the theme cannot paint,
Gantt bar past the range. Agents already call `preview` after building;
the new warnings are how they fix a dense document.

**Skills.** Trusted, enabled, unscoped skills may add layouts and recipes
that use the new kinds through the existing contribution schema. Mention
grants nothing.

**Files.** `apps/server/src/canvas/canvasAgentTools.ts`,
`canvasDocumentRecipes.ts`, `canvasPreviewWarnings.ts`;
`packages/contracts/src/canvasSkill.ts` if a recipe skeleton bound must
rise (today 12 slots — a tabbed recipe may need a slightly higher
skeleton cap, raised in the same change); `packages/domain` recipe
starter tests; `apps/docs/advanced/files.md`.

**Acceptance.** `describe` with no kinds names the new blocks and the new
recipes. Creating from the game-design recipe opens headings and callouts
that wait for real data, not fake metrics. Preview of a packed tabbed
document returns typed warnings the author can act on.

**Verify.** Agent-tool and recipe tests. Preview-warning unit tests.
Optional: one recorded `describe` → `create` → `preview` fixture in the
existing canvas tool suite.

### 6. Scripted-artifact tier (later, gated)

Not in the first delivery. Start only if milestones 1–5 are shipping and
the maintainer still wants interaction that CSS and the catalog cannot
express (a playable prototype, a calculator, a live sample).

**If opened.** A new block or design tier that may run script, served
from an isolated origin the renderer does not share with Octant, with
the threat model in
[canvas-scripted-artifact-threat-model.md](../security/canvas-scripted-artifact-threat-model.md)
implemented rather than stubbed. Hang protection, no implicit network,
no host objects, no share or export of the program, mode and Project
authority unchanged. This is its own decision, not a silent widening of
0164.

**Until then.** `design` stays the HTML path. The catalog stays the
document path.

## How this lands in the current specifications

When a milestone is implemented, edit the owner in the same PR:

| Owner | What changes |
| --- | --- |
| [Architecture](../architecture.md) (Canvas section) | New kinds, schema/share versions, inline/expand rule, diagram roles, Gantt reading, design-in-thread, still-no-script |
| [Workspace](../design/workspace.md) | Expanded inline frame, wheel/focus, Chat vs Work/Code open actions |
| [DESIGN.md](../../DESIGN.md) | Layout chrome, diagram marks, density |
| [files.md](../../apps/docs/advanced/files.md) | What a person sees in the thread |
| 0165 | Stay `Proposed` until the maintainer accepts the tradeoff; do not treat this plan as approval |

Do not edit 0010, 0052, or 0164 to invert them. A Related link is enough.
0052's Mermaid non-goal remains; this plan restates it.

## Residual risk and named non-work

- Native Electron wheel routing can differ from the Vite harness. Milestone
  2's browser evidence is necessary and not sufficient; packaged-app
  confirmation on macOS is a named residual until someone runs it.
- Agents may still write Markdown. Milestone 5 reduces that; it cannot
  eliminate it.
- Geographic maps, freehand ink, realtime co-edit, and embedding a
  third-party canvas engine stay out.
- Scripted artifacts, Mermaid-as-renderer, and any isolated-origin work
  stay out of milestones 1–5.
- No product code ships in the pull request that only records this plan.
