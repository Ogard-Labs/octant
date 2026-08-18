# 0010. Secure file preview and canvas artifacts

**Status:** Accepted

## Context

Threads produce and consume documents, spreadsheets, PDFs, images, generated
artifacts, and validation evidence. Users want them beside the conversation as
ordinary workspace tabs, and agents want to present non-linear results
(reports, dashboards, diagrams, reviews) more usefully than as long Markdown.
Both are attractive routes for authority leaks: a renderer that reads paths
directly, a document parser running in the UI process, or an "artifact" that is
arbitrary agent-generated HTML and script.

## Decision

Preview:

- File and artifact previews are normal tabs in the persistent split-tree
  workspace: movable, splittable, focusable, restorable across restart.
- Previews are host-authorized and local-first. The renderer never receives a
  host path and never reads the filesystem. Targets are opaque Project-scoped
  file references, attachment ids, artifact-version ids, or evidence ids;
  every open, chunk, selection, refresh, and handoff is re-authorized by the
  server against mode, Project, root, host, and remote-client policy.
- The first release provides read-only structured viewers for source and
  plain text, Markdown, images, PDF, CSV/TSV, workbook, document, and slide
  formats. Editing stays format-specific: text and source may hand off to the
  editor where the mode grants write authority; the previewer gains no write
  behavior.
- Parsing runs in the server, outside the renderer, with content sniffing in
  addition to extension checks and explicit memory, decompression, time, and
  output budgets. Scripts, forms with side effects, embedded files, remote
  resources, formula execution, and macros are disabled.
- Fidelity is honest: unsupported or incompletely rendered content shows a
  notice and offers Quick Look, Finder, or an explicitly chosen external
  application as fallback rather than pretending.
- The workspace persists only a stable target and bounded view state (page,
  sheet, zoom, scroll, mode), never file bodies, search queries, or selected
  content. Missing, moved, changed, or unauthorized sources restore as honest
  unavailable or stale placeholders and never substitute another file.
- Structured selections (line ranges, cell ranges, pages, image attachment)
  can be attached to a composer as explicit context.
- The renderer owns a closed registry from normalized preview kind to viewer
  component; a viewer cannot install or activate anything.

Canvas:

- A Canvas is a versioned, provider-neutral artifact owned by exactly one host
  and Project. It records originating mode, thread, actor, provider, and
  model; a validated definition of first-party blocks; a bounded source
  manifest of host-owned opaque references; and provenance for generation,
  revisions, refreshes, skills, and actions.
- The block catalog is bounded and versioned (text, callouts, metrics,
  tables, charts, timelines, diagrams, code and diffs, thread and run
  summaries, evidence references, declarative action blocks). Unknown blocks
  or schema versions fail closed. The renderer never interprets arbitrary CSS,
  HTML, JavaScript, React, remote components, inline handlers, data URLs, or
  unapproved network locations.
- A diagram is structure, not a picture: nodes, edges, named groups, and the
  direction it reads, with an optional position per node. Where each part is
  drawn is derived from that data by one deterministic layout, so every surface
  that draws a diagram draws the same one and none of them is handed markup.
  A node's own position is the author's, which is the seam a direct-manipulation
  editor would write into without changing what a diagram is.
- A Canvas appears as a card in its thread and opens as an ordinary workspace
  tab. Refinement creates a new immutable version; refresh is a server command
  that re-authorizes every source against current policy and never replaces
  the last complete version on partial failure. Opening or interacting with a
  Canvas grants no authority; cross-Project or cross-host use needs an
  explicit bounded reference re-authorized by the owning host.
- Trusted, enabled skills may contribute Canvas layouts and data-source
  guidance; mentioning a skill grants nothing.
- Local-only use is complete; sharing is optional and needs no Octant cloud.

## Consequences

- Rich viewing without turning the renderer into a trusted process; parser
  vulnerabilities are contained in the server with budgets and sandboxing.
- Restoration is by identity, so previews survive moves and renames honestly
  and fail visibly on real changes.
- Agents get a structured presentation surface that is safe to render from any
  provider; the price is a closed block catalog that grows by contract change,
  not by ad-hoc markup.

## Related

- 0003 Product modes and authority
- 0011 Extensions and skills activation ladder
- 0015 Workspace shell model
