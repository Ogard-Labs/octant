---
description: Open a dev server that runs on another paired computer from the computer in front of you, without an SSH tunnel or an exposed port.
---

# Open A Server From Another Computer

When an agent or you start a dev server in a Code thread on one paired
computer (the host), you can open the page on the computer in front of you (the
client). Octant carries the page's requests to the host over the host's private
HTTPS listener, so nothing needs an SSH tunnel and no new port is exposed.

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

In the Octant desktop app, choose the other computer in the Environments filter
so the start screen shows only that computer. Its Running services card then
lists the servers running there, and a server that qualifies has **Open** and
**Open in browser**.

- **Open** shows the page in a window of Octant's own browser that only you
  control; links to other sites open in your default browser.
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
- **Live reload does not connect yet.** Octant does not carry WebSocket
  connections to the other computer yet, so a dev server's hot-reload socket
  is refused and the page needs a manual reload. A dev server that polls
  instead keeps working.
- **A taken local port changes the page's origin.** Octant keeps one local port
  for these pages, from 47610 to 47619. If another program holds it, Octant
  moves to the next free port in that range, says so once, and pages opened
  earlier start with empty storage because their origin changed. If the whole
  range is taken, Open is refused and says so; nothing else in Octant is
  affected.
- **Octant must stay open.** Each request is signed by the Octant window you
  opened the page from. If you close that window, the page says an Octant
  window must be open; open the server again from Running services.
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
