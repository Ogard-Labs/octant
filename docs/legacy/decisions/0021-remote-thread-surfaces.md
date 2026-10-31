# 0021. Remote thread surfaces: watching the running product

**Status:** Accepted

## Context

Decision 0013 settled who a paired device is and what it may ask for: an
agent-first companion — an inbox of threads, live thread control, approvals, and
lightweight review — with a least-authority catalog that fails closed on
anything it does not name. What it did not settle is the thing people most want
a phone for while the Mac is working: _seeing the product run_. The host already
drives a browser for a thread, records simulator screenshots through the Apple
toolchain, owns the thread's terminals, and renders canvases and file previews.
None of those surfaces were classified, so all of them were refused — correctly,
but silently, and with no path to opening them.

Opening them naively is the failure mode to avoid. "The phone can use the
browser" would hand a remote device the ability to point the host's browser at
any origin and type into any field, which is a larger authority than watching,
and one nothing else in the catalog grants.

## Decision

- A **thread surface** is one way of watching a thread: the conversation, the
  host's browser, its terminals, a simulator screenshot, a canvas, or a file
  preview. Every surface names the catalog action reading it requires, and — if
  it can be acted on at all — the separate action acting on it requires.
- Reach is derived from the catalog, never declared. A companion client asks the
  shared surface matrix, which classifies each surface as `unavailable`,
  `read-only`, or `interactive` from the host's own least-authority catalog. A
  surface whose read action is not remote-approvable is unavailable, and one
  whose interaction is host-only degrades to watching rather than disappearing.
- Watching is remote work; deciding what the host runs is not:
  - `browser.observe`, `simulator.observe`, and `terminal.read` are
    remote-approvable.
  - `browser.interact` is remote-approvable, and covers only gestures that land
    inside the page the host already opened — click, press, scroll, and the
    reads that follow them.
  - `browser.session.manage` (open, release, cancel, stop, navigate, type,
    close a tab) and `terminal.write` are local-host-required.
- The gateway admits exactly the browser read routes and the action route, and
  nothing else on that surface. The action route re-derives the principal and
  refuses every action kind outside a companion's reach, so admission alone
  never decides what a gesture may do.
- A companion client draws the host's picture; it never renders the page. Taps
  are sent as points normalized against the picture actually drawn, and the host
  maps them onto its own viewport, so nothing the phone measured is trusted.
- A picture is honest about being a picture: a view says when the host has moved
  on since the capture, when no browser is running, and when the host does not
  share the surface at all, rather than showing an empty frame.
- A companion client offers only surfaces it can actually fill. A surface the
  host would allow but the client cannot draw is absent, not an empty tab.
- Extends 0013, which is unchanged: the principal boundary, the pairing and
  session rules, the approval classification, and the local-host-required list
  all still hold. This record only adds surfaces to the catalog those rules
  already govern.

## Consequences

- A phone can watch the product the Mac is building and tap through it, which is
  what "companion parity" means in practice, without gaining any authority to
  redirect the host.
- Terminal, simulator, canvas, and preview surfaces are settled in the matrix
  before their views exist. Building each view is wiring, not a new authority
  question, and a view built against a surface the catalog refuses will report
  itself unavailable rather than fail at the request.
- Every new surface costs one catalog entry and one admission rule, both of
  which fail closed by default. Forgetting either makes a surface unavailable,
  which is the safe direction.
- Browser reach is deliberately asymmetric: a companion can complete a flow the
  host started, but cannot start one. Typing a password from the phone is out of
  reach by construction, which is a limitation and a protection at once.

## Related

- 0013 Remote access: single host, paired devices, and mobile (extended)
- 0009 Sandbox confinement, approvals, and Plan mode
- 0014 Apple development and validation as an app-managed capability
