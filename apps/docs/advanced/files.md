---
description: File authority by mode, secure read-only previews, artifact types, and structured selections.
---

# Files, Previews, and Selections

File access is server-enforced per mode. Opening a file never grants new
authority: if the mode or Project cannot read it, the host rejects the request
before reading any bytes.

## File authority by mode

- **Chat** sees only explicitly attached files and durable artifacts already
  in the Chat Project scope. There is no implicit filesystem access.
- **Work** sees files inside the one OS-confined Work Project root, plus
  its artifacts and evidence. It cannot silently become Code.
- **Code** sees files inside the exact repository checkout or worktree
  selected by the Code Project or thread, plus artifacts and evidence.

Every Work and Code thread belongs to one Project, so its first turn cannot
start until a Project is chosen. Octant never infers a root from a prompt or
working directory.

## Path safety

Path containment is enforced host-side after canonicalization and symlink
policy. Absolute paths and NUL bytes are rejected. Reads may follow a final
symlink only when the resolved target stays inside the checkout; writes,
renames, and deletes reject any symlink component. Hard-linked regular files
are readable, but mutation requires a link count of 1. Editable text must be
valid UTF-8 and at most 5 MiB; binary and larger files are read-only metadata
targets.

## Secure previews

Previews are read-only and cover source and plain text, Markdown, images,
PDF, CSV/TSV, Excel `.xlsx`, Word `.docx`, and PowerPoint `.pptx`. Previewing
never executes macros, document scripts, embedded executables, active PDF
content, or remote resources.

Text-like files offer **Preview** and **Raw** modes; writable source and text
files may offer **Edit in Monaco**, which opens the file as an editor tab
using the ordinary save and conflict policy.

Preview chrome shows file name, type, size, and freshness, provenance
(Project, repo, worktree, attachment, or artifact), search, zoom, **Attach
selection**, **Reveal in Finder**, **Open externally**, and **Close**, plus a
read-only indicator and fidelity notice. Previews are normal persistent
workspace surfaces and restore after a restart.

When a file cannot be rendered faithfully, the preview reports an honest
state: **Unsupported**, **Limited fidelity**, **Locked**, **Too large**,
**Stale**, **Unauthorized**, **Interrupted**, or **Failed**. Parser failures
never mutate the source.

## Structured selections

**Attach selection** creates bounded, source-versioned references — for
example, text plus a line range, a PDF page range, a worksheet and cell range,
a Word structural block, or a PowerPoint slide. Adding a selection to the
composer is a separate explicit action; the context planner re-checks
authority and never silently substitutes the whole file.

## Artifact types

Artifacts span Chat attachments, Work files and artifact versions, Code
repository files, test results, diagnostics, and Apple validation evidence.
They can originate from attachment cards, the Work file browser, artifact
entries, the Code file tree, test and diagnostic evidence, search results,
deep links, and recent items.

## Agent-authored documents and canvases

Agents receive usage instructions with the tools available to their current
task. In Chat, Work, and Code, and for a managed child run bound to its own
workspace, `octant_canvas` creates and revises structured
plans, designs, reports, reviews, diagrams, tables, and dashboards. A Chat thread
outside a Chat Project, and a managed child run in Chat mode, are not offered the
tool, because a Canvas there has no Project to belong to. When you ask
for something substantial, the agent builds it as a Canvas and replies with a
short pointer; brief answers stay in the conversation. A follow-up such as "add
a risks section" revises the existing Canvas: the read-only `list` operation
returns the thread's Canvases and `read` returns one's current blocks and
sequence. The tool's always-visible description stays short; its read-only
`describe` operation carries the detail. Without block kinds it explains the
three ways a Canvas carries work (typed blocks for data, a design frame for the
look, and a running design for a prototype you can try) and tells the agent to
use the simplest one that does the job. It then lists the
supported kinds and when to use the structured ones, the document recipes an agent should
start from, and a creation example. Asking to write a plan, review a pull
request, summarise research, write an article, pitch a product, show a design
system, or build a prototype you can try starts from the matching recipe. Requesting up
to three `blockKinds` returns their exact schemas from the host's block
contracts, plus how to author and worked examples for the kinds that carry
them (plain kinds such as `rich-text` return their schema alone):

