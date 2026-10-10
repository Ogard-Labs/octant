# 0164. Canvas designs are HTML in a frame that runs nothing

**Status:** Accepted

## Context

People ask an agent to design an app screen, a website, a landing page, or a
slide deck, and expect something that looks finished and that they can click
through. The Canvas `mockup` block draws a wireframe from a closed set of
components. It is safe and portable, but it cannot look like a finished
product, and no closed component set can.

0010 kept every Canvas block structured: the renderer never interprets
agent-written HTML, CSS, or script. A finished-looking design needs the author
to control layout, type, colour, and imagery, which in practice means HTML and
CSS. The question is where that markup runs and what it may reach.

## Decision

A `design` block holds the frames of one design at one size (phone, tablet,
desktop, or a 16:9 slide), each frame a page of static HTML, plus one shared
stylesheet. Frames link to each other by fragment (`href="#checkout"`).

- **The frame runs nothing.** Each page is drawn in an `iframe` with an empty
  `sandbox` and a `srcdoc` document. No script runs, nothing submits or opens,
  and the page has an opaque origin with no access to Octant. The document
  carries a policy that loads nothing but inline styles and `data:` images and
  fonts, and it inherits the app's own policy, which it can only narrow.
- **Links stay inside the design.** A sandboxed page with no script can still
  navigate itself when a person clicks a link, so the host refuses any link
  that is not a fragment. Every frame is drawn in one page for Play, so a
  fragment link shows the frame it names through `:target` with no script.
  The renderer writes each fragment against the page's own address, because a
  `srcdoc` page resolves a bare fragment against its parent's address.
- **The host tells the author what will not work.** The domain policy refuses
  markup with a script, an event handler, an embedded document, a remote
  image, stylesheet, or font, or a link out of the design, and names the frame
  and the construct. The sandbox is the boundary; these checks are advice
  that keeps a broken frame from being stored, except the link rule, which is
  part of the boundary.
- **It is version 9 of the Canvas schema.** An older runtime refuses a
  design-carrying document as a future version. An authored revision declares
  the current version, so an older document can gain a design.
- **It does not leave the host as markup.** A shared snapshot refuses a
  design, because the secret filter cannot read markup and the viewer would
  not be this sandbox. Markdown and HTML export write each frame's title, not
  its markup.

## Consequences

- An agent can deliver app screens, a site, or a deck that looks finished and
  that a person clicks through or presents, with no new dependency and no
  service outside the host.
- Interaction beyond links is what CSS alone can do (checkbox and `:has()`
  states, `details`). A design cannot fetch data, animate with script, or
  react to input beyond that.
- Images must be inline SVG, gradients, or `data:` URLs. Project files and
  generated images are not yet reachable from a frame.
- A design is large: an agent writing one can be silent for minutes while it
  composes a single tool call. Chat and Work therefore wait five minutes for a
  provider event before cutting a turn off, as Code already did.
- Chromium stopped painting sandboxed frames that were `inert` or had
  `pointer-events: none`, so a frame shown as a picture stays hit-testable and
  a cover over it takes the pointer.

## Alternatives considered

- **Let frames run script in an isolated origin.** Richer prototypes, but it
  needs a separate serving origin and a network policy the renderer does not
  have today, and a frame that runs script can hang the renderer process.
  Left for a later decision with its own threat model.
- **Connect an external design service.** Fast to reach a polished result, but
  it sends Project content to a third party and makes a core capability depend
  on one vendor.
- **Grow the mockup catalogue.** Stays structured, but no closed component set
  reaches a finished look.

## Related

- [0010](0010-secure-preview-and-canvas.md) — the structured Canvas this narrows
  for one block.
- [0052](0052-canvas-boards.md) — Canvas boards and comments.
- [0165](0165-a-canvas-in-the-thread-can-be-the-whole-answer.md) — later proposal
  for in-thread documents; scripted frames stay deferred.
