# 0165. A Canvas in the thread can be the whole answer

**Status:** Proposed

## Context

People ask an agent for a long answer — a game design, a product spec, a
research brief — and expect to read it in the thread as a finished document
they can browse: tabs, metric cards, a flowchart, a map of zones, wide tables
with badges. A click on a tab should change what is showing without sending
anything back to the agent. Today that answer is either a long Markdown reply
or a Canvas the thread clips at 560px and fades out.
`canvasInlineRefusal` admits inline only for at most 12 blocks with no
`diagram`, `plan`, `mockup`, or `design`. Sequence, state, ER, swimlane, and
mind map already draw inline; the generic board does not.

0010 kept a closed, versioned catalog and refused agent HTML, CSS, and script.
0164 then admitted one `design` block: static HTML and CSS in an empty-sandbox
`srcdoc` frame, fragment links only, refused in a share. 0052 kept one
deterministic diagram layout and listed Mermaid import as a non-goal. The
remaining question is whether matching a freeform in-thread mini-app means
growing that catalog, relaxing the inline clip, or letting the agent write a
program.

## Decision

- **Layout is catalog, not markup.** New first-party blocks organize a long
  answer: tabs, sections, columns, grids, cards, and badges or pills. A tab
  switch, a collapsed section, and a card's open state are view state and
  never journal a version. Children are named by block id, one level deep, so
  the document stays inside the existing depth budget. Unknown kinds and
  future schema versions still fail closed.
- **The thread can hold the whole Canvas.** `inline` remains the author's
  request. A person may also expand any Canvas of the thread in place. The
  expanded body is not a nested scroller by default: it grows with its
  content up to a large cap, and only a focused region (a board, a wide
  table, the expanded frame itself once the person has put focus there)
  takes the wheel. A board keeps ctrl/meta zoom. Folding to a card and
  opening the sidebar stay. The 12-block and sidebar-only refusals apply to
  the agent's unprompted inline request, not to a person's expand.
- **Diagrams stay structured and one layout.** Flowcharts are the generic
  `diagram` with a closed node-role and edge-style set (process, decision,
  terminator; tone, shape, stroke from theme tokens). Sequence, state, ER,
  swimlane, and mind map already exist and need visual polish, not a second
  engine. A Gantt is a typed reading of dated, dependent tasks — either a
  `timeline` extension or a `plan` view — laid out in domain. A map of zones
  is a grouped, styled diagram, not a geographic tile layer. Mermaid and
  PlantUML stay non-goals as renderers. A later translator that turns a
  Mermaid subset into these blocks is an import, not a second picture.
- **HTML generation stays the 0164 design.** A `design` may render in an
  expanded thread the same way it does in the sidebar: empty sandbox,
  fragment links, CSS-only interaction, no script. It still does not leave
  the host as markup. Do not open a scripted-artifact tier to win the
  in-thread document. That tier needs its own isolated origin, network
  policy, hang protection, and threat model
  (`canvas-scripted-artifact-v0`); it is a later, separately approved
  capability for prototypes that are programs, not documents.
- **Theming is the existing visual system.** New blocks use DESIGN.md tokens,
  light and dark, Geist, and the data-visualisation marks. Density is
  comfortable by default. Colour never carries a distinction alone.
- **Agents are taught the catalog.** `describe`, recipes, preview warnings,
  and trusted skill layouts name the new blocks and show a finished example.
  Validation already returns a reason the author can act on; new kinds do
  the same.
- **Shares, export, and budgets stay fail-closed.** Layout, styled diagrams,
  and Gantt travel in a share. A design and any future scripted artifact do
  not. Caps stay unless a named budget is raised in the same schema bump
  that needs it.

## Consequences

- A long answer can look finished and be browsed in the thread without
  sending a click back to the agent, and without giving the agent a program
  to run in the renderer.
- The catalog grows by contract. Agents that ignore `describe` will still
  write Markdown. Authoring guidance is part of the work, not a follow-up.
- 0010's remaining rules stand: closed catalog, host-authorized previews,
  versioned artifacts, local-first completeness. 0164 is unchanged for what
  a design may run. 0052's one-layout rule is unchanged.

## Alternatives considered

- **Let the agent write HTML and script in the thread.** Fastest visual
  match, and what a freeform in-thread mini-app appears to be. It reopens
  the isolated-origin work 0164 deferred, can hang the renderer, and cannot
  be shared or exported as the artifact. Rejected as the path for documents.
- **Grow only `design` and show it inline.** Covers finished screens, not a
  browsable spec with typed metrics, tables, and diagrams that share and
  export.
- **Import Mermaid as the diagram renderer.** Agents already write it, but
  it is a second layout and a foreign stylesheet. Rejected; keep one
  deterministic layout.

## Related

- [0010](0010-secure-preview-and-canvas.md) — the structured Canvas this extends
- [0052](0052-canvas-boards.md) — boards, comments, and the Mermaid non-goal
- [0080](0080-hand-off-writes-a-canvas-from-the-export-cut.md) — hand-off still writes the closed catalog
- [0164](0164-canvas-designs-are-html-in-a-frame-that-runs-nothing.md) — the design frame this does not script
- [Plan](../plans/canvas-rich-artifacts.md) — order of work
- [Threat model stub](../security/canvas-scripted-artifact-threat-model.md) — deferred scripted tier
