# Canvas universal artifact: screens, flows, decks, and code handoff

Status: Building (slice 1 of 5)
Size: Full — four Canvas capabilities that cross contracts, domain, server, and web.
Owner: Henrik · Started: 2026-10-28 · Approved: 2026-10-28, Henrik
Working assumptions: none

Planning only. Each slice updates the owning specifications
(`docs/design/canvas.md`, `docs/design/canvas-visuals.md`) in the same PR as its
implementation, per the repo's design workflow.

## 1. Requirements

### Sources

| ID  | Location                                                                                                                         | What it contributes                                                                                                                                                                                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | This conversation, 2026-10-28                                                                                                    | The ask: enhance Canvas to create UI mockups of web apps, websites, and mobile apps; be rich in features; make presentations and documents; "more like a big universal artifact". Henrik chose all four proposed slices ("All").                                     |
| S2  | github.com/DeepanshuMishraa/sheet (AGPL-3.0-or-later, a fork of lassejlv/loora)                                                  | Landscape only: a local-first infinite canvas of structured UI nodes, agent-editable over MCP, with drafts and one-way HTML/React-TSX/JSON/PNG export. Ideas only — the license and the originality rule forbid reusing its code, schemas, or distinctive structure. |
| S3  | `docs/design/canvas.md`, `docs/design/canvas-visuals.md`, `docs/architecture.md#canvas-documents-designs-and-prototypes`         | Current Canvas rules: the closed block catalogue, the three authoring tiers, schema and share version gates, export parity, and the recorded rationale against growing the typed catalog to chase looks.                                                             |
| S4  | `packages/contracts/src/canvas.ts`, `packages/domain/src/canvas*.ts`, `apps/web/src/canvas/blocks/*`, `apps/server/src/canvas/*` | Current implementation: the mockup catalog and budgets, the dashboard's reference-by-id and reading order, the diagram board, design frames and assets, preview warnings, exports, and the agent tools.                                                              |

### Requirements

| ID   | Requirement                                                                                                                                                                                                                                                                               | Priority | Acceptance criterion                                                                                                                                                                                                                                                                                                                                                                                                                                          | Sources    |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| FR-1 | A Canvas holds a `flow` block that places screens — a mockup block (optionally one variant) or a static design frame — as named nodes on a board, with labeled edges between them.                                                                                                        | Must     | Given three mockups and a design with two frames, a flow naming them validates and renders a board drawing each screen (its frame drawing, or the design frame itself, scaled into its node) with its edges and labels; a flow naming a block that is neither a mockup nor a design, a missing block, a nonexistent variant or frame, a repeated screen, or a design that runs script is refused with a typed reason; shares and every export carry the flow. | S1, S3, S4 |
| FR-2 | A flow edge may name a source hotspot — a node inside the source mockup from a closed interactive-component list — and Play presents the flow as a click-through prototype: named hotspots navigate to their targets, keyboard-operable, with back and exit, and no script runs anywhere. | Must     | In the played flow, activating a named hotspot shows the target screen; every hotspot is reachable by keyboard; a flow with a dangling hotspot node is refused at revision; a screen with no outgoing edge navigates nowhere.                                                                                                                                                                                                                                 | S1, S3     |
| FR-3 | Dragging a screen on the flow board journals a new version through the existing Canvas layout-revise path, admitted by a pure policy; a stale drag is refused and the renderer reloads.                                                                                                   | Must     | After a drag, a new `canvas.version-appended@1` version exists with actor `local-user`; a drag against a non-head sequence is refused with the existing stale-revision reason.                                                                                                                                                                                                                                                                                | S3, S4     |
| FR-4 | The mockup catalog grows by closed, inert components: search, breadcrumb, pagination, stepper, progress, slider, menu, footer, hero, map, media, chat, chat message.                                                                                                                      | Should   | Each new component renders in wireframe and styled fidelity, is named in the outline reading and every export, and a field it does not take is refused (`mockup-field-refused`).                                                                                                                                                                                                                                                                              | S1         |
| FR-5 | An image-capable mockup node may name a declared asset (generated image, Project file, browser capture) drawn inside the frame, resolved under the design-asset provenance rules.                                                                                                         | Should   | In Work, a declared Project-file image draws in the mockup; the same source in Chat is refused `design-asset-refused`; a missing asset draws the labelled placeholder and `preview` reports `design-asset-unavailable`.                                                                                                                                                                                                                                       | S1, S3     |
| FR-6 | A mockup block may define local components from its own subtree and place instances of them; every instance draws the same fixed subtree.                                                                                                                                                 | Should   | A block with one definition placed twice draws both instances identically; a dangling definition reference, a cycle (a definition instancing a definition), and an over-budget definition are each refused with a typed reason.                                                                                                                                                                                                                               | S1         |
| FR-7 | The export panel exports a mockup (each variant) as standalone semantic HTML and as a dependency-free TSX component, and a flow as one HTML page set whose screens link by real anchors matching the hotspots; output is deterministic and script-free.                                   | Should   | Exporting a two-mockup flow yields linked pages where a hotspot link navigates to the target page; no exported file contains a script or remote reference; the TSX form has no imports and inlines its styles; the same definition exports byte-identical output in both forms.                                                                                                                                                                               | S1, S2     |
| FR-8 | A Canvas holds a `deck` block naming slides in order — a design frame, a mockup screen, or a data block (metric, progress, status, chart, table, dashboard) — each with optional presenter notes, and Present walks the deck across blocks.                                               | Should   | A Canvas holding a slide design and a chart presents as one deck with arrow navigation and notes; Present on a plain design block keeps today's behavior; a deck naming a missing block or frame is refused.                                                                                                                                                                                                                                                  | S1, S3     |
| FR-9 | `describe` gains guidance and recipes for flows, decks, richer mockups, and realizing a mockup as a design frame, within the existing 6,000-byte budget.                                                                                                                                  | Should   | The `canvasAgentTools.test.ts` budget test passes with the new guidance; new recipes (an app flow, a data deck) appear in the Create panel and in unscoped describe.                                                                                                                                                                                                                                                                                          | S1, S3     |

| ID    | Requirement                                                                                                                                                                                 | Priority | Notes                                                         |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------- |
| NFR-1 | Every new block kind or field is a Canvas schema bump (the next free version at each slice: 23, 24, 25) and a share bump (12, 13, 14); an older runtime refuses it as a future version.     | Must     | Existing gate pattern; D-8 corrects the numbers against main. |
| NFR-2 | Flow and deck reading order and layout are pure functions in `packages/domain`; the renderer, artifact SVG, Markdown and HTML export, and shares draw the same result.                      | Must     | Existing determinism pattern.                                 |
| NFR-3 | No new authority: flows and decks reference blocks only; image fills resolve under the thread's existing mode and Project authority; no new file, shell, network, or frame-sandbox surface. | Must     | Design-asset precedent.                                       |
| NFR-4 | New components are inert named tree parts; the board keeps the diagram board's keyboard model; click-through is keyboard-operable.                                                          | Must     | Mockup accessibility rules.                                   |
| NFR-5 | `preview` warns on dangling or absent references, unreachable screens, and a missing variant, whether or not a picture was taken.                                                           | Should   | Warnings are computed from the document.                      |
| NFR-6 | Exported files carry no script and load nothing; click-through runs in the app renderer, not a frame.                                                                                       | Must     | Export containment.                                           |

