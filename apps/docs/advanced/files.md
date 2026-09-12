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
task. In a Chat Project, `octant_canvas` creates and revises structured reports,
diagrams, tables, and dashboards. Its read-only `describe` operation lists the
supported block kinds and a creation example. Requesting up to three
`blockKinds` returns their exact schemas from the host's block contracts:

```json
{ "operation": "describe", "blockKinds": ["rich-text", "diagram"] }
```

The agent supplies the actual document as validated blocks. A prompt alone is
only a provenance note. Revisions replace the block list and must name the
last observed version sequence; creation starts at sequence 1. Raw HTML,
JavaScript, CSS, and invented file or artifact references are not Canvas
content.

A created Canvas appears as a card in its Chat with **Open Canvas**. Octant
can also offer newly authored documents beside the conversation.

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

**Comments** live beside the Canvas in the sidebar. A comment is anchored to a
block or to a board node; replies, resolving, and deleting are journaled by
the host, so they survive restart and reload. Every comment is authored as you,
with the device it came through noted ("paired device" when it arrived from a
paired phone or browser). A comment whose block has since left the canvas is
kept and marked rather than dropped. Shared snapshots never include comments.
Board templates are not available yet. Revisions
do not force a document the user closed to reopen. Agents should identify the
created document rather than invent a download URL or claim a preview opened
without evidence. Canvas authoring through this tool currently requires a
Chat Project; it does not grant Work or Code authoring authority.

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