```json
{ "operation": "describe", "blockKinds": ["rich-text", "diagram"] }
```

The agent supplies the actual document as validated blocks. A prompt alone is
only a provenance note. Revisions replace the block list and must name the
last observed version sequence; creation starts at sequence 1. JavaScript and
invented file or artifact references are not Canvas content, and HTML and CSS
appear only in a design's frames.

### Start a Canvas from a recipe

In a Chat thread, choose **Show canvas** from the **Thread actions** menu. Under
**Start from**, pick **Blank** or a recipe: an implementation plan, a design
spec, an architecture review, a code review, an audit or test report, a
postmortem, a research brief, a dashboard, an article, a design brief, a
design system, a clickable prototype, and the others the host offers,
including any an enabled skill adds. Each shows one line about what it holds
and a small outline of its sections. Use the arrow keys to move between them.

A Canvas started from a recipe opens with the recipe's sections: its headings,
and a "To fill" note for every other block saying what belongs there. A recipe
that is a document, such as the article, opens as that document in your theme,
with a title and section headings waiting for the text. With
**Ask this thread's agent to fill it in** ticked, Octant also sends a message on
the thread asking its agent to fill the new Canvas, with the Canvas attached.
The message appears in the thread like one you typed, and the agent works with
the thread's usual model and access. Untick it to get only the outline. Add
what the Canvas should cover in the box beneath, if you like.

A created Canvas appears in its thread at the end of the turn that made it, as
a row you can click to open it. The row shows a live miniature of the Canvas
and one line about what it holds, such as a plan's next task and how many
tasks are done. With Settings › Appearance › Style set to Vivid, each Canvas
takes a colour from what it holds. Octant can also offer newly authored documents
beside the conversation.

### Canvases inside the thread

When you ask for a chart, a few numbers, a table, a diagram such as a
sequence, state, entity-relationship, swimlane, or mind map, or a document you
read, such as a brief or an article, the agent can ask for it to be shown in
the thread (`"presentation": "inline"`). The Canvas then appears at the end of
the turn that made it, drawn with the same blocks it has in the sidebar. It is
still one Canvas: it keeps its versions, it appears in your library, and you
can share or export it. Any other Canvas appears there as a row that opens it.

- **Open in sidebar** (the panel icon) opens the same Canvas in the sidebar next to a Work or
  Code thread. There you can comment, edit a board or plan, and see its
  history. Chat has no Canvas sidebar tool, so its button says **Open Canvas** and
  opens the Canvas in its own tab.
- **Expand in thread** (the expand icon, on the frame or on a row) shows the
  whole Canvas in place, including a board, a plan, or a mockup. It grows
  with its content up to about the height of the thread. **Collapse** returns
  it to its faded frame; on a Canvas that started as a row, **Show as card**
  returns it to the row. This window remembers your choice.
- **Show as card** (the fold icon in its header) folds an inline Canvas to a
  single row. **Show in thread** unfolds it. This window remembers that too.
- Scrolling moves the thread while the pointer passes over a Canvas. Click
  inside an expanded Canvas (or Tab to it) and scrolling moves only the
  Canvas; press Escape to give scrolling back to the thread. On a board, drag
  to pan and hold Ctrl or Command while scrolling to zoom.
- Hover a line or bar chart to read the value under the pointer. **View chart
  data** lists every reading.
- Charts also include a funnel (how many make it through each stage), a radar
  (a few things compared on the same qualities), and a sankey (where a quantity
  flows, drawn as bands between named steps). Hover or Tab to a stage, a point,
  or a band to read it; a funnel's table also gives each stage's share of the
  first and of the one before. In a radar or sankey legend, click a name to hide
  that series or step.