| ID    | Constraint                                                                                                                                            | Source                      |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| CON-1 | No Sheet code, schemas, or distinctive structure may enter Octant (AGPL-3.0 plus the repo originality rule). Ideas and observed capability gaps only. | S2, AGENTS.md               |
| CON-2 | The mockup stays a closed catalog of inert components carrying typed fields only — no markup, styles, or script.                                      | S3                          |
| CON-3 | Chasing looks stays in design frames; the typed catalog grows only for structure and reuse.                                                           | S3 (architecture rationale) |
| CON-4 | Local-first: no hosted service beyond the existing public Canvas share service; no new external calls.                                                | AGENTS.md                   |
| CON-5 | Repo code style: strict TS, branded ids, `readonly` boundaries, oxfmt/oxlint, no `any` or `!`.                                                        | AGENTS.md                   |

| ID    | Assumption                                                                                                                                                                                                       |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ASM-1 | The design player (Present/Play dialog) can be generalized to walk an arbitrary slide list, not only one design's frames. Verified in slice 5's detailed design before any player change.                        |
| ASM-2 | The export panel's existing file-set flow (approval card, numbering, replace-exact-files) can carry generated HTML forms without a new browser surface: the HTML export is generated from typed data, not drawn. |

### Traceability

| Source                                                                              | Disposition                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S1 (mockups of web/mobile apps, richer features)                                    | FR-1, FR-2, FR-4, FR-5, FR-6                                                                                                                                                                                 |
| S1 (presentations, documents, universal artifact)                                   | FR-8 (decks); documents are current shipped behavior, no new FR                                                                                                                                              |
| S1 ("All" — the four proposed slices)                                               | Scope In below                                                                                                                                                                                               |
| S2 (infinite positioned canvas)                                                     | Rejected as a shape; its observable gap (screens composed spatially, typed click-through, one-way code export) is covered by FR-1, FR-2, FR-7 under our reference-board model. No code or structure (CON-1). |
| S2 (drafts + merge)                                                                 | Out (scope)                                                                                                                                                                                                  |
| S3 (tier doctrine, version gates, export parity)                                    | NFR-1, NFR-2, NFR-3, CON-2, CON-3                                                                                                                                                                            |
| S4 (dashboard reference-by-id, reading order, layout-revise, design assets, player) | The reuse substrate cited by FR-1, FR-3, FR-5, FR-8; no new FR against existing behavior                                                                                                                     |

### Dependencies

FR-2 and FR-3 need FR-1. FR-8 leans on ASM-1. FR-9 lands incrementally with each
slice and is complete only when FR-1 through FR-8 are.

## 2. Scope

- In: FR-1 … FR-9, NFR-1 … NFR-6.
- Out: freehand/vector drawing and arbitrary free placement — ruled out with
  the four-slice proposal Henrik approved, 2026-10-28 (fights the
  deterministic-layout principle); Sheet-style drafts/merge for a Canvas —
  ruled out same date (no current pain).
- Later: click-through Play over shares and public links — ruled in-app for
  now, Henrik 2026-10-28 (Q-3); PDF/PNG export of a mixed deck (only design
  frames have a per-frame sheet export today).

## 3. Conceptual design

### Purpose

Canvas becomes the single artifact an agent and a person shape together for
anything visual and structured: data documents, UI screens, the flows between
screens, decks that present any of it, and a one-way bridge from screen to
code. It pointedly does not become a free-form design editor: screens keep one
definition, boards compose references, and the look of a finished design keeps
living in design frames.

### Context map

```
            person (window)                 agent (thread tool)
                  │ create/revise,                │ octant_canvas:
                  │ layout-revise, comments,      │ describe/create/revise/read/preview
                  │ export, share, Play/Present   v
   paired device ─┼────────────► host canvas service ──► version journal
   (reads; no    │                    │
   drags)         │                    ├─ design-asset resolution (provenance, confinement)
                  ▼                    ▼
            export files          share snapshot / public link
            (MD/HTML/PNG/PDF)     (share service, off by default)
```

Trust boundaries and top threats:

- Agent tool input → typed, budgeted values validated by pure policies; the
  threat is malformed or dangling references, answered by typed refusals
  rather than lenient drawing (tampering).
- Declared assets → resolved under the version's provenance like design
  assets; the threat is authority bypass (a Chat Canvas naming a Project
  file), answered by the existing `design-asset-refused` path (elevation).
- Files and snapshots leaving the host → typed data only, secret filter,
  script-free generated HTML; the threat is disclosure, answered because no
  new markup crosses the boundary that the filter cannot read (disclosure).
- Play click-through → runs in the app renderer over typed data; no frame, no
  script, no ticketed page (elevation, denial of service).

### Capabilities

| Capability                                                            | FR IDs           |
| --------------------------------------------------------------------- | ---------------- |
| Compose screens into flows and walk them                              | FR-1, FR-2, FR-3 |
| Draw richer screens within the closed catalog                         | FR-4, FR-5, FR-6 |
| Hand screens off as code and as linked pages                          | FR-7             |
| Present any Canvas as one deck                                        | FR-8             |
| Teach agents the new surface                                          | FR-9             |
| Keep the artifact versioned, deterministic, and accessible everywhere | NFR-1 … NFR-6    |

### Components

| Component                                                            | Responsibility                                                                   | Requirement IDs                     |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------- |
| Flow policy and layout (`packages/domain`)                           | Validate screens, edges, hotspots; one pure board layout; reading order          | FR-1, FR-3, NFR-2, NFR-5            |
| Deck policy (`packages/domain`)                                      | Validate the slide list; slide reading order                                     | FR-8, NFR-2                         |
| Mockup catalog (`packages/contracts`, `packages/domain`, `apps/web`) | New components, image fills, reusable definitions, outline readings              | FR-4, FR-5, FR-6, NFR-4             |
| Canvas export (`packages/domain`, `apps/server`)                     | Script-free HTML from typed data: per-variant mockup pages, linked flow page set | FR-7, NFR-6                         |
| Canvas renderer (`apps/web`)                                         | Flow board, click-through Play, deck Present, new component drawing              | FR-1, FR-2, FR-4, FR-6, FR-8, NFR-4 |
| Agent tools (`apps/server`)                                          | Describe guidance, recipes, preview warnings, revision admission                 | FR-9, NFR-5, NFR-1                  |

### Domain concepts

- **Screen** — a flow node: one mockup block at a chosen variant (absent means
  its single frame), or one static frame of a design block. A screen is a
  reference; the mockup or design owns the content.
- **Hotspot** — a node inside the source mockup, from a closed
  interactive-component list, that a flow edge names as the thing the person
  taps. Not a coordinate: it survives revision and anchors comments.
- **Slide** — a deck entry: a design frame, a mockup screen, or a data block,
  each with optional presenter notes.
- **Flow** — screens plus labeled edges; the board is one deterministic
  layout of that graph.
