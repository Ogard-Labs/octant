# Open a dev server from another computer

**Status: approved by the maintainer on 2026-10-14; slices 1 to 3 built: the
host relays HTTP; slice 5 built for the Running services card in the desktop
app, without WebSockets, and its rules are in the
[architecture](../architecture.md); the user guide is written.** Slice 4 and
the parts of slice 5 listed under it as not built are still plans. A
paired browser and the phone keep the host's picture of the page. This plan does not authorize
merging or releasing anything.

## Design

**Outcome.** When an agent or the person starts a dev server on one paired
computer (the host), the person opens it live on the computer in front of them
(the client), in Octant's own browser or their default browser, with no SSH
tunnel and no new port exposed. Requests go from a forwarder in the client's
desktop app to the host's existing private HTTPS listener, which forwards them
to the server on the host's loopback. The host's listener, its address, and
pairing stay as they are.

**What stays out.** No raw port forwarding: the proxy carries HTTP and
WebSocket requests to one classified listener, never a TCP stream to a port
the client names. No host process inventory: the client never names a port,
address, or process, and a refusal never says whether some other process holds
a port. No public ingress and no relay: the host's listener stays on its LAN
or Tailscale address, and the client's forwarder binds loopback only.

**Who may open what.** The host mints a proxy grant on a paired device's
request and refuses it unless all of these hold:

- The principal is a paired device. A local window opens the server directly
  and is refused with `local-principal`.
- The listener id comes from the host's own listing: the thread's Local
  servers, or a Running services row that names a thread. The host
  re-observes and re-classifies by that id, as Open and Stop do. An id that is
  not listed gets the same `not-found` as a server that stopped.
- The listener is Octant-owned (a live terminal descendant), listening, and
  serves HTTP or HTTPS on a loopback address (decision 5). A server
  Octant does not own is refused even with a confirmation: Octant cannot tell
  who started it, and putting it on another computer exposes more than the
  host's picture of it does. Its Open keeps the picture.
- The thread is one the device can already read under the remote rules, and
  the local Open decision for the thread's posture allows it. A server in the
  Project folder belongs to no thread, so it gets no grant.
- The device holds fewer than its cap of open grants (see Limits).

A grant is an opaque random id bound to the device, its credential
generation, the proxy session, the thread, the listener id, and the observed
endpoint (the loopback URL and the identity of the process that held it). The
host journals a grant opening and closing with the principal, thread, port,
and reason. Single requests are not journaled.

**Every request carries the device proof.** The host serves the proxy on one
route prefix of its private listener (for example `/api/server-proxy/<grant>/`)
and admits a request only when:

- the request proof verifies against the device's proxy session (signature,
  nonce, timestamp, path, body digest: the envelope product routes use), and
  the device is active with a current credential generation;
- the grant belongs to that device and session and is still open;
- the thread is still readable by that device;
- the endpoint is still held by the same process. The host re-confirms this
  before each new upstream connection and at most every two seconds on a
  reused one. A port now held by another process closes the grant.

The host forwards only to the grant's loopback URL with the request's path and
query. It strips Octant's session cookie, proof, and CSRF headers, as the
gateway already does, and hop-by-hop headers; it sets `Host` to
`localhost:<port>` and adds no forwarding headers. Refusals are typed.

**Proxy session.** The client mints a proxy session with the same device-key
challenge it uses for its product session. A proxy session reaches only the
proxy route, and a product session never reaches it. Each has its own nonce
store and budgets, so loading a page with hundreds of modules cannot exhaust
the budget the Octant interface needs, and the reverse.

**Revocation takes effect at once.** The host keeps a registry of open proxied
responses and WebSockets by device and grant. Revoking or rotating the device,
signing it out, disabling the listener, archiving the thread or losing read
access to it, turning Code off, or the server stopping or changing hands
closes the grant: in-flight responses are aborted and WebSockets closed with
1008 (policy violation) before the revoke response completes, the same order
in which sessions are dropped today. The next request fails its proof and the
client shows the failure page.

