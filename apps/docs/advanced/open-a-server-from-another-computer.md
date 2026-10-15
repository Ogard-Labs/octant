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
Octant. The same server keeps the same name across reopens and restarts.

## Limits

- **Links to `localhost` inside the page do not load.** The page runs on your
  computer, so an absolute `http://localhost:<port>` URL in its HTML, scripts,
  or data reaches your own loopback, not the host's. The same applies to a
  sign-in callback registered on `localhost` and to a second server of the same
  thread that the page reaches by port.
- **Live reload may not connect.** The host's proxy does not yet carry
  WebSocket connections, so a dev server's hot-reload socket is refused and the
  page needs a manual reload until that lands. A dev server that polls instead
  keeps working.
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

Access ends at once, on the host, when you revoke the device, when the device
signs out, when the thread is archived or you lose access to it, or when the
server stops or another process takes its port. Open pages then show that this
computer no longer has access, and the next request is refused. Revoking a
device is in [Remote Access](./remote-access#device-management).
