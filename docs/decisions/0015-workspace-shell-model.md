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
  inside the same window for focus work; it is not a split-tree tab and not a
  fourth authority mode. A pinned card may be interactive and host its thread's
  own live transcript and composer, but only under its own source context: each
  card resolves its surface from that context and holds its own controller and
  stream. The focus zone grants nothing, merges nothing between cards, and has
  no authority to lend; what it cannot host that way stays a read-only reading.
- Zen is a focus zone: a window holds several named, ordered spaces and shows
  one at a time. The spaces a window holds are their own journaled aggregate,
  keyed by window and separate from the spaces themselves, so switching writes
  only which space is in front and never anything pinned to either. A window
  holds at most eight spaces and always keeps its last one. The element budget
  is a property of a space, so each space carries its own.
- The zone's pointer is the authority for which space is in front. A space's
  own showing flag says only whether the focus zone is replacing the shell for
  that window, and moves with the pointer.
- A window that had a space before it had a zone keeps that space as the first
  space of its zone. Projections are rebuildable, so the migration is
  forward-only and nothing pinned to that space is rewritten.
- Switching space grants nothing. Every pinned element still acts strictly
  under its own bound source context, and a space is a place to arrange them,
  never an authority of its own.
- Live cards carry their own render and subscription budget within a space,
  separate from the element ceiling, because a streaming element costs more
  than a drawn one. A card that is minimized, out of view, or past that budget
  pauses, says so, and keeps its last reading rather than passing stale text
  off as live.
- A card may be pinned to a terminal a Code thread owns. The card addresses the
  shell rather than describing it: it names the thread, checkout, and terminal,
  and the server writes the card only after the thread catalog says this window
  may see the thread and Code says that thread owns the shell. Every keystroke
  is authorized against the same thread and checkout it is from the workspace
  tab, so a pinned shell reaches exactly as far as the tab already did and no
  further. A pinned card never starts or restarts a shell; opening one is the
  Code thread's to do.
- One budget covers every card that streams, whatever it streams. A pinned
  conversation and a pinned shell cost the same live slot and compete for it.
- A space may dock one research browser onto a Work or Code thread it is bound
  to, and shows that thread's browsing context. It is docked to the space's edge
  rather than pinned to the canvas because the page is a native view the host
  places by absolute window bounds, while the canvas draws its cards under a
  transform; a page arranged among them would be positioned by the canvas's last
  pan rather than by where it appears. The rail, the address, and the page all
  live outside that transform.
- The dock's tabs are real pages of one browsing context, opened by the host, so
  they share that context's session as any browser profile's tabs do. A tab the
  renderer arranged out of one view would share neither the session nor the
  origin approval, and is not a tab.
- The person browsing may reach an origin approval never granted, and that
  origin joins what their own view may show. It never joins what the agent may
  act on: the agent reaches only origins approval put on the context, and
  refuses to read or drive a page outside them however far the person has
  browsed. Docking grants nothing, and neither does following a link.
- Desktop and web clients share the same content structure and commands; web
  omits native window affordances. The UI is truthful: every visible action
  works, is clearly unavailable, or is absent.

## Consequences

- The switcher lists a window's spaces without loading any of them, because the
  zone holds only names, order, and which space is in front.
- Removing a space drops it from the switcher; its own journal is retained, so
  the removal is not a destructive write.
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
- Zen can host real work without becoming a second workspace: the card seam
  carries only a source context, so a new interactive card is a shell surface
  bound to that context, never a widening of what the canvas may do.
- The focus zone can hold a live web page without the canvas learning about
  native views: the dock is the space's edge, and what it shows is a thread's
  browsing context under that thread's authority.

## Related

- 0003 Product modes and authority
- 0010 Secure file preview and canvas artifacts
- 0016 Component foundation and theme