- A dashboard lays headline numbers, status lights, progress, charts, and
  tables out as a grid of tiles under its own title. On a wide Canvas the tiles
  sit side by side; in the sidebar or on a phone they stack in one column, in
  the same order you read and Tab through them. Every chart in a dashboard
  still has **View chart data**, and you can comment on the dashboard or on any
  tile in it.
- A table sorts when you click a column header and narrows with **Filter
  rows**. **Group rows** gathers rows that share a column's value under a
  header with the row count; click the header, or press Enter or Space on it,
  to fold or unfold the group, and pick a **Group summary** to add the count,
  sum, or average of a number column to each header. In **Columns**, hide a
  column or pin it so it stays at the left while you scroll sideways. None of
  this changes the Canvas: the agent, exports, and shares keep the table as it
  was written.
- A tall inline Canvas starts cut off at a fixed height and fades out. **Show
  the whole Canvas** expands it in place.

What you see in the thread is read-only, even expanded: dragging a board node
or changing a plan's task happens in the sidebar, or in the Canvas tab in Chat,
where comments and sharing are too. The agent can show a document of any length
inline, including an article or spec it wrote as a document-size design. A
Canvas with a diagram board (the generic diagram you can drag), a plan, a
mockup, a design at a device size (phone, tablet, desktop, or slide), or a
running prototype always first appears as a row, because you work on those in
the sidebar. Sequence, state, entity-relationship, swimlane, and mind
map diagrams can be shown inline. If an inline Canvas gains one of those
blocks, later or through your own edits, it turns back into a row. The agent is
told when that happens.

### The agent looks at a Canvas before it replies

After building a chart, a treemap, a design, or a small inline Canvas, the agent can look
at the shipped drawing before it writes back, using the read-only `preview`
operation:

```json
{ "operation": "preview", "canvasId": "…", "width": "inline", "theme": "light" }
```

`width` is `inline`, `sidebar`, or a number of pixels from 320 to 1200, and
`theme` is `light` or `dark`; both default to `sidebar` and `light`. The agent
can name a `version` sequence to look at an earlier version instead of the
current one. Preview returns a screenshot of the Canvas drawn by the same
renderer the thread uses, at that width and in that theme, and a list of layout
warnings: a label too long for its slot, a legend that overflows its row,
a chart with an empty series, and text or marks below their contrast target. For
a design it also reports a screen whose content is wider than the screen, the
hardest-to-read text on each screen, an image it could not show, and, for a
running prototype, each error its script threw as it started. To find those
errors Octant runs the prototype once in the preview browser, which is started
with no way to reach the network or other programs on your Mac. An error that
only happens after a click is not seen by a preview. The agent fixes what the
warnings name with a revision, then replies.

Preview is bounded so a loop cannot spend your machine or the model's attention
on the same page: one preview runs at a time per thread, and only a few are
allowed per minute.

Preview needs a browser to draw. Octant uses a Chromium that is already on your
Mac — Google Chrome, Chromium, or Microsoft Edge — and never a second browser of
its own. The signed app does not bundle a browser, so on a Mac with none of
those installed, `preview` still returns the layout warnings but no picture, and
says so. Some models cannot take a picture in a tool result; for those the
warnings alone come back, and the result says the model could not be shown an
image. The page Octant screenshots loads nothing from the network: it carries
only Octant's own built files and the Canvas itself.

### Tabs and columns

A long Canvas can arrange its blocks in tabs or side-by-side columns. A tab
strip holds two to twelve labelled tabs; click a tab, or move along the strip
with the arrow keys, `Home`, and `End` and press `Enter`. Which tab is open is
yours alone: switching saves nothing and makes no new version, so the person
beside you can read another tab of the same Canvas. Columns hold two to four
tracks and fold into one column when the Canvas is narrow, as it is in the
sidebar. A tab or a column can hold a dashboard, which looks the same as it
does anywhere else in the Canvas. Comments still sit on the blocks inside a tab
or a column. A shared
copy keeps the tabs, and an exported Markdown or HTML copy reads every tab in
order under its label.

### Diagrams as boards