- **Deck** — an ordered slide list; Present is a reading of it.

## 4. Logical design

### Component contracts

- **Flow/deck policy** (pure, sync): given a document, returns typed refusals
  (`flow-screen-kind-refused`, `dangling-flow-screen`,
  `duplicate-flow-screen`, `flow-screen-placed-twice`, `dangling-flow-edge`,
  `flow-hotspot-refused`, `flow-edge-self`, `deck-slide-kind-refused`,
  `dangling-deck-slide`, `duplicate-deck-slide`, budget codes) or admits it.
  Guarantee: a document it admits draws identically on every surface (NFR-2).
- **Flow layout** (pure, sync): given a flow, returns node positions, edges,
  and edge routings that the board, artifact SVG, and HTML export share;
  accepts journaled position overrides like the diagram layout does.
- **Reading order** (pure, sync): extends `canvasReadingOrder` so a flow's and
  a deck's referenced blocks read inside their block, not again at their own
  position, exactly as dashboards place cells.
- **Mockup outline** (pure, sync): extends to instances (a definition's
  subtree read once per placement) and image fills (the asset read as
  "image: <id>", never bytes).
- **Renderer**: draws the board (diagram-board interaction, mockup frame
  drawing per screen), runs click-through (view state only, journals nothing),
  draws new components, walks decks in the player. Guarantees: inert parts,
  keyboard operation, no version written from Play or Present.
- **Export service**: generates HTML from typed data (no browser, no script);
  flows the files through the existing file-set approval. A share snapshot
  carries flows and decks as typed blocks at their share versions.
- **Preview service**: adds pure warnings for dangling references, unreachable
  screens, and missing variants; picture-taking is unchanged.

### Domain model

```
FlowBlock {
  kind: "flow"; title
  screens: 1..24 × { screenId, blockId,
                    variantId? (a mockup), frameId? (a design frame) }
  edges:   0..96 × { edgeId, fromScreenId, toScreenId,
                     fromNodeId?, label? (≤80), tone? (diagram tones) }
}
DeckBlock {
  kind: "deck"; title
  slides: 2..64 × { slideId, blockId, frameId?, variantId?, notes? (≤2,000) }
}
MockupBlock gains:
  assets?:      1..12 × { assetId, source: generated-image | project-file | browser-capture }
  definitions?: 1..8 × { defId, label, nodes: 1..24 }   // counted in the 160-node budget
node gains:   assetId? (image-capable components), defId? (component "instance")
new components: search, breadcrumb, pagination, stepper, progress, slider,
                menu, footer, hero, map, media, chat, chat-message
```

Invariants: unique screen/slide ids; every edge and slide names a block the
document holds; a mockup screen names at most one variant (absent is its single
frame), a design screen names one frame of a design that runs no script, and a
block never appears as two screens; a hotspot names a node of the source
screen's mockup from the interactive-component list, so an edge from a design
screen carries no hotspot (it is a screen-level link); a mockup is placed in at
most one flow, a block in at most one deck (the dashboard's placed-once rule
extends to decks); definitions are acyclic and their nodes counted once; the
same asset rules as designs (a Chat Canvas refuses project-file and
browser-capture sources). A design screen's node size is its frame's declared
viewport (phone 390×844, tablet 820×1180, desktop 1440×900, slide 1920×1080),
so the board layout stays pure.

Lifecycle: a flow or deck is authored and revised like any block (version
append); Play state and the open slide are view state and journal nothing;
dragging a screen is the one person interaction that journals, as on diagram
boards.

### Data ownership

| Datum                      | Owner                              | Readers                                     |
| -------------------------- | ---------------------------------- | ------------------------------------------- |
| Screen content             | The mockup block                   | Flow, renderer, exports, share              |
| Flow graph and deck list   | The flow/deck block                | Renderer, exports, share                    |
| Journaled screen positions | The version journal                | Board layouts                               |
| Asset bytes and resolution | Host asset routes under provenance | Renderer (data-inlined), export placeholder |
| Play/Present state         | The renderer only                  | Nobody; never journaled                     |

### Integration

- Renderer → `/api/canvas/layout-revise` (exists; the admission policy learns
  flows), request/response, renderer commands, journal authoritative.
- Renderer → design-asset route (exists; learns mockup blocks as requesters).
- Export panel → export file-set port (exists; new HTML forms ride it).
- Agent tools → describe/recipes (exist; extended), preview → warnings list
  (exists; extended).
- Share snapshot → share schema versions (bumped per slice).

### Scenario walkthroughs

1. **Agent authors an app flow.** Agent calls `describe` (guidance: mock the
   screens, then connect them in a flow) → `create` with mockups and a flow →
   policy admits the flow (FR-1) → `preview` returns warnings; a screen that
   no edge reaches is reported unreachable (NFR-5) → the thread shows the
   Canvas in the sidebar, device-size and flow always sidebar (existing rule).
   Exercises FR-1, FR-9, NFR-1, NFR-5.
2. **Person walks the prototype and comments.** Person opens the Canvas →
   Play on the flow → taps a named hotspot, the target screen shows; Back and
   Esc work; keyboard reaches every hotspot (FR-2, NFR-4) → person drags a
   screen into place; layout-revise journals `local-user` version (FR-3) →
   person comments on an edge and sends it to the agent; the existing
   comment-to-agent turn revises under thread authority (no new authority,
   NFR-3). Exercises FR-2, FR-3, NFR-3, NFR-4.
3. **Person exports the flow as a site.** Export panel → HTML page set → the
   service generates one script-free page per screen, anchors matching the
   hotspots (FR-7, NFR-6) → files flow through the existing approval card and
   file-set numbering (ASM-2) → a second export of the same version is
   byte-identical (NFR-2). Exercises FR-7, NFR-2, NFR-6.
4. **Agent builds a deck from data.** Agent authors a slide design and a
   chart, then a deck naming the design's frames and the chart with notes
   (FR-8) → policy refuses a deck naming a block twice (placed-once) →
   person presses Present; the player walks slides across blocks, notes on
   `N` (FR-8, ASM-1) → Present on a plain design block is unchanged.
   Exercises FR-8, NFR-1.
5. **Share carries the new blocks.** A Canvas with a flow, a deck, and
   filled mockups is shared → share version 12/13/14 carries the new blocks
   as typed data; the snapshot viewer draws the board and slides; an older
   runtime refuses it as a future version (NFR-1) → the secret filter reads
   typed values only, so no new markup acknowledgement is needed (NFR-3).
   Exercises NFR-1, NFR-2, NFR-3.

### NFR mechanisms

