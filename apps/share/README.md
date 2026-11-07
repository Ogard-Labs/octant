# @octant/share — the public Canvas share service

A small Bun service that stores and serves Canvases published from Octant as
public links. Ogard Labs does not operate this service: you run it yourself, on
a server you control, and point Octant at it. Anyone can also build their own
service against the published wire contract (see below).

## Run it

From a checkout of this repository:

```sh
bun install
OCTANT_SHARE_DATA_DIR=/var/lib/octant-share \
OCTANT_SHARE_PUBLIC_ORIGIN=https://share.example.com \
OCTANT_SHARE_USERCONTENT_ORIGIN=https://usercontent.example.com \
OCTANT_SHARE_ABUSE_CONTACT=abuse@example.com \
bun apps/share/src/main.ts
```

Or with Docker, from the repository root:

```sh
docker build -f apps/share/Dockerfile -t octant-share .
docker run --rm -p 4100:4100 -p 4101:4101 \
  -e OCTANT_SHARE_DATA_DIR=/data \
  -e OCTANT_SHARE_PUBLIC_ORIGIN=https://share.example.com \
  -e OCTANT_SHARE_USERCONTENT_ORIGIN=https://usercontent.example.com \
  -v octant-share-data:/data octant-share
```

Any Docker-friendly host works (your own VPS, Fly.io, Railway, Render, a home
server behind a reverse proxy). The only hard requirements are the two origins
and a data directory.

Put a TLS-terminating reverse proxy in front of the two ports. The service
refuses to start when the public origin and the user-content origin are the
same, because design markup is served from the second origin and must never
run on the page origin.

## Configuration (environment variables)

| Variable                          | Default                    | Meaning                                                                                  |
| --------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------- |
| `OCTANT_SHARE_DATA_DIR`           | required                   | Where the store lives.                                                                   |
| `OCTANT_SHARE_HOST`               | `127.0.0.1`                | Bind address; use `0.0.0.0` in a container.                                              |
| `OCTANT_SHARE_PORT`               | `4100`                     | Public API and viewer port.                                                              |
| `OCTANT_SHARE_USERCONTENT_PORT`   | `4101`                     | Design-frame origin port.                                                                |
| `OCTANT_SHARE_OPERATOR_PORT`      | `4102`                     | Loopback-only operator listener, active when a token is set.                             |
| `OCTANT_SHARE_PUBLIC_ORIGIN`      | derived from host and port | The `https://` origin links point at.                                                    |
| `OCTANT_SHARE_USERCONTENT_ORIGIN` | derived from host and port | The `https://` origin design frames are served from. Must differ from the public origin. |
| `OCTANT_SHARE_ABUSE_CONTACT`      | unset                      | Address shown on link pages for reports.                                                 |
| `OCTANT_SHARE_OPERATOR_TOKEN`     | unset                      | At least 32 characters; enables operator takedown.                                       |
| `OCTANT_SHARE_MAX_DOCUMENT_BYTES` | `262144`                   | Per-link document cap (256 KiB).                                                         |
| `OCTANT_SHARE_MAX_TOTAL_BYTES`    | 5 GiB                      | Total store cap; creates answer `unavailable` past it.                                   |
| `OCTANT_SHARE_TRUST_PROXY`        | unset                      | `1` only behind a proxy you control, so `X-Forwarded-For` is trusted for rate limits.    |

The service writes no IP or user-agent logs and keeps only an aggregate view
count per link; rate limiting counts per IP in memory and keeps nothing after
the window. Revoked or expired links answer `410` with a content-free tombstone
(link id and time) for 90 days, then `404`.

## Take a link down

```sh
OCTANT_SHARE_OPERATOR_TOKEN=<token> bun apps/share/src/takedown.ts <share-id>
```

The command asks the running service over its loopback operator listener, so the
service must be running.

## Point Octant at your service

In Octant: **Settings › Permissions › Public links** — turn the switch on and set
**Service address** to your public origin (for example
`https://share.example.com`). Nothing is sent until you approve a publish card
for one Canvas. `http://` addresses are accepted only on this computer's
loopback (`127.0.0.1`, `localhost`, `[::1]`) for local testing.

## Use a different service

Octant accepts any `https://` address, so you can run your own build of this
app or a third-party service that implements the wire contract published in
[`@octant/contracts/canvas-public-share`](../../packages/contracts/src/canvasPublicShare.ts):
`POST /api/v1/shares`, `PUT|DELETE|GET /api/v1/shares/<id>`, and
`POST /api/v1/shares/<id>/reports`, plus the viewer pages on a separate origin.
A plain file host or pastebin does not qualify — it must render the Canvas
document. To share a single Canvas as Markdown instead of a rendered page, use
the built-in **GitHub Gist** export, which needs no share service.

## Tests and checks

```sh
bun test apps/share        # from the repository root, or: cd apps/share && bun test
bun run smoke --filter @octant/share   # boots the service on free ports and publishes to it
```
