# 0092. A window capability travels only over TLS or loopback

**Status:** Accepted

## Context

0013 rules that non-loopback HTTP is never supported, and 0074 fixes the
canonical local host at `http://127.0.0.1:13773`. Both are enforced by the
server: the remote listener is HTTPS-only, and the loopback listener validates
its Host header. The renderer had no rule of its own. It took whatever server
address the launch parser accepted, a `serverUrl` query parameter or the page's
own origin, exchanged its launch or local session for a window capability
against that address, and every client then sent the capability in a request
header to the same place. A launch address naming a plain-HTTP host on another
machine therefore made the renderer hand its capability to anyone on the path.
The server's refusal cannot help: it arrives after the header has left the
browser. Judging only that first URL is not enough: default `fetch` following
would resend the header onto a later hop, including HTTPS to non-loopback HTTP.

## Decision

- A server address the renderer will send its window capability to must use
  `https:`. `http:` is accepted only for a loopback host: an address in
  `127.0.0.0/8`, `::1`, or the name `localhost`, judged on the parsed hostname
  so that shorthand and alternate spellings of one address normalise first.
  IPv4-mapped IPv6 forms are not loopback, matching the host's own listener.
- The address rule is one pure function in the renderer's shell, applied where
  the address enters: the launch parser. No client, hook, or fetcher accepts an
  address the parser did not, and none re-validates redirect targets against
  that function.
- A request that sends `x-octant-window-capability` sets `redirect: "error"`.
  A redirect is a refused transport, never followed.
- A refused address is a value, never an exception and never a silent fallback
  to another address or to pairing. The renderer shows why it refused and
  which host, and sends nothing. `fetch` rejecting on `redirect: "error"` is
  platform behavior and is handled as an existing transport failure.
- The server keeps its own loopback and HTTPS checks unchanged. The client rule
  is not a substitute for them; it exists because a client-side leak happens
  before a server-side refusal can.

This record extends the 0013 rule that non-loopback HTTP is never supported
from the listener to the client that would connect to it. Every other rule of
0013 and 0074 stands.

## Consequences

- A launch address that is plain HTTP on a LAN address no longer opens the
  product; it explains itself. The canonical host, loopback development
  renderers, and HTTPS remote access are unaffected.
- A capability-bearing fetch that receives a redirect fails as a transport
  error rather than completing against another host.
- A future client built on the same shell inherits the address rule by going
  through the parser and the redirect rule by going through the authenticated
  fetch seam; a client with its own entry point must apply both.

## Related

- 0013 Remote access: single host, paired devices, and mobile
- 0074 One Machine has one canonical host and store
