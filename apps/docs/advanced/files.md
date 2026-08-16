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

An **unfiled** Work or Code thread has no filesystem, shell, Git, worktree,
test, preview, or delivery authority until an existing folder is explicitly
attached. Octant never infers a root from a prompt or working directory.

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
read-only indicator and fidelity notice. Preview tabs are normal persistent
workspace tabs and restore after a restart.

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

## Next steps

- [Editor and terminals](/advanced/editor-and-terminals) for editing and command surfaces
- [Git and worktrees](/advanced/git-worktrees) for repository-scoped files
- [Privacy and security](/advanced/privacy-and-security) for path and preview boundaries
