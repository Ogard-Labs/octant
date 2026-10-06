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
last observed version sequence; creation starts at sequence 1. Raw HTML,
JavaScript, CSS, and invented file or artifact references are not Canvas
content.

A created Canvas appears in its thread at the end of the turn that made it, as
a row you can click to open it. Octant can also offer newly authored documents
beside the conversation.

### Small Canvases inside the thread

When you ask for something small, such as a chart, a few numbers, a short table,
or a sequence diagram, the agent can ask for it to be shown in the thread
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
  the whole Canvas in the sidebar. Scrolling always moves the thread, never the
  Canvas.

Inside the thread a Canvas holds at most 12 blocks. A board, plan, or mockup
always opens in the sidebar, because you work on those there. If a Canvas grows
past that, later or through your own edits, it turns back into a card. The
agent is told when that happens.

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

The document fills the Canvas tab and the dock. Its header holds the version
picker (choose an earlier version, or **Compare with** the previous one to see
which blocks were added, changed, or removed), **Comments** with the number of
open threads, and a `⋯` menu for **Share**, **Refresh**, and **Refine**.

**Comments** open in a panel over the document rather than beside it. Hover a
block and select its comment marker to read or add comments on that block;
blocks with open threads always show their marker and count. The panel filters
open, resolved, or all threads. A comment is anchored to a
block, to a board node, to a sequence participant or message, or to a state
or its transition; replies, resolving, and deleting are journaled by
the host, so they survive restart and reload. Every comment is authored as you,
with the device it came through noted ("paired device" when it arrived from a
paired phone or browser). A comment whose block has since left the canvas is
kept and marked rather than dropped. Shared snapshots never include comments.
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