| NFR    | Mechanism                                                                                                                      | Arithmetic / argument                                                                                                                                                                         | Numeric       |
| ------ | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| NFR-1  | Version-gate constants per slice (`CANVAS_FLOW_SCHEMA_VERSION = 22`, deck 24; share max bumped in step), existing refusal path | Structural; the strict schema refuses unknown fields already                                                                                                                                  | No            |
| NFR-2  | Pure layout + reading-order functions with snapshot tests, shared by every surface (existing pattern)                          | 24 screens ≤ a design's frame budget; 96 edges < the 1,024-edge diagram budget the board engine already lays out; every screen size is a declared viewport, so layout needs no measured value | No            |
| NFR-3  | No new routes with authority; image fills ride the design-asset resolution unchanged; flows/decks hold references only         | Nothing new crosses a trust boundary except typed data the filter already reads                                                                                                               | No            |
| NFR-4  | Inert named tree parts (existing mockup rules); board keyboard model reused; click-through is focusable React, not a frame     | Same mechanism the catalog already proves                                                                                                                                                     | No            |
| NFR-5  | Pure document checks added to the existing warnings list; computed without a browser like layout warnings today                | Warnings are bounded per block (≤ one per dangling reference)                                                                                                                                 | No            |
| NFR-6  | Generated HTML from typed data by a pure function; test asserts no `<script>`, no remote reference, byte-identical reruns      | Generation needs no browser (ASM-2), so no new network surface exists                                                                                                                         | No            |
| Budget | Describe guidance trimmed as it grows; the 6,000-byte test is the guard                                                        | A rule added is a rule trimmed (existing rule)                                                                                                                                                | Yes (6,000 B) |

### Risk register

- **ASM-1 (player generalization)** is the least-precedented change: the
  player is built around one design's frames. Slice 5's detailed design
  verifies it before player code changes; if it fails, decks fall back to
  design-frame-only slides and the rest of the work is unaffected.
- **Design screens on the board**: a design screen draws as its live frame
  inside a zoom/pan board node, lazy-loaded with the same in-view rule the
  document's design board uses (D-7). Up to 24 sandboxed frames is heavier
  than the document flow, though well inside what a 24-frame design block
  already loads; the board virtualizes like diagram boards if it needs to.
  Every other surface stays pure: layout uses declared viewports, and
  exports draw design screens through the existing design paths (titles in
  Markdown, pages as written in HTML).
- **Board drawing weight**: a flow draws up to 24 mockup frames; the artifact
  SVG path already draws a frame per variant, so the drawing exists, but the
  interactive board should virtualize like diagram boards if frames push it.
- **Describe budget pressure**: four slices of new guidance in 6,000 bytes;
  mitigated by recipes carrying the shapes and describe pointing at them.
- **Scope drift toward a design editor**: instance overrides, per-node
  styling, and free placement are the pull; CON-2 and CON-3 are the guard, and
  review should treat any such proposal as a new design question.

## 5. Decisions

### D-1: A flow places references, not copies (Accepted, 2026-10-28)

Context: a flow must survive mockup revisions and share one screen definition
across surfaces (FR-1). Options: (a) copy screen content into the flow; (b)
reference blocks by id, the dashboard's precedent. Choice: (b). Consequences:
the reading-order rule extends (a placed mockup reads in its flow); a mockup
placed in two flows is refused; flows stay cheap (references only) inside the
128-block budget.

### D-2: Click-through is typed link data; the script tier stays out of it (Accepted, 2026-10-28)

Context: interactivity exists today only in running design frames (script,
prototype host). Options: (a) teach prototypes to script navigations; (b) put
the link on the edge as data and let the renderer walk it. Choice: (b). It is
the lowest tier that delivers the result, adds no frame, no ticket, no host
process, exports to real anchors, and stays comment-anchored and
revision-safe. Consequences: click-through is bounded to what typed data says
(a hotspot navigates; no data entry) — richer behaviour remains the design
tier's job.

### D-3: Mockup growth is closed-catalog structure, not looks (Accepted, 2026-10-28)

Context: the architecture rationale rejects growing the typed catalog to chase
appearance. Options: (a) open styling per node; (b) add components, reuse,
and image fills while the look stays theme-driven. Choice: (b). Consequences:
a finish a closed component cannot express stays a design frame's job; the
catalog list is version-gated so older runtimes refuse the blocks.

### D-4: Code handoff is one-way generated export; no import, no new agent surface (Accepted, 2026-10-28)

Context: Sheet's one-way export is the right idea in the wrong license.
Options: (a) a bidirectional code↔canvas format; (b) pure generation from
typed data into the export panel. Choice: (b). Consequences: no round-trip
contract to maintain; the agent bridge is describe guidance (realize the
mockup as a design frame), not a tool.

### D-5: A deck references block surfaces; placed-once extends to decks (Accepted, 2026-10-28)

Context: a deck must mix design frames, mockups, and data blocks with one
Present (FR-8). Choice: reference by id, order-only; a block placed in a deck
reads there, mirroring the dashboard rule, so comments and revisions keep one
home per block. Consequences: Present on a plain design block is unchanged;
export parity for mixed decks is a Markdown/HTML reading first (PDF per-slide
export stays design-frames-only, Later).

### D-6: Slice 1 limits flow screens to mockups (Superseded by D-7, 2026-10-28)

Context: a design frame as a screen needs a thumbnail or live-frame story
inside a board node. Proposed mockups only first; the maintainer chose
otherwise.

### D-7: Design frames join flows as screens in slice 1 (Accepted, 2026-10-28)

Context: website flows are mostly design frames, so mockup-only flows would
serve the headline use badly (Q-1). Options: (a) mockups first, design frames
later; (b) both in slice 1, the board drawing a design screen as its live
frame. Choice: (b), Henrik 2026-10-28. Consequences: slice 1 grows the
live-frame-in-board rendering, lazy-loaded with the document board's in-view
rule and scaled into the node; a design named as a screen must run no script
(a running design is the prototype tier and keeps its own Play); exports draw
design screens through the existing design paths, and the flow HTML page set
links across the exported pages. Supersedes D-6.

## 6. Coverage

| Requirement | Capability         | Component                               | Slice             |
| ----------- | ------------------ | --------------------------------------- | ----------------- |
| FR-1        | Compose flows      | Flow policy/layout, renderer, contracts | 1                 |
| FR-2        | Compose flows      | Renderer, flow policy                   | 2                 |
| FR-3        | Compose flows      | Layout-revise admission, renderer       | 1                 |
| FR-4        | Richer screens     | Mockup catalog (contracts/domain/web)   | 3                 |
| FR-5        | Richer screens     | Asset resolution, catalog, renderer     | 3                 |
| FR-6        | Richer screens     | Mockup catalog                          | 3                 |
| FR-7        | Code handoff       | Export service, domain generation       | 2, 4              |
| FR-8        | Present any Canvas | Deck policy, player                     | 5                 |
| FR-9        | Teach agents       | Agent tools                             | 1–5 (incremental) |
| NFR-1       | Cross-cutting      | Contracts version gates                 | 1, 3, 5           |
| NFR-2       | Cross-cutting      | Domain layouts + tests                  | 1, 3, 5           |
| NFR-3       | Cross-cutting      | Asset resolution, typed references      | 1, 3              |
| NFR-4       | Cross-cutting      | Catalog, renderer                       | 2, 3              |
| NFR-5       | Cross-cutting      | Preview warnings                        | 1, 3              |
| NFR-6       | Cross-cutting      | Export generation                       | 2, 4              |

## 7. Build plan

