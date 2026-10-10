# 0165. Canvas artifacts are documents, designs, and prototypes

**Status:** Accepted

## Context

People ask an agent for three kinds of finished work and expect to use it
where they asked:

- a document they read — a spec, a research brief, an article, a game design
  with tabs, metric cards, flowcharts, and badge tables;
- a design they review — app screens, a site, a deck, a design system;
- a prototype they try — a UI/UX flow that reacts to input, a calculator, a
  playable sketch.

Canvas reaches part of each and none fully. The typed catalog (0010, 0052)
draws data well and travels in shares, but it has no document chrome, and a
closed component set never reaches a finished look. The `design` block (0164)
reaches a finished look with static HTML and CSS, but its frame is forced to a
white light page with no Octant fonts or tokens, it is drawn at a fixed device
size and scaled down, it cannot reach a Project image, and it cannot react
beyond what CSS does. The thread shows a Canvas as a 560px faded teaser, and
`canvasInlineRefusal` keeps diagrams, plans, mockups, and designs out of the
thread entirely.

Two browser facts set the cost. A `srcdoc` frame inherits the app's content
policy, which allows only `script-src 'self'`, so a frame written in place
can never run agent script; a running frame needs a document the host
serves with its own policy. A frame sandboxed without `allow-same-origin`
has an opaque origin and cannot reach Octant's cookies, storage, DOM, or
RPC, wherever it is served from. A separate origin or desktop protocol is
not needed for that isolation.

## Decision

Canvas offers three tiers in one artifact. An author uses the lowest tier
that delivers the result, and may mix them in one Canvas.

- **Typed blocks carry data.** Metrics, tables, charts, plans, and the
  diagram family stay the catalog, because comments anchor to them, revision
  edits them, and shares and exports keep their structure. The catalog gains
  what documents and diagrams lack, and no more:
  - `tabs` and `columns`, which name existing child blocks one level deep.
    The selected tab is view state and never journals a version. Cards,
    grids, and pills are not separate kinds; a static frame or a tone on an
    existing block covers them until evidence says otherwise.
  - Closed diagram node roles (process, decision, terminator), edge styles,
    and group tones, drawn by the one deterministic layout.
  - A Gantt reading of dated, dependent tasks as a `plan` view.
  - Import of a bounded Mermaid subset into typed diagram blocks. The host
    translates and lays out; Mermaid is never a renderer. Unknown constructs
    fail closed and keep the source as a code block.
- **Static frames carry the look.** `design` keeps 0164's rule that the
  frame runs nothing, and gains what a finished document or design needs:
  - A `document` size: fluid width, height grown to its content. The host
    measures the page itself, so the frame is sandboxed with
    `allow-same-origin` and never `allow-scripts`; that pairing would be an
    escape, and a test keeps it impossible.
  - An opt-in workspace theme: the frame receives Octant's semantic tokens,
    light or dark as the workspace is, the bundled fonts, and a first-party
    stylesheet of article typography, cards, CSS-only tabs, badges, metric
    tiles, tables, callouts, and code. A device-size design stays unthemed by
    default, because a product screen keeps its own brand.
  - Assets by reference: a frame names a Canvas or Project image by id; the
    server resolves it under the thread's mode and Project authority and the
    host inlines the bytes before drawing. A Chat Project reaches only its
    artifact library. The frame still loads nothing itself.
- **Running frames carry behavior.** A `design` may declare that it runs
  script. Its page is served by the host from a route that returns the
  document with a `Content-Security-Policy: sandbox allow-scripts` header and
  a policy that allows inline script and style, `data:` and `blob:` media,
  and no connection. The frame is also sandboxed in the parent without
  `allow-same-origin`, `allow-top-navigation`, `allow-popups`, or
  `allow-forms`. The page is fetched with a single-use ticket scoped to one
  Canvas version, never with the session credential. A host-written bridge
  in the page reports size, script errors, and a heartbeat; the parent
  accepts only those typed messages from that frame, clamps them, and
  removes a frame that stops answering. The bridge grants no tool, journal,
  or file capability. Desktop runs these frames out of process, cancels any
  navigation of a frame away from its own page, and reserves a shortcut that
  frame script cannot intercept to move focus back to host chrome. In every
  client a frame that loads a second page is removed.
- **The thread can hold the whole Canvas.** A person may expand any Canvas
  in its thread, including a board, a plan, a design, and a running
  prototype. An expanded Canvas grows with its content up to about the
  thread viewport; a region takes the wheel only after the person focuses it,
  and boards keep ctrl/meta zoom. The agent may ask for `inline` on a
  document of reading blocks and static frames within the ordinary block
  budget; the 12-block teaser cap goes. A running frame in the thread starts
  when a person presses Run. Editing, comments, and sharing stay in the
  sidebar, and nothing drawn in the thread writes a version.
- **Agents are taught and checked.** `describe` presents the three tiers
  with a finished example of each. In-tree recipes cover an article, a
  product or game design brief, a design system, and a clickable prototype.
  `preview` draws frames and returns overflow, contrast, missing-asset, and
  script-error warnings, so the author can fix a frame before the person
  sees it.
- **Shares and exports carry what they can draw safely.** Typed blocks travel
  as today. A static or running frame travels in an authenticated snapshot
  only when the viewer draws it under this same frame policy and the sharer
  acknowledges that markup is shared as written, because the secret filter
  reads values, not markup. HTML export writes frames as sandboxed `srcdoc`
  pages with the same policy; Markdown export writes the title. Public links
  stay out.

Each tier is a Canvas schema bump; an older runtime refuses the document as a
future version.

## Consequences

- An agent can deliver a finished article, a themed spec with tabs and
  diagrams, real-looking screens, and a prototype a person clicks through,
  all in the thread where they asked, without a new dependency or an outside
  service.
- 0164's frame that runs nothing becomes the middle tier instead of the
  ceiling. Its link and markup refusals still hold for static frames.
- Running frames add a served route, a ticket, a bridge, and a watchdog. That
  is bounded work in the server and renderer, not a new process topology.
- Shares of frames depend on the snapshot viewer adopting the frame policy;
  until it does, frames fail closed in a share as they do today.
- 0052's one-layout rule stands. Its Mermaid non-goal narrows to the
  renderer: import into typed blocks is in scope.

## Alternatives considered

- **Grow only the typed catalog.** Safe and portable, but every new look is a
  schema change, and no closed set reaches a finished design or article.
  Kept for data-bearing blocks only.
- **Serve running frames from a separate origin or desktop protocol.** A
  stronger boundary on paper, but the opaque-origin sandbox already denies
  the frame Octant's origin, and a second listener or protocol must be
  rebuilt for remote clients. Revisit if a frame ever needs
  `allow-same-origin` with script.
- **Run frames in a separate Electron view per artifact.** Hard process
  isolation, but it cannot be laid out in the thread, does not exist in a
  remote browser, and costs a process per Canvas.
- **Render Mermaid directly.** Agents already write it, but it is a second
  layout and a foreign stylesheet. Import keeps one picture.
- **Connect an external design or artifact service.** Fast, but it sends
  Project content to a third party and makes a core capability depend on a
  vendor.

## Related

- [0010](0010-secure-preview-and-canvas.md) — the structured Canvas this extends
- [0052](0052-canvas-boards.md) — boards, comments, one layout, Mermaid non-goal
- [0080](0080-hand-off-writes-a-canvas-from-the-export-cut.md) — hand-off still writes typed blocks
- [0164](0164-canvas-designs-are-html-in-a-frame-that-runs-nothing.md) — the static design frame this extends
- [Canvas HTML frames threat model](../security/canvas-html-frames-threat-model.md)