A diagram block opens as a board. Zoom with the `+` and `−` controls, `⌘`/`Ctrl`
plus scroll, or the `+`, `-`, and `0` keys; drag the background to pan; **Fit**
returns to the whole picture. Dragging a node, or nudging a focused node with
the arrow keys (`Shift` for larger steps), saves the new position as a new
immutable version authored by you, listed in the version history beside the
agent's revisions. Older versions stay intact and can still be opened; a board
opened at an older version is read-only. If the host has moved on since you
opened the board, the drag is refused, the board reloads, and you drag again on
the current version. Boards keep the diagram budgets (512 nodes, 1,024 edges).

A flowchart or a map of areas is a diagram too. Its nodes can be drawn as a
process box, a decision diamond, or a start-and-end pill; a connection can be
a plain line, an arrow, or a dashed arrow; and a connection or a group can take
a tone such as success or danger, so a group of nodes reads as a region. The
tones follow your theme, and the label beside each one still says what it
means. Diagrams saved before shapes existed open as they did.

A plan with dates can open as a Gantt chart: choose **Gantt** above the plan to
see each task as a bar from its start to its due day, arrows from the tasks it
waits on, and its status beside its title. Tasks without dates are listed under
the chart. Choosing a view never changes the plan.

If the agent already has a diagram written in Mermaid, it can hand it to the
Canvas as a Mermaid code block: a flowchart, sequence, state, entity-relationship,
or mind map in the supported subset becomes the matching Canvas diagram, drawn
by Octant, so you can comment on it and share it like any other. Octant never
draws Mermaid itself; a diagram outside the subset (another chart type, custom
styling, links) stays a code block.

A login or request flow is a sequence: participants across the top, messages
in order down the page, an activation on a lifeline, and notes. A lifecycle
such as an order is a state machine: states that may nest, labeled
transitions, and an initial and a final state. Both use the same node and
edge budgets as a board. Comments can sit on a participant, a message, a
state, or a transition.

A screen is a mockup block: a desktop window, browser, phone, tablet, dock
panel, or custom-size frame, and a tree drawn from a closed set of parts:
window, header, sidebar, navigation, stack, row, grid, card, tabs, list, list
row, heading, text, form field, select, button, toggle, checkbox, badge,
avatar, icon, image placeholder, table, modal, and toast. Nodes name a parent
rather than nesting. A mockup is a wireframe in neutral ink unless the agent
asks for the styled fidelity, which draws the same parts with your theme's
accent and status colours. Several frames can sit side by side to show states
(empty, loading, error) or alternatives. Numbered callouts explain parts of the
screen, and you can comment on a callout from the Comments panel. The controls
are not live: they cannot be focused and they do not submit, and a screen
reader announces each part as part of the mockup. Outline, under the frame,
lists the whole tree as text, and a Markdown or HTML export writes the same
outline. Ask `describe` for `mockup` to get a settings screen and a set of
states.

### Comparing options

Ask the agent to compare options, choose between libraries or vendors, or
record an architecture decision, and it builds a comparison matrix. The options
are columns and the criteria are rows. Each cell holds a score, a short note
such as "EU only", or a yes, partial, or no mark. A small number beside a cell
points to its note under the table.

- A criterion can count more than others. Its weight is shown under its name.
  Some criteria are better when lower, such as cost, and say so.
- **Weighted score** under each option is worked out by Octant from the scores
  and the yes, partial, and no marks; text never counts. When an option has no
  reading for a criterion that counts, its score says how many were not scored.
- The agent's **Recommended** option is marked and explained under the table.
  It may differ from the highest score, which is marked **Highest**.
- **Order by score** puts the best-scoring option first. It changes only your
  view.
- On a narrow screen the matrix scrolls sideways while the criteria stay put.
  **View matrix data** lists each option on its own row.

### Formulas

Ask for an equation, a derivation, or an explanation with formulas in it, and
the agent writes math blocks. A formula on its own line can carry a caption
that names it, such as "Bayes' theorem", and a sentence can carry small
formulas inline.

- Formulas take your theme's text colour, including dark mode and high
  contrast; an agent cannot colour them.
