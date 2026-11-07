---
description: How to share a Canvas with a public link — the service you run or choose, what you turn on, what leaves your computer, who can open it, and how to update, expire, or revoke it.
---

# Share a Canvas with a public link

A public link lets anyone you give the URL open a read-only copy of a Canvas in
a browser. The copy is hosted by a share service **you run or choose** — Octant
ships no hosted service of its own. Read this before you turn it on: the
service can read what you publish.

Public links are off until you turn them on, and no service address is set until
you enter one. Turning them on sends nothing. The first request is your first
publish.

## Turn Public links on

1. Open **Settings › Permissions**.
2. Set **Service address** to the public origin of your share service (see
   [Run your own service](#run-your-own-service) below), for example
   `https://share.example.com`.
3. Turn on **Public links**.

A service address starts with `https://`. A plain `http://` address is accepted
only for this computer (`127.0.0.1`, `::1`, or `localhost`), so you can try a
self-hosted service locally. While the switch is off, or no address is set, the
**Public link** destination is not offered and Octant makes no request to any
service.

## Publish a Canvas

1. Open the Canvas and choose **Export**.
2. Choose the destination **Public link**.
3. Read the approval card and approve it.

Publishing works only in a local Octant window. A paired phone or browser can
see your links and copy one, but cannot publish, update, or revoke.

### What the approval card shows

- The destination, **Public link**, and the service it goes to.
- The audience: anyone who has the link.
- The exact content that will be sent, in full. If the Canvas holds a design,
  the card says its markup is shared as written.
- That the service stores and can read the Canvas, and shows its title and
  summary in link previews.
- The expiry, which you can change, and an optional password.
- For an update, the link whose content it replaces.

Nothing is sent until you approve. Declining sends nothing. Octant sends exactly
the content on the card and does not render it again after you approve.

## What leaves your computer

Octant sends one document built from the Canvas's current version:

- the title, the publish time, and a summary of up to 200 characters taken from
  the first reading text, which link previews use;
- the Canvas's blocks;
- the markup of any design, as written.

Octant does not send:

- file contents;
- the images a design names. A frame shows a placeholder where one was named;
- Canvas, version, host, Project, or thread ids, source lists, or source ids;
- anything at all from a Canvas that holds an action block. Such a Canvas
  cannot be published as a public link.

The copy is frozen. Changing the Canvas later does not change the link until you
approve an update. The document is at most 262,144 bytes (256 KiB). The service
refuses a larger one.

## Who can open the link

Anyone who has the URL. The address holds a random 128-bit id, so it cannot be
guessed, but it is not private once you share it. The page asks for no sign-in.
Add a password if you want a second gate.

The service can read the published Canvas. That is how it draws the page and
the preview. Treat a public link like any other file you host with a third
party — and remember you are that party's customer, or its operator.

Link pages ask search engines not to index them, send no referrer, and load
nothing from other sites: no scripts, fonts, analytics, or trackers.

A design that runs script does not load until the viewer clicks **Run**. Static
designs draw without it. Design frames are served from the service's separate
user-content origin, so design markup never runs on the page origin itself.

### Link previews

When someone pastes the link into a chat, the preview shows the Canvas's title
and summary. A password-protected link previews as **Password-protected
Canvas** and shows neither.

## Expiry

A link expires after 30 days by default. You can pick 1 to 365 days on the
approval card. **No expiry** is offered only as an explicit choice. An expired
link answers that it is gone, and the service deletes its content. Your computer
deletes the link's owner secret within an hour of the expiry.

## Password

You can set a password of 8 to 256 characters on the approval card.

- The password is never in the URL. Viewers type it into a form on the page.
- Octant sends it once, over HTTPS. The service stores only a hash of it.
  Octant does not keep it.
- A correct password lets that browser open the link for one hour.
- An update keeps the current password unless you set a new one. To remove a
  password, revoke the link and publish again.

## Update a link

A Canvas has one active link. If it already has one, publishing again is an
update. The card says which link it replaces. The content and expiry change; the
URL stays the same.

To get a second link for the same Canvas, revoke the first.

## Revoke a link

Open the Canvas's share panel and choose **Revoke** next to the link. The
service deletes the content at once. From then on the link answers "gone". The
share panel also lists each link with **Copy link** and **Update**.

Revoke is final. To share the Canvas again, publish again. The new link has a
new address.

## Delete a Canvas or a thread

Deleting a Canvas, or a thread with the Canvases it owns, revokes their active
links. If the service cannot be reached, Octant keeps a note of the pending
revoke and the key it needs, and retries when Octant starts and on later
deletions or listings until the service confirms. That note holds no Canvas
content.

## Turn Public links off

Turning the switch off does not delete your links. They stay live until they
expire or you revoke them. The Canvas still lists them, and **Revoke** still
works. **Update** and new publishes are refused while the switch is off.

Revoke your links first if you want the content gone.

## Privacy at the service

The reference service (below) stores the Canvas you published, and its
metadata: when it was created and updated, when it expires, its size, the
password hash, and a count of views. The view count is a single total for the
link.

It writes no IP address, browser, or referrer to any log. It counts requests
per IP address in memory only, to limit abuse, and keeps nothing after the
short rate-limit window.

When you revoke a link, or it expires, the content is deleted. A small record
with only the link's id and the time stays for 90 days so the link answers
"gone" instead of "not found". After that the link answers "not found".

### Reports and takedown

Every link page has a report form. A report names a reason from a list and can
add a note of up to 1,000 characters. It is stored without the reporter's
address. The operator can take a link down. A removed link answers "removed".

The abuse contact shown on link pages is whatever the operator sets with
`OCTANT_SHARE_ABUSE_CONTACT` — when you run the service, that is you.

## Run your own service

The share service is a small Bun app in this repository at
[`apps/share`](https://github.com/Ogard-Labs/octant/tree/main/apps/share), with
a Dockerfile for one-command deploys. See its
[README](https://github.com/Ogard-Labs/octant/blob/main/apps/share/README.md)
for the full configuration reference.

Quick start from a checkout of this repository:

```sh
bun install
OCTANT_SHARE_DATA_DIR=/var/lib/octant-share \
OCTANT_SHARE_PUBLIC_ORIGIN=https://share.example.com \
OCTANT_SHARE_USERCONTENT_ORIGIN=https://usercontent.example.com \
OCTANT_SHARE_ABUSE_CONTACT=you@example.com \
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

Any host you control works: your own VPS, a home server behind a reverse
proxy, or any Docker-friendly platform. Put TLS in front of the two ports. The
service uses two web addresses — one for pages and API, one for design frames —
and refuses to start if they are the same. Then enter the public origin in
**Settings › Permissions › Public links**.

To take a link down as the operator, set `OCTANT_SHARE_OPERATOR_TOKEN` (at
least 32 characters) when you start the service. Then, on the same server, with
the same token in your shell:

```sh
bun apps/share/src/takedown.ts <share-id>
```

The command asks the running service to remove the link, so the service must be
running.

## Use a different service

You are not limited to the reference app. **Settings › Permissions › Public
links** accepts any `https://` address, so a third-party service can serve your
links if it implements the published wire contract in
[`@octant/contracts/canvas-public-share`](https://github.com/Ogard-Labs/octant/blob/main/packages/contracts/src/canvasPublicShare.ts):
`POST /api/v1/shares`, `PUT|DELETE|GET /api/v1/shares/<id>`, and
`POST /api/v1/shares/<id>/reports`, plus viewer pages on a second origin. A
plain file host or pastebin does not qualify — it must render the Canvas
document. Whichever service you choose, it can read everything you publish to
it, and its own terms and privacy notice apply.

## Share as a file instead

If you do not want to run or trust a link service at all, export the Canvas
without one — see [Export a Canvas or artifact](/guide/export):

- **sharehtml.org page** — the Canvas as one rendered HTML page at an unlisted
  link, no account needed on your side;
- **GitHub Gist** — Markdown, unlisted by default;
- **a folder** — including one your sync client watches, so the file lands in
  Google Drive, Dropbox, or another file-share service you already use.

## Related

- [Export a Canvas or artifact](/guide/export)
- [Privacy notice](/advanced/privacy-notice)
- [Sub-processors](/advanced/sub-processors)
