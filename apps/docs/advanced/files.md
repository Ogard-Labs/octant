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
plans, designs, reports, reviews, diagrams, tables, and dashboards. When you ask
for something substantial, the agent builds it as a Canvas and replies with a
short pointer; brief answers stay in the conversation. A follow-up such as "add
a risks section" revises the existing Canvas: the read-only `list` operation
returns the thread's Canvases and `read` returns one's current blocks and
sequence. Its read-only `describe` operation lists the
supported block kinds, the document recipes an agent should start from, and a
creation example. Asking to write a plan, review a pull request, or summarise
research starts from the matching recipe. Requesting up to three
`blockKinds` returns their exact schemas from the host's block contracts:

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
postmortem, a research brief, a dashboard, and the others the host offers,
including any an enabled skill adds. Each shows one line about what it holds
and a small outline of its sections. Use the arrow keys to move between them.

A Canvas started from a recipe opens with the recipe's sections: its headings,
and a "To fill" note for every other block saying what belongs there. With
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

### Small Canvases inside the thread

When you ask for something small, such as a chart, a few numbers, a short table,
or a diagram such as a sequence, state, entity-relationship, swimlane, or mind
map, the agent can ask for it to be shown in the thread
(`"presentation": "inline"`). The Canvas then appears at the end of the turn
that made it, drawn with the same blocks it has in the sidebar. It is still one
Canvas: it keeps its versions, it appears in your library, and you can share or
export it.

- **Open in sidebar** (the panel icon) opens the same Canvas in the sidebar next to a Work or
  Code thread. There you can comment, edit a board or plan, and see its
  history. Chat has no sidebar, so in Chat the button says **Open Canvas** and
  opens the Canvas in its own tab.
- **Show as card** (the fold icon in its header) folds it to a single row.
  **Show in thread** unfolds it. This window remembers your choice.
- Hover a line or bar chart to read the value under the pointer. **View chart
  data** lists every reading.
- A tall Canvas is cut off at a fixed height and fades out. Its button opens
  the whole Canvas in the sidebar, or in its own tab in Chat. Scrolling always
  moves the thread, never the Canvas.

Inside the thread a Canvas holds at most 12 blocks. A Canvas with a diagram
board (the generic diagram you can drag), a plan, or a mockup always appears as
a row that opens it in the sidebar, or in its own tab in Chat, because you work
on those there. Sequence, state, entity-relationship, swimlane, and mind map
diagrams can be shown inline. If a Canvas grows
past that, later or through your own edits, it turns back into a card. The
agent is told when that happens.

### The agent looks at a Canvas before it replies

After building a chart, a treemap, or a small inline Canvas, the agent can look
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
a chart with an empty series, an inline document past its height cap, and text
or marks below their contrast target. The agent fixes what the warnings name
with a revision, then replies.

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

A login or request flow is a sequence: participants across the top, messages
in order down the page, an activation on a lifeline, and notes. A lifecycle
such as an order is a state machine: states that may nest, labeled
transitions, and an initial and a final state. Both use the same node and
edge budgets as a board. Comments can sit on a participant, a message, a
state, or a transition.

A screen is a mockup block: a desktop, tablet, or phone frame and a tree of
window, header, sidebar, list, list row, form field, button, toggle, tabs,
card, image placeholder, and text. Nodes name a parent rather than nesting.
The drawing is a wireframe. Its controls are not live: they cannot be focused
and they do not submit. Ask `describe` for `mockup` to get a settings screen.

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

### Designs, prototypes, and slides

Ask for an app, a screen, a website, a landing page, or a presentation, and the
agent builds a design: real screens or slides that look finished. A design has
one size, phone, tablet, desktop, or slide, and its screens sit side by side
in the Canvas, numbered in order.

- **Play** opens the design at full size. Click its links and buttons to move
  between screens. Click a screen to play from that one. **Restart** goes back
  to the screen you started from.
- A deck shows **Present** instead. Use the arrow buttons, or the left and
  right arrow keys, to move between slides.
- Some designs react to taps without changing screen, such as a card you can
  select or a reminder you can tick. That is all they can do: a design runs no
  script, loads nothing from the internet, and has no links that leave it.
  Pictures in it are drawn by the agent.
- A design cannot be shared as a snapshot yet. Exporting it writes the name
  of each screen, not the screens themselves.

Comments, versions, and **Compare with** work on a design as on any other
block. To change it, ask the agent: "make the buttons rounder" revises the
same design.

The document fills the Canvas tab and the dock. Its header holds the version
picker (choose an earlier version, or **Compare with** the previous one to see
which blocks were added, changed, or removed), **Comments** with the number of
open threads, and a `⋯` menu for **Share**, **Refresh**, and **Refine**.

**Comments** open in a panel over the document rather than beside it. Hover a
block and select its comment marker to read or add comments on that block;
blocks with open threads always show their marker and count. The panel filters
open, resolved, or all threads. A comment is anchored to a
block, to a board node, to a sequence participant or message, or to a state
or its transition, or to a comparison matrix's option or criterion; replies,
resolving, and deleting are journaled by the
host, so they survive restart and reload. Every comment is authored as you,
with the device it came through noted ("paired device" when it arrived from a
paired phone or browser). A comment whose block has since left the canvas is
kept and marked rather than dropped. Shared snapshots never include comments.
A shared snapshot keeps every block, including charts, tables, treemaps,
heatmaps, bar lists, and comparison matrices with their number formats. A design, or an action block
that runs a command on this Mac, stops a share: Share then says the canvas
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

## Next steps

- [Editor and terminals](/advanced/editor-and-terminals) for editing and command surfaces
- [Git and worktrees](/advanced/git-worktrees) for repository-scoped files
- [Privacy and security](/advanced/privacy-and-security) for path and preview boundaries
