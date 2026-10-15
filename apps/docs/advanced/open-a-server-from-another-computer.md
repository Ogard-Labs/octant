---
description: Open a dev server that runs on another paired computer from the computer in front of you, without an SSH tunnel or an exposed port.
---

# Open A Server From Another Computer

When an agent or you start a dev server in a Code thread on one paired
computer (the host), you can open the page on the computer in front of you (the
client). Octant carries the page's requests to the host over the host's private
HTTPS listener, so nothing needs an SSH tunnel and no new port is exposed.

This page describes the designed behavior. Opening a page live needs the
desktop app's local forwarder, which is not shipped yet. Until it is, a row on a
window reading another computer keeps showing the host's picture of the page.

## What it needs

- **The Octant desktop app on the client.** A paired browser and the phone
  cannot attach a device proof to a page's own requests, so there Open keeps the
  host's picture and says to use the Octant app.
- **A paired device.** The client is paired with the host under
  [Remote Access](./remote-access) and still has access.
- **A server Octant started, in a thread.** The server must be listening, run
  in a Code thread's own worktree, and belong to a thread this device can
  already read. A server Octant did not start, or one in the Project folder
  itself, opens only on the host. Its row says so.

## Open a server

On the Running services card, a server that qualifies has **Open** and **Open
in browser**.

- **Open** shows the page in Octant's browser, in a view only you control.
- **Open in browser** shows it in your default browser.

The page gets its own name on your computer, `<port>-<label>.octant.localhost`,
so its cookies and storage stay apart from your own `localhost` servers and from
Octant. The same server keeps the same name across reopens and restarts, as long as
Octant gets the same local port it used before.

## Limits

- **Links to `localhost` inside the page do not load.** The page runs on your
  computer, so an absolute `http://localhost:<port>` URL in its HTML, scripts,
  or data reaches your own loopback, not the host's. The same applies to a
  sign-in callback registered on `localhost` and to a second server of the same
  thread that the page reaches by port.
- **Live reload works only through the page's own address.** The host carries
  the dev server's WebSocket connections, so a hot-reload client that connects
  to the page's own host and port updates the page. One that is pinned to a
  fixed reload port or another host cannot reach this computer, and the page
  needs a manual reload. Octant's browser shows whether live updates are
  connected; your default browser has no such indicator.
- **A taken local port changes the page's origin.** Octant keeps one local port
  for these pages. If another program holds it at launch, Octant moves to the
  next free port in a range of ten, and pages opened earlier start with empty
  storage because their origin changed. If the whole range is taken, Open is
  refused and says so; nothing else in Octant is affected.
- **Octant must be open.** Each request is signed by an open Octant window.
  With none open, the page says an Octant window must be open.
- **Open in browser has one residual risk.** Browsers send a name's cookies to
  every port on that name. A process on your computer that gets your browser to
  request the name on its own port can replay the page's access cookie. What it
  reaches is that one dev server, for as long as the grant lives, and never
  Octant authority on either computer. **Open** in Octant's browser does not
  have this risk.
- **Limits per device:** 8 open servers, 32 concurrent requests, uploads up to
  8 MiB.

## Ending access

Some losses end access the moment they happen, on the host, before the change
returns: revoking or rotating the device, the device signing out, its
credential expiring, archiving or deleting the thread, and turning the listener
off. Open pages then show that this computer no longer has access, and the next
request is refused.

Other changes are found when the next request arrives: you lose read access to
the thread another way, the server stops, or another process takes its port.
The host checks before each request and closes the access then. A process that
takes the port in the milliseconds between that check and the connection can
receive that one request before the following check closes it. Revoking a
device is in [Remote Access](./remote-access#device-management).
