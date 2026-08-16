# 0015. Workspace shell model

**Status:** Accepted

## Context

Octant's window hosts three modes, many pane kinds (threads, files, editor,
terminals, diffs, previews, browser, Simulator, canvases, boards), a sidebar,
and optional utility panels, and one renderer serves desktop and remote
clients. Ad-hoc layout state in React or a docking library with its own model
would fragment persistence, break restore, and let focus or drag gestures
change what a tool may touch. The shell needs one layout model, one authority
context per visible workspace, and a navigation grammar that survives visual
redesigns.

## Decision

- The shell is mode-first: a persistent left sidebar with the Chat, Work, and
  Code selector on top, mode-aware primary action and destinations, Projects
  and threads, mode boards, and settings; an integrated borderless top chrome
  with native macOS traffic lights, a center identity and status region, and
  trailing contextual actions that overflow before colliding; and a central
  workspace. Mode changes alter content, authority, default composition, and
  density, never the navigation grammar. Chat is calmest, Work adds artifact
  context, Code is densest.
- The mode selector may be shown as compact buttons (default) or a dropdown;
  both consume the same enabled-mode list and dispatch the same authoritative
  set-active-mode command. Presentation preferences never enable a mode or
  grant authority.
- The central workspace is one persistent recursive split tree: a leaf is a
  tab group with a top-aligned tab strip; a branch is a horizontal or vertical
  split. Users activate, close, reorder, move, split, dock (drop on a group's
  edge to create a split), resize, focus, and reset. There is one layout model
  and no third-party docking framework. The renderer owns only transient
  pointer state and drop previews; completed operations go through
  server-authoritative workspace commands and the persisted layout projection.
- Layout persists per client window, mode, and Project context and restores
  after restart; mode presets apply only when no saved layout exists or the
  user restores them. Any pane can enter temporary focus mode without
  destroying the layout. Unknown or unavailable restored tabs render as
  placeholders with reset and close, never as fabricated content.
- One visible split tree belongs to one authority context: host, mode,
  Project, and bound root or environment. The server resolves every open,
  move, or dock against that key. Same-Project surfaces may share groups; a
  cross-Project, cross-mode, or cross-host drop is rejected and may offer
  "open in new window". Selecting another Project is a deliberate atomic
  context switch. Renderer focus never grants or changes authority.
- The Right Utility Dock is an optional, capability-gated shell region outside
  the split tree (Browser, Review, Files, Terminal, Side Chat as the mode
  allows). It is not a drop target; dock and workspace instances of the same
  capability are separate views. Sidebar and dock are independently resizable
  with persisted widths; at narrow widths the dock becomes an overlay drawer.
- Environment (worktree, checkout, local servers) belongs to a thread tab and
  follows the authoritative thread; each tab persists floating, pinned, or
  hidden presentation.
- Work and Code have server-authoritative thread boards derived from thread
  and runtime state with fixed statuses Ready, In Progress, Waiting, Done.
  Cards cannot be dragged between columns. Code boards may group by Status or
  Project over one card set; grouping is a per-device view preference. Done
  stays visible by default. Chat has no board, and no mode has a general task
  Kanban.
- Every saved Project has a mode-aware Overview composed from authoritative
  projections; it is a normal workspace view, not a dashboard route. Sidebar
  search is one overlay that finds threads of the current mode; Projects,
  Recents, and Unfiled are folder labels on threads.
- The sidebar uses native translucency when supported and falls back to an
  opaque semantic surface for reduced transparency, increased contrast,
  performance, unsupported hosts, or an explicit preference, without changing
  geometry; the workspace stays visually solid.
- Zen is a separate presentation aggregate that replaces the renderer surface
  inside the same window for focus work; it is not a split-tree tab, not a
  fourth authority mode, and never merges authority from attached entities.
- Desktop and web clients share the same content structure and commands; web
  omits native window affordances. The UI is truthful: every visible action
  works, is clearly unavailable, or is absent.

## Consequences

- One layout aggregate serves every pane kind, so new surfaces (previews,
  canvases, Simulator, plugin tabs) inherit persistence, docking, restore, and
  the authority key for free.
- Cross-Project mixing in one tree is deliberately impossible; multi-Project
  work is multiple windows, which keeps terminal, composer, and Files ownership
  unambiguous.
- Boards stay honest monitors of real threads rather than a second task
  system to maintain.
- Visual redesigns can change tokens, density, and chrome without touching the
  layout model or authority key.

## Related

- 0003 Product modes and authority
- 0010 Secure file preview and canvas artifacts
- 0016 Component foundation and theme