| Slice | What it delivers                                                                                                                                                                                                       | Requirement IDs                        | Status                                 |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------- |
| 1     | `flow` block: schema 23, policies, pure layout, board drawing (mockup frames and design frames as live nodes), comment anchors, reading order, MD/HTML/SVG export parity, share v12, preview warnings, journaled drags | FR-1, FR-3, NFR-1, NFR-2, NFR-3, NFR-5 | In review (#1830); rendered QA pending |
| 2     | Click-through Play over the flow; flow HTML export as one linked, script-free page set (D-9: one self-contained site)                                                                                                  | FR-2, FR-7 (flow part), NFR-4, NFR-6   | In review (#1832); rendered QA pending |
| 3     | Mockup catalog: new components, image fills, reusable definitions — schema 24, share v13                                                                                                                               | FR-4, FR-5, FR-6, NFR-5                | In review (#1839); rendered QA pending |
| 4     | Per-variant mockup HTML and TSX export; describe guidance and recipes for everything above                                                                                                                             | FR-7 (rest), FR-9                      | Planned                                |
| 5     | `deck` block: schema 25, share v14, player integration, deck recipes                                                                                                                                                   | FR-8, FR-9                             | Planned                                |

Each slice rides its own `feature/*` branch and PR to `main`, updates the
owning specifications in the same PR, and runs the verification the AGENTS
table scopes (server route/persistence tests, rendered QA at the visual
boundaries, `bun run verify` where the slice crosses shared infrastructure).
Slice 1 is the riskiest contract (reference placement across kinds with
version gates and export parity) and comes first; the plan is a sequence of
independent-outcome PRs, not a stack, unless a slice proves dependent.

## 8. Open questions

| ID  | Question                                                         | Ruling                                                                              |
| --- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Q-1 | Should design frames join flows as screens in slice 1, or later? | Include design frames early — Henrik, 2026-10-28 (D-7 supersedes D-6).              |
| Q-2 | HTML only, or also a TSX export form?                            | Add a dependency-free TSX component per mockup variant — Henrik, 2026-10-28 (FR-7). |
| Q-3 | Should click-through Play also run over shares and public links? | In-app only for now — Henrik, 2026-10-28 (Later).                                   |

No open questions remain.

## 9. Detailed design

### Slice 1: the `flow` block

Numbers corrected against `origin/main`: Canvas schema 22 is taken (chart
callouts), so the flow block is **Canvas schema version 23** and the share
carry is **share version 12** (see D-8).

#### Modules

| Module                                                                                                     | Job                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/canvas.ts`                                                                         | `CanvasFlowBlock`, `CanvasFlowScreen`, `CanvasFlowEdge`, budgets, `CANVAS_FLOW_SCHEMA_VERSION = 23`, the block union, the declared-version gate |
| `packages/domain/src/canvasFlowLayout.ts` (new)                                                            | `layoutCanvasFlow`: the pure board layout, one result every surface draws                                                                       |
| `packages/domain/src/canvasPolicy.ts`                                                                      | `validateFlows`, the placed-once extension, structural budget inference                                                                         |
| `packages/domain/src/canvasDashboardLayout.ts`                                                             | Reading order learns that a flow places its screens                                                                                             |
| `packages/domain/src/canvasBoardPolicy.ts`                                                                 | `admitCanvasDiagramLayoutRevision` admits flow drags                                                                                            |
| `packages/contracts/src/canvasShare.ts` + `packages/domain/src/canvasShareSnapshotPolicy.ts`               | Share version 12 carries the flow                                                                                                               |
| `apps/server/src/canvas/canvasAgentTools.ts`                                                               | Describe's catalog, tiers, and guidance mention flows within the 6,000-byte budget                                                              |
| `apps/server/src/canvas/canvasDocumentRecipes.ts` + `packages/domain/src/canvasRecipeStarter.ts`           | The `app-flow` recipe and its starter blocks                                                                                                    |
| `apps/server/src/canvas/canvasPreviewWarnings.ts`                                                          | The `flow-unreachable-screen` warning                                                                                                           |
| `apps/server/src/canvas/artifactRender.ts`, `artifactDocumentRender.ts`                                    | The flow's SVG thumbnail and Markdown/HTML reading                                                                                              |
| `apps/web/src/canvas/blocks/FlowBoard.tsx` (new) + `MockupBlock.tsx`, `DesignBlock.tsx`, `CanvasBlock.tsx` | The board; a single-variant mockup frame drawing and a single design frame drawing become reusable so board nodes draw real screens             |

#### Interfaces

**Schema.** `screenId` is a `CanvasNodeId` and `edgeId` a `CanvasEdgeId`, so
node and edge comment anchors work unchanged.

```ts
export const CANVAS_FLOW_SCHEMA_VERSION = 23;
export const CANVAS_MAX_FLOW_SCREENS = 24;
export const CANVAS_MAX_FLOW_EDGES = 96;
export const CANVAS_MAX_FLOW_LABEL_LENGTH = 80;
// The mockup components a hotspot may start from: button, list-row, nav,
// tabs, select, checkbox, toggle. (Slice 3's menu, pagination, stepper,
// slider, search join here.)
export const CANVAS_FLOW_HOTSPOT_COMPONENTS = [...] as const;

export const CanvasFlowScreen = Schema.Struct({
  screenId: CanvasNodeId,
  blockId: CanvasBlockId,
  /** One variant of a mockup; absent is its single frame. */
  variantId: Schema.optional(CanvasMockupVariantId),
  /** One frame of a design that runs no script; required when blockId is a design. */
  frameId: Schema.optional(CanvasDesignFrameId),
  x: Schema.optional(FiniteNumber),
  y: Schema.optional(FiniteNumber),
  positioned: Schema.optional(Schema.Literal(true)),
}).annotations(strict);

export const CanvasFlowEdge = Schema.Struct({
  edgeId: CanvasEdgeId,
  fromScreenId: CanvasNodeId,
  toScreenId: CanvasNodeId,
  /** The hotspot: a node of the from-screen's mockup, from the interactive list. */
  fromNodeId: Schema.optional(CanvasNodeId),
  label: Schema.optional(boundedNonEmptyText(CANVAS_MAX_FLOW_LABEL_LENGTH)),
  tone: Schema.optional(CanvasDiagramTone),
}).annotations(strict);

export const CanvasFlowBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("flow"),
  title: CanvasLabel,
  layout: Schema.optional(CanvasDiagramLayoutKind), // "manual" after a drag
  screens: Schema.Array(CanvasFlowScreen).pipe(
    Schema.minItems(1), Schema.maxItems(CANVAS_MAX_FLOW_SCREENS)),
  edges: Schema.Array(CanvasFlowEdge).pipe(Schema.maxItems(CANVAS_MAX_FLOW_EDGES)),
}).annotations(strict);
```

The gate follows the house pattern: `{ kind: "flow", since: 23 }` in
`VERSION_GATED_BLOCK_KINDS`, 23 in `SUPPORTED_CANVAS_SCHEMA_VERSIONS` and the
`CanvasSchemaVersion` literal, and a `declaredSchemaRejection` check that a
document declaring less than 23 is refused as a future version.

**One literal example.** A `revise` that adds a flow to a Canvas holding the
mockup `search-mockup` (variant `loaded`) and the design `site-design` (frame
`results`):

```json
{
  "kind": "canvas-revise",
  "blocks": [
    {
      "blockId": "search-mockup",
      "kind": "mockup",
      "title": "Search",
      "device": "phone",
      "nodes": [/* … */]
    },
    {
      "blockId": "site-design",
      "kind": "design",
      "title": "Site",
      "size": "desktop",
      "frames": [/* … */]
    },
    {
      "blockId": "app-flow",
      "kind": "flow",
      "title": "Search flow",
      "screens": [
        { "screenId": "search", "blockId": "search-mockup", "variantId": "loaded" },
        { "screenId": "results", "blockId": "site-design", "frameId": "results" }
      ],
      "edges": [
        {
          "edgeId": "run-search",
          "fromScreenId": "search",
          "toScreenId": "results",
          "fromNodeId": "search-button",
          "label": "Run search"
        }
      ]
    }
  ],
  "expectedSequence": 3
}
```

Accepted: a new version at sequence 4 whose definition decodes. Refused:
`flow-hotspot-refused` if `search-button` is a `text` node (not interactive),
`flow-screen-frame-missing` if the design holds no frame `results`.

**Policy refusals** (`validateFlows`, thrown as `CanvasPolicyRejected`):
`dangling-flow-screen` (a block the document lacks),
`flow-screen-kind-refused` (neither mockup nor design),
`flow-screen-variant-missing` (a variant the mockup does not declare),
`flow-screen-frame-missing` (a design screen without `frameId`, or a frame the
design does not hold), `flow-screen-design-refused` (a design that runs
script), `duplicate-flow-screen` (a `screenId` twice),
`duplicate-flow-edge`, `dangling-flow-edge`, `flow-edge-self`,
`flow-hotspot-refused` (a `fromNodeId` that is not a node of the from-screen's
mockup, whose component is not in the interactive list, or that sits on a
design screen), and the budget codes `flow-screens-budget-exceeded` and
`flow-edges-budget-exceeded`. `validatePlacedOnce` gains the flow's screen
`blockId`s, so the existing `block-placed-twice` also covers a mockup placed
by a flow and a dashboard (one block, one drawing, one comment home);
`inferStructuralBudgetCode` learns the two flow budgets so the author hears
the right code before decode.

**Layout.** `layoutCanvasFlow(flow, screenSizes): CanvasFlowLayout` is pure
and deterministic. Each screen has an intrinsic size: a mockup's device size
(`CANVAS_MOCKUP_DEVICE_SIZE`, or its `custom` size) or a design frame's
viewport (`phone` 390×844, `tablet` 820×1180, `desktop` 1440×900, `slide`
1920×1080). Screens draw at a board scale: as wide as their size allows,
capped at the widths the design board already uses (440px for a desktop or
slide, 260 tablet, 200 phone) and never wider than the column, so the result
needs no measured value. Auto screens rank by edge topology (breadth-first
from screens with no incoming edge, in declaration order) and lay left-to-right
with one band per rank; a `positioned` screen sits at its `x`/`y`, and
`layout: "manual"` makes positioned screens authoritative, as the diagram
layout does. Edges route as elbows between screen boxes, stepping out beside a
box they would cross. Output:
`{ screens: [{ screenId, x, y, width, height, scale, label }], edges: [{ edgeId, points, label, tone, hotspot }], width, height }`.
`hotspot` names the from-node so the renderer can draw the link from the
control itself.

**Board admission.** `admitCanvasDiagramLayoutRevision` (the wire event and
command names are unchanged; the spec text renames the policy's target from
"must be a diagram" to "must be a board, a diagram or a flow") admits a flow
target: each position must name a `screenId` the flow holds (else the
existing `unknown-node`), the positions apply as `x`/`y`/`positioned` with
`layout: "manual"`, and the revised definition revalidates whole. No new
denial code: a target that is neither a diagram nor a flow keeps
`not-a-diagram` with a message that says "board".

**Reading order and exports.** `canvasReadingOrder` gains a `flow` item: the
flow reads where it sits, its placed blocks are skipped at their own
positions, and its reading is the graph — the title as a heading, one line
per screen (its label, then the mockup outline reading or the design frame
title), then the edges ("Search — Run search → Results" with the hotspot's
component). The artifact SVG thumbnail draws the layout scaled into the band
(mini frames and elbow edges, like the diagram thumbnail); the Markdown/HTML
document renderer writes the reading above; design markup never travels in a
reading.

**Preview.** `preview` adds one warning kind: `flow-unreachable-screen`, for
a screen no edge reaches and that is not the flow's first screen. Design
screens on the board are iframes the preview page draws, so the existing
`design-frame-overflow` and `design-contrast-below-target` warnings reach them
through the same bridge.

**Describe and recipes.** Unscoped describe gains `flow` in the closed catalog
with one line, a tier-list mention (typed blocks carry data; a flow carries
the structure between screens), and a request mapping ("an app or site flow
→ mock the screens, then connect them in a flow"). The 6,000-byte
`canvasAgentTools.test.ts` budget is the guard; guidance is trimmed elsewhere
to pay for it. Scoped `describe` for kind `flow` returns the canonical schema.
The `app-flow` recipe: a title heading and a `flow` slot whose starter
callout names what it waits for, matching the recipe-starter pattern.

**Share.** Share version 12 (`CANVAS_SHARE_SCHEMA_VERSION = 12`,
`CANVAS_SHARE_MAX_BLOCK_SCHEMA_VERSION = 23`) carries the flow whole: it is
typed data with no markup and no source ids. Whether 12 must also carry the
chart callouts of Canvas 22 is resolved against `canvasShareSnapshotPolicy`
when implementing and recorded under Codebase deltas.

**Renderer.** `FlowBoard` follows `DiagramBoard`'s interaction exactly: zoom
(0.25–4, `+`/`-`), pan, fit (`0`), focusable nodes with arrow-key nudge, and a
finished drag handed to the host through the same layout runtime (absent on a
shared snapshot or paired browser: zoom and pan still work). The board is a
positioned surface over an SVG edge layer: a mockup screen draws its variant
through a reusable single-frame mockup drawing (extracted from `MockupBlock`,
which keeps rendering all its variants from the same piece); a design screen
draws as its live scaled `srcdoc` frame with the theme and asset runtimes
`DesignBlock` already takes, lazy-loaded when it or its neighbour is in view,
as the design board loads today. A design that runs script is never a screen,
so no running frame, ticket, or prototype host is involved. Screen labels sit
under their frames; edge labels sit on the line; tones are theme roles. Node
comment markers anchor by `screenId`, edge markers by `edgeId`, through the
existing comment runtime.

#### Data changes

No storage beyond the existing version journal: a flow is a block in a
version's definition, and drags mint versions through the existing
layout-revise path. No migrations.

#### Failure modes

- A drag against a moved sequence: refused `stale-version`, the board
  reloads (existing behavior).
- A placed block deleted by a later revision: impossible in one revise (the
  policy revalidates the whole definition); a comment on a gone screen stays
  and reads as no longer on the canvas (existing anchor behavior).
- A design asset that fails to resolve: the labelled placeholder and the
  existing `design-asset-unavailable` warning; the board keeps the frame.

#### Tests

| Criterion           | Test                                                                                                                                   | Type      | Location                                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------ |
| FR-1 schema + gates | flow decodes at 23; declaring 22 with a flow is a future version                                                                       | contract  | `packages/contracts/src/canvas.test.ts`                                                                            |
| FR-1 refusals       | each `validateFlows` code refused with its reason; placed-once across flow and dashboard                                               | unit      | `packages/domain/src/canvasPolicy.test.ts`                                                                         |
| FR-1 layout         | deterministic snapshot; manual positions honored; edges route past boxes                                                               | unit      | `packages/domain/src/canvasFlowLayout.test.ts`                                                                     |
| FR-1 reading        | a flow's screens read inside it; placed blocks skip their own position                                                                 | unit      | `packages/domain/src/canvasDashboardLayout.test.ts`                                                                |
| FR-3 drags          | flow drag admitted and journaled; stale refused; unknown screen refused                                                                | unit      | `packages/domain/src/canvasBoardPolicy.test.ts` + route coverage in `apps/server/src/canvas/canvasService.test.ts` |
| NFR-1 shares        | share 12 carries a flow; share 11 refuses it as future                                                                                 | unit      | `packages/domain/src/canvasShareSnapshotPolicy.test.ts`                                                            |
| NFR-5 preview       | unreachable screen warned with and without a picture                                                                                   | unit      | `apps/server/src/canvas/canvasPreviewWarnings.test.ts`                                                             |
| FR-9 describe       | catalog lists flow; budget holds                                                                                                       | unit      | `apps/server/src/canvas/canvasAgentTools.test.ts`                                                                  |
| FR-1 rendered       | board draws mockup and design screens, edges, labels; drag calls the runtime; keyboard nudge works; a placed mockup is not drawn twice | component | `apps/web/src/canvas/blocks/FlowBoard.test.tsx`, `CanvasView.test.tsx`                                             |

Rendered QA after the tests: the flow board in light, dark, forced colours,
and at phone width.

#### Rollout

No flag: the block is version-gated, an older runtime refuses it as a future
version, and everything ships in one app build. Rollback is reverting the
commit; stored version-23 documents are refused by the rolled-back runtime as
future versions, which is the designed behavior.

### Slice 2: click-through Play and the flow site export

FR-2, FR-7 (flow part), NFR-4, NFR-6. Q-3 holds: Play runs in the app only;
shares and public links keep drawing the board read-only.

#### Shape (D-9)

**Play in-app.** `FlowBoard` gains a Play control beside its zoom controls,
and a `FlowPlayer` dialog mirroring `DesignPlayer`: the same dialog bar
(title, live position hint, Restart, Fullscreen, Close), a stage that scales
the current screen to fit, and Esc to leave. The current screen is the
mockup's or design's own drawing — no new frame surface. A mockup screen's
hotspot nodes (the interactive components its edges name) render as real
buttons that navigate to their target screen; every other part stays inert.
Screen-level edges (no hotspot, and every edge from a design screen) draw as
an explicit "Go to" link list under the screen, so a transition always has a
place to tap. Back steps a history stack; navigation is view state only and
journals nothing.

**The flow site (D-9).** The HTML export renders a flow as one interactive,
self-contained section set inside the exported document — not one file per
screen: screens are `:target`-navigated sections exactly as a design's
frames link inside one page (`display: none`, `:target`, and a
`body:not(:has(:target))` start rule, the pattern `designDocument.ts`
already ships), hotspot nodes are real `<a href="#screen">` anchors, and
screen-level edges join the link list. The Markdown export keeps slice 1's
graph reading. This supersedes the plan's "one file per screen" wording: the
click-through outcome is identical, the file stays self-contained like the
Save-as-HTML form, and the export contract (text body vs. drawn pictures)
changes nothing. A per-file page set stays Later if a destination needs it.

**The mockup page generator.** `canvasMockupHtml` in `packages/domain`
(`canvasMockupHtml.ts`): a pure function rendering one variant of a mockup
block as semantic, inert HTML (section/nav/h*/p/ul/li/button[disabled]
per the closed catalog), with the hotspot nodes a caller names rendered as
anchors to the caller's targets. Deterministic, byte-identical on reruns,
no script, a small neutral inline stylesheet, the light scheme. Slice 4
reuses it for the per-variant export and the TSX form.

**Design screens in the site and the player.** A design screen keeps its
own page: in the export the section holds the sandboxed `srcdoc` frame the
HTML export already writes (via `renderCanvasDesignExportFrames`); in the
player it is the live scaled `FrameView`. Its own internal fragment links
work as they do in any design; cross-screen edges come from the link list.

#### Tests

| Criterion                                                  | Test                                                                                                         | Location                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| FR-2 hotspot click navigates; keyboard path; back and exit | FlowPlayer renders, hotspot button navigates by pointer and Enter, Back returns, Esc closes                  | `apps/web/src/canvas/blocks/FlowBoard.test.tsx`       |
| FR-2 screen-level edges navigate                           | A "Go to" link under a screen with a hotspot-less edge navigates                                             | `apps/web/src/canvas/blocks/FlowBoard.test.tsx`       |
| NFR-4 inert elsewhere                                      | The board's screens stay inert outside Play                                                                  | `apps/web/src/canvas/blocks/FlowBoard.test.tsx`       |
| FR-7 deterministic script-free site                        | The flow site has no `<script>`, hotspot anchors match edges, reruns byte-identical, `:target` rules present | `packages/domain/src/canvasFlowSite.test.ts`          |
| Generator honesty                                          | Each component renders semantically; a hotspot node becomes an anchor to its target                          | `packages/domain/src/canvasMockupHtml.test.ts`        |
| Export wiring                                              | The HTML export carries the site; Markdown keeps the reading                                                 | `apps/server/src/canvas/artifactDocumentRender` tests |

### D-9: The flow site is one self-contained HTML section set, and Play is the renderer (Accepted, 2026-10-28)

Context: the plan said "one HTML page set," and the export contract offers
one text body or browser-drawn picture files. Options: (a) a new multi-file
export format (contract change across targets, cards, and placements);
(b) one self-contained document whose screens navigate by `:target`, the
pattern the design frames already ship. Choice: (b), Henrik's plan wording
notwithstanding — same click-through outcome, zero contract surface, and the
file matches the Save-as-HTML form people already paste elsewhere.
Consequences: a per-file page set stays Later; Play is typed link data
executed by the renderer (D-2) so no script, ticket, or prototype host is
involved anywhere in this slice.

## 10. Verification

| Acceptance criterion                                                                                            | Test                                                                                                                                                                                                                                                                                                                  | Result | Change      |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------- |
| FR-1 flow decodes at 23 and a 22 document carrying one is a future version                                      | "refuses a flow in a document that declares the version before it", `packages/domain/src/canvasPolicy.test.ts`; contract decode tests                                                                                                                                                                                 | Pass   | This change |
| FR-1 each `validateFlows` refusal fires with its reason; placed-once across flow and tab                        | "flow screens and transitions" (6 tests), `packages/domain/src/canvasPolicy.test.ts`                                                                                                                                                                                                                                  | Pass   | This change |
| FR-1 layout deterministic; manual positions honored; backward edges routed below                                | `packages/domain/src/canvasFlowLayout.test.ts` (8 tests)                                                                                                                                                                                                                                                              | Pass   | This change |
| FR-1 reading order: flow reads inside; placed blocks skip their position                                        | "flow reading order" (2 tests), `packages/domain/src/canvasDashboardLayout.test.ts`                                                                                                                                                                                                                                   | Pass   | This change |
| FR-3 flow drag journaled; unknown screen refused; non-board target refused                                      | "Canvas flow screen drag policy" (3 tests), `packages/domain/src/canvasBoardPolicy.test.ts`                                                                                                                                                                                                                           | Pass   | This change |
| NFR-1 share 12 carries a flow; share 11 refuses it                                                              | "carries a flow from share version 12 and refuses it under an earlier one", `packages/contracts/src/canvasShare.test.ts`; share-policy fixture updated                                                                                                                                                                | Pass   | This change |
| NFR-5 unreachable screen warned from the document alone                                                         | "warns about a flow screen no transition reaches, and not the first screen", `apps/server/src/canvas/canvasPreviewWarnings.test.ts`                                                                                                                                                                                   | Pass   | This change |
| FR-9 describe lists flow guidance; budget holds; app-flow recipe taught                                         | `apps/server/src/canvas/canvasAgentTools.test.ts` (111 pass)                                                                                                                                                                                                                                                          | Pass   | This change |
| FR-1 rendered board: screens and edges draw, drag journals, keyboard nudge works, placed mockup not drawn twice | `apps/web/src/canvas/blocks/FlowBoard.test.tsx` (5 tests); canvas suite 422 pass                                                                                                                                                                                                                                      | Pass   | This change |
| NFR-2 workspace typecheck; fmt, lint, style, paths, wiring, ui, decisions, diff checks                          | `bun run typecheck` (0 errors) + repo checks                                                                                                                                                                                                                                                                          | Pass   | This change |
| Whole-suite regression across the workspace                                                                     | Per-package suites: contracts 2327, web 6762, server-canvas 627, theme/host-runtime/client-runtime/plugin-host/plugin-api/provider-sdk/cli/docs/mobile all pass; domain and server carry only failures verified identical on clean main (10 pairing, 6 lease/purge/extension/ssh, 1 flaky long scheduler integration) | Pass   | This change |
| FR-2 Play opens on the first screen; a tapped hotspot navigates; Back returns; Close leaves                     | "flow click-through Play" (3 tests), `apps/web/src/canvas/blocks/FlowBoard.test.tsx`                                                                                                                                                                                                                                  | Pass   | Slice 2     |
| FR-2 a screen-level transition waits in the Go to list and is keyboard-operable                                 | "reaches a hotspot with the keyboard and lists a screen-level transition as Go to", same file                                                                                                                                                                                                                         | Pass   | Slice 2     |
| NFR-4 every control stays inert outside Play                                                                    | "keeps every control inert outside Play", same file                                                                                                                                                                                                                                                                   | Pass   | Slice 2     |
| FR-7/NFR-6 the flow site is script-free, anchors match hotspots, reruns byte-identical, `:target` navigates     | `packages/domain/src/canvasFlowSite.test.ts` (6 tests)                                                                                                                                                                                                                                                                | Pass   | Slice 2     |
| FR-7 the HTML export carries the site; Markdown keeps the graph reading; design markup flagged only when placed | "renders a flow as a script-free site whose transitions are real anchors", `apps/server/src/canvas/artifactDocumentRender.test.ts`                                                                                                                                                                                    | Pass   | Slice 2     |

## 11. Codebase deltas and change log

### D-8: Slice numbering corrected against main (Accepted, 2026-10-28)

Context: the base moved and Canvas schema 22 is taken by chart callouts.
Choice: the flow block is version 23, share 12; the catalog slice is 24, the
deck 25, each assigned finally when its slice starts. The next free version
governs over any number written earlier.

### Codebase deltas

- The flow's declared-version gate on `CanvasDefinition` was merged into the
  tabs/columns filter's `Schema.filter` step rather than adding its own: one
  more pipe step crossed Effect's inference-depth cliff, which degraded the
  whole definition type in consumer typechecks. The merged message names both
  rules with their versions. Later Canvas gates should watch the same cliff
  and merge rather than append.
- The first CSS draft drew the screen node its own focus ring; the
  visual-language contract (one neutral focus edge no surface repaints)
  refused it, so the node keeps the browser's own outline, as a diagram
  node's does.

### Change log

- 2026-10-28: Phase 1 written; approved by Henrik same day. Q-1 ruled
  design-frames-early (D-7 supersedes D-6; FR-1, slice 1, and the risk
  register updated), Q-2 ruled TSX added (FR-7, slice 4), Q-3 ruled in-app
  Play only (Scope Later).
- 2026-10-28: Branch rebased onto current `origin/main` for slice 1; Canvas
  schema 22 proved taken (chart callouts), so slice numbering moved to 23/24/25
  (D-8); slice 1's detailed design written against the current contracts,
  domain policies, board policy, and renderer.
- 2026-10-28: Slice 1 implemented: flow schema at Canvas 23 (share 12), pure
  `layoutCanvasFlow`, `validateFlows` and placed-once, reading order, board
  drag admission, describe guidance and the `app-flow` recipe, the
  `flow-unreachable-screen` preview warning, MD/HTML/SVG export parity, the
  `FlowBoard` renderer with live design screens, and the owning specs
  (`canvas.md`, `canvas-visuals.md`) updated in the same change. The custom
  focus ring the first CSS draft drew was removed: the visual-language
  contract holds that the workspace draws one neutral focus edge no surface
  repaints.
- 2026-10-28: Slice 1 delivered for review as #1830 (forced workspace
  typecheck, per-package suites, and repo checks green; rendered QA named as
  pending there). The turbo typecheck cache had hidden the inference-depth
  cliff and two fixture typings from earlier runs; the cache was cleared by
  an environment restart and both were fixed at the source, and the delta is
  recorded above.
- 2026-10-28: Slice 2 implemented: click-through Play (the design player's
  anatomy over flow screens, hotspots as the one live control, a Go to list
  for hotspot-less transitions, view state only) and the flow site export
  (`canvasMockupHtml` and `canvasFlowSite` in the domain, a `site` piece in
  the HTML export; Markdown keeps the graph reading). Two ui-contract
  refusals shaped the hotspot: a generated page's button keeps the adapter's
  look, and no surface repaints OctantButton, so the in-app hotspot wears
  the secondary variant as-is. Delivered for review as #1832.
- 2026-10-28: Slice 3 implemented: the mockup library at Canvas 24 (share 13) — thirteen new closed components, the `progress`/`assetId`/`defId` node
  fields, declared images under the design-asset rules, and reusable local
  definitions placed by instance, all gated by one merged version filter
  (the inference cliff of D-8's delta still stands) and carried by a share
  whole except its images. The generator, outline readings, hotspot list,
  renderer faces, and describe guidance grew with the catalog. Delivered for
  review as #1839.
