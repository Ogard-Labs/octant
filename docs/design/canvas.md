# Canvas

This topic specification owns the Canvas agent tool's `describe`, `read`, and
`preview` operations, document recipes, thread presentation, the closed block catalogue,
diagram boards and comments, the `design` block, and a person's HTML import.
Architecture owns the
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
runs, one finished example of each frame tier. The same guidance lays a
slide out in fixed pixels at its 1920x1080 size, never in `vh` or `vw`
(a slide is drawn in that viewport and scaled as a picture, so a viewport
unit tracks whatever draws it; the deck example once used `100vh`), with body
text at or above 32px, titles of 64 to 96px, one idea per slide, and the same
header and footer on every slide; it gives a website or landing page a
desktop size and the page's real sections in order; and it draws a UI kit's
component sheet as a document in the kit's own palette with each control in
every state. The `diagram` guidance lays a system diagram out by tier (one
group per tier, flow left to right, short node labels, the protocol on each
edge). Unscoped
describe also lists document recipes: an id, a title, when to use one, and a
skeleton of block kinds that already exist, where a `design` slot may name
the `size` it is drawn at. The
host offers an implementation plan, a memo (a one-page report from typed
blocks alone: summary, facts, detail, and the ask), a design spec, an
architecture review (its options in a comparison matrix), a code review, an
audit or test report, a postmortem, a research brief, a dashboard, a
repository map, a design prototype (screens, a website, or a landing page at a
device size), a slide deck, a data model, an architecture diagram (the parts
grouped by tier as a diagram, the main flow as a sequence, and a key-decisions
table), an article (one themed document), a
product or game design brief (a themed pitch, then typed blocks in tabs), a
design system (a themed document and a token table), a UI kit (a token table
and a component sheet in the kit's own palette with every state), and a
clickable prototype (a design that runs), and an app flow (typed screens and
the flow that connects them). Together they cover the deliverables
people ask an assistant for most: a web page, a one-page document, a deck, a
dashboard, a system diagram, and a prototype or small app. A trusted, enabled, unscoped skill
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

Every Chat thread is offered `octant_canvas`, as people expect of an
assistant that makes documents. A Chat thread in a Chat Project writes into
that Project, through the window's active Chat Project as before. A Chat
thread in no Chat Project owns its Canvas itself: the Canvas's provenance
names the thread and no Project (`projectId: null`, Canvas schema version 20,
so an older runtime refuses it as a future version rather than reading the
missing Project as corruption), its workspace scope is `chat-virtual` with no
Project, and the tool's description says it is bound to this Chat thread. The
host decides the owner from the thread alone and never reads the window's
Project for it; the create request names no Project, the window must have
none open, and the thread must be active and in no Chat Project, or the
create is refused `unavailable`. Such a Canvas carries exactly what a Chat
Project Canvas carries and no more: no file, shell, Git, or network
authority (`chat-implicit-authority` refuses any of them), a design that
names a Project file is refused, and a design's generated images resolve
only from the thread itself rather than from a Project's threads. A managed
child run in Chat mode or with no Project is still not offered the tool: a
child's Canvas appears in its parent thread's dock, and a Chat parent has no
workspace the host resolves for the run.

A thread-owned Canvas belongs to its thread for life, and the thread's data
rules decide it: it is listed in the thread's cards and dock wherever the
thread is, and a thread moved into a Chat Project keeps showing the
Canvases it owned, revisable by that thread's agent, while they never join
the Project's inventory or memory scope and are never re-homed (a Canvas's
provenance is immutable). It is reached only by its own thread's agent and
by a person's window in Chat, whatever Project that window shows, because
the thread itself has no Project authority to match; another thread's agent
cannot read it by id, since no Project makes it a neighbour's. A Clear of
the thread's outside-content mark leaves the Canvas's own recorded mark, as
for any Canvas. Deleting the thread takes the Canvas out of reach, and the
thread's purge erases it with the thread, as it erases every Canvas the
thread authored. A thread export carries it beside the Project's Canvases
the thread shows. It exports to the host's export folder, the one chosen for
everything without a Project of its own, so the export-folder view reports
scope `host` and refuses a `project` choice, and a host export carries it
whole with no Project named, its owner being the thread in its provenance
(the host-export Canvas record once required a Project, which left every
such Canvas out of the cut). It is never mirrored (the
mirror files artifacts by Project; the receipt says so and journals
`skipped`), never published to an artifact replica, absent from the
Project-grouped artifact library, and not shared (see [Shares](#shares)). A
Canvas tab that opens it names no Project and rests in the Chat layout
whatever Project the pane's context binds. The shell opens and restores that
tab under the rule the Canvas routes authorize by: the Canvas still belongs
to its thread, and the thread, read from the Canvas's own provenance, exists
and is not deleted or deleting; otherwise the pane shows the welcome surface,
because a tab restored past that rule opened to a refusal once the thread was
deleted but not yet purged.

The delivery rule also reaches the model as an instruction, not only as the
tool description. Every turn that offers `octant_canvas` (Work, Code, and
every Chat thread) carries one short, provider-neutral,
budgeted entry in its required context: deliver a document, report, memo,
plan, deck, dashboard, page, or prototype the person will keep or share as a
Canvas with `octant_canvas`, not as a file written with the runtime's own file
tools and not as a long reply, unless the person asks for a file or for plain
text. The entry grants no tools or authority, is attributed as Octant policy
like the Work artifact instruction, and is absent from every turn that does
not offer the tool. Work's artifact instruction defers to it: a document goes
in the task folder when the person asked for a file or no Canvas tool is
offered. The rule moved into required context because, in a live Work turn, a
runtime with its own file tools read the tool description and still wrote the
memo as a Markdown file, then pasted it into the reply after the write was
denied.

Canvas stays the default delivery everywhere. On a Claude Code account whose
person enabled **Claude artifacts** (off by default; see
[Providers and model endpoints](model-endpoints.md#claude-artifacts)), each
Work or Code thread may choose them instead, and only a thread that chose them
gets a different rule in that place for its turns outside Plan: write the
document as one `.html` or `.md` file in the working folder and publish it
with Claude's own `Artifact` tool, which puts it on the person's claude.ai
account. The rule keeps a Canvas as the answer when the person asks for one or
when the runtime leaves the tool out of its session, and `octant_canvas` stays
offered. The driver names its artifact tool through the provider-neutral
`nativeArtifactTool` seam and the turn starts its session with the thread's
`nativeArtifacts` choice, so the host chooses the rule without naming a
provider; every other thread, every other provider, Chat, and Plan keep the
Canvas rule. Naming the tool grants nothing: the driver's gate decides each
call (see [Architecture: security and authority](../architecture.md#security-and-authority)).

The choice is the thread's `documentDelivery`, absent until the person
decides. The first time a thread that may choose artifacts shows a Canvas, a
one-time offer sits beneath that first Canvas: "Use Claude artifacts for this
thread instead?", repeating that it turns on Claude Code's usage telemetry to
Anthropic for the thread's turns, with **Use Claude artifacts** and **Keep
Canvas**. Either answer is journaled, so the offer never returns. The thread's
composer menu (Work's task actions; Code's document control beside the access
picker) switches it either way at any time; turning artifacts on there asks
in a confirmation that repeats the warning. A change applies from the next
turn. A paired device may choose Canvas but not artifacts.

A published page appears in the thread under the turn's tool rows as a link
card that opens in the person's browser, beside the host's snapshot of the
file the person approved publishing, labelled as the published snapshot
(later edits on claude.ai are not reflected). An HTML snapshot is drawn
through the same importer and design policy as an
[imported HTML page](#html-import): a static design frame with no
network, and a page with script waits for Run, whose single-use page the host
builds from that thread's own journal under the window's read check (never
from what the request carries). A Markdown snapshot is read as Markdown. A running Work turn shows the link card at once and the
snapshot once the turn settles. A
file that is neither, too large, or unreadable keeps only the link card.
Octant never fetches, frames, or signs in to claude.ai, and the card and
snapshot stay visible when the settled toolchain folds.

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
`runsScript` at version 18, the `tabs` and `columns` layout groups,
diagram styles, and the plan's `gantt` view at version 19, and a Chat
Canvas owned by its thread (a chat provenance with no Project) at version
20, the design and diagram fields below at version 21, a chart's
`title`, `subtitle`, and point `note` and `emphasis` at version 22, and the
`flow` block at version 23, so a document that
declares an earlier version and carries one is refused as a declared future
version. Version 20 adds no block or field a share carries, so a share names a
block authored at 20 as 19 under share version 10. Version 21 adds the
following, all optional, so every version 20 document still decodes:

| Field                            | Where             | Limit                                                                                                                                                                                                                              |
| -------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notes`                          | each design frame | Non-empty plain text, at most 2,000 characters; shown as text, never as markup                                                                                                                                                     |
| `theme: "brand"` with `brand`    | design block      | At most 32 tokens named `color-*`, `font-*`, `radius-*`, or `space-*` (lowercase slug), each value at most 128 characters                                                                                                          |
| `source.kind: "browser-capture"` | design asset      | A `captureId`; allowed in Work and Code, refused in Chat like a Project file (`design-asset-refused`)                                                                                                                              |
| `icon`, `detail`                 | diagram node      | `icon` is one of `client`, `browser`, `mobile`, `server`, `service`, `database`, `cache`, `queue`, `storage`, `cdn`, `gateway`, `auth`, `function`, `external`, `user`, `analytics`; `detail` is non-empty, at most 120 characters |
| `parentGroupId`                  | diagram group     | A group of the same diagram, nested at most 3 levels                                                                                                                                                                               |

The domain policy refuses an unknown parent group
(`unknown-diagram-parent-group`), a cycle (`diagram-group-nesting-cycle`), and
nesting deeper than three levels (`diagram-group-depth-exceeded`). A brand is
chosen with `theme: "brand"`: either half without the other is refused, as is
a brand on a design that runs script, because a running design is its own page
and the reader's renderer writes no tokens into it (`design-brand-refused`,
`design-run-refused`). Each token must pass the frame token safety rule
(`designFrameTokenValueIsSafe`: no `;`, braces, angle brackets, backslash,
`url(`, `@import`, or `expression(`) and its kind's shape: a colour is a hex
value or an `rgb`, `hsl`, `oklch`, or `oklab` function, a font is a comma list
drawn from a closed list of system faces and generic families (a brand never
loads a font), and a radius or spacing step is a non-negative length in `px`,
`rem`, `em`, or `%`. A `brand` design is drawn from its own tokens: every
frame starts from a neutral light base for each `--oct-*` role the kit classes
read, then the brand's tokens, each written as `--brand-<name>` and onto the
roles it names (`color-primary` sets the accent roles and the first series
colour; `color-background`, `color-surface`, `color-text`, `color-muted`,
`color-border`, `color-on-primary`, `color-secondary`, `color-success`,
`color-warning`, `color-danger`, `font-body`, `font-mono`, and the `radius-*`
tokens set theirs; `font-heading` and `space-*` are `--brand-*` only), ahead of
the frame kit and the author's styles. It never reads the workspace theme, so
the Canvas, Present, Play, the share viewer, the public link, and an HTML
export draw it identically, always on a light scheme, and an export needs no
window's theme. `designBrandDeclarations` writes the tokens and repeats the
brand rule on every one, so a value that reached a renderer by another route
is left out rather than written. Present shows a frame's notes, and a diagram's icons, details, and nested
groups are drawn ([Canvas visuals](canvas-visuals.md)). A `browser-capture`
asset resolves under the owning thread's authority (see the design-asset rules
below).

A Project holds a **brand kit** of the same shape (`brandKit` on the Project
record, any Project type, including a Chat Project, which gains no folder or
shell authority from it). It is set with `change-project-brand-kit`, journaled
as `project.brand-kit-changed@1`, validated by the same rule as a design's
brand (`invalid-brand-kit`), and cleared by saving an empty kit; the Project
overview's **Brand kit** inspector edits it. When a thread's own Project has a
kit, Canvas `describe` returns it as `brandKit` and tells the agent to author
designs with `theme: "brand"` and those tokens copied unchanged; a thread with
no Project, or a Project without a kit, is told nothing. The kit is looked up
by the Project the host bound the thread to, never by a name the model gives,
and `describe` still reads no window state. The agent's design carries its own
copy of the tokens, so later edits to the kit change new designs, not ones
already made.

A share carries a brand (validated again before it leaves) and the diagram
fields, so share version 11 names blocks up to Canvas version 21 and a share
under version 10 that carries one is refused as a future version. Frame notes
are the presenter's, like speaker notes in a deck: a share, a public link, and
an export carry the slides and drop the notes, and what notes hold never blocks
a share because it never leaves. Present shows the current slide's notes in a
panel under the slide when the presenter turns on Notes (the `N` key does the
same); the choice is remembered for the browser session, starts off, and the
control is absent from a deck with no notes. Notes render as plain text. A
PDF notes page is not offered, as this host renders no PDF. A captured-page asset is not shared, as no
declared image is. The optional table column
`display` and the chart, table, and metric `format` fields are the one ungated
exception: they only change how a value is drawn, so they carry no schema
version, but the strict definition schema refuses an unknown field, so a
runtime rolled back past them refuses a document that uses them rather than
drawing it as plain text.
The pure `canvasInlineRefusal` policy admits an author's `inline` request for
visualizations and reading blocks at any length within the ordinary block
budget: every chart type, dashboards, tables, math, diagrams (a `diagram`
board included, drawn read-only), and a `design` of the `document` size,
including one that runs script. A document-size design is a page as wide as
the column, so an article, a spec, or an HTML page brought into a Canvas as a
document reads in the thread; a running one is drawn in the same sandboxed
frame, under the same page policy and bridge limits, as in the sidebar, and
waits for the person's **Run**. It refuses a request that holds a `plan`, a
`mockup`, or a device-size `design` (phone, tablet, desktop, or slide), which
are worked on or reviewed at their own size. When an author asks for `inline`
with such a block, the host records the request as asked, the Canvas is a
sidebar Canvas (`effectiveCanvasPresentation`, and the card and the tool result
say `sidebar`), the reason returns as `presentationNote`, and the thread shows
it as a preview card that opens it. A definition's `presentation` is therefore
the request, not the placement: every reader (the card projection, the agent's
result, `preview`, the dock offer, and the thread) places a Canvas by
`effectiveCanvasPresentation`, and only the preview-card choice reads the
recorded request. The agent is told to put a visualization
that answers the current question inline and to leave longer documents in the
sidebar. Recording the request rather than `sidebar` is what lets the thread
tell a refused inline request from a Canvas the author placed in the sidebar,
which stays a row; a host that predates this recorded `sidebar`, so such a
Canvas stays a row there. The refusal bounds only the author's unprompted request: a
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
`no-renderer`, `render-failed`, `provider-cannot-take-images`) beside one plain
sentence (`imageOmittedNote`) saying that no picture was taken, why, and that
the listed warnings are the whole reading. The code alone was not enough: shown
a bare `no-renderer`, a live model reported "no picture" in one turn and
described the picture it never saw in the next. A development host has the
page too: `bun run dev` and `octant web --dev` build it before the host starts,
again whenever the renderer's sources or the contracts, domain or theme
packages it bundles are newer, and point the host at
`apps/web/dist` through `OCTANT_WEB_DIST_PATH`, since a host run from source
does not find the web build on its own. `/health` reports `canvasPreviewPage`,
whether the host finds the page, so `octant web --dev` attaching to a host left
running without the web build warns that it must be restarted. A `design` is markup, so how its frames read
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
journal a version; a board pans and zooms but its nodes do not move, and a
running design's bridge can only resize its frame, report an error, or keep it
alive, as in the sidebar. A sidebar Canvas whose definition records an inline
request is a preview card: its live miniature, inert, drawn across the column
above its title, and the whole card opens it. Any other is a row that opens it.
Sizing in the column is in [Canvas visuals](canvas-visuals.md#data-visualisation).
A card from an older host,
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
From Canvas schema version 22 any chart may carry a `title` (the finding, as a
sentence) and a `subtitle` (what was measured and over which span), each at
most 160 characters. On a line, area, scatter, bar, or distribution chart a
point may also carry a `note` of at most 40 characters, drawn as a callout
beside it, and `emphasis: true` on the reading the chart is about; a chart
holds at most 12 notes. Other chart types refuse both, since a slice, stage,
axis spoke, or stacked segment has no single point to label.
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

## Flow blocks

A `flow` block (Canvas schema version 23) composes screens the document already
holds into one board: it holds the graph alone — the screens it names keep
their single definitions — so a revision to a mockup or a design shows on every
flow that places it. Each of its at most 24 `screens` places one block at a
`screenId` the document holds: a mockup, at one `variantId` it declares
(absent is its single frame, required when it declares variants), or one
`frameId` of a design that runs no script; a design screen names exactly one
frame, and a running design is refused, because a running frame is the
prototype tier and keeps its own Play. Up to 96 `edges` carry `fromScreenId`,
`toScreenId`, an optional label of at most 80 characters, an optional tone
(the diagram tones), and optionally `fromNodeId`: the hotspot the person taps,
a node of the from-screen's mockup from the closed interactive list (button,
list-row, nav, tabs, select, checkbox, toggle), so a link is data the
renderer can draw without a script; an edge from a design screen carries no
hotspot, and an inert mockup part is refused (`flow-hotspot-refused`). The
domain policy names each refusal (`dangling-flow-screen`,
`flow-screen-kind-refused`, `flow-screen-variant-missing`,
`flow-screen-frame-missing`, `flow-screen-design-refused`,
`duplicate-flow-screen`, `duplicate-flow-edge`, `dangling-flow-edge`,
`flow-edge-self`, and the screens and edges budgets). A placed block is
placed once, exactly as a dashboard places its cells: a screen is never also
a dashboard cell or a tab child (`block-placed-twice` names both placers).

The board is the diagram board's model with screens instead of boxes: the
pure `layoutCanvasFlow` (`packages/domain/src/canvasFlowLayout.ts`) ranks
screens by their transitions (a breadth-first walk from screens with no
incoming edge, so a screen sits one step past the first screen that reaches
it, and a loop the walk cannot settle draws across columns with its closing
edge routed backward, below the screens), draws each screen as wide as its
declared device allows — the same caps the design board uses — and keeps
every screen's aspect from its intrinsic size, so the layout needs no measured
value and the board, the artifact SVG, and the exports draw the same picture.
A person's drag or keyboard nudge on a screen journals a new version through
the same `/api/canvas/layout-revise` path as a diagram drag, admitted by the
same policy, whose target is any board — a diagram's nodes or a flow's
screens — and which marks the flow `layout: "manual"` with the screen's
`x`, `y`, `positioned`. The route is host-window only; a paired browser reads
the board but does not move screens. Comments anchor to a flow's screens and
edges through the existing node and edge anchors, so a comment on a screen
stays on it through a revision and reads as no longer on the canvas when the
screen is gone. `preview` warns about a `flow-unreachable-screen`: a screen
no transition reaches and not the flow's first, computed from the document,
so the warning returns whether or not a browser drew the picture. Design
screens on the board are drawn frames, so the design-frame overflow and
contrast warnings reach them through the same bridge.

The board offers **Play**: a dialog in the design player's anatomy that walks
the flow. Each screen draws at its intrinsic size, scaled to the stage; a
mockup's hotspot nodes — the interactive components its edges name — are the
one live thing in the drawing, real buttons that navigate to their target,
and every other control stays inert; a transition without a hotspot, and
every edge leaving a design screen, waits in a Go to list under the stage,
so no transition is left without a place to tap. Back steps the path taken,
Restart returns to the first screen, and Esc leaves. Where the person is in
the flow is view state alone: Play journals nothing and grants nothing, and
it is typed link data the renderer walks (D-2 of the plan doc), so no script,
ticketed page, or prototype host is involved. The share viewer and a public
link draw the board read-only: Play stays in the app.

The Markdown export writes the flow as its graph — the title, one
line per screen, then each transition with its hotspot — and the artifact SVG
thumbnail draws the layout scaled into the band, so no markup travels in a
reading. The HTML export writes a flow as its **site**: one script-free,
self-contained section set inside the exported document whose screens move
by `:target` — the pattern a design's frames already ship inside one page —
with the hotspot nodes as real anchors to their targets, each mockup screen
rendered as semantic inert HTML by the pure `canvasMockupHtml` generator, each
design screen holding the same sandboxed frame page the export writes for a
design's frames, and the screen-level transitions in the link list. A share
carries the flow whole at share version 12, which names
blocks authored up to Canvas version 23; the flow holds references and typed
values, so no new markup acknowledgement exists. The `app-flow` recipe starts
from typed screens: a mockup slot and a flow slot that names them.

## Shares

A share names the Project it is taken from, and a reader's access is judged
against that Project, so a Canvas owned by a Chat thread outside every
Project is not shared: the share overview answers no authority for it, and a
share request is refused `scope-mismatch` with the reason. It stays in its
thread; export is how it leaves.

A public link carries the same blocks without host, Project, thread, or
source identity; its rules are in [Canvas public links](canvas-public-links.md).
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
view, so it names blocks up to version 19. Share version 10 carries a design's
frames and accompanies no Canvas version, and share version 11 carries the
version-21 design and diagram fields, so it names blocks up to version 21.
Version 22 adds only a chart's title, subtitle, and point callouts, which a
share still strips: a shared chart leaves as its readings and is named as
version 21. Share version 12 carries the flow block, so it names blocks up
to Canvas version 23 (`CANVAS_SHARE_MAX_BLOCK_SCHEMA_VERSION`), and the share
service must learn it before a desktop release publishes one.
Share documents version independently of Canvas documents: a treemap, a
heatmap, a bar list, a chart's or a table column's number format, a table
column's display, and a board's layout arrive with share version 3, and a
comparison matrix with share version 4, math with share version 5, the
mockup catalog with share version 6, the funnel, radar, and sankey charts
with share version 7 (whose blocks may name Canvas version 14), the dashboard
with share version 8, and tabs, columns, a diagram's edge styles and tones,
its group tones, and a plan's `gantt` view with share version 9, and a
design's frames with share version 10, and a brand and the richer diagram
fields with share version 11 (frame notes never leave), and the flow block
with share version 12, so a share
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

A Canvas diagram block is also a board, as a flow block is (see
[Flow blocks](#flow-blocks)). The renderer zooms, pans, and fits the
same deterministic layout every surface draws, and a user's drag or keyboard
nudge is journaled through `/api/canvas/layout-revise` as a new immutable
`canvas.version-appended@1` version with `actor: local-user` that the host
stamps itself, whatever actor the request names, admitted by the
pure `admitCanvasDiagramLayoutRevision` policy (the target must be a board —
a diagram's nodes or a flow's screens — every moved node must exist, the
sequence must be the head, budgets stand).
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
A person can send an open comment, with its replies, to the Canvas's owning
thread as a focused revision request (**Send to agent**, event
`canvas.comment-sent-to-agent@1`, command `canvas-comment-send-to-agent`). The
renderer queues one follow-up turn through the thread's message queue, so the
turn runs under that thread's own authority and no new authority exists; the
prompt names the Canvas, the anchor by block, node, edge, row or region id, and
the text, and asks for a change to that part alone with every other block kept
identical. A Chat thread also carries the Canvas as a context selection. The
action is absent when the Canvas has no thread the person can reach, when a
version older than the head is on screen, and while a request is already with
the agent. The host marks the comment sent only after the thread took the
turn, stamping the Canvas head it holds. The turn's request, message and
selection ids are derived from the comment and the send it replaces, so a
retry after the host refused the sent marker (a concurrent comment change) is
the same send: the queue answers it as a duplicate and no second turn runs.
The Canvas tool's read lists open requests as `requestedChanges` to the
Canvas's owning thread only (and its managed children), never to another
thread that can read the same Canvas, and a revise result carries a `warning`
when blocks outside every requested anchor changed; the warning does not refuse
the revision. A request stays open, and the warning stays on, across a
person's own edit made after the send and before the agent ran. A comment reads
"Addressed in vN" once an agent-authored version after the one it was sent
against exists; a person's own layout edit does not answer it, and only that
agent version closes the request in the tool as well. A send stays on this computer and is not carried by artifact sync.
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
as its content, and an optional `theme`: `workspace`, `none`, or (from version 21) `brand`, defaulting to
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
`generated-image` (a completed image job's attachment id), a `project-file`
(a path relative to the Work thread's folder or the Code thread's checkout),
or, from version 21, a `browser-capture` (the id of a screenshot the Browser
kept; see below),
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
revision, and a Code file the same way under the thread's checkout. A
`browser-capture` resolves only for a Work or Code Canvas, and only to a
capture the Canvas's own thread kept and its journal still retains
([Browser captures](browser-captures.md)): another thread's capture id, a
dropped capture, and any capture in Chat are not found or refused, and a
missing one draws the usual placeholder with the `design-asset-unavailable`
warning. The picture is the screenshot the capture already stores (the model
envelope, about 40 KiB), so the 3 MiB asset cap needs no change and the
capture size cap stays as it is. Website redesign is a document recipe
(`website-redesign`): the agent opens the page in the Browser, takes a
screenshot, declares the capture, shows it in a before frame, and draws the
after frame as HTML and CSS; it never fetches the site's images, styles, or
fonts into a frame. Bytes are
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
declared images: an asset names a Project file, an image job, or a browser capture, which resolve
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
the bridge is left out, since an exported page has no host to report to. Every
exported HTML document carries a policy of its own, first in its head, with
`default-src 'none'`, `connect-src 'none'`, and `frame-src 'none'`, so the file
loads nothing wherever it is opened: a frame's page forbids its script every request but not leaving, and
a prototype that set its own address loaded another page, which reached a
local listener; the document's policy refuses that navigation, and a `srcdoc`
frame, which is not one, still draws. A `srcdoc` page inherits the document's
policy, so the document admits inline script only when it draws a running
frame. Present and Play open a near-full-window dialog with a full-screen
toggle (`requestFullscreen` on the player; Esc leaves, and the arrow keys keep
moving slides). **PNG and PDF export** draw the same standalone pages in the host's
browser, under the preview's no-route switches and request interception. A
Canvas that holds device-size or slide designs is drawn one frame to a sheet at
the frame's own size: a PNG per frame, named `Title 1.png`, `Title 2.png` and so
on (padded to the count), or one PDF with a page per frame at that size. A PDF
holds each frame as a picture drawn at twice its size, because print mode drops
backgrounds inside frames and flattens blur and large shadows; text in design
frames is not selectable there. A
running design is drawn as a single sheet after the preview's settle wait. A
Canvas with no such frames is drawn as the thread draws it: one PNG (cut off at
a fixed height) or an A4 PDF the browser paginates. A set is placed like a
single file: the card names which files of the set are already there, approving
it replaces exactly those, and any other file already taken, including one that
appeared after the card, is numbered.
The Gist destination declares Markdown only, so it is never offered either
form. Pictures of design frames are as unreadable to the share filter as the
markup, so their card sets `drawsDesignFrames` for the person to acknowledge,
and a themed design needs the window's `frameTheme` as in HTML export.
The export approval card says when the document writes design markup
(`writesDesignMarkup`), so approving it is the person's acknowledgement that
markup leaves as written. In a destination export a declared image draws a
placeholder; the HTML file below writes in those that resolve for its reader. A design in
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
and it does not carry Octant's fonts; the tokens' own fallbacks apply.

**HTML file.** The Canvas surface's More menu offers **Save as HTML file** and
**Copy HTML**: the version on screen as one self-contained file a person can
open offline in any browser or paste into another tool. It is the HTML export's
document, drawn on the light scheme with Octant's own anatomy written into one
inline stylesheet (callouts with their tone edge, metric tiles in a row, a
progress bar, a status badge, tables that scroll in their own box), and every
picture inline as SVG from the layout the board draws: each chart type with its
axis, gridlines, series hues (the theme's palette roles) and legend; the
sequence, state, entity-relationship, swimlane, mind-map, and node-edge
diagrams; the treemap, heatmap, and bar list. The reading the Markdown form
writes follows each picture under a **Data** disclosure, so no value is only in
a picture. A destination's HTML export draws the same document under the
approval card's body limit (`CANVAS_EXPORT_BODY_MAX_BYTES`, 256 KiB). Pictures
make it larger than the reading a destination received before they were
drawn, so a Canvas that exported then must still export: when the drawn
document would pass the limit, each picture but the node-edge diagram (drawn
before the others) is written as its reading alone, unfolded, and each styled
block as its text. The stylesheet and no-load policy every HTML document now
carries add about 3 KB that this does not take back. Math is MathML, which needs no font. Design frames are written as in
the HTML export above, under the same sandbox and page policy; a running
prototype runs there and reaches nothing (the frame threat model, F11). The
file names only system and generic font families and loads nothing: the
document's policy refuses every load, and the only address outside it is a link
block's own `http(s)` link, which a reader follows by choice. `POST
/api/canvas/html-file` renders it under the window authorization `get` runs
(a paired device's Canvas read grant included) for the version the window
names, with the window's `frameTheme`. It names no destination, so it holds no
approval card, calls no plugin, journals nothing, and sends nothing anywhere: the
file goes back to the window that asked, which downloads it or writes it to the
clipboard. Text passes the same share filter as every export, so a host path,
a credential-shaped value, and a source's opaque reference are redacted, and no
host, Project, thread, Canvas, version, image, or source id is written. Each
design's declared images resolve under the version's provenance, as when the
reader draws the design, and are written in as `data:` images up to 4 MiB of
images for the whole file (`CANVAS_HTML_FILE_IMAGES_MAX_BYTES`, charged once per
reference); an image past that draws the labelled placeholder, the file says how
many were left out, and so does the result (`imagesLeftOut`). The whole file is
at most 7 MiB (`CANVAS_HTML_FILE_MAX_BYTES`) measured as the JSON string the
answer carries it in, where a newline, quote, backslash, or control character
takes two to six bytes, so the answer fits the 8 MiB a paired device is served;
past that it is refused as `too-large`.
The surface's status line says what happened, and when the file holds design
markup, that the markup is included as written. An image block names a source,
not bytes, and draws as its description, as on screen. The agent's
`octant_canvas` tool has no export operation, and this adds none.

A share refuses an action block, whose
command runs only on this host. That refusal, and any block or field the share
contract does not carry, are checked before the snapshot is journaled and
reach the owner as an `unsafe-payload` denial: the Canvas cannot be shared, not
a malformed request. A device-size design is always a sidebar Canvas for the
author's own request (a preview card in the thread); a `document` design, with
or without script, may be asked for `inline`. An authored
revision declares the current schema version on the version and its
definition, so a Canvas written under an earlier version moves forward and can
gain a design; a version append never moves a Canvas back. Agents writing
a design can be silent for minutes while composing the tool call, so Chat and Work
wait five minutes for a provider event before cutting a turn off, as Code does.
Chromium stops painting sandboxed frames that are `inert` or have
`pointer-events: none`, so a frame shown as a picture stays hit-testable and a
cover over it takes the pointer
([decisions/0164-canvas-designs-are-html-in-a-frame-that-runs-nothing.md](../decisions/0164-canvas-designs-are-html-in-a-frame-that-runs-nothing.md)).
A whole app window is a `desktop` design that runs script, and it is built in
steps. A frame and the shared stylesheet each hold up to 65,536 characters
(`CANVAS_MAX_DESIGN_MARKUP_LENGTH`, raised from 32,768): a finished window at
1440×900, with its sidebar, panes, tabs, and script in one frame, ran past the
old number, and 64 KiB holds one with room. The limits that keep a document sane
are unchanged: 24 frames, 128 blocks, 256 KiB of text across the whole Canvas
(so about three frames this large, or many smaller screens), and a 1 MiB
payload. Widening a limit needs no schema version: a reader that predates it
refuses the larger frame as invalid rather than drawing it wrongly. An agent
does not send the window in one call. `revise` takes `designEdits` instead of
`blocks`: for each named design block, a replacement `styles`, `frames` added
or replaced by `frameId`, and `removeFrameIds`. The host reads the current
version, requires `expectedSequence` to equal its sequence so a person's change
in between is not overwritten, marks the reading thread as a read does, applies
the edits, decodes the edited design whole, and revises with the full block list,
so every other block and frame is kept and the markup policy, budgets, and
authority are the ordinary revise path's. Describe's `design` guidance teaches
the order (shell first, then a frame per screen), the `app-redesign-prototype`
recipe names the shape, and the worked `app-window` example shows state without
a framework: one `state` object, one `render()` that writes it to the page and
sets CSS variables such as `--accent` on the root, and one delegated listener.
In the thread a running prototype is drawn at its design size, scaled to the
column; **Full screen** (where the browser offers it) takes the prototype and its
header, so **Stop** stays reachable, and scales it to the screen's height as well
as its width. Play for a static design has the same control. A lone static desktop
window takes the board's full width instead of the thumbnail width a row of
screens shares.

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

## HTML import

A person can bring a single HTML page they already have, such as a page an AI
assistant made for them, into a new Canvas. **Import HTML…** sits under the
Create Canvas form wherever a person can create a Canvas (today the Chat
thread's Canvas tools), and takes a file the person chooses or markup they
paste. It opens a new Canvas in the same thread and Project a create there
would, and nothing else: the page is the whole document, one `design` block.
The feature and its copy say "HTML page"; Octant reads no assistant's own
artifact format and copies no other product's identifiers.

- **Authority.** `POST /api/canvas/import-html` carries the scope a create
  carries (host, mode, workspace, origin thread, requested authority) and runs
  the create route's window context and Project check, then the create
  policy's request authorization, before the page is read. The server builds
  the create request itself (blank intent, no sources) and writes the Canvas
  through the same create path, so an import can reach no Project, thread, or
  mode a create could not. The remote gateway admits neither create nor import
  for a paired device; both stay local-window actions.
- **Bounds and refusals.** The page is at most 256 KiB of UTF-8
  (`CANVAS_HTML_IMPORT_MAX_BYTES`), checked on the host; a body past the
  route's 1 MiB read is answered as too large too. What survives the import
  must fit one design frame and one stylesheet (65,536 characters each).
  Anything else is a discriminated refusal, never a partial Canvas:
  `too-large`, `not-html` (no element at all, or binary content holding NUL),
  `unparseable` (a tag, attribute value, comment, or script, style, or title
  element that never ends), `empty` (nothing left to draw), and `unsupported`
  (the design policy still refuses what is left, with its reason). A create
  the window may not make is the create's own `denied` result.
- **Shape.** The pure `importCanvasHtmlPage` (domain) makes one
  `document`-size design with `theme: "none"`, so the page keeps its own look
  and is as wide as the Canvas and as tall as its content. Head and body
  `style` elements become the design's stylesheet (a `media` other than
  `all` or `screen` is kept as an `@media` block); the body's markup is the
  frame; inline script from the head goes first; the body's own attributes
  move to an element wrapping the page, and a body event handler such as
  `onload` becomes a listener on the window, which is what it listened to.
  Comments are dropped.
- **Tier.** The tier is read exactly as the design policy reads any design:
  a page that still holds an inline `<script>` or an event handler declares
  `runsScript` and is a running design, under the served page, `sandbox
allow-scripts`, page policy, bridge, prototype host, and Run rules above;
  every other page is a static frame. A page whose only script was a file
  is static once the file is taken out. No import chooses a looser tier, and
  the result is checked by `canvasDesignMarkupRefusal` and
  `canvasDesignStylesheetRefusal` before it is written, as an agent's design
  is.
- **No new egress.** A frame loads nothing and leaves nothing, so the import
  takes out what the page would fetch or where it would go, and the window
  lists each kind with its count and up to three examples (an address, a
  `rel`, or a setting name, shown as text): script files, stylesheets and
  `@import`s, images, fonts, and media that are not inline `data:` images
  (a CSS `url()` becomes `none`), links that are not a fragment (an empty,
  bare `#`, or `javascript:` link is removed without a report), embedded
  pages, form destinations (`action`, `formaction`, `ping`), page settings
  (`meta` other than charset and viewport, which the host writes itself,
  `base`, and `link` elements other than stylesheets), and SVG `set` and
  `animate`. Nothing is fetched on the page's behalf.
- **Outside content.** The page came from outside Octant. The Canvas's first
  version commits together with a `canvas.outside-content-carried@1` record
  naming the writer `imported-page:<versionId>`, which is never a thread, so
  every agent that later reads or previews the Canvas is marked under the
  harness's taint rules, the thread it was imported into included, and a
  person's Clear on that thread does not exempt it. A record that cannot be
  written refuses the import. The Canvas title is what the person typed or
  the file's name, never the page's `<title>`: the agent tool's `list` hands
  titles to an agent without reading the Canvas, so outside text stays in the
  design, whose title is the page's own.
- **Window.** The renderer reads the chosen file as text (and refuses one
  past the bound without sending it, as the host would), then shows the new
  Canvas's name, its tier (a running page says it starts on open in the
  sidebar or on **Run** in the thread), and what was taken out. The panel
  stays open on that summary; the thread lists the Canvas meanwhile.

Rationale: a separate "imported" tier, or a looser policy for a page the
person chose, was rejected because it would give outside markup more than an
agent's design gets; fetching the page's stylesheets or images at import was
rejected as new egress from the host on a page's behalf. The Canvas title rule
keeps an import from adding an unmarked channel to an agent's context.

## Verification

- Block policies and layouts: `packages/domain/src/canvas*.ts` and their tests
  (for example `canvasPolicy.test.ts`, `canvasDiagramLayout.test.ts`,
  `canvasMathPolicy.test.ts`, `canvasRecipeStarter.test.ts`).
- Service, revision routes, and comments: `apps/server/src/canvas/canvasService.test.ts`.
- A Chat thread's own Canvas: offered and bound in
  `apps/server/src/canvas/canvasAgentTools.test.ts`, created, listed,
  revised, and replayed in `canvasService.test.ts` and
  `canvasProjection.test.ts`, served and listed over the API in
  `apps/server/src/canvasRoutes.test.ts`, erased with its thread in
  `apps/server/src/threadRetentionService.test.ts`, and its tab restored in
  `apps/server/src/shellService.test.ts`.
- Preview: `apps/server/src/canvas/canvasPreviewService.test.ts`,
  `canvasPreviewWarnings.test.ts`, and `canvasPreviewBrowser.smoke.ts`.
- HTML import: the tier, what is taken out, and each refusal in
  `packages/domain/src/canvasHtmlImport.test.ts`; the route, its refusals,
  the create scope check, and a script-bearing page served only under the
  running page's sandbox in `apps/server/src/canvasRoutes.test.ts`; the
  outside-content record in `canvasOutsideContentMark.test.ts`; the paired
  device refusal in `apps/server/src/authenticatedProductRoutes.test.ts`; and
  the panel in `apps/web/src/canvas/CanvasCards.test.tsx`.

## Renderer loading

The shell validates a Canvas before rendering it. Its document and block
renderers load when a Canvas is first shown, with a local opening status while
that code loads; a thread without a shown Canvas does not load the block
renderers or math engine. Comment and version labels stay separate from
document rendering. This changes loading only, not Canvas authority or validation.
