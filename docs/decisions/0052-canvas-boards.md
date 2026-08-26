# 0052. Canvas boards are the diagram block

**Status:** Proposed

## Context

0010 already defines a Canvas: a versioned, provider-neutral document of
first-party blocks, authored through an app-managed tool, fail-closed on
unknown schema, and never handed arbitrary HTML, CSS, or JavaScript. A diagram
in that catalog is structure — nodes, edges, named groups, an optional
position per node, and one deterministic layout so every surface draws the
same picture.

That is enough for a report and not enough for a board. `apps/server/src/canvas`
and `apps/web/src/canvas` already persist, revise, refresh, and render Canvas
documents. The renderer still draws a static SVG from `layoutCanvasDiagram`.
Node `x`/`y` exist on `CanvasDiagramNode` as the author's seam — the layout
keeps them when present — but nothing records a human drag as a new version,
and there is no comment contract. Visual work then leaves the artifact as a
screenshot or as text the board cannot round-trip.

A parallel whiteboard model would split one Canvas into two documents and two
authority stories. This record extends 0010. It does not reopen the closed
catalog, the no-markup rule, or mode, Project, or host authority.

## Decision

- **A board is the existing `diagram` block, versioned forward.** There is no
  second whiteboard aggregate, no second Canvas kind, and no embedded
  third-party canvas engine (tldraw, Excalidraw, Miro, or anything that
  executes user or agent HTML or JavaScript). `CANVAS_SCHEMA_VERSION` in
  `packages/contracts/src/canvasIdentity.ts` is bumped when the board and
  comment extensions land; decoders reject any version they do not know, so
  earlier clients fail closed rather than silently dropping new fields.
  Expressiveness grows through the typed catalog, not by rendering a program.
- **Layout changes are immutable Canvas versions.** A drag, rename, or
  structural edit appends a version with `actor: user | agent`. Node `x`/`y`
  remain the position the layout respects. Agent revise and user layout share
  one history; a later version does not rewrite an earlier one.
- **Comments are journaled Canvas facts**, not renderer state. Each is
  anchored to a `blockId`, `nodeId`, `edgeId`, or region, with author, time,
  resolved state, and threaded replies. Region anchors need a stable identity
  and coordinate space defined before comments ship; until then, a comment
  whose anchor cannot be resolved is surfaced unanchored rather than dropped.
  Unauthorized or revoked access redacts comment bodies fail-closed. Shared
  snapshots **exclude comments by default**.
- **Budgets stay.** `CANVAS_MAX_DIAGRAM_NODES` is 512 and
  `CANVAS_MAX_DIAGRAM_EDGES` is 1_024 in `packages/contracts/src/canvas.ts`;
  domain policy re-checks both before a definition can persist or render.
  Boards do not raise those caps.
- **Open question, before comments are persisted:** on a local-only host, is
  a comment authored as the single local user, or as a named actor per remote
  client? Do not pick this silently in contracts or journal events.

Non-goals for this record: freehand ink, realtime co-edit, physical-device
boards, and Mermaid or PlantUML import.

## Consequences

- Board work is a catalog change plus comment and layout commands, not a new
  persistence product. Contracts stay schema-only; authority stays on the
  server. A user-facing Boards guide belongs with the renderer, not here.
- Sharing a Canvas remains a snapshot of the document, not of the conversation
  on it, unless a later record opts comments in.
- 0010's remaining rules stand: closed catalog, no executing markup,
  host-authorized previews, versioned artifacts, local-first completeness.

## Related

- 0010 Secure file preview and canvas artifacts
- 0002 Durable event journal and rebuildable projections
- 0028 The artifact library
