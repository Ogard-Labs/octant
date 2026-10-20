# Canvas

This topic specification owns the Canvas agent tool's `describe`, `read`, and
`preview` operations, document recipes, thread presentation, the closed block catalogue,
diagram boards and comments, and the `design` block. Architecture owns the
Canvas boundary and authority rules
([Architecture: process topology](../architecture.md#process-topology)) and the
approved direction for documents, designs, and prototypes
([Canvas documents, designs, and prototypes](../architecture.md#canvas-documents-designs-and-prototypes)).
Frames follow the
[Canvas HTML frames threat model](../security/canvas-html-frames-threat-model.md).

## Agent tool and recipes

Canvas follows the same rule through its read-only `describe` operation. The
always-visible `octant_canvas` description keeps what an agent needs before
its first call: what a Canvas is and when to deliver work as one instead of a
long reply, the operations, the authoring and safety rules (structured blocks,
markup only in a design's frames, no file, shell, Git, or network authority,
no invented references), where the thread shows it, and to call `describe`
before authoring. The delivery rule is a test of the answer, not of the verb
the person used: anything the person will keep, share, present, or come back
to (a report, memo, plan, spec, review, audit, comparison, article, slide
deck, dashboard, web page, design or mockup, diagram, or prototype), and any
reply that needs headings, tables, or charts or runs past a few paragraphs, is
a Canvas with a one- or two-sentence reply pointing at it; what is read once
(a short answer, a one-off snippet or command, a clarifying question,
conversation) stays in the reply. When in doubt the agent makes the Canvas
rather than asking, because a person who wanted the document otherwise had to
ask twice, and one who wanted text can say so once. The description also asks
for a finished look: typed blocks for data, a design frame only for the look.
The description serialises with its input schema inside a 6,000-byte budget
that `canvasAgentTools.test.ts` holds, so a rule added here is paid for by a
rule trimmed. Per-block guidance is answered by `describe`. Unscoped
describe names the three tiers (typed blocks carry data, a static design frame
carries the look, a running design frame carries behaviour) and the rule to
use the lowest tier that delivers the result, then lists the closed block
catalogue with one line on when to use each
guided kind, how common requests map to recipes, what preview measures, and a
creation example; describe for up to three block kinds returns their canonical
schemas, plus authoring guidance and worked examples for the kinds that carry
them; a plain kind such as `rich-text` returns its schema alone. The `design`
guidance names the frame kit classes, the images the thread's mode can show
(generated images in every mode, and Project files in Work and Code), when a
design should declare that it runs script, and the limits its bridge keeps;
its examples are a phone flow, a deck, a themed spec, and a prototype that
runs, one finished example of each frame tier. Unscoped
describe also lists document recipes: an id, a title, when to use one, and a
skeleton of block kinds that already exist, where a `design` slot may name
the `size` it is drawn at. The
host offers an implementation plan, a memo (a one-page report from typed
blocks alone: summary, facts, detail, and the ask), a design spec, an
architecture review (its options in a comparison matrix), a code review, an
audit or test report, a postmortem, a research brief, a dashboard, a
repository map, a design prototype (screens, a website, or a landing page at a
device size), a slide deck, a data model, an article (one themed document), a
product or game design brief (a themed pitch, then typed blocks in tabs), a
design system (a themed document and a token table), and a clickable
prototype (a design that runs). Together they cover the deliverables people
ask an assistant for most: a web page, a one-page document, a deck, a
dashboard, and a prototype or small app. A trusted, enabled, unscoped skill
may add recipes through its Canvas contribution; a skill that is not enabled
contributes none, and a contributed recipe cannot replace an in-tree id. A
recipe is a starting shape, not a document and not authority. Describe reads no
Project data and creates no artifact.
A person starts a Canvas from the same list. `GET /api/canvas/recipes` returns
it to any authenticated window (a recipe carries no Project data), with an
optional one-line `summary` per recipe for the chooser. `create` with intent
`template` names a recipe as `templateId`; the host resolves it against what it
offers at that moment, refuses an id it does not offer as `invalid-template`,
and opens the Canvas with the pure `canvasRecipeStarterBlocks` document: each
heading role as a heading, a `design` slot of the `document` size as a themed
document frame holding the recipe's title and section headings that wait for
content (the recipe's words are written into the frame as text, never as
markup), and every other role as an info callout naming the
block kind it waits for, never a data block with invented values. The create
request keeps its ordinary scope and authority checks. When the Create Canvas
panel belongs to a thread, the person may also ask that thread's agent to fill
it in: after the Canvas exists, the renderer sends an ordinary turn on the
thread with the new Canvas attached as whole-canvas context, so the agent
revises it with its own tools under the thread's existing authority.

A Chat thread outside a Chat Project, and a managed child run in Chat mode or with
no Project, are not offered `octant_canvas`: a Canvas there has nowhere to belong
and every call would be refused. The refusal for a window without a Chat
Project stays as the backstop.

## Presentation and schema versions

`create` and `revise` take an optional thread `presentation`: `inline` or
`sidebar` (the default). The value is part of the definition and needs Canvas
schema version 4. An older runtime refuses a version-4 document as a future
version and does not report it corrupt.
A treemap block is gated the same way at Canvas schema version 5, a heatmap
block at version 6, a comparison matrix at version 10, a math block at
version 11, the mockup catalog at version 12, a table row's `id` at
version 13, the funnel, radar, and sankey chart types at version 14, the
dashboard block at version 15, a design's `document` size or `theme` at
version 16, a design's image `assets` at version 17, a design's
`runsScript` at version 18, and the `tabs` and `columns` layout groups,
diagram styles, and the plan's `gantt` view at version 19, so a
document that declares an earlier version and carries one is
refused as a declared future version. The optional table column
`display` and the chart, table, and metric `format` fields are the one ungated
exception: they only change how a value is drawn, so they carry no schema
version, but the strict definition schema refuses an unknown field, so a
runtime rolled back past them refuses a document that uses them rather than
drawing it as plain text.
The pure `canvasInlineRefusal` policy admits an author's `inline` request for
reading blocks at any length within the ordinary block budget, and for a
`design` of the `document` size that runs no script, which is an article or
spec and reads like one. It refuses a request that holds a `diagram`, `plan`,
`mockup`, a device-size `design` (phone, tablet, desktop, or slide), or a
`design` that runs script. When an author asks for `inline` with such a block,
the host records `sidebar` and returns the reason as `presentationNote`. The refusal bounds only the author's unprompted request: a
person may expand any Canvas in its thread, and that view preference never
reaches the server
(see [Canvas documents, designs, and prototypes](../architecture.md#canvas-documents-designs-and-prototypes)).
A revise without a choice keeps the current presentation.

## Preview and placement in the thread

`preview` returns a picture and a layout reading of one shipped version. Its
input is the `canvasId`, an optional `version` (a sequence), a `width`
(`inline`, `sidebar`, or 320–1200 px) and a `theme` (`light` or `dark`). The
layout warnings are computed from the document and the target width alone and
are typed values — a clipped label, a legend over its row, an empty series,
and ink below its contrast target — so a
build reports them whether or not a browser rendered the picture. The picture is
a screenshot of the web app's own Canvas renderer: the host's headless Chromium,
found through the same executable list the browser runtime and the Canvas
browser smokes use, loads the Canvas preview page built with the web assets
(`apps/web/canvas-preview.html`, built into `dist/canvas-preview/`), which draws
the version with the same blocks and stylesheet the thread uses, in the chosen
theme and at the chosen width. The host writes the document into that page as
inert JSON and answers only the page's own built files from disk; every other
request is aborted, and the page's content security policy forbids connections,
so the network is off and the page holds no server address or credential. The
operation is bounded: one preview in flight per thread, a small allowance per
minute, and an image no wider than 1,600 px and no taller than 4,096 px. When no
Chromium is present, the build carries no preview page, the page fails to
settle, or the model driving the turn does not accept images in a tool result,
the warnings still return and the result names which (`no-browser`,
`no-renderer`, `render-failed`, `provider-cannot-take-images`). A `design` is markup, so how its frames read
is measured in the drawn page rather than computed from the document: after
the page settles the host reads each drawn frame and adds a
`design-frame-overflow` warning for a frame whose content is wider than its
page, a `design-contrast-below-target` warning for the text that reads worst
in a frame (4.5:1, or 3:1 for large text; text over an image or gradient is
left unmeasured), and a `design-script-error` warning for each of the first
uncaught errors a running design threw as it loaded (the preview page records
them from the bridge itself, because the app's list under a prototype keeps
only the latest few). Every design the page drew is read; if reading them
passes its time budget, each remaining design gets a `design-not-measured`
warning rather than being left out as if it were clean. A design with a frame
that did not answer gets the same warning, beside the warnings of its frames
that did. The budget is checked before each frame, so a frame it does not
reach counts as one that did not answer. A running design runs in the preview as
it does for a reader: the host builds its page with `renderCanvasDesignPage`,
answers it at a path under the preview page's own origin with the page
route's headers, and the preview page draws it in a frame sandboxed to
`allow-scripts` alone, so the errors arrive through the same bridge. A value
read from inside a frame is a claim: the host keeps only entries of the
expected shape and bounds, and leaves a frame that does not answer in two
seconds unmeasured. These warnings exist only when a browser drew the page,
so a Canvas that holds a design is drawn even for a model that is shown no
picture. Because request interception does not see WebRTC, the preview
browser is started with no route out (`--proxy-server` to a port that is
never a proxy, `--proxy-bypass-list=<-loopback>`, `--host-resolver-rules`
mapping every name to not-found, and
`--webrtc-ip-handling-policy=disable_non_proxied_udp`); the preview browser
smoke runs a prototype that tries fetch, XHR, WebSocket, an image, a
self-navigation, and a peer connection over UDP and TCP, and asserts that
nothing arrives. Whether a model
accepts images is read from its own input modalities, the same signal the
computer-use screenshots use; there is no separate provider capability for
images in a tool result.
The signed desktop app bundles the `playwright-core` driver but no browser
binary, so it resolves Chromium from the host's installed browsers. On a host
with none, `preview` is warnings-only, and the user guide says so.

`read` and `preview` reach any Canvas of the reader's Project by id, so both
carry its outside-content mark to the reader. After the Canvas is read or the
preview is drawn, and before anything from it is returned, the host marks the
reading thread (a managed child under its run) with label `canvas` when the
Canvas records a marked writer other than the reader or the thread it belongs
to is marked now. A reader that cannot be marked gets a refusal instead of the
Canvas. Architecture owns the rule, including how a Canvas records a marked
writer at write time
([Architecture: modes](../architecture.md#modes-chat-work-and-code)).
The mark follows the Canvas tool only. A Canvas's mirrored or exported files
carry no marker, so a thread that reads one with its own file tools is not
marked, as for any file a marked thread writes; this residual is kept on
purpose, because a file tool cannot tell a mirror from any other file.
Chat marks a reader by this same rule, not on every Canvas tool result.
A thread reference card reports the effective presentation and the first
version's time (`canvasCreatedAt`). A Canvas that has outgrown the bound, by a
revision or a person's edit, is listed as `sidebar`.
The renderer places every Canvas after the last row of the turn the person
opened at or before `canvasCreatedAt`. An inline one is drawn there read-only:
it gets no layout, plan, comment or action runtime, so nothing drawn inline can
journal a version. Any other is a row that opens it. A card from an older host,
or one no loaded turn can place, stays in the thread's card list.

## Charts and dashboards

A chart is a closed type: line, area, bar, scatter, distribution, pie, donut,
stacked bar, grouped bar, bar-and-line, funnel, radar, or sankey. Pie and donut
are one series of labeled non-negative slices. Stacked, grouped, and
bar-and-line charts share categories across series; a bar-and-line series names
itself as a bar or a line. A funnel is one series of at most 16 labeled stages,
each no larger than the one before. A radar compares series on 3 to 16 shared,
labeled axes with readings that are not negative. A sankey carries no series:
its `links` are flows of a positive value from one named node to another (at
most 256 flows between 64 nodes); a flow listed twice or a set of flows that
returns to a node it left is refused. Stage, axis, and node labels are at most
80 characters. The domain policy names each refusal (`funnel-not-narrowing`,
`funnel-negative-value`, `funnel-stages-budget-exceeded`, `radar-axis-count`,
`radar-negative-value`, `sankey-cycle`, `sankey-flow-not-positive`,
`duplicate-sankey-link`, `sankey-nodes-budget-exceeded`,
`sankey-links-budget-exceeded`, `chart-label-budget-exceeded`). The sankey
layout is pure and deterministic in `packages/domain`
(`canvasSankeyLayout`): a node sits one column right of the furthest node that
feeds it, every ending lines up in the last column, and one scale sizes every
band, so the screen and the artifact preview SVG draw the same picture. The
three types arrive together with Canvas schema version 14.
A `dashboard` block is a KPI layout: a title that names its region, an
optional `columns` of 1 to 4 (four when absent), and 1 to 24 `cells`, each
naming the `blockId` of a metric, progress, status, chart, or table block in the
same document with an optional `span` of columns. It is a block rather than a
document-level layout field so it is version-gated, revised, commented on,
shared, and described like any other kind, and a Canvas can hold one beside
prose. Cells reference blocks rather than copy them, so a placed block keeps
its one definition, id, and comment anchor. A dashboard is not a placeable
kind, so grids never nest, and it never places `tabs` or `columns`
(`nested-layout-group`). The domain policy names each refusal
(`dashboard-cells-budget-exceeded`, `dangling-dashboard-cell`,
`dashboard-cell-kind-refused`, `duplicate-dashboard-cell` for a block placed
twice in one dashboard or across two, and `dashboard-span-exceeds-columns`).
The reading order is pure in `packages/domain` (`canvasDashboardLayout`): a
dashboard reads where it sits with its cells in order, a tabs or columns block
reads with its children per pane or track, and a placed block reads only there.
A tab pane or a column may hold a dashboard, which draws there as it does at
the top level, so nesting stops at tabs or columns, then a dashboard, then its
tiles. Across every dashboard, tab, and column a block is placed at most once
(`block-placed-twice`, naming the block and both blocks that place it). The screen, the shared snapshot, the artifact preview SVG (framed
cells packed in that order, stopping at the first row the picture cannot hold
whole), and the Markdown and HTML export (the title as a heading, then each
placed block) all use it.
The accessible table lists every reading: a funnel's stages with their share of
the first stage and of the stage before, a radar's axes by series, and a
sankey's flows with each one's share of its source. A pie or donut legend
toggles at most 24 slices, and a sankey legend at most 24 nodes (hiding a node
hides every flow through it); the rest stay in the picture and the table. A
shared snapshot keeps the chart, its number format, every series mark, and a
sankey's links.

## Treemap, heatmap, bar list, and metric

A treemap is a hierarchy drawn as squarified rectangles: nodes name a parent,
one root, values sit on leaves, and a group's reading is the sum of its
children. A leaf carries a value for every declared measure and may name a
manifest source, which offers Open file through the allowlisted open-source
action; the host reauthorizes it. The pure, deterministic layout lives in
`packages/domain`, so the screen, the artifact preview SVG, and the Markdown and
HTML export all draw the same rectangles. The person switches the size and
colour measures and zooms into a group (click, breadcrumb, Escape, right-click,
or Enter on a keyboard-selected cell); these are view state and are never
journaled. The domain policy refuses a second root, a cycle, a dangling parent,
a group that carries its own value or a leaf that does not, a value that is
negative, a measure that is not declared, and a hierarchy past the depth, node,
measure, or label budget. The accessible fallback is a hierarchical table
sortable by each measure. A shared snapshot keeps the hierarchy, its measures,
and every reading, and drops each leaf's source id.
A heatmap is a grid coloured by value. A matrix names its rows and columns and
carries a cell per coordinate with a value and an optional short note; a cell on
a coordinate the block does not hold, a repeated row, column, or coordinate, and
a grid past the row, column, or cell budget are each refused. A calendar carries
one reading per date and lays the days out on a week grid whose first day comes
from the locale. A coordinate the block does not list is drawn apart from a zero.
Both read a value through the shared scale roles. The pure, deterministic layout
lives in `packages/domain` (`canvasHeatmapLayout`), so the screen, the artifact
preview SVG, and the Markdown and HTML export all draw the same cells. The person
can sort a matrix's rows by their total and walk the cells with the arrow keys;
these are view state and are never journaled. The accessible fallback is a table
of every coordinate and its total for a matrix, or of every dated reading for a
calendar. A shared snapshot keeps the grid, its readings, and their notes.
A bar list is a ranking of magnitudes (`packages/domain/src/canvasBarListLayout.ts`):
each row is a label, a value, an optional second value, and an optional manifest
source. Rows sort largest first with a stable tie-break by the author's order,
a reader can flip the ranking to smallest first, and the list shows a top N with
Show all; both are view state and are never journaled. A bar's length is its
share of the largest value, drawn in neutral ink or through the shared
sequential scale. A path-like label uses the shared
path style (directory dimmed, file name at full ink), and a row that names a
manifest source offers Open file through the allowlisted open-source action,
which the host reauthorizes. The pure, deterministic layout is shared by the
screen, the artifact preview SVG, and the Markdown and HTML export. The domain
policy refuses a repeated label, a negative or non-finite value, a list past the
row budget, and a source the manifest does not hold; the accessible fallback is a
table of every row. A shared snapshot keeps every row and reading and drops each
row's source id. A metric block may carry a `format`, a `delta`, a
`goodDirection` of `up`, `down`, or `neutral` so a delta's tone is never guessed,
a `sparkline` of at most 256 readings, and a short `caption`; consecutive metric
blocks are gathered into one responsive row of two to four tiles. The bar list
and the metric's direction, sparkline, and caption arrive with Canvas schema
version 7, so a document declaring an older version that carries any of them is
refused as a future version; a static export carries the same metric fields.

## Comparison matrix, math, and mockup

A comparison matrix (`packages/domain/src/canvasComparisonMatrix.ts`) sets
options as columns against criteria as rows. A criterion may carry a weight
(absent counts once, zero keeps it out of the score) and may prefer the lower
reading. Each cell holds exactly one reading: a score, a short text, or a glyph
of yes, partial, or no, with an optional note. The pure layout computes each
option's weighted score as the weighted share of the best reading it could have
had across the criteria that can be scored. A score counts as its place on the
score range, yes, partial, and no as the whole, half, and none of a criterion,
and text never counts. A counted criterion an option has no reading in scores
nothing and is reported beside its total. The author names a recommended option,
which is drawn apart and never inferred from the scores. Options and criteria
take node ids, so a comment anchors to a column or a row through the existing
node anchor. The board contract has no cell anchor, so a comment on a cell sits
on its row or column. Ordering options by score is view state. The domain policy
refuses an id used twice across options and criteria, a cell or recommendation
that names an option or criterion the block lacks, a repeated coordinate, a
score outside a declared range, and a matrix past the option, criterion, or cell
budget. The block is a native table that scrolls inside its own focusable region
with the criteria pinned; its disclosed fallback lists one row per option. The
screen, the artifact preview SVG, and the Markdown and HTML export read the same
layout. The comparison matrix arrives with Canvas schema version 10 and share
version 4.
A math block (`packages/domain/src/canvasMathPolicy.ts`) is a formula written in
a LaTeX math subset and typeset by KaTeX (code MIT, bundled fonts SIL OFL 1.1;
pinned in `apps/web` and `apps/server`, with both licences in
`apps/web/public/KATEX-LICENSE.txt`). Layout
`display` is one formula on its own line with an optional caption; layout
`inline` is a paragraph of prose and formula runs. A formula source is at most
1,000 characters and a paragraph 48 runs and 4,000 characters. KaTeX only draws:
every surface passes the shared options, so `trust` is off (no links, images,
or HTML attributes), `strict` is an error, macro expansion and explicit sizes
are bounded, and each formula gets a fresh macro table. The domain policy also
refuses `math-command-refused` for a source that defines a macro (`\def`,
`\newcommand`, and the like), links or embeds (`\href`, `\url`,
`\includegraphics`, `\html…`), sets its own colour (`\color`, `\textcolor`,
`\colorbox`, `\fcolorbox`), or names an internal `@` command, and refuses
oversized sources, runs, and paragraphs with their own budget codes. The
renderer builds KaTeX's DOM into an element React leaves empty, pairs the drawn
glyphs (hidden from assistive technology) with MathML that carries the source
as an annotation, offers the source as text under View source, and shows a
formula KaTeX refuses as its source with a plain note. KaTeX's stylesheet and
fonts are bundled; the Vite builds never inline a font as a `data:` URL,
because the renderer's content policy loads fonts from its own origin only. The
Markdown export writes a display formula as a fenced `math` block and an inline
formula as GitHub's code-span math; the HTML export writes MathML alone, with
the source under a Source disclosure; the preview SVG draws the source. A
source the share filter would not let leave the host is withheld whole. The math
block arrives with Canvas schema version 11 and share version 5.
A mockup block (`packages/domain/src/canvasMockupOutline.ts` for its tree and
reading) describes a screen as data drawn from a closed catalog; it holds no
HTML, CSS, script, or image source. The frame is a device preset (`desktop`
window, `browser`, `tablet`, `phone`, `dock-panel`) or `custom` with its own
size (240–2,560 px a side), and the fidelity is `wireframe` (neutral ink, the
default) or `styled` (the active theme's accent, status roles, and surfaces).
Nodes name a parent and take a component from window, header, sidebar, list,
list row, form field, button, toggle, tabs, card, image placeholder, text,
stack, row, grid, heading, select, checkbox, table, avatar, badge, icon (a
bundled set of meanings each surface maps to its own glyph), nav, modal, and
toast. Optional node fields (`on`, `value`, `tone`, `icon`, table `columns` and
`rows`, `gridColumns`) belong to named components, and the domain policy
refuses one on any other component as `mockup-field-refused`. Up to four
`variants` put states or alternatives side by side; every top-level node then
names one and its children follow it. Up to twelve `annotations` are numbered
callouts pinned to nodes, and a comment on a callout uses the node anchor of
the node it names. A version-12 mockup holds at most 160 nodes eight deep, with
120-character text, 240-character callouts, and tables of six columns and eight
rows; a document declaring an earlier version keeps the version-3 bounds of 64
nodes six deep. The policy also refuses a custom device without a size or a
preset with one (`mockup-size-mismatch`), a table whose rows do not match its
columns (`mockup-table-shape`), an undeclared or repeated variant, and a
dangling or repeated callout. The renderer draws every control inert: each
part is a disabled tree item whose name says what it is and what it shows, the
frame is a region whose role description is mockup, and Outline lists the tree
as text. The Markdown and HTML export write that outline per variant with the
callouts, the preview SVG draws a frame per variant, and a share carries the
block whole. The catalog arrives with Canvas schema version 12 and share
version 6.

## Shares

A share carries every block kind and field a Canvas holds except source ids,
a design's declared images, and the action block it refuses (see the `design`
block). A table
column keeps its number format and display, a table row leaves as its cells
without the `id` comments anchor to, and a board keeps its own layout. Because
the row id is the only Canvas version 13 field and a share drops it, a share at
version 6 named a block authored at version 13 as version 12. Share version 7
carried the version-14 chart types, so it named blocks up to version 14, share
version 8 carries the version-15 dashboard, so it named blocks up to version
15, and share version 9 carries tabs, columns, diagram styles, and the Gantt
view, so it names blocks up to version 19
(`CANVAS_SHARE_MAX_BLOCK_SCHEMA_VERSION`). Share version 10 carries a design's
frames and accompanies no Canvas version.
Share documents version independently of Canvas documents: a treemap, a
heatmap, a bar list, a chart's or a table column's number format, a table
column's display, and a board's layout arrive with share version 3, and a
comparison matrix with share version 4, math with share version 5, the
mockup catalog with share version 6, the funnel, radar, and sankey charts
with share version 7 (whose blocks may name Canvas version 14), the dashboard
with share version 8, and tabs, columns, a diagram's edge styles and tones,
its group tones, and a plan's `gantt` view with share version 9, and a
design's frames with share version 10, so a share
that declares an older version
and carries one is refused as a future version.
A `tabs` block has 2 to 12 panes, each a short label and the block ids it
shows; a `columns` block has 2 to 4 tracks, each the block ids it stacks.
Both name blocks the same document holds rather than nesting them, so each
child keeps the identity a comment anchors to, a revision edits, and a share
carries. The domain policy refuses a name that holds no block
(`dangling-layout-child`), a block placed in more than one pane or track
(`repeated-layout-child`), and a group or an action inside a group
(`nested-layout-group`); a pane or track may hold a dashboard. A pane without
a label fails the schema, and groups count against the ordinary 128-block
budget. The renderer, the shared snapshot, and the Markdown/HTML export draw
each child inside its group once, through the shared reading order, and never
again in the block list; export reads a tab as a heading over its blocks and
columns in track order, and the artifact preview SVG draws the children in
that order. Tabs are a `tablist` whose arrow keys,
Home, and End move between tabs; which tab is open is the reader's view state,
sends nothing to the host, and journals nothing. Columns fold to one track
when the Canvas itself is narrow.

## Plan block

The catalogue includes a `plan` block: phases, and one list of tasks that each
name their phase, carry a status (todo, doing, blocked, done), and may carry an
owner, estimate, acceptance notes, dates, dependencies on other tasks in the
block, and manifest source ids. The domain policy refuses a task in a missing
phase, a dangling or circular dependency, or a missing source. Tasks are not
nested in phases because nesting puts a task's dependencies past the Canvas
depth budget. The renderer offers checklist, status-board, timeline, and Gantt
views; switching is a reading choice and revises nothing. A plan may name
`gantt` as its view from Canvas schema version 19. The Gantt view is a reading
of the same tasks, not a block that restates them: the pure
`layoutCanvasPlanGantt` places one bar per dated task (by phase, then start)
from its start to its due day, a one-day bar when only one date is given or the
due day precedes the start, elbow arrows from each task waited on to the task
that waits, week or four-week ticks, and the undated tasks in dependency order
under the chart. Duplicate task ids and circular dependencies are refused as for
any plan. Bars take the status tones, and the status is also written beside each
title. The Markdown/HTML export reads each task's days from the same layout. A shared snapshot keeps the
plan but drops its source ids. A person sets a task's status from its mark;
`/api/canvas/plan-revise` journals that as a new `canvas.version-appended@1`
version, admitted by the pure `admitCanvasPlanTaskRevision` policy (the block
must be a plan, the task must exist, the sequence must be the head). As with a
drag, the host stamps its own `local-user` actor and the renderer shows the
change at once, putting it back with the host's reason when refused. Agent
revisions and person changes share one history, so the agent reads the change
when it next reads the Canvas. In a Work or Code Canvas, an open task offers
Start, which opens a new-thread draft in the Canvas's own Project with the task
(and its acceptance notes) written in. It creates nothing and grants nothing: the
person sends the draft like any new thread, and the thread gets that mode's
ordinary authority. A Chat Canvas offers no Start, because a Chat Project has no
folder to bind.

## Diagram boards and comments

A Canvas diagram block is also a board. The renderer zooms, pans, and fits the
same deterministic layout every surface draws, and a user's drag or keyboard
nudge is journaled through `/api/canvas/layout-revise` as a new immutable
`canvas.version-appended@1` version with `actor: local-user` that the host
stamps itself, whatever actor the request names, admitted by the
pure `admitCanvasDiagramLayoutRevision` policy (target must be a diagram,
every moved node must exist, the sequence must be the head, budgets stand).
The generic diagram is also styled, from Canvas schema version 19. A node's
`role` is closed to `process` (a box), `decision` (a diamond), and
`terminator` (a pill); a node without one is the plain rounded box. A role
was free text before; a block that declares version 19 or newer is refused for
any other role (`unknown-diagram-role`), while an older block keeps its text,
still loads, and draws as the plain box, so nothing already saved breaks and a
revision that copies such a block forward keeps it. An edge takes a `style` of
`line` (the default), `arrow`, or `dashed` (a dashed arrow), and an edge or a
group may take a `tone` of `neutral`, `accent`, `success`, `warning`, or
`danger`; a toned group draws as a washed region. Tones are theme roles, never
colours. The pure `layoutCanvasDiagram` stays the one layout: it carries each
node's shape, each edge's style, tone, and drawn points, and each group's tone;
it gives every group its own band across the flow so two groups' frames never
overlap, starts a grouped diagram far enough in that no frame is drawn above
the picture, meets a diamond on its slanted side, and steps an edge that would
cross another node out beside the column and back rather than under the boxes.
The board in the thread and the sidebar, the agent's preview (a screenshot of
that board), the artifact SVG sidecar and thumbnail (the layout scaled into the
band), and the HTML export (the layout drawn inline as plain SVG elements with
no script, id, or external reference) place the same nodes; the Markdown
export names a shaped node by its role.
Mermaid is never rendered. The pure `importCanvasMermaid` translates a bounded
subset into the typed blocks above: a `flowchart` or `graph` (TD/TB or LR;
`[ ]` process, `{ }` decision, `([ ])` terminator, `( )` the plain box;
`-->`, `---`, and `-.->` links with a piped or inline label; one level of
`subgraph`) into a `diagram`; a `sequenceDiagram` (participants and actors
with aliases, `->>`, `-->>`, `->`, `-->` messages, notes beside or over one
participant, activate and deactivate) into a `sequence`; a `stateDiagram`
(transitions, `[*]` as a start and an end with their own ids, `state "…" as`,
composite states) into a `state`; an `erDiagram` (relationships with
cardinalities, attribute blocks, `PK`) into an `er`; and a
`mindmap` (tree by indentation; a square, rounded, or circle topic keeps
its text and drops its id and shape) into a `mindmap`. Anything else — another
diagram type, styling, classes, `click`, loops and alternatives, other shapes
and links, a nested subgraph, a note spanning two participants, an `FK` or
`UK` key, a non-identifying (`..`) relationship, two ids that would collide, a source over 32,768
characters, or a translation the block catalog refuses — returns a typed
refusal (`unsupported-diagram`, `unsupported-construct` with its line, `empty`,
`too-large`, `invalid-result`). The one entry point is the agent's Canvas
`create` and `revise`: a `code-excerpt` block with language `mermaid` and no
source id is replaced by its translation under the same block id before the
document is validated, and the result lists each such block as `imported` or
`kept-as-code` with the reason. A refused source stays the code block it was.
Beside that generic node-and-edge diagram, a `sequence` block is participants,
ordered messages, activations, and notes, and a `state` block is states that
may nest by parent id, labeled transitions, and initial and final roles. Three
further kinds share the same budgets: an `er` block is entities with named,
typed attributes (an attribute may be a key) and relationships that name a
cardinality at each end and an optional label; a `swimlane` block is ordered
lanes of actors or teams, the steps each lane owns (a step may be flagged as a
decision), and labeled connections; and a `mindmap` block is one root topic
over children that name their parent, each with an optional note. Both
sequence and state, and the three later kinds, use the diagram node and edge
budgets; the er, swimlane, and mindmap kinds are version-gated together at
Canvas schema version 8, so a document that declares an earlier version and
carries one is refused as a declared future version. Layout is deterministic.
Participants and states are node comment anchors; messages and transitions are
edge comment anchors; entities, steps, and topics are node anchors and
relationships and connections are edge anchors. Static export draws every kind
through the same artifact SVG path as the other blocks, and the Markdown/HTML
document renderer gives the er kind an attribute table, the swimlane kind
numbered steps per lane, and the mindmap kind a nested list.
Agent revisions and user layout share one history; a stale drag is refused and
the renderer reloads rather than overwriting a newer version. Only the head
version is editable. The route is host-window only; a paired browser reads
boards but does not move nodes. Comments are journaled facts of one
`canvas-comments` aggregate per Canvas (`canvas.comment-added@1`, `-replied`,
`-resolved`, `-deleted`), whose version is the board's comment sequence, so
concurrent comments conflict on the journal instead of both winning; the
service rebuilds them with the pure `applyCanvasCommentEvent` reducer, refuses
unauthorized reads with no bodies, and stamps each comment's origin (`host` or
the authenticated `remote-device`) beside its `local-user` author. The host
stamps that author (and a resolve's or delete's actor) itself and ignores the
actor the request names, so a renderer can never author a comment as an agent.
A table row is either a list of cells or `{ id, cells }`; the id is the
author's, unique within the table (the domain policy refuses a repeat as
`duplicate-table-row-id`), and arrives with Canvas schema version 13. A `row`
comment anchor names a table block and that id, never a position, so a comment
stays on its row through the reader's sort, filter, and grouping (all view
state, never journaled; a table stores no default grouping) and through a revision
that inserts, removes, or edits rows. A row without an id cannot be anchored
and the renderer offers it no marker. A comment whose row is gone from the
version on screen is shown as no longer on the canvas and is never dropped; the
comment service does not check anchors against a version, because comments
belong to the Canvas rather than one version. A comparison matrix does not use
the table row model; its criteria already anchor through node ids. Shared
snapshots serialise the definition and so never carry comments
([decisions/0052-canvas-boards.md](../decisions/0052-canvas-boards.md)).

## Design block

A `design` block (Canvas schema version 9) is the one block whose content is
markup: the frames of one design at one size, `phone` (390×844), `tablet`
(820×1180), `desktop` (1440×900), or `slide` (1920×1080), each a page of
static HTML, plus one shared stylesheet. Version 16 adds the `document` size,
whose frames are sections of one page as wide as the Canvas column and as tall
as its content, and an optional `theme`: `workspace` or `none`, defaulting to
`workspace` for a document and `none` for a device size, so a product screen
keeps its own brand. The renderer draws each frame in an `iframe` with a
`srcdoc` page whose policy loads nothing but inline styles and `data:` images
and fonts, on top of the app policy the page inherits. A static frame's
sandbox never includes `allow-scripts`; a design that declares `runsScript`
is drawn in a different frame, described below. A device-size frame that is not themed has an empty
`sandbox`; a document or a themed frame has `allow-same-origin` and nothing
else, so the host can read the page: it measures the document's body with a
`ResizeObserver` and sets the frame's height to it (up to 12,000px, past which
the page scrolls inside the frame), and it installs Geist and Geist Mono into
the page as fonts built from the bundled files, because the inherited app
policy (`font-src 'self'`) refuses a `data:` font the page could name. A
themed page also receives the workspace's computed `--oct-*` tokens and
light or dark scheme, redrawn when the root's theme attributes change, and the
frame kit stylesheet, all ahead of the author's own; `DESIGN.md` names the
kit. A test renders every size and theme and asserts no static frame is given
`allow-scripts`, and that no frame of any tier has both `allow-scripts` and
`allow-same-origin`. In a static frame no script runs, nothing submits, and
the page can use none of Octant's origin. Frames link by fragment; Play draws every frame in one page so a link
shows its frame through `:target`, and the renderer writes each fragment
against the page's own address because a `srcdoc` page resolves a bare one
against its parent. The pure `canvasDesignMarkupRefusal` policy refuses, in a
static design, a script, an event handler, and, in every design, an embedded document, a remote image, stylesheet,
or font (in a `url()`, an `@import`, or an `image-set()` candidate, however a
character reference or CSS escape spells it), and any link that is not a
fragment, naming the frame and the
construct; the event store and revise policy return that reason to the
author rather than a generic failure. The sandbox is the boundary and the
link rule is part of it, because a link is the one way a page with no script
can leave. Version 17 lets a design declare up to 12 image `assets`, each a
`generated-image` (a completed image job's attachment id) or a `project-file`
(a path relative to the Work thread's folder or the Code thread's checkout),
and markup names one as `octant-asset:<id>` in `src`, `srcset`, a `url()`, or
an `image-set()` candidate. The markup policy admits a reference only for a
declared id spelled literally and refuses a Project file in a Chat Canvas or
a path that is not confined. The definition holds references only. Each time
a reader draws the design it asks `GET /api/canvas/design-assets` for that
version and block; the route runs the same window authorization as `get`
(paired devices included, under their Canvas read grant) and the server
resolves each asset under that version's provenance, with nothing cached: a
generated image only when its job's thread belongs to the Canvas's Project
(never the host-wide image library), a Work file through the Work confinement
sequence under the Project root while the thread is bound to its current
revision, and a Code file the same way under the thread's checkout. Bytes are
sniffed as PNG, JPEG, GIF, or WebP; SVG is refused because an SVG file is
markup a sniff cannot tell from other text, and inline SVG already serves
vector art. Each image is capped at 3 MiB and a design at 5 MiB, which keeps
the base64 response inside the remote gateway's 8 MiB. The renderer replaces
each literal reference with a `data:` image before writing the page, so the
frame still loads nothing; an image that is loading, missing, refused, too
large, or not an image draws a labelled placeholder, and the agent's
`preview` reports a `design-asset-unavailable` warning naming the block, the
asset id, the reason, and the frames that name it, never the bytes. An
authenticated snapshot carries a design's frames, static or running, from
share version 10, as the author wrote them. The secret filter reads values,
not markup, so a Canvas that holds a design is shared only when the sharer
acknowledges that its markup is shared as written
(`acknowledgedMarkupSharedAsWritten`); without it the share is refused as
`consent-required`, and markup that holds a token or key in a recognisable
shape is refused as `unsafe-payload` even then. A shared design carries no
declared images: an asset names a Project file or an image job, which resolve
only under this host's authority, so a frame that named one draws a
placeholder. The snapshot viewer draws a shared design with the same block
the live Canvas uses, so its frames get the same sandbox and page policy, and
a reader that only knows share version 9 refuses the snapshot as a future
version rather than drawing a frame any other way. A shared prototype runs
from a page the host tickets on a share access that names it (`runDesign`):
the access is decided and journaled like any read of the snapshot, the ticket
is the page route's own single-use ticket, and the page is that snapshot's
design. It waits for **Run**, as in the thread. Markdown export writes frame
titles, not markup. HTML export writes a design's frames as written, each a
sandboxed `srcdoc` page that carries the frame policy in a `meta` element
ahead of everything else in it: a static design as one page per screen with
an empty `sandbox`, and a running design as one page of every screen with
`sandbox="allow-scripts"` and the served page's policy without `sandbox`,
which a page cannot declare for itself. No frame has `allow-same-origin`, and
the bridge is left out, since an exported page has no host to report to. The
document that draws frames carries a policy of its own with `frame-src
'none'`: a frame's page forbids its script every request but not leaving, and
a prototype that set its own address loaded another page, which reached a
local listener; the document's policy refuses that navigation, and a `srcdoc`
frame, which is not one, still draws. A `srcdoc` page inherits the document's
policy, so the document admits inline script only when it draws a running
frame. The export approval card says when the document writes design markup
(`writesDesignMarkup`), so approving it is the person's acknowledgement that
markup leaves as written. A declared image draws a placeholder. A design in
the workspace theme is exported in the theme the person's window draws it
with: an HTML export of a Canvas that holds a design carries `frameTheme`, the
scheme and the frame's token values, because an exported file has no Octant
page to read them from. They are values to bound, not markup: the contract
admits only token-shaped names and values that cannot end a declaration, and
the host writes only the tokens a frame receives
(`DESIGN_FRAME_THEME_TOKENS`), checks each value again
(`designFrameTokenValueIsSafe`, which the app's own frames use), and adds the
frame kit, which lives in `packages/domain` so the app and the export share
one copy. An export handed no theme writes a themed design as its titles. An
exported document frame cannot be measured, so it scrolls at a fixed height,
and it does not carry Octant's fonts; the tokens' own fallbacks apply. A share refuses an action block, whose
command runs only on this host. That refusal, and any block or field the share
contract does not carry, are checked before the snapshot is journaled and
reach the owner as an `unsafe-payload` denial: the Canvas cannot be shared, not
a malformed request. A device-size design, and any design that runs script, is
always a sidebar Canvas for the author's own request; a `document` design that
runs none may be asked for `inline`. An authored
revision declares the current schema version on the version and its
definition, so a Canvas written under an earlier version moves forward and can
gain a design; a version append never moves a Canvas back. Agents writing
a design can be silent for minutes while composing the tool call, so Chat and Work
wait five minutes for a provider event before cutting a turn off, as Code does.
Chromium stops painting sandboxed frames that are `inert` or have
`pointer-events: none`, so a frame shown as a picture stays hit-testable and a
cover over it takes the pointer
([decisions/0164-canvas-designs-are-html-in-a-frame-that-runs-nothing.md](../decisions/0164-canvas-designs-are-html-in-a-frame-that-runs-nothing.md)).
Version 18 lets a design declare `runsScript: true`, which makes it a running
prototype. For it alone, the markup policy admits inline `<script>` elements
and event handlers; a script file, every remote load, `meta`, `base`,
embedded documents, and links that leave the design stay refused, and it
cannot take the `workspace` theme, which only the reader's renderer can
write. A `srcdoc` page inherits the app policy (`script-src 'self'`), so the
host serves the page itself. `POST /api/canvas/design-run` names the
version, block, and optional start frame; it runs the same window
authorization as `get` (mode, Project, window, and a paired device's Canvas
read grant) and returns a path holding a single-use ticket of 32 random bytes
that expires in 10 seconds and authorizes that one page. The ticket is held in
memory only and is forgotten when redeemed, so a replayed or expired one is
refused; the window credential never enters the address. `GET
/api/canvas/design-page?ticket=` redeems it only for a frame load
(`Sec-Fetch-Dest: iframe` when the browser sends it; the desktop's main process
asks for the page without a fetch destination, and only for a ticket the
renderer named) and serves the page with
`Content-Security-Policy: sandbox allow-scripts; default-src 'none';
script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:;
font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none';
form-action 'none'; base-uri 'none'`, `Referrer-Policy: no-referrer`, and
`Cache-Control: no-store`; a refusal carries the same headers. Declared
images are resolved under the version's provenance and written in as `data:`
images: every image once, and a repeated reference only while the page's
images stay within the design's 5 MiB as base64, after which it draws a
placeholder, so the page fits the remote gateway's 8 MiB rather than arriving
cut short. The remote gateway forwards that one path as a pre-auth route,
because a frame's load carries neither the session proof nor Octant's
headers and the ticket is its whole authority, and keeps the page's policy in
place of its own; its document policy adds `frame-src` for that path on its
own origin. The renderer's policy adds `frame-src 'self'` and the loopback
design-page path, which the packaged `file://` and Vite renderers reach on the
loopback host. The host writes a bridge script first in the page; it posts the
page's height, uncaught errors cut to 280 characters, and a heartbeat every
second on the `octant-design-frame@1` channel and grants nothing. The
renderer reads only typed, bounded messages (below), clamps height to
48–12,000px, and shows errors as text. A page with no heartbeat for 5 seconds
(10 for the first) while the window is visible is removed and shown as stopped
with **Run again**, as is a page that posts more than 250 messages in a second,
which would starve the renderer that holds **Stop**, and a page that loads a
second time, which is a page it navigated to. Host chrome holds a running label
and **Stop**. In the thread a prototype starts only on **Run**; the sidebar
runs it on open. A running page is in the tab order, right after Stop, and Octant
never moves focus into it when it opens; in a browser, page script can still
take focus on its own in some cases (see the frame threat model, F10).

In a browser the page is drawn in a frame sandboxed to `allow-scripts` alone,
and the renderer accepts only messages whose `source` is that frame's window
and whose origin is opaque. A browser cannot cancel a self-navigation, so the
Run control says the prototype is not network-contained, and says that its
script can still connect to another computer, under the
[Canvas HTML frames threat model](../security/canvas-html-frames-threat-model.md).

On desktop a running prototype is never drawn in a frame. A page policy does
not cover WebRTC, and the renderer's WebRTC policy stops only UDP: on Electron
43.5.0 a peer connection naming a TURN server over TCP still reached a local
listener from a sandboxed frame. A session of the app's own process can be kept
off the network but not off the app's resolver: Electron 43 has no resolver
rule for one session, and the app's other sessions need to resolve names, so
in such a session a `dns-prefetch` link made the app look up a name the page
chose. So the prototype runs in the **prototype host**, a process of its own
with the same no-route switches as the preview browser, a resolver rule that
answers every name with not-found among them:

- **The process.** `apps/desktop` starts the host from its own executable with
  a host switch (a packaged app always runs its own entry, so the entry runs
  either the app or the host). It has no Dock icon or windows on screen, a
  throwaway data directory, and leaves when the app's IPC channel closes or it
  is sent SIGTERM, at once and whatever a page's `beforeunload` asks; a host
  still running after that is killed, and the app kills one still running as
  it exits. It
  runs while a window that prepared it or opened a prototype keeps its page:
  when the last such window closes, loads another page, or its renderer exits,
  the app stops the host, even one still starting, and the next run starts a
  new one.
- **Preparing.** A run is two separate facts: whether it is contained (what the
  person is told) and where it is drawn (the desktop's own surface, or a frame).
  Whatever builds the run, a prototype drawn on the surface is not asked for a
  ticket until the renderer has asked the main process to prepare the surface;
  a shared snapshot's prototype takes the same path as a live one. The agent's
  preview browser is contained and draws a frame, because it is an ordinary
  browser with no such surface. Preparing starts the host, which points its
  in-memory session at a SOCKS address that is never a proxy, with
  `<-loopback>` so loopback is not exempt, reads back that a public and a
  loopback address both resolve to it and neither to `DIRECT`, reads back that
  `localhost` does not resolve, and refuses every permission, device, screen
  capture, and download. When it cannot, the prototype reports why and does not
  run; it is never drawn in a frame instead, and the app window cancels any
  frame navigation to the design page. The app window has no `<webview>`.
- **What may open.** The renderer names only the host's ticketed address and
  the page's size, under a surface id it chose. The main process refuses any
  other address and opens a prototype only once the host is ready. Each
  prototype belongs to the window that opened it: only that window hears its
  events or may send it input, and its prototypes close when it closes, loads
  another page, or its renderer exits. An open still waiting on the page when
  that happens is dropped and its page request cancelled.
- **The page.** The main process asks the host for the ticketed design page
  itself and hands the prototype host the page with its content type and
  policy. The host serves it once, under an `octant-prototype:` scheme of its
  session, to an offscreen window sandboxed and context-isolated with no Node.
  Nothing else is served, so the page needs no route to the host's loopback
  address and the host API is unreachable from it.
- **Drawing and input.** The host paints the page offscreen, at twice its
  pixels on a Retina display, and sends each changed rectangle, one frame at a
  time: the next goes only once the window says it drew the last, and paints
  meanwhile fold into one changed rectangle of the latest. Each prototype may
  send 128 MB of pixels a second; a larger frame goes, and the next waits until
  it is paid back. The renderer
  paints it on a canvas the same size, scale, and placement as a frame, so
  expanded and in-thread placements, sizing to content, and redraw without
  restart are unchanged. The renderer forwards pointer, wheel, and key events
  in the page's own pixels, copy, cut, paste, select all, undo, and redo as
  edit commands, and the page's cursor back. The main process checks each
  input's shape before the host plays it back. Text typed through an input
  method's composition, and assistive technology reading inside the page, do
  not reach it: the page is a picture to the window.
- **The bridge.** The page's preload forwards its bridge messages, cut to type,
  height, and message text, to the host, which passes on at most 251 a second
  (one past the renderer's flood limit, so the renderer still sees a flood) as
  events of that prototype. The host runs only the six edit commands by name. The renderer applies the same channel, type, bounds,
  heartbeat, and flood checks, and also stops a prototype whose page goes away.
  There is no window or origin to check because the page has no parent frame to
  post to.
- **What the page may do.** The host refuses new windows, every navigation and
  redirect, non-proxied UDP, and every permission. The renderer reads
  Command-Escape (Control-Escape elsewhere) before anything is forwarded and
  moves focus to the prototype's Stop; the main process also refuses to forward
  it. The page never holds the window's focus, so it cannot take the keyboard
  back.

The app window still gives each sandboxed document its own process
(`IsolateSandboxedIframes`, per-document grouping), because Electron 43 grouped
one site's sandboxed frames into one process, so a page spinning in a loop held
the next frame.

The containment probe (`bun run smoke:canvas-prototype-containment`) holds this:
a hostile page in the prototype host reaches no UDP, TCP, HTTP, or host
listener and asks the resolver for none of its names (`dns-prefetch` and
`preconnect` links, STUN and TURN servers named by host name), while the same
page in a frame of the app's own process does look them up.

## Verification

- Block policies and layouts: `packages/domain/src/canvas*.ts` and their tests
  (for example `canvasPolicy.test.ts`, `canvasDiagramLayout.test.ts`,
  `canvasMathPolicy.test.ts`, `canvasRecipeStarter.test.ts`).
- Service, revision routes, and comments: `apps/server/src/canvas/canvasService.test.ts`.
- Preview: `apps/server/src/canvas/canvasPreviewService.test.ts`,
  `canvasPreviewWarnings.test.ts`, and `canvasPreviewBrowser.smoke.ts`.