- **View source** shows the formula as the agent wrote it, in LaTeX math
  markup. A screen reader reads the formula itself.
- A long formula scrolls sideways on a narrow screen rather than widening the
  page.
- A formula that cannot be drawn shows its source and says so.
- Exported Markdown keeps formulas as GitHub math, and exported HTML keeps them
  as MathML that a browser draws without any download.

### Designs, prototypes, and slides

Ask for an app, a screen, a website, a landing page, or a presentation, and the
agent builds a design: real screens or slides that look finished. A design has
one size, phone, tablet, desktop, or slide, and its screens sit side by side
in the Canvas, numbered in order.

Ask for an article, a spec, or a design system, and the agent can write it as
a design document instead. A document is as wide as the Canvas and grows to
fit its content, so you read it in place without scrolling inside it. It uses
Octant's own fonts and colours, follows your theme as you change it, and can
hold cards, metric tiles, badges, tables, callouts, code, and tabs you click
between. App screens and slides keep the designer's own colours unless the
agent asks for your theme.

- **Play** opens the design at full size. Click its links and buttons to move
  between screens. Click a screen to play from that one. **Restart** goes back
  to the screen you started from.
- A deck shows **Present** instead. Use the arrow buttons, or the left and
  right arrow keys, to move between slides.
- Some designs react to taps without changing screen, such as a card you can
  select or a reminder you can tick. That is all an ordinary design can do: it
  runs no script, loads nothing from the internet, and has no links that leave
  it. A prototype, below, is the one kind that runs script.
  Pictures in it are drawn by the agent, or are real images it names.
- Ask for a working prototype, such as a checkout with a cart you can fill,
  and the agent can make a design that runs its own script. Its header
  calls it a prototype. In the sidebar it starts when you open it; in
  the thread it starts when you press **Run**. While it runs, Octant shows
  **Running** and **Stop** above it, outside the prototype. A prototype
  cannot reach Octant or your files, and it cannot load a page, an image, or
  data from the internet. In the Octant app a prototype also runs with no
  network connection at all: it cannot open a connection to another computer
  or make Octant look up a host name, and if Octant cannot set that up, the
  prototype does not run and says why. If it stops responding, or tries to
  open another page, Octant stops it and offers **Run again**. Script errors appear as text under it.
- Ask to redesign a whole app, and the agent can build a prototype of its
  window at desktop size, with a sidebar of threads, tabs, panes, and an accent
  colour you can change. It builds the window in steps, adding a screen at a
  time, rather than in one long request, so a large prototype appears sooner and
  your own changes to the Canvas are kept in between. Press **Full screen**
  above a running prototype, or in **Play**, to see it as large as your screen
  allows. Octant scales it to fit, and **Stop** stays in view.
- A running prototype is part of the Tab order, right after **Stop**, whether
  it started when you opened it or when you pressed **Run**. Octant does not
  move the keyboard into it by itself; press **Tab** from **Stop** to enter it.
- If a prototype holds on to the keyboard, press **Command-Escape**
  (**Control-Escape** outside macOS) in the Octant app to move focus to its
  **Stop** button. The prototype never sees that key, so it cannot keep the
  keyboard. Typing through an input method's composition (for example,
  Japanese or Chinese input) does not reach a prototype in the Octant app.
- In a web browser connected to your Mac, a prototype runs in the browser
  and Octant cannot stop it from opening another page before it removes it,
  or from connecting to another computer, so the **Run** control says it is
  not network-contained there and Octant says its script can still connect out.
  Run one there only if you would be comfortable with that. To leave a
  prototype from the keyboard in a browser, use the browser's own focus keys
  (such as **F6**) or the **Stop** button. If a prototype stopped responding
  in a browser, open Octant in a new tab to run one again.
- A design can show real images: a screenshot or other image file from the
  thread's folder (Work) or checkout (Code), or an image generated in the same
  Project. In a Chat Project it can show only images generated there. Octant
  reads each image when you open the design, under the thread's access, and
  draws it into the page, so the design itself still fetches nothing. An image
  it cannot show (missing, outside the folder, from another Project, larger
  than 3 MB, or not a PNG, JPEG, GIF, or WebP) appears as a labelled
  placeholder.
