---
description: The Monaco editor, external-editor handoff, dirty-state protection, conflict recovery, and integrated terminals.
---

# Editor and Terminals

Code mode provides a first-class editing surface and server-owned terminals.
All authority lives server-side; the interface renders opaque file and
checkout identities, never raw host paths.

## Monaco editor

The Monaco editor is a full editable pane with:

- File tabs and multiple editor panes in the persistent split-tree
- Syntax highlighting and built-in services for TypeScript, JavaScript, JSON,
  CSS, and HTML
- Find and replace, go to line, multi-cursor, undo and redo, and save
- Diff viewing
- Dirty-state protection and external-change detection
- Restoration of file tabs and pane layout after restart

Other languages get syntax highlighting and editing fundamentals only; deeper
tooling is handled through external-editor handoff.

File states are **dirty**, **saving**, **saved**, **conflicted**,
**unavailable**, and **closed**.

### Stale-save conflict recovery

Saves carry the expected file identity and digest, write an exclusive
same-directory temporary file, flush, atomically rename, flush the directory,
and verify the result. An external change creates a new observed identity and
blocks the stale write with a **conflict** result:

- A conflict keeps the prior content identity, digest, and byte length while
  recording `state: "conflict"`. The authoritative file is not replaced.
- An interrupted save keeps prior authoritative metadata and records
  `state: "interrupted"` with rescan required; the draft stays dirty and
  Save-enabled with reconnect and retry guidance.

## External-editor handoff

You can open a file in an external editor. Handoff is desktop-only,
authenticated, and fail-closed:

- The editor is configured in Settings as an explicit executable plus a
  structured argument template — never a shell string, and never an
  authoritative host path.
- The process launches without a shell against the exact authoritative
  checkout, file, and line.
- The server accepts the target only when the thread and checkout are active
  and matching, the path is confined, and the file reference is available,
  read-only, or completed. **Archived, waiting, conflicting, mismatched,
  missing-path, and out-of-scope targets are rejected.**
- Failures map to a sanitized `503 unavailable`; private paths and exception
  details never cross the boundary, and a failed handoff does not change
  Octant state.

## Terminals

Terminals are server-owned PTY processes in the selected checkout, rendered by
Xterm. They appear as movable tabs and multiple terminals can run
concurrently.

- Explicit shell selection with a sanitized inherited environment and
  credential references resolved only at launch
- Bounded input and output; each pane retains at most 8 MiB of redacted
  output in 64 KiB chunks, with an explicit truncation marker
- Backpressure, resize coalescing, cancellation, and graceful shutdown that
  escalates to a verified process-group kill — never a kill by broad process
  name
- Renderer reload reattaches while the server and PTY stay alive; a full
  restart restores the transcript, exit state, and an explicit rerun action —
  it never restarts a command silently

Terminal settings are independent of editor typography: font family, size,
line height, ligatures, cursor style, scrollback, shell, and theme-derived
colors. The default terminal font stack falls back to installed Nerd Fonts
(Symbols Nerd Font Mono, MesloLGS NF, Hack Nerd Font Mono) so prompt glyphs
render when you have one; set your own family in Settings to prefer another.

### Authority

Plan mode cannot start or stop terminals. Opening the Terminal tab yourself
starts a shell without a prompt in every other posture — your click is the
approval. Approval-gated mode still prompts before an agent starts or stops a
terminal; Full access allows it. The shell keeps its history and prompt caches
in an Octant-owned directory, since the sandbox never lets it write inside
your home. Local process monitoring
covers only processes Octant launches and owns; arbitrary host-process
discovery and control are deferred.

## Next steps

- [Files, previews, and selections](/advanced/files) for reading and previewing
- [Git and worktrees](/advanced/git-worktrees) for the repository surface
- [Recovery and troubleshooting](/advanced/recovery) for interrupted saves