**Forwarder and signer on the client.** The forwarder runs in the desktop
app's main process and binds `127.0.0.1` and `::1` on one port the desktop
records, so the page's origin stays the same across launches. A port cannot be
held while the app is closed. When the recorded port is taken at launch, the
forwarder tries the next free port in a small fixed range, records it, and the
next Open says that pages opened earlier start with empty storage, because
their origin changed; when the whole range is taken, Open is refused with that
reason and nothing else in Octant is affected. It holds no
private key: device keys are non-extractable WebCrypto keys in the renderer's
storage. For each upstream request the forwarder builds the proof payload and
asks an open Octant window to sign it over IPC. The renderer signs only
payloads for the proxy route of a grant it holds, so the channel cannot sign
product requests. The client computer's own Octant server never sees the
host's credential or traffic, because hosts never trust each other. With no
Octant window open, signing stops and the page says an Octant window must be
open.

**Addressing.** Each opened server gets the name
`<port>-<label>.octant.localhost` on the forwarder's port, where `<label>` is a
short base32 digest of the host id and thread id. The same host, thread, and
port always give the same name, so a reopen, a dev-server restart, or an app
restart keeps cookies and storage. Chromium resolves `*.localhost` to
loopback without DNS and treats it as a secure context; whether every default
browser on macOS does is checked before building (see decision 4). A name per
server keeps each server's cookies and storage apart from other proxied
servers, from the person's own `localhost` servers, and from Octant's origins:
cookies and storage are scoped by host, not port. The forwarder routes by
`Host` and requires an exact match, so a rebound DNS name gets nothing; an
unknown name gets the refusal page.