- Sharing a Canvas that holds a design asks for one more tick: its markup is
  shared exactly as written, and Octant does not check markup for secrets. The
  snapshot shows the design's screens and runs a prototype when you press
  **Run**, under the same limits as in the Canvas. Images the design took from
  your Project or from generated images are not shared; their places show a
  placeholder. Exporting to HTML writes the design's screens into the file,
  and a prototype runs there with no way to reach the network; the approval
  card says the file includes the design's markup exactly as written. A design
  drawn in your theme is exported in the theme your window shows at that
  moment, without Octant's own fonts. A Markdown export still writes the name
  of each screen instead.

Comments, versions, and **Compare with** work on a design as on any other
block. To change it, ask the agent: "make the buttons rounder" revises the
same design.

The document fills the Canvas tab and the dock. Its header holds the version
picker (choose an earlier version, or **Compare with** the previous one to see
which blocks were added, changed, or removed), **Comments** with the number of
open threads, and a `⋯` menu for **Share**, **Refresh**, and **Refine**.
Those three act on the current version, so an earlier version shows them
unavailable and says why.

**Comments** open in a panel over the document rather than beside it. Hover a
block and select its comment marker to read or add comments on that block;
blocks with open threads always show their marker and count. The panel filters
open, resolved, or all threads. A comment is anchored to a
block, to a board node, to a sequence participant or message, or to a state
or its transition, to a comparison matrix's option or criterion, or to a table
row the agent gave an id. Hover a table row, or move to it with Tab, to comment
on that row; the comment stays on the row when you sort, filter, or group the
table and when the agent revises it. Replies,
resolving, and deleting are journaled by the
host, so they survive restart and reload. Every comment is authored as you,
with the device it came through noted ("paired device" when it arrived from a
paired phone or browser). A comment whose block has since left the canvas is
kept and marked rather than dropped, and so is one whose table row was removed. Shared snapshots never include comments.
A shared snapshot keeps every block, including charts (funnels, radars, and
sankeys too), dashboards, tables, treemaps,
heatmaps, bar lists, comparison matrices, and formulas, with their number formats. A design is
shared once you tick that its markup is shared as written. An action block
that runs a command on this Mac stops a share: Share then says the canvas
cannot be shared safely.
A treemap or bar list in a shared snapshot offers no **Open file**, because
those files are on your Mac.
Board templates are not available yet. Revisions
do not force a document the user closed to reopen. Agents should identify the
created document rather than invent a download URL or claim a preview opened
without evidence. Canvas authoring through this tool is bound to the thread's Chat Project,
Work folder, or Code checkout; it grants no file, shell, Git, or network
authority.

In Work and Code, permitted file tools can create documents within the bound
folder or checkout. The agent should report their real relative paths so the
user can find them in **Files**; observed Markdown and text documents can also
appear in **Document**. Binary document formats require appropriate generation
tools, not text saved with a different extension.
Work includes this artifact guidance in the task's context budget even when
the selected runtime uses its own file tools.

Image generation uses a separate configured image profile. The agent's image
tool returns a job id and status; queued or running work is not a finished
image. Completed artifacts appear in the task for opening or attachment.

You can also start an image yourself. In an open Chat, Work, or Code thread, the
**Create image** button beside the attach button opens the same sheet: choose an
image profile and model, describe the image, and generate. The image appears in
that thread, where you can attach it, revise it, or download it. In Work and Code
it can also be saved to the Project (Work saves when you click Save; Code asks
you to confirm). With no image profile ready, the button opens **Settings →
Image generation** instead.

## Next steps

- [Editor and terminals](/advanced/editor-and-terminals) for editing and command surfaces
- [Git and worktrees](/advanced/git-worktrees) for repository-scoped files
- [Privacy and security](/advanced/privacy-and-security) for path and preview boundaries
