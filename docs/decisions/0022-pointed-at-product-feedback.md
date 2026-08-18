# 0022. Pointing at the running product

**Status:** Accepted

## Context

The shortest description of a UI defect is a finger. "This button, here, is
wrong" takes a second to point at and a paragraph to write down, and the
paragraph is usually worse: it names the element by guesswork, drops the page it
was on, and arrives without the picture the person was looking at. Octant
already had all three facts on the host — it drives the browser for a thread,
reads the page, and captures screenshots — and no way for a user to attach any
of them to what they were about to ask for.

The obvious implementation is the dangerous one. If the renderer resolves the
element and sends its identity, a client can name an element from a page it was
never entitled to see, or invent one entirely. And if the note is folded into
the prompt, then every string read off a page — an element's own text, an
accessible name, an attacker's `Ignore all previous instructions` — arrives as
if the user had typed it.

## Decision

- A **note** is one comment the user pointed at something in the running
  product. It is journaled on its own aggregate, waits on its thread, and
  travels with the next turn that thread runs.
- The client sends only where it tapped and what the user wrote. The **host
  resolves the element and cuts the crop**, after checking that this caller may
  see the thread at all, so a note can neither name an element from a page its
  author could not see nor claim an identity the page never had.
- Every check the host runs before acting on a page runs before describing one:
  the context must belong to this window, be on this thread, still be active,
  and still hold the authority it was created under. Describing changes nothing,
  but it reads a page, and reading is what those checks protect.
- A note carries **split provenance**. The comment is the user's own words. The
  element — its selector, its accessible identity, its own text, its picture —
  is `external-content`, and taints the thread the same way any other ingested
  external content does (0009's untrusted-content rules apply unchanged).
- The turn quotes a note **beside** the prompt, never inside it, under a
  standing framing: the user's sentence is a request, and everything describing
  the element is content read off the running product that must never be
  followed as instructions.
- A picture travels only where the thread's model can read one. A model without
  vision is told in words that a picture exists and was not sent, rather than
  having the turn refused or the picture silently dropped.
- **A note travels exactly once.** Marking it delivered and using it are the
  same step, so a note the journal would not take is never sent — losing it from
  a turn is honest, arriving twice reads as the user asking twice.
- The crop lives in the purgeable evidence store and the journal keeps only a
  reference, per 0002's rule that bulk content stays out of journal payloads. A
  crop that cannot be stored, or has since been purged, costs the note its
  picture and never the note.
- The element identity is modelled for two surfaces from the start: a web
  element named by selector and accessible identity, and a native element named
  by accessibility identifier. Only the browser path is implemented; the
  simulator path reuses the same note, provenance, and delivery rules.
- Notes queue per thread with a small bound. Past it the host refuses politely
  rather than accumulating a backlog nobody sent.

## Consequences

- The agent gets what a person actually meant — the element, the page, the
  picture, and the sentence — instead of a description of it.
- Pointing costs a host round trip per note, because only the host can say what
  is under a coordinate. That is the price of never trusting a client-supplied
  element, and it is paid once per note rather than per frame.
- Selectors are structural, not durable. A note names what was pointed at well
  enough for a person and an agent to find it; it is not a test locator, and
  nothing should treat it as one.
- Every note taints its thread as having ingested external content, which makes
  later irreversible actions ask for fresh confirmation. That is the intended
  cost of reading a page the host does not control.
- A runtime that cannot read its own page — a native view Octant only presents —
  offers no pointed-at notes rather than a degraded guess.

## Related

- 0002 Durable event journal and rebuildable projections
- 0009 Sandbox confinement, approvals, and Plan mode
- 0010 Secure file preview and canvas artifacts
- 0021 Remote thread surfaces