Rejected: serving the page on the client's `localhost:<port>` (it collides with
the person's own servers and two threads on the same port, and every port on
`localhost` shares one cookie jar); a path prefix on the host listener's origin
(absolute paths such as `/@vite/client` and cookie paths break, and the page
would run on Octant's origin next to its session cookie); wildcard DNS for the
host (it needs public DNS or a resolver, which is ingress or relay territory).

**Who can use a name.** Loopback is reachable by every process on the client,
including another OS user, and any of them can serve some other
`*.octant.localhost` name on some other port. Every such name is same-site
with the proxied one, and a cookie for a name is sent to every port on it, so
neither `SameSite=Strict` nor the exact `Host` match proves where a request
came from. The forwarder therefore admits a request only when it carries that
open's secret and, where the browser sends fetch metadata, `Sec-Fetch-Site` is
`same-origin` or `none` and any `Origin` is the name's exact origin.
`same-site` and `cross-site` requests are refused, so a sibling name's page
cannot drive the dev server through the person's browser.

Open mints the secret. Octant's own browser never holds it as a cookie: the
desktop adds it as a request header only to requests for the name's exact
origin, so no other port ever sees it. The default browser gets it as a
cookie: Open loads `/.octant/claim` on the name with a one-time token in the
fragment, which the page posts back, the launch-token pattern `octant web`
uses. The cookie has a reserved name and is `HttpOnly`, `SameSite=Strict`, and
host-only; the forwarder strips it before forwarding and drops any upstream
`Set-Cookie` of that name. Residual risk, stated in the user guide: because
browsers send a name's cookies to every port on it, a process on the client
that gets the person's browser to request the name on its own port receives
the cookie and can replay it to the forwarder. What it reaches is that one dev
server for as long as the grant lives, never Octant authority on either
computer. Decision 11 chose to offer the default browser with this risk
stated.

**What the page sees.** The page's origin is the name. Upstream, the dev
server sees `Host: localhost:<port>`, and `Origin` and `Referer` that name the
client origin are rewritten to `http://localhost:<port>`, so host checks and
same-origin checks in the dev server pass; other origins pass unchanged. In
responses, the forwarder:

- rewrites a `Location` that names the upstream origin (`localhost`,
  `127.0.0.1`, or `[::1]` at that port) to the name, and leaves relative and
  other-origin redirects alone;
- drops a `Set-Cookie` `Domain` attribute that names `localhost` or a loopback
  address, so the cookie is host-only on the name, and keeps `Path`,
  `SameSite`, and `Secure`;
- drops `Strict-Transport-Security`.

Bodies are never rewritten. An absolute `http://localhost:<port>` URL inside
HTML, script, or JSON reaches the client's own loopback and fails; so does an
OAuth callback registered on `localhost` and a second server of the same thread
called by its port. The Open menu says so in one line. An HTTPS dev server's
loopback certificate is accepted and pinned for the grant's life (decision 5).

**WebSockets and hot reload.** The forwarder accepts an upgrade on a name and
opens a WebSocket to the proxy route; the upgrade request carries a proof like
any request. The host accepts upgrades on the proxy route only (every other
route keeps refusing them), connects to `ws://localhost:<port>/<path>` with
`Host` and `Origin` rewritten, and passes the subprotocol through. After the
upgrade, frames carry no proof of their own: the socket lives under its grant
and closes on revocation, when the grant closes, or when the proxy session
reaches its absolute expiry, and the dev server's client reconnects with a new
proof. A dev server's hot-reload client that connects to the page's own host
works; one pinned to another host or port does not. Octant's browser shows
whether live updates are connected; the default browser has no Octant chrome,
so the Open menu and the user guide state the limit.

**Where Open is offered.** In the desktop app, a Local servers row and a
Running services row for an Octant-owned, listening server in a thread open the
page live in Octant's browser, with Open in browser beside it. Octant's browser
is the person's, never an agent's: a native view in a partition per name,
confined to that origin, which no agent on either computer can drive. Any
other row's Open keeps the host's picture, with one line saying why. A paired
browser without the desktop app, and the phone, have no forwarder. A plain
browser cannot attach a device proof to its own navigations, subresource
loads, or WebSocket upgrades. A service worker could sign fetches but not the
first navigation or an upgrade, and it would need the device key in the page's
origin, which a non-extractable key cannot reach. There, Open keeps the host's
picture and says the Octant app is needed to open the page live.

**Limits.** These are starting values for the live check to confirm. Over a
limit the client gets a 503 with `Retry-After`; nothing queues past the bound.

| Resource                     | Limit                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| Open grants                  | 8 per device, 32 per host                                                          |
| Concurrent proxied requests  | 32 per device, 64 per host, apart from the product budget of 8 per device          |
| Request body                 | 8 MiB, because the forwarder hashes the body for the proof before sending it (413) |
| Response                     | Streamed with no size cap; closed after 5 minutes without a byte                   |
| WebSockets                   | 4 per grant, 16 per device; 16 MiB per message                                     |
| Proxy-session nonces         | 16,384 in the retention window, apart from the product session's store             |
| Upstream connect on the host | 5 seconds, then the request fails as unreachable                                   |

**Failure copy.** A failure inside an opened page is a small refusal page the
forwarder serves at the name; a refusal before opening is a line on the row.

| Condition                           | Copy                                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------- |
| Server Octant does not own          | Octant didn't start this server, so it opens only on {host}.                             |
| Server in the Project folder        | This server isn't in a thread, so it opens only on {host}.                               |
| Paired browser or phone             | To open this page live, use the Octant app on your computer.                             |
| Thread the device cannot read       | This device can't open servers in that thread.                                           |
| Server stopped or changed           | The server on port {port} stopped or changed. Open it again from Running services.       |
| Device revoked                      | This computer no longer has access to {host}. Pair it again to open servers there.       |
| Host unreachable                    | Can't reach {host}. Check that it's on and on the same network.                          |
| No Octant window open               | Open an Octant window to keep this page connected.                                       |
| Over a limit                        | {host} is busy with other requests from this computer. Try again in a moment.            |
| Request body too large              | This upload is over the 8 MB Octant can send to {host}.                                  |
| Forwarder ports all taken           | Octant can't open pages here: its local ports {first}–{last} are in use.                 |
| Live updates not connected (in-app) | Live updates aren't connected. A dev server set to a fixed reload port can't reach this. |

## Decisions

The maintainer approved the recommended option for every decision on
2026-10-14. Each lists the chosen option first, then the options not taken and
why.

1. **Where the client forwarder runs: A, the desktop app's main process.**
   - Not B, the client computer's own Octant server: it would put the other
     host's credential and traffic in a second host's server, which "hosts
     never trust each other" forbids.
   - Not C, a CLI command for a computer without the desktop app: it can
     follow once A works and needs its own key custody.

2. **Who signs each request: A, the renderer, per request, over IPC.** The
   private key stays non-extractable. The live check measures a cold Vite page
   load, which is hundreds of requests, to confirm the cost.
   - Not B, a second, extractable proxy key kept in the Keychain by the main
     process: it adds a second credential to pair, rotate, and revoke.
   - Not C, a device proof only when the grant opens, then a bearer cookie for
     the page's requests: it breaks the rule that every request carries the
     device proof.

3. **A separate proxy session: A.** Its own session, nonce store, and budgets,
   reaching only the proxy route.
   - Not B, reusing the product session: a page load would use up its nonce
     store and its concurrency of 8 per device.

4. **Address shape: A, `<port>-<label>.octant.localhost` on one stable
   forwarder port.** Before building, check that every default browser on
   macOS resolves `*.localhost` and keeps `Secure` cookies on it. If one does
   not, fall back to one `127.0.0.1` port per opened server for that browser
   only, and say that cookies on a loopback IP address are shared across its
   ports.
   - Not B, the upstream port on the client's `localhost`: it collides with
     the person's own servers, and every port on `localhost` shares one cookie
     jar.
   - Not C for every browser, one `127.0.0.1` port per opened server: the same
     shared cookie jar, and many more ports.

5. **HTTPS dev servers: A, accept the certificate the loopback server
   presents, pinned for the grant's life,** as local Open's
   `acceptsLocalCertificate` does. The page on the client stays `http` on its
   `*.localhost` name.
   - Not B, refusing them: it would turn away a common dev setup for no gain
     in authority.

6. **Servers in the Project folder (no thread): A, no grant in the first
   release.** Open keeps the host's picture.
   - Not B, a Project-scoped grant for a device that can read the Project: the
     design is thread-scoped, and B needs its own read rule.

7. **Servers Octant does not own: A, refuse, even with a confirmation.**
   - Not B, allowing them after the Stop-style confirmation naming process,
     folder, and port: only Octant-owned listeners are proxied, because Octant
     cannot tell who started the others.

8. **Storage in Octant's browser: A, a persistent partition per name, cleared
   when the host is removed or the device unpaired.** A sign-in inside the dev
   app survives a reopen. The default browser keeps its own storage either
   way.
   - Not B, an ephemeral partition per open: every reopen would sign the
     person out of their dev app.

9. **Signing with no Octant window open: A, signing needs an open window and
   the page says so.**
   - Not B, a hidden background renderer that keeps signing: it keeps a
     renderer alive only to sign, which is a separate lifecycle to design.

10. **Plan threads: A, apply the local Open decision for the thread's posture
    unchanged.** Opening is the person browsing, not the agent writing, and a
    remote device gets no more than a local window.
    - Not B, refusing a Plan thread's servers: it would give a remote device
      less than a local window for no safety gain.

11. **Opening in the default browser: A, offer Open in browser, with the
    replayable-cookie risk stated in the user guide.** The exposure is one dev
    server the person opened, to a process already running on their computer,
    and the issue asks for the person's own browser.
    - Not B, Octant's browser only, where the secret is a header the desktop
      adds for the exact origin and never a cookie: it removes the risk but
      leaves the person without their own browser, which they asked for.

12. **Forwarder port range: A, ten ports from one fixed default, falling
    forward on collision.** A small known range keeps names recognizable and
    makes the refusal copy precise.
    - Not B, any free port the system assigns: it changes every origin on each
      collision.

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

   **Built.** The contracts are `packages/contracts/src/remoteServerGrants.ts`:
   the request names the listing its id came from (a thread's Local servers
   with that thread and Project, or Running services with neither), the
   answer is the grant id, thread, and port or a typed refusal, and the
   opened and closed journal payloads carry the device, thread, and port and
   nothing about the endpoint. The policy is
   `packages/domain/src/remoteServerGrantPolicy.ts`. Rules this slice
   resolved, which the route must keep:
   - The checks run in a fixed order, and the first failure answers: local
     principal, unreadable thread, unlisted id, not Octant-owned, no thread,
     not listening, posture. Thread readability comes before the listing, so a
     device that cannot read a thread learns nothing about which ids are
     listed in it.
   - A server belongs to a thread only when it runs in that thread's own
     worktree: a Running services row that names the thread, or a Local
     servers row in the thread's checkout when that checkout is its own
     worktree. A Local servers row outside the checkout gets `not-in-thread`
     like the Project folder does, because Octant's ownership is host-wide and
     the server may be another thread's.
   - The posture check calls the local Open decision unchanged. It allows
     every posture today, so its refusal (`open-denied`) cannot occur yet; it
     exists so a later change to local Open reaches paired devices too. A
     local decision that asks for a confirmation or an approval refuses the
     grant, because a paired device cannot give either for the host.
   - Close reasons are the losses listed under revocation, plus the proxy
     session ending, since a grant is bound to its session.

   The grant cap refusal and its contract arrive with the grant service in
   slice 2. No rule moved to the architecture: no route, service, or client
   reaches the contracts or the policy yet.

2. **Grant service and route on the host.** Minting and closing grants,
   re-observation by listener id, journal events for open and close, grant
   caps, and the proxy session.
   Route tests: refuses a listener Octant does not own; refuses a thread the
   device cannot read; refuses a revoked device; answers `not-found` the same
   way for an unlisted id and a stopped server; refuses a local principal;
   refuses past the grant cap. The product session cannot reach the proxy
   route and the proxy session cannot reach product routes. Journal replay
   rebuilds the open-grant view.

   **Built.** The proxy session store is `apps/server/src/remote/remoteServerProxySessions.ts`,
   the grant service `apps/server/src/remote/remoteServerGrantService.ts`, and
   the route lives in the private listener's authentication beside product
   sessions. The rules now in force are in the
   [architecture](../architecture.md) under proxy sessions and server grants.
   Rules this slice resolved, which later slices must keep:
   - The proxy session lives in the host's memory, not the product session
     store, so a product route cannot find it and a host restart ends it and
     every grant with it; a starting host journals those grants closed as
     `proxy-session-ended`.
   - The proxy transcript is the product one under its own label, so a device
     key signature asks for exactly one kind of session.
   - The grant cap refusal is `grant-limit`, asked last. Opening the same
     server again under the same session returns the same grant rather than
     spending the cap, since there is no route to release a grant: grants end
     only by the losses listed under revocation.
   - A device keeps at most four proxy sessions; a fifth ends its oldest, so a
     client that lost its cookie is not locked out until idle expiry.
   - An archived thread is refused as `thread-unreadable`, because archiving
     closes a grant. A purged thread closes its grants as `thread-unreadable`,
     and the purge then erases their records.
   - A credential expiry closes grants as `device-credential-expired`, a close
     reason this slice added. Signing out any of a device's product sessions
     ends all its proxy sessions, as `device-signed-out`.
   - A Local servers row belongs to the thread only when the thread's checkout
     is a managed worktree whose root is not the Project folder.
   - A thread or server closed while a grant request was being decided
     mints nothing: closing either bumps a counter the request checks just
     before minting, and the thread is re-read there too. A failed thread read
     answers unavailable, never `thread-unreadable`.
   - A device decides one grant request at a time, since each re-observes the
     host's listeners.
   - A host key recovery revokes every device the old key paired, so its
     grants close as `device-revoked`; the device's record keeps the recovery
     as the reason.
   - The grant and proxy-session endpoints have no caller until slice 5's
     forwarder, so the wiring check lists them as uncalled, each with the
     reason.

   Not closed by this slice, and closed by slice 3's per-request checks: a
   server that exits or changes hands without Octant stopping it, read access
   lost other than by archive, and Code turned off.

3. **HTTP proxy route on the private listener.** Per-request proof against
   the proxy session, endpoint identity re-check, header handling, budgets,
   and the revocation registry.
   Tests: refuses a revoked device and aborts its in-flight streamed response
   before the revoke response completes; refuses a grant presented by another
   device; refuses a request after the port changes hands; Octant's cookie,
   proof, and CSRF headers never reach the upstream server; `Host` is
   `localhost:<port>`; the body cap answers 413 and the concurrency cap 503
   with `Retry-After`, apart from the product budget.

   **Built.** The relay is `apps/server/src/remote/remoteServerProxyRelay.ts`,
   its checks and revocation registry live in the grant service, its header
   rules are `packages/domain/src/remoteServerProxyRelayPolicy.ts`, and the
   port re-observation is `createLiveLocalListenerHoldingProbe`. The rules now
   in force are in the [architecture](../architecture.md) under the relay.
   Rules this slice resolved, which later slices must keep:
   - The forwarder reaches the host the way any proxy request does: the
     listener's own `Origin` (required on unsafe methods) and `Sec-Fetch-Site`
     `same-origin` or none. The host turns that `Origin` into the dev server's
     origin and a `Referer` under the grant's path into the dev server's path,
     so the forwarder rewrites the page's origin to the listener's and its
     paths to the grant's, never to the dev server's.
   - The per-open secret stays between the page and the forwarder. The host
     never sees it: any cookie named `octant-` (after an optional `__Secure-`
     or `__Host-`) is Octant's and crosses neither way, so the claim cookie
     uses that prefix.
   - Only a response carrying `x-octant-server-proxy: relayed` is the dev
     server's; the host strips that header from the dev server, so every other
     response on the route is the host's own refusal or budget.
   - Each request gets its own upstream connection, so the plan's two-second
     re-check on a reused connection does not arise. Ownership is re-walked
     from the Octant terminal roots on every check, so a server that left its
     terminal closes its grant as `server-changed-hands`.
   - `Authorization` and the page's own cookies reach the dev server: they are
     the page's credentials for its own server and carry no Octant authority.
   - Code is always on today, so `code-disabled` cannot occur yet; the check
     exists so a later switch reaches open grants.
   - A server's port and scheme come from the grant's endpoint only, which is
     a loopback IP literal; a `localhost` endpoint is refused rather than
     looked up.
   - The forwarder must not read relayed responses through a session or cookie
     jar that holds the listener's origin. A relayed response arrives from the
     listener's address, so a jar would store the dev server's `Set-Cookie`
     under that origin and send it back beside the proxy session cookie. The
     forwarder hands the response to the page under the page's own name. The
     host already drops `Clear-Site-Data` and `Alt-Svc`, which act on whichever
     origin reads a response.
   - The relay does not confirm which process accepted each connection, so a
     port that changes hands between the check and the connection receives one
     request before the next check closes the grant. The architecture records
     why.

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

   **Built.** The Running services card takes an optional live opener from
   its window. With one, an Octant-owned, listening server in a thread offers
   **Open** and **Open in browser** and states the page's limits in one line;
   a server Octant does not own, or one in no thread, says it opens only on its
   computer, in the table's words; a refusal from the opener shows on the row.
   The pieces: name, admission, and header rules in
   `packages/domain/src/remoteServerPagePolicy.ts`; the proxy session in
   `RemoteConnection.issueServerProxySession`; grants and the signing door in
   `packages/client-runtime/src/remoteServerProxyClient.ts`; the forwarder in
   `packages/client-runtime/src/remoteServerForwarder.ts` (Node only, outside
   the package barrel); its lifecycle, recorded port, signing round trip,
   listener transport, and Octant's browser window in
   `apps/desktop/src/remoteServerPages.ts`; the window's opener in
   `apps/web/src/home/remoteServerLiveOpener.ts`. Rules this slice resolved:
   - **Where Open appears.** A desktop window reads its own host, so it had no
     row of another computer to open. A desktop window whose Environments
     filter is narrowed to one paired computer that is connected reads that
     computer's Running services over its paired session, names it, and offers
     the live opener; with any other filter it reads its own host as before.
     Rows read that way have no picture Open, since this window's Browser tabs
     belong to its own host.
   - **The renderer builds the proof.** The forwarder sends the request's
     method, full proxy path, and body digest, never a payload to sign. The
     window canonicalizes the path, refuses it unless it is under the proxy
     route of a grant it holds (a dot segment that climbs out is refused), and
     builds and signs the envelope itself, so the channel can sign nothing but
     a proxy request. The main process accepts back only Octant's own headers
     (session cookie, proof, CSRF, command id, origin, fetch metadata), and
     only from the window it asked.
   - **The signer is the window that opened the page.** Its grants live in its
     memory, bound to its proxy session. When it closes, its pending
     signatures fail at once and the page says an Octant window must be open;
     another window cannot sign for grants it never got.
   - **A proxy session the host forgot** (idle expiry, a host restart) answers
     the next grant request 401; the client mints one new session and asks
     once more, and drops the grants of the old one. A refused proxy session
     never clears the product session.
   - **Port.** The forwarder starts on the first Open, not at launch, so the
     app holds no port until it is used. It binds `127.0.0.1` and `::1` (a
     computer without IPv6 keeps IPv4 alone) on the recorded port, else the
     next free one in 47610–47619, and records the one it holds in the app's
     data folder. A move is said once, on the row, as a notice.
   - **Secret and claim.** Each name has one 32-byte secret for its life in
     the forwarder; reopening the same server keeps it. Octant's browser adds
     it as `x-octant-page-access` only to requests whose origin is exactly the
     page's. Open in browser loads `/.octant/claim` with a one-time token
     (two minutes) in the fragment; the page's own script posts it back, and
     the forwarder answers with the `octant-page-access` cookie, `HttpOnly`,
     `SameSite=Strict`, host-only. The claim post must carry the page's own
     `Origin`.
   - **Octant's browser** is a window of its own per page name in a persistent
     partition, sandboxed, with every permission refused. It stays on the
     page's origin; a link or new window to another origin opens in the
     default browser. No agent can reach it: it is not a Browser tab.
   - **Transport.** The forwarder reaches the host through the listener trust
     rule (private address, pinned or platform certificate) with plain Node
     HTTP and no cookie jar. A trust refusal sends nothing and the page says
     the host cannot be reached.
   - **Responses.** Only a response the host marks relayed reaches the page,
     with `Location`, `Set-Cookie`, and HSTS handled as the design says;
     anything else is the host's answer and becomes the failure page.
   - **Decision 4 check.** On macOS 27 the system resolver answers
     `*.localhost` with `127.0.0.1` and `::1` (checked with `dscacheutil`), so
     Safari and other browsers that use it reach the name; Chromium resolves it
     itself. Whether every default browser keeps a dev server's `Secure`
     cookies on `http://*.localhost` is part of the live check.

   **Not built in this slice:** a Local servers row's Open (its listing carries
   no ownership), the live-updates indicator, WebSocket forwarding (the
   forwarder answers an upgrade 501 until slice 4), clearing a page's
   partition when its host is removed or the device unpaired (decision 8),
   and signing when the opening window has closed. The stopped-or-changed
   copy names Running services, since Local servers does not offer Open yet;
   four refusals the table lacked use the copy below.

   | Condition                              | Copy                                                                     |
   | -------------------------------------- | ------------------------------------------------------------------------ |
   | Name the forwarder did not open        | Octant didn't open a page at this address.                               |
   | No secret or a used claim token        | Open this page again from Octant on this computer.                       |
   | `same-site` or `cross-site` request    | Octant refused a request another site sent to this page.                 |
   | Proxy session ended, grant not in hand | This page's access to {host} ended. Open it again from Running services. |

   **WebSocket.** Slice 4 is not built: the relay refuses an upgrade with
   `upgrade-refused` and never connects (a gateway test with a dev server that
   would accept the upgrade proves it never receives one). Until it lands the
   user guide and the row state that live reload may not connect.

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
