# Open a dev server from another computer

Plan for the proposal in
[Architecture: opening a dev server from another computer](../architecture.md#opening-a-dev-server-from-another-computer).
The design is not approved and nothing is built. This plan lists the decisions
the maintainer still has to make, with a recommendation for each, and the
order in which the work would land. It does not authorize building or merging.

## Open decisions

1. **Where the client forwarder runs.**
   - A. The desktop app's main process.
   - B. The client computer's own Octant server.
   - C. A CLI command for a computer without the desktop app.

   Recommended: **A**. B would put the other host's credential and traffic in
   a second host's server, which "hosts never trust each other" forbids. C
   can follow once A works; it needs its own key custody.

2. **Who signs each request.**
   - A. The renderer, per request, over IPC; the private key stays
     non-extractable.
   - B. A second, extractable proxy key kept in the Keychain by the main
     process.
   - C. A device proof only when the grant opens, then a bearer cookie for
     the page's requests.

   Recommended: **A**, measured in the live check (a cold Vite page load is
   hundreds of requests). B adds a second credential to pair, rotate, and
   revoke. C breaks the rule that every request carries the device proof.

3. **A separate proxy session.**
   - A. Its own session, nonce store, and budgets, reaching only the proxy
     route.
   - B. Reuse the product session.

   Recommended: **A**. A page load would otherwise use up the product
   session's nonce store and its concurrency of 8 per device.

4. **Address shape.**
   - A. `<port>-<label>.octant.localhost` on one stable forwarder port.
   - B. The upstream port on the client's `localhost`.
   - C. One `127.0.0.1` port per opened server.

   Recommended: **A**. Before building, check that every default browser on
   macOS resolves `*.localhost` and keeps `Secure` cookies on it. If one does
   not, use C for that browser only, and say that cookies on a loopback IP
   address are shared across its ports.

5. **HTTPS dev servers.**
   - A. Accept the certificate the loopback server presents, pinned for the
     grant's life, as local Open's `acceptsLocalCertificate` does.
   - B. Refuse them, with copy that says so.

   Recommended: **A**. The page on the client stays `http` on its
   `*.localhost` name.

6. **Servers in the Project folder (no thread).**
   - A. No grant; Open keeps the host's picture.
   - B. A Project-scoped grant for a device that can read the Project.

   Recommended: **A** for the first release. The design is thread-scoped,
   and B needs its own read rule.

7. **Servers Octant does not own.**
   - A. Refuse, even with a confirmation.
   - B. Allow after the Stop-style confirmation naming process, folder, and
     port.

   Recommended: **A**, per the rule that only Octant-owned listeners are
   proxied.

8. **Storage in Octant's browser.**
   - A. A persistent partition per name, cleared when the host is removed or
     the device unpaired.
   - B. An ephemeral partition per open.

   Recommended: **A**, so a sign-in inside the dev app survives a reopen. The
   default browser keeps its own storage either way.

9. **Signing with no Octant window open.**
   - A. Signing needs an open window; the page says so.
   - B. A hidden background renderer keeps signing.

   Recommended: **A** for the first release. B keeps a renderer alive only to
   sign, which is a separate lifecycle to design.

10. **Plan threads.**
    - A. Apply the local Open decision for the thread's posture unchanged.
    - B. Refuse a Plan thread's servers.

    Recommended: **A**. Opening is the person browsing, not the agent
    writing, and a remote device gets no more than a local window.

11. **Opening in the default browser.**
    - A. Offer Open in browser, with the replayable-cookie risk stated in the
      user guide.
    - B. Octant's browser only, where the secret is a header the desktop adds
      for the exact origin and never a cookie.

    Recommended: **A**. The exposure is one dev server the person opened, to
    a process already running on their computer, and the issue asks for the
    person's own browser. Choose B if review weighs that risk higher.

12. **Forwarder port range.**
    - A. Ten ports from one fixed default, falling forward on collision.
    - B. Any free port the system assigns.

    Recommended: **A**. A small known range keeps names recognizable and makes
    the refusal copy precise; B changes every origin on each collision.

## Slices

Each slice is one reviewable change. Slices 1 to 4 are host-only and ship
dark; slice 5 makes the feature reachable.

1. **Contracts and grant policy.** Grant command, result, and refusal schemas;
   the pure policy that decides a grant (paired principal, listed id,
   Octant-owned, listening, readable thread, posture).
   Tests: a domain policy table that refuses a local principal, a server not
   owned by Octant, a server in the Project folder, an unknown or
   unresponsive health, and an unreadable thread; contract round-trip and
   strictness (no port, PID, or command line accepted from the client).

2. **Grant service and route on the host.** Minting and closing grants,
   re-observation by listener id, journal events for open and close, grant
   caps, and the proxy session.
   Route tests: refuses a listener Octant does not own; refuses a thread the
   device cannot read; refuses a revoked device; answers `not-found` the same
   way for an unlisted id and a stopped server; refuses a local principal;
   refuses past the grant cap. The product session cannot reach the proxy
   route and the proxy session cannot reach product routes. Journal replay
   rebuilds the open-grant view.

3. **HTTP proxy route on the private listener.** Per-request proof against
   the proxy session, endpoint identity re-check, header handling, budgets,
   and the revocation registry.
   Tests: refuses a revoked device and aborts its in-flight streamed response
   before the revoke response completes; refuses a grant presented by another
   device; refuses a request after the port changes hands; Octant's cookie,
   proof, and CSRF headers never reach the upstream server; `Host` is
   `localhost:<port>`; the body cap answers 413 and the concurrency cap 503
   with `Retry-After`, apart from the product budget.

4. **WebSocket upgrade on the proxy route only.**
   Tests: every other route still refuses an upgrade; an upgrade without a
   valid proof is refused; an open socket closes with 1008 when the device is
   revoked or the grant closes; the subprotocol passes through; the message
   cap and per-grant socket cap hold.

5. **Client forwarder, signer, and Open.** The desktop main-process
   forwarder, name derivation, the claim cookie, response rewriting, failure
   pages, the renderer signing channel, Open and Open in browser on Local
   servers and Running services, and the live-updates indicator.
   Tests: desktop tests that the name is stable for the same host, thread, and
   port; an unknown `Host`, a request without the secret, and a `same-site` or
   `cross-site` request from a sibling `*.octant.localhost` name are refused;
   Octant's browser sends the secret only to the name's exact origin; a taken
   recorded port moves to the next in the range and a fully taken range
   refuses Open with its copy;
   the renderer refuses to sign anything but a proxy-route payload for a grant
   it holds; `Location` and `Set-Cookie` rewriting; web component tests for
   the row states and failure lines; rendered QA of both cards on a client
   window reading another computer, at the dock's narrow and wide widths.

6. **User guide.** A page in `apps/docs` on opening a server from another
   computer: what it needs (the desktop app on the computer in front of you,
   a paired device, an Octant-owned server in a thread), its limits (absolute
   `localhost` URLs, pinned reload ports, OAuth callbacks), and how revoking
   a device ends access.

## Live acceptance

On two paired Macs, host B and client A, both running the desktop app:

1. In a Code thread on B, start Vite from the thread's terminal.
2. On A, open the thread from All Hosts and choose Open on the server's
   Local servers row. The page loads in Octant's browser at its
   `*.octant.localhost` name, and the live-updates indicator says connected.
3. Edit a component on B. The page on A updates without a reload.
4. Open in browser: the same page loads in A's default browser, and hot
   reload works there too.
5. Revoke A's device on B. Both pages show the revoked copy at once, and the
   next request is refused.
6. Repeat Open from the Running services card on A.
7. Record cold-load request count and time with per-request signing, to
   settle decision 2.
