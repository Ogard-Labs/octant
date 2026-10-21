# Canvas visuals

This is the current specification for how a Canvas draws data, mockups, and
designs. [DESIGN.md](../../DESIGN.md#data-visualisation) owns the shared visual
language these blocks speak (palette roles, type, surfaces, focus), and
[Workspace](workspace.md#tool-lifecycles) owns where a Canvas opens and how it
behaves in a thread. Update this specification with an approved change,
following the [design workflow](README.md#changing-the-design).

## Data visualisation

Charts, metric blocks, tables, and timelines are one visual system, so a Canvas
reads as one document whatever kinds it mixes. These rules own the mark, the
ink, and the reading; a later block (treemap, heatmap, bar list, comparison
matrix) builds on them
rather than inventing a second chart language.

**Hue is for marks only.** Data colour appears on the mark — a bar, a line, a
slice, a scale cell — never on the chrome. The Default style keeps its
monochrome chrome, and a chart in the default theme still draws its series in
the palette hues, because the series are the data. Every mark pairs its hue
with a second channel: a dash pattern on a line, a label in the legend, a value
in the disclosed table. Colour alone never carries a distinction, and under
forced colours the marks fall to system colours while the dash pattern and the
labels keep them apart.

**Categorical series order.** Six hues, assigned in a fixed order so a series
keeps the same colour across charts and legends: brass, teal, rose, violet,
green, blue (`--oct-series-1..6`, each pinned per mode). A seventh series
restarts the order, and the legend, the dash pattern, and the data table keep
them apart. A series label is drawn in `--oct-fg-2`, never in the series hue: a
12px label needs text contrast the mark's hue does not carry.

**Scales.** Ordered data — a heatmap cell, a bar list's length — uses one of two
scales, exposed as theme roles and derived from the palette
(`packages/theme/src/chartScales.ts`):

- `--octant-chart-sequential-1..5`, one hue from low to high, the teal family.
- `--octant-chart-diverging-1..5`, the red family through a neutral midpoint to
  the blue family: 1 the strongest negative, 3 the neutral, 5 the strongest
  positive.

Every step clears 3:1 against the workspace in light and dark, so a scale cell
reads on the surface it sits on. A custom theme inherits both scales or
overrides any step through a semantic override.

**Marks.** One set of specs (`packages/theme/src/chartMarks.ts`) is shared by the
on-screen renderer and the static SVG export:

- Bars: a 2px top corner, a 2px gap between bars in one category; bars touch
  only when a distribution's density is the subject.
- Lines: a 2px stroke with round caps and joins.
- Dots: a 3px radius, on a scatter point and on each line vertex.

**Axis and grid ink.** The axis is `--oct-chart-axis`, a hairline that reads as
a rule. The grid behind a cartesian chart is `--oct-chart-grid`, deliberately
fainter than `--oct-border-soft`: it repeats four times inside one small frame
and at border weight it reads as a table. The grid is a backdrop, never a frame;
gridlines stop short of the plot edges.

**Reading numbers.** One formatter (`formatCanvasNumber`) reads every number a
Canvas shows, in the renderer and in the static export. A chart, a metric block,
and a table column may name an optional `format`: `number` (the default, locale
grouping — 1,234,567), `compact` (1.36M), `percent` (a ratio where 1 is 100%),
`bytes` (base-1024 — 1.5 KB), and `duration` (seconds — 1h 2m 5s). Numbers use
tabular numerals so a column of readings aligns. A label longer than its slot
truncates with an ellipsis rather than wrapping or shrinking.

**One tooltip.** Every chart mark has one hover and focus tooltip that names the
series and its formatted value. It is placed from the mark's own plotted
coordinates, offset above (or below near the top), so it never covers the
pointer, and it follows keyboard focus as well as the pointer. It has no
entrance motion.

**Path labels.** A file label is read from the right: the directory is dimmed and
the file name is at full ink, in the code font.

**Treemap.** A hierarchy is drawn as squarified rectangles
(`packages/domain/src/canvasTreemapLayout.ts`): each leaf's area is a size
measure and its colour is a colour measure, and a group's reading is the sum of
its children, so the picture never states a total the leaves do not. The screen
renderer and the static SVG export draw the same deterministic layout. The size
and colour measures are switches in the block header; those switches, and a zoom
into a group (by click, breadcrumb, Escape, or right-click; arrow keys move
between cells and Enter zooms in), are view state and revise nothing. A colour
scale is sequential, diverging (centred on the mid-point of the colour domain),
or categorical by top-level group, and reads through the shared scale roles.
Cell labels are drawn only where they fit, and the disclosed table is the
accessible reading, sortable by each measure.

**Heatmap.** A grid is coloured by value
(`packages/domain/src/canvasHeatmapLayout.ts`). A `matrix` names its rows and
columns and carries a cell per coordinate with a value and an optional short
note; a `calendar` carries one reading per date and lays the days out on a week
grid whose first day comes from the locale, drawn at its own size and scaled
down only to fit a narrower Canvas. A matrix row label longer than its gutter
is shortened with an ellipsis; the table carries it in full. Both read a value through one of the
same two scale roles — sequential or diverging — with a legend that shows a
scale bar and its bounds. A coordinate the block does not list is drawn as an
empty dashed cell, apart from a zero reading. The screen renderer and the static
SVG export draw the same deterministic layout. A matrix's rows can be sorted by
their total and the cells can be walked with the arrow keys; these are view
state and revise nothing. The disclosed table is the accessible reading, and it
shows a missing coordinate as an empty cell rather than a zero.

**Bar list.** A ranking of magnitudes — the "hottest files" or "slowest tests"
panel (`packages/domain/src/canvasBarListLayout.ts`). Each row is a label, a
value, an optional second value, and an optional manifest source. Rows sort
largest first by default and a reader can flip the ranking to smallest first; a
tie keeps the author's order. The list shows a top N with Show all up to the row
budget, and both the order and the number shown are view state. A bar's length is its share of the largest value — the reading is
the length, so bars use the neutral ink, or the sequential scale when the
magnitude is the subject; a value is never negative. A label that reads as a
path uses the shared path style: the directory is dimmed and the file name keeps
full ink in the code font. A row that names a manifest source offers Open file
through the allowlisted open-source action, which the host reauthorizes. The
screen renderer, the static SVG export, and the Markdown and HTML export rank
the same list. The disclosed
table is the accessible reading of every row, including the rows Show all holds
back.

**Comparison matrix.** Options across the top, criteria down the side, and a
weighted score under each option (`packages/domain/src/canvasComparisonMatrix.ts`).
It is a native table on its own card. The card's ground is opaque, so the
criteria column stays pinned while the options scroll beneath it at phone width.
The region scrolls inside itself and takes keyboard focus. A cell reads as a
score, a short text, or a yes, partial, or no glyph. The glyphs differ in shape
(a filled check, a half disc, an empty ring with a dash) and are always written
beside the word, so colour never carries the reading. A score and each weighted
score draw a neutral-ink meter of their share of the criterion. A
lower-is-better criterion is turned round first, so a longer meter always reads
better. The highest score is set in strong ink and marked Highest. A full tie
marks none. The recommended option is the author's call, not the arithmetic's.
Its column is tinted with the foreground, ruled along the top, and badged with
an inverted Recommended pill, so emphasis is ink in the monochrome default. An
empty coordinate reads as not assessed, never as a zero or a no. Cell notes are
numbered in reading order and listed under the table. Ordering the options by
score is view state. The disclosed table reads one row per option. Under forced
colours the column keeps a system-ink rule, the badge an outline, and the meters
a framed track.

**Math.** A formula is typeset by KaTeX in the reading ink, never in a colour
of its own: fraction rules, radicals, and delimiters all take the current
colour, so a formula follows the theme, dark mode, and forced colours, and the
source may not pick a colour. A display formula sits on its own line inside a
focusable region that scrolls sideways, so a long line never widens the page at
phone width, with its caption centred beneath in secondary ink. An inline
formula sits in the prose line at the prose size. The drawn glyphs are hidden
from assistive technology and MathML carries the reading. **View source**
discloses the source as plain monospace text. A formula KaTeX refuses shows its
source in a dashed frame with "This formula could not be drawn." rather than
KaTeX's red error text. Under forced colours the formula is CanvasText and the
refused frame keeps a system-ink border.

**Metric tiles.** Consecutive metric blocks are gathered into one responsive
row of two to four tiles, and a metric's value is set large in tabular numerals
so a row of numbers aligns. A metric may name how its value reads (`format`), a
unit, a `delta`, and a `goodDirection` of `up`, `down`, or `neutral` so a
delta's tone is never guessed: a direction that agrees with the change reads in
`--oct-success`, one that disagrees in `--oct-danger`, and an absent or
`neutral` direction keeps the neutral ink so the arrow and the signed value
carry the reading. It may also carry a `sparkline` of at most 256 recent
readings, drawn as a glance with no axis, and a short `caption`. The value, the
delta, and the caption are the accessible numbers; the sparkline is decorative.

**KPI dashboards.** A `dashboard` block lays the document's own metric,
progress, status, chart, and table blocks on a grid. It names each placed block
by id, so a block keeps one definition and its comments, and the grid is drawn
where the dashboard sits with the placed blocks drawn there instead of at their
own positions. The dashboard is a region named by its title, set in
`--oct-text-base` at the strong weight. A metric keeps its own tile; every other
cell takes the same face (a faint ring at `--oct-radius-sm` and
`--oct-space-3` padding), so the grid reads as one surface of tiles, and a
cell's comment marker sits in its corner rather than past its edge. A one-line
status or progress keeps its own height beside a taller chart instead of
stretching into an empty panel. The grid answers its own width rather than the
window's, because a Canvas in a dock column sits in a wide window: below 36rem
it is one column (the dock and a phone), below 52rem at most two, and from 52rem
the declared columns (one to four, four by default) and spans. A tile takes one
column and a chart or table two unless the author names a span. Cells never
leave the order the author listed, so the single column and keyboard focus both
read in that order. Every placed chart keeps its disclosed data table. Under
forced colours each cell keeps a CanvasText edge.

**Tabs and columns.** A long Canvas arranges its blocks with `tabs` and
`columns`, which hold blocks of the same document. Tabs use the
shared surface tab strip (`.surface-tabs`): plain labels over a hairline, the
selected tab in the foreground ink with a 2px underline, wrapping onto a second
row rather than scrolling sideways. The strip is a `tablist`; the arrow keys,
Home, and End move between tabs and Enter or Space opens one. The open tab is
the reader's view state, so it is never written to the document and a shared or
exported copy reads every tab in order. Columns are two to four equal tracks
separated by the ordinary block gap, with no rule of their own; they fold to one
track when the Canvas itself is narrower than the tracks need (a container
query on the Canvas, not the window), so a sidebar Canvas on a wide display
still reads as one column. Metric tiles inside a tab or a track gather into a
tile row as they do in the document. A tab or a track may hold a KPI dashboard,
drawn exactly as it is at the top level; a dashboard never holds tabs or
columns, so nesting stops at tabs or columns, then a dashboard, then its tiles,
and a block is placed in only one tab, track, or cell. Under forced colours only
the open tab keeps an underline, in `Highlight`, so the selection never rests on
hue.

**Diagram marks.** A board's shapes say what a step is, not its colour: a
process is a square-cornered box, a decision a diamond, a terminator a pill,
and a node without a role the plain rounded box. The three shaped roles carry a
slightly heavier rule in the secondary ink; every node keeps the surface fill
and the foreground label. An edge is a 1.5px line in the axis ink; an `arrow`
ends in a filled head, and a `dashed` edge is a 6/4 dashed arrow for an
optional or asynchronous step, so the dash, not a hue, carries that. An edge or
a group may take a tone, which is a theme role (`--oct-accent`,
`--oct-success`, `--oct-warn`, `--oct-danger`, or the foreground for neutral),
never an authored colour: a toned edge and its head take the role's ink, and a
toned group is a region, a 9% wash of the role inside a solid 55% edge, with its
name in the secondary ink. Each tone sits beside a label that says what it
means. Groups never overlap, and an edge that would cross a box steps out
beside the column. Under forced colours every node is Canvas with a CanvasText
rule, edges and heads are CanvasText, and dashes and shapes keep the
distinctions.

**Gantt.** A plan's Gantt view is bars on days in a horizontally scrolling
frame: a 200px title gutter, week ticks (four-week ticks, or a multiple of four
weeks, on a long plan, so ticks stay a label apart) in hairline ink, and 16px
bars with a 3px corner. The track stops widening at 4096px, past which days
narrow below 2px and a bar keeps at least 2px. Days are calendar dates, named
in UTC so no reader's time zone moves them. A bar takes the plan's status
tones — to do is a faint foreground wash, doing the accent, blocked danger, and
done success — and its status is also written after the title, so the tone is
never the only channel. Dependency arrows are elbows in the axis ink. Tasks
without dates are listed under the chart as ordinary task rows. Under forced
colours bars are CanvasText, a to-do bar is outlined, and arrows are CanvasText.

**Tables.** A table is columns of a declared type and rows in the order the
author wrote. A column may name a `format` and a `display` of `text` (the plain
reading, the default), `bar` (an in-cell bar whose length is the value's share
of the column's largest reading), `heat` (a tint on the shared sequential
scale), or `status` (the value drawn as a badge). The value is always drawn with
the mark, never instead of it, so a bar and a tint are scan aids: under forced
colours they fall to system ink and the plain value remains the reading. A text
column whose values read as a path uses the shared path style, and a number
column is right-aligned in tabular numerals. Sorting (each sorted header
announces its direction with `aria-sort`; hiding the sorted column drops the
sort), a text filter, hidden and pinned columns, and grouping are view state
and revise nothing, so the exported and static forms keep the order the author
wrote; a table stores no default grouping, because which column to group by is
the reader's question rather than part of the data. **Group rows** groups by any
column's value: each group is its own row group whose header row is a
`rowgroup` header holding a disclosure button (`aria-expanded`), the value, and
its row count, optionally followed by a **Group summary** — the count, sum, or
average of a number column's filled cells, where an empty cell is not a zero.
Groups read in the grouped column's order (empty last) and follow its direction
when it is also the sort; the sort orders rows within each group, and the
filter applies first, so a count is what the reader can see and a group the
filter empties is gone. A collapsed group that holds open row threads shows
their count in its header. **Pin** in the Columns list moves a column to the
leading edge, after the comment gutter and in the author's order among pinned
columns, and keeps it there while the table scrolls sideways; pinned cells take
the gutter's warm surface and a hairline marks the last pinned edge, which
forced colours draw as a system-ink border. The header sticks through a scrolling table. Where comments
are available, a row the author gave an `id` carries a comment marker in a
leading gutter pinned to the left edge, so it stays in view while a wide table
scrolls sideways; the gutter takes the header's warm surface so the scrolled
columns never show through it. Like a
block's marker it shows on row hover or keyboard focus, and always with its
count once the row holds an open thread. A row without an id has an empty
gutter cell, and a table with no ids draws no gutter.

**Motion.** A chart transitions only on a state change — a legend toggle, a zoom
— never on entrance. A transition lasts at most 200ms and is off under
`prefers-reduced-motion: reduce` and when the workspace sets
`data-octant-reduced-motion="true"`.

**Funnel, radar, and sankey.** These draw at the figure's measured width in the
same system. A funnel centres each stage as a bar whose width is its share of
the first stage, with a faint neck of the stage hue between neighbours; the
stage name sits at the left in `--oct-fg-2` and the value with its share of the
first stage at the right, the share in `--oct-meta`. A funnel is one series and
draws no legend. A radar draws rings at round values from zero and a spoke per
axis in the grid ink, each series as an outline in its hue and dash over a 14%
wash, with a vertex dot per axis; focusing a vertex lists every visible series at
that axis in the one tooltip, and the legend toggles series. A sankey draws its
nodes as 10px columns and each flow as a translucent band in the hue of the node
it leaves, so a source can be followed to its endings; a hovered band, or every
band through a hovered node, darkens. Node names read into the gap beside their
column in text ink, and where two columns face across one gap they share it; a
node's total joins its name only where both fit. A crowded column closes its
gaps and the picture grows taller rather than squeezing a node below 4px, and a
chain with more columns than the figure holds at 56px apart draws wider and
scrolls sideways. The legend toggles nodes.
Under forced colours the washes fall away: radar areas and funnel necks become
outlines, and sankey bands become system-ink outlines told apart by their dash.

**Empty and error states.** A chart with no series, a table with no rows, and a
timeline with no items keep their block's height and say so in `--oct-muted` text
rather than collapsing, so a document does not jump as data arrives. A block that
cannot be drawn fails closed to its plain reading and its disclosed data table;
it never shows a broken mark.

## Mockups and designs

A mockup is a
screen drawn from a closed catalog in a desktop, browser, tablet, phone, dock
panel, or custom-size frame — window, header, sidebar, navigation, stack, row,
grid, card, tabs, list, list row, heading, text, form field, select, button,
toggle, checkbox, badge, avatar, icon, image placeholder, table, modal, and
toast — and those controls are inert. The wireframe fidelity uses neutral ink,
hairline, and surface, never a hue; a tone is drawn as emphasis (a filled or
heavier outline). The styled fidelity draws the same tree with the active
theme's accent, status roles, and surfaces, so it follows light, dark, and an
imported theme. Variants sit side by side and wrap below 260px each. Numbered
callouts are ink marks on their node with the notes listed under the frame. In
forced colours every hairline is the system frame and a filled mark is system
text. A design is the author's own screens or slides: Octant draws
only the frame around them (a hairline, the surface behind, and a numbered
caption) and never restyles what is inside. On the board each frame is as wide
as its size allows (440px for a slide or desktop screen) and never wider than
the column, so a deck in a narrow side panel is not clipped; the box keeps the
page's aspect ratio from the first paint, and the page inside is scaled once
the board is measured. A frame's page loads only when the frame, or the frame
beside it, has come into view, and stays loaded after; a long deck therefore
opens as fast as a short one. Its player is a near-full-window dialog that
scales the screen to fit with the stage padding around it; a deck keeps the
current slide and its two neighbours loaded, the neighbours hidden, so a step
shows a page already drawn. A
design of `document` size is read in place instead: no caption, no player, the
full width of the Canvas column, and exactly as tall as its page, so it never
scrolls inside itself below a 12,000px cap.

## Design frame kit

A design drawn in the workspace theme (the default for a `document`, opt-in
for a device size) is part of Octant, not a picture of something else. Its
page receives, ahead of the author's own stylesheet:

- the semantic `--oct-*` tokens as the workspace computes them — ground,
  surface, ink ladder, borders, accent, status foregrounds and tints, chart
  series, the type scale, leading, weights, tracking, spacing, and radii — so
  the active theme, Vivid, increased contrast, and the interface font size all
  carry in, and the page redraws when any of them changes;
- the workspace's light or dark scheme; a document is transparent on the
  Canvas surface, a themed screen paints `--oct-bg`;
- Geist and Geist Mono, which the host installs into the page;
- the frame kit, a first-party stylesheet that uses only those tokens and
  system colours.

The kit's classes carry the `oct-` prefix: `oct-article` (a 72ch reading
column with the heading ladder, lists, quotes, rules, and captions),
`oct-eyebrow`, `oct-lede`, `oct-muted`, `oct-grid`, `oct-card` with
`oct-card__title`, `oct-metrics` of `oct-metric` tiles (`__label`, `__value`,
`__delta--good` or `--bad`), `oct-badge` with an `--accent`, `--success`,
`--warn`, or `--danger` tone, `oct-callout` with a `--success`, `--warn`, or
`--danger` edge, `oct-table` inside `oct-table-wrap`, `oct-code`, and
`oct-tabs`. Tabs are radio inputs, each followed by its label, then one
`div.oct-tab-panel` per tab in the same order, at most eight tabs to a group;
the checked radio shows its panel, so tabs switch without script. Under forced colours a badge keeps a
system border and the chosen tab a `Highlight` underline. The kit never sets a
colour of its own, so a page written only with it matches the workspace in
every theme.

## Verification

- Marks, scales, and number reading: `packages/theme/src/chartMarks.test.ts`,
  `packages/theme/src/chartScales.test.ts`, and
  `packages/domain/src/canvasNumberFormat.test.ts`.
- Deterministic layouts shared by the renderer and the static export: the
  treemap, heatmap, bar-list, and comparison-matrix tests and snapshots beside
  their layouts in `packages/domain/src/`.
- Palette and context-tone contracts: `apps/web/src/theme/visualLanguageContract.test.ts`.
- Frame kit: `packages/domain/src/canvasDesignFrameKit.ts`.
- Render changed blocks in light, dark, forced colours, and at phone width. A
  documentation-only move is not evidence of fresh rendered QA.
