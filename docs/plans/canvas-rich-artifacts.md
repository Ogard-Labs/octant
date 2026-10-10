# Rich Canvas artifacts

**Status:** Planning. This is not a current-design owner. Architecture,
Workspace, and DESIGN.md stay the owners until the maintainer accepts
[0165](../decisions/0165-canvas-artifacts-are-documents-designs-and-prototypes.md);
each step below updates them in the PR that ships it.

Canvas should produce finished documents and articles, real-looking designs
and UI/UX mockups, and prototypes a person can click through, shown in the
thread where they were asked for. 0165 sets the three tiers: typed blocks for
data, static frames for the look, running frames for behavior. The security
boundary for frames is
[canvas-html-frames-threat-model.md](../security/canvas-html-frames-threat-model.md).

## Starting point

| Surface | Today |
| --- | --- |
| Catalog | Closed, versioned (`CANVAS_SCHEMA_VERSION` 12): headings, rich text, callouts, metrics, status, tables with status badges, charts, timeline, treemap, heatmap, bar list, comparison matrix, math, plan, mockup, design, and the diagram family. No tabs or columns. |
| Thread | `InlineThreadCanvas` draws a read-only Canvas capped at 560px and faded. `canvasInlineRefusal` admits `inline` only for at most 12 blocks without `diagram`, `plan`, `mockup`, or `design`. |
| Design frame | `srcdoc`, empty sandbox, frame policy in `designDocument.ts`. Forced `color-scheme: light` on white, no Octant fonts or tokens, fixed device viewports scaled to fit, no Project images, CSS-only interaction. Refused in shares; export writes titles. |
| Diagrams | One layout per kind in domain. Generic node `role` is an open token drawn as one box; edges have no style. |
| Authoring | `describe`, `create`, `revise`, `preview`; in-tree recipes; trusted skills may add recipes. |

## Order of work

Each step is one reviewable PR. Steps 1 and 2 are independent; the rest
follow in order. Every step bumps the Canvas schema where it adds fields,
updates the owning specification, and captures rendered evidence through
`scripts/capture-canvas-charts.ts` and `apps/web/canvas-browser-evidence.html`
at light, dark, Vivid, Contrast, and forced colours.

### 1. The thread holds the whole Canvas

- A person can expand any Canvas in its thread; expanded height follows
  content up to about the thread viewport. The wheel stays with the thread
  until the person focuses a region; boards keep ctrl/meta zoom.
- `canvasInlineRefusal` drops the 12-block teaser cap for reading blocks and
  static frames within the ordinary block budget.
- Files: `canvasPresentationPolicy.ts`, `InlineThreadCanvas.tsx`,
  `CanvasView.tsx`, `canvas.css`, `docs/design/workspace.md`,
  `apps/docs/advanced/files.md`.
- Acceptance: a 40-block Canvas with a board expands in a Chat, Work, and
  Code thread; scrolling over it unfocused moves the thread; nothing drawn
  inline writes a version. Packaged-app wheel routing is checked natively.

### 2. Static frames look like Octant

- `document` size: fluid width, height measured by the host. The frame
  gains `allow-same-origin` and never `allow-scripts`, enforced by a test.
- Opt-in workspace theme: semantic tokens, light/dark, bundled fonts as
  `data:` fonts, and a first-party stylesheet for article typography, cards,
  CSS-only tabs, badges, metric tiles, tables, callouts, and code.
- Files: `designDocument.ts`, `DesignBlock.tsx`, `canvasDesignPolicy.ts`,
  contracts `canvas.ts`, `DESIGN.md` (frame kit), architecture Canvas
  section.
- Acceptance: an agent-written article and a themed design spec read as part
  of Octant in every theme, size to their content, and still run nothing.

### 3. Frames reach assets

- A frame names a Canvas or Project image by id. The server resolves
  declared ids under the thread's authority before drawing; the host inlines
  bytes. Chat reaches only its artifact library.
- Acceptance: a mockup shows a Project screenshot; an id outside the
  Project draws a placeholder and a preview warning.

### 4. Running frames

- `design` may declare that it runs script. The server serves its page from
  an authenticated route with a single-use version ticket, a
  `sandbox allow-scripts` response directive, and `connect-src 'none'`. The
  app policy admits that route in `frame-src`.
- Host-written bridge: size, script errors, heartbeat. Parent watchdog and
  Stop. Desktop verifies and enables out-of-process sandboxed frames and a
  WebRTC policy that refuses non-proxied UDP.
- Run in the thread is a person's click; the sidebar may run on open.
- Files: contracts `canvas.ts`, `canvasDesignPolicy.ts`, a frame route
  beside `authenticatedProductRoutes.ts`, `DesignBlock.tsx`,
  `apps/web/index.html`, desktop session setup, architecture security
  section.
- Acceptance: a clickable checkout prototype with state runs in the thread
  and sidebar; an infinite loop is stopped without freezing Octant; a fetch,
  a top navigation, and a popup are refused; a replayed ticket is refused.

### 5. Typed layout and diagrams

- `tabs` and `columns` naming existing child blocks one level deep; the
  selected tab is view state.
- Closed diagram node roles and edge styles, group tones, and a Gantt view of
  `plan`, all in the one domain layout.
- Mermaid-subset import into typed diagram blocks; unknown constructs keep
  the source as a code block.
- Acceptance: an eight-tab design brief of metrics, a flowchart, a zone map,
  and badge tables round-trips through a share; an older decoder refuses it.

### 6. Authoring and preview

- `describe` teaches the three tiers with one finished example each.
- Recipes: article, product or game design brief, design system, clickable
  prototype.
- `preview` draws frames and returns overflow, contrast, missing-asset, and
  script-error warnings.
- Files: `canvasAgentTools.ts`, `canvasDocumentRecipes.ts`,
  `canvasPreviewWarnings.ts`, `apps/docs/advanced/files.md`.

### 7. Frames in shares and exports

- Authenticated snapshots draw frames under the same policy after the
  sharer acknowledges that markup is shared as written. HTML export writes
  frames as sandboxed `srcdoc` pages carrying the frame policy.
- Files: `canvasSharePolicy.ts`, snapshot viewer, export writer, the share
  threat models.

## Out of scope

Public share links, geographic map tiles, freehand ink, realtime co-editing,
a third-party canvas engine, and any frame that runs script with
`allow-same-origin`.
