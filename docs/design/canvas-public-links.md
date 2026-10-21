# Canvas public links

This topic specification owns public share links for a Canvas: the Settings
switch, publishing through the export approval card, what leaves the host,
the link's terms, the host's record of each link, and the public Canvas share
service that stores and serves them, which lives in the `octant-webapp`
repository. Architecture owns the
boundary: the external call it adds
([Overview and principles](../architecture.md#overview-and-principles)), what
a share carries
([Canvas documents, designs, and prototypes](../architecture.md#canvas-documents-designs-and-prototypes)),
and the release scope
([Current Release Boundary](../architecture.md#current-release-boundary)).
Authenticated snapshots and exports to a folder or a gist stay as
[Canvas: Shares](canvas.md#shares) describes them.

Approved by the maintainer on 2026-10-20: the service can read what it is
sent, so it can draw the page and link previews. The host side, the wire
contract, and the service are implemented; deploying the service, its DNS,
and TLS are not part of this change.

## Off until the person turns it on

- Settings › Data & privacy › **Public links** is off by default. Its row names the
  service URL, `https://canvas.octant.sh` unless the person enters their own.
  A service URL is `https:`; `http:` is accepted only for a loopback address
  (`127.0.0.1`, `::1`, `localhost`) so a self-hosted service can be tried on
  one computer.
- While the switch is off, the Public link destination is not offered, no
  request reaches the service, and nothing is prepared for it. Turning the
  switch on sends nothing either: the first request is the person's first
  publish.
- Turning the switch off does not delete links that exist. They live at the
  service until they expire or are revoked, so the Canvas still lists them and
  **Revoke** still works: withdrawing a link only narrows access. **Update**
  and a new publish are refused while the switch is off.

## Publishing is the person's act

- A link is published only through the Canvas export flow, destination
  `public-link`, format `share-document`, and only after the person approves
  the export approval card in a local window. A paired device may see the
  links and copy one, but prepare, approve, update, and revoke are refused for
  it, as minting an authenticated share already is.
- No agent tool reaches the export flow or the service, and none is added:
  the Canvas agent tools create, revise, and preview, and the host's own
  service port is reached only from the export destination and the revoke
  route.
- The approval card names:
  - the destination (Public link) and the service host it goes to, as the
    card's account line;
  - the audience: anyone with the link (`secret` visibility: unlisted, but
    open to whoever holds the URL);
  - what leaves: the payload itself, shown in full, and, when the Canvas holds
    a design, that its markup leaves as written;
  - that the service stores and can read the Canvas, and shows its title and
    summary in link previews;
  - the expiry, which the person can change, and an optional password;
  - for an update, the link it replaces the content of.
- Approving the card is the acknowledgement that a design's markup is shared
  as written, as for an authenticated snapshot. The payload digest on the card
  is the payload sent; nothing is rendered again after approval.

## What leaves the host

The payload is a `CanvasPublicShareDocument`
(`packages/contracts/src/canvasPublicShare.ts`), built by
`buildCanvasPublicShareDocument` in `packages/domain` from the Canvas's
current version through the same block filter an authenticated snapshot
uses:

- the title, the publish time, the share schema version, a summary of at most
  200 characters taken from the first reading text (used for link previews),
  and the shared blocks;
- no Canvas, version, host, Project, or thread id, no provenance labels, and
  no source manifest; no source ids on any block; no file contents; no
  declared images of a design (a frame draws a placeholder where one was
  named); and an action block refuses the whole publish;
- a design's frames only with the card's acknowledgement.

The document is self-contained: the service draws it from its typed blocks
without calling back to the host. It is a frozen copy. Nothing syncs; a
change to the Canvas reaches the link only when the person approves an
update. The payload is bounded at 262,144 bytes of UTF-8, the export body
budget, and the service refuses a larger one.

## Link terms

- **Ids.** The service mints the share id from 16 random bytes (128 bits),
  written as 22 characters of URL-safe base64. The link is
  `<service>/s/<id>`.
- **Expiry.** The default is 30 days; the person may pick 1 to 365 days, or
  no expiry, which the card offers only as an explicit choice. The service
  refuses an expiry later than 365 days from the request. An expired link
  answers 410.
- **Password.** Optional, 8 to 256 characters. It travels in the request body
  over TLS, the service stores only its hash (`Bun.password`, argon2id), and
  it never appears in a URL, the journal, or the host's records. A viewer
  enters it in a form; a correct answer sets a view grant cookie (HttpOnly,
  SameSite=Strict, Secure on HTTPS, scoped to that link's path, one hour),
  signed by the service and void once the password or content changes. Update
  keeps the existing password unless the card supplies a new one; removing a
  password is revoke and publish again.
- **Update.** A Canvas has at most one active link. Publishing while one is
  active is an update: the card says which link, the service replaces the
  payload and expiry under the same id, and the URL does not change.
- **Revoke.** Revoking deletes the payload at the service and leaves a
  content-free tombstone (id and time) so the link answers 410. A tombstone is
  removed after 90 days, after which the link answers 404.

## Owner proof

There are no accounts. At create the service returns a per-share owner secret
(32 random bytes, URL-safe base64) and stores only its SHA-256. The host keeps
the secret in the credential broker's own namespace for it
(`/v1/canvas-public-share-secrets/*`; a Keychain service and a Secret Service
attribute of its own) under a random credential reference, never in the
journal, a projection, a response to a window, or a log. Keeping it apart from
provider credentials means a provider purge never strands a link its owner
can no longer revoke. Update, revoke,
and status present it as `Authorization: Bearer`; the service compares hashes
in constant time and answers a wrong or missing secret with 403, the same
answer for an id that does not exist, so the secret cannot be used to probe
ids. The host deletes the secret once the service confirms revocation or the
link has expired. Expiry is settled by a host sweep that runs once the host is
serving and hourly after that: it deletes the secret first, then journals
`canvas.public-share-expired@1`, so a failed delete is retried on the next pass
and a settled link is not visited again.

A link the service created but the journal could not record (a full disk
refuses the append) would be live, unlisted, and unrevocable, so the host
withdraws it at once with the secret it still holds and then deletes the
secret. If the service cannot be reached the revoke is owed and retried like
any other; when the journal refuses that too, it is owed in memory until the
host stops. Publishes, updates, revokes, and expiry for one Canvas run one at
a time on the host, so two approved publishes cannot both create a link; the
journal's version check is the backstop.

## The host's record

Each link is journaled (`canvas.public-share-published@1`, `-updated@1`,
`-revoked@1`, `-expired@1`, in the `canvas-public-share` aggregate) and projected per Canvas as its id, URL, service origin, the
Canvas version it carries, publish and update times, expiry, whether it has a
password, and status (`active`, `expired`, `revoking`, `revoked`). The Canvas
share panel lists them with **Copy link**, **Update**, and **Revoke**.

Purging a Canvas, or a thread with the Canvases it owns, revokes each of their
active links. A revoke the service cannot answer is kept as `revoking`, with
its owner secret, after the Canvas is gone, and retried when the host starts
and on each later purge or listing until the service answers that the link is
gone. Only that pending revocation outlives the purge: it is a
`canvas-public-share-revocation` aggregate naming the link, its service, and
the secret's reference, and no Canvas, so the purge's ownership walk leaves it.
The Settings switch is the `canvas-public-link-settings` aggregate, changed
only from a local window against the version the window read.

## The service

The service is a Bun app in the `octant-webapp` repository, beside Octant's
other web services, because it is deployed with the website rather than
shipped with the desktop app. It reads the share document with this
repository's contracts and draws blocks with its domain layout code, bundled
from one pinned commit of this repository (`packages/share-kit` there, with the
commit and versions in its `source.json`); it has no other dependency. A host
that publishes a share format or wire version the running service does not
know is refused, and nothing is stored, so a change to either version here
needs the kit synced and the service deployed before the desktop release that
publishes it. It serves two origins from two listeners: the public origin
(`https://canvas.octant.sh`) for the API and viewer pages, and a separate
user-content origin (`https://canvas-usercontent.octant.sh`) for design frames.
It refuses to start when the two origins are the same. TLS is terminated in
front of it.

### API (version 1)

| Route                              | Body or proof                              | Answer                                    |
| ---------------------------------- | ------------------------------------------ | ----------------------------------------- |
| `POST /api/v1/shares`              | `canvas-public-share-create`               | 201 `canvas-public-share-created`         |
| `PUT /api/v1/shares/<id>`          | owner secret, `canvas-public-share-update` | 200 `canvas-public-share-updated`         |
| `DELETE /api/v1/shares/<id>`       | owner secret                               | 200 `canvas-public-share-revoked`         |
| `GET /api/v1/shares/<id>`          | owner secret                               | 200 `canvas-public-share-status`          |
| `POST /api/v1/shares/<id>/reports` | `canvas-public-share-report`               | 202                                       |
| `GET /s/<id>`, `POST /s/<id>`      | password form for a protected link         | the viewer page, or 404 / 410 / 401 / 429 |
| `POST /s/<id>/report`              | the viewer's report form (no script)       | a thank-you page                          |
| `GET /f/<id>/<blockId>?t=<token>`  | user-content origin only                   | one design's frames                       |
| `GET /healthz`                     | none                                       | 200 `ok`, nothing about any share         |

Every body is decoded strictly against the contract, an unknown field or
future version is refused, and a refusal is `canvas-public-share-refused`
with a code (`malformed`, `too-large`, `unauthorized`, `not-found`, `gone`,
`rate-limited`, `unavailable`). The owner routes answer 410 for a revoked or
expired link.

### Viewer safety

- Every viewer response carries `X-Robots-Tag: noindex, nofollow, noarchive`
  and a `robots` meta tag, `Referrer-Policy: no-referrer`,
  `X-Content-Type-Options: nosniff`, and a policy of `default-src 'none';
script-src 'none'; style-src 'self'; img-src 'self' data:; frame-src
<user-content origin>; form-action 'self'; base-uri 'none';
frame-ancestors 'none'`. The page loads one first-party stylesheet and
  nothing from any third party: no script, font service, analytics, or
  tracker.
- Typed blocks are drawn by the service as escaped HTML, using the domain's
  number format and reading order. Text is never interpreted as markup.
- A design's frames are drawn only from the user-content origin, in an
  `iframe` whose `sandbox` never holds both `allow-same-origin` and
  `allow-scripts`. A static design is `sandbox=""` under the static frame
  policy. A design that runs script is not loaded until the viewer clicks
  **Run**, a plain link that draws the page again with that one frame as
  `sandbox="allow-scripts"`, served under the running frame policy with its
  own `sandbox` directive. Frame responses carry `frame-ancestors` naming the
  public origin only, and a frame address carries a short-lived token the
  service signs for one link and revision, so a protected link's frames are
  not open without its password. The token also names whether it opens the
  static or the running policy. A design drawn in the workspace theme is drawn
  with the frame kit and the default theme's token values, light or dark as
  the viewer's system prefers, since no window hands its tokens over.

### Privacy and limits

- The service stores the payload and its metadata: created, updated, and
  expiry times, byte length, the password hash, the owner secret hash, and an
  aggregate view count. It writes no IP address, user agent, referrer, or
  access log. Rate limits count per IP in memory for the current window only.
- Limits (configurable): a payload of 262,144 bytes; 10 creates, 60 owner
  calls, 120 views, 5 password attempts per link, and 5 reports per IP per
  minute; and a total storage cap past which create answers `unavailable`.
- **Abuse.** Every page links to a report form (`POST /api/v1/shares/<id>/reports`,
  a reason from a closed list and an optional note of at most 1,000
  characters), stored without the reporter's address. The operator takes a
  link down with `bun run takedown <id>` in the service's folder, which asks the
  running service to delete the payload and leave a tombstone that answers 410
  "removed". The request goes to an operator listener bound to 127.0.0.1 and
  started only when `OCTANT_SHARE_OPERATOR_TOKEN` (at least 32 characters) is
  set, with that token as `Authorization: Bearer`. Takedown runs in the serving
  process because the store relies on being the only writer: a second process
  would race a view's write and leave the storage total uncounted. No view or
  update writes a payload that has a tombstone. The viewer names
  the operator's abuse contact when `OCTANT_SHARE_ABUSE_CONTACT` is set.
- **Link previews.** Open Graph and card tags carry the title and summary. A
  password-protected link previews as "Password-protected Canvas" and shows
  neither. A preview image is allowed by this rule but not produced yet.
- Expired payloads are deleted by a sweep that runs at start and hourly.

### Configuration

`OCTANT_SHARE_HOST` (default `127.0.0.1`), `OCTANT_SHARE_PORT`,
`OCTANT_SHARE_USERCONTENT_PORT`, `OCTANT_SHARE_PUBLIC_ORIGIN`,
`OCTANT_SHARE_USERCONTENT_ORIGIN`, `OCTANT_SHARE_DATA_DIR`,
`OCTANT_SHARE_MAX_DOCUMENT_BYTES`, `OCTANT_SHARE_MAX_TOTAL_BYTES`,
`OCTANT_SHARE_ABUSE_CONTACT`, `OCTANT_SHARE_OPERATOR_TOKEN`, and
`OCTANT_SHARE_OPERATOR_PORT` (default `4102`, always on 127.0.0.1). The
frame-token key is generated into the data
directory (mode 0600) when it is first needed.

## Rationale

The service reading content is the maintainer's choice: it lets a link draw
as a page and preview in a chat, at the cost that the operator can read what
is published. End-to-end encryption with the key in the URL fragment was
rejected for v1 because the service could then draw neither the page nor a
preview, and every view would need script. Drawing typed blocks on the
service, rather than storing the host's rendered HTML, keeps markup the
service did not write off its origin: only design frames carry author markup,
and they live on the separate user-content origin. One active link per Canvas
keeps Update unambiguous; a second link for the same Canvas is a revoke away.

## Verification

- `packages/domain` `canvasSharePolicy.test.ts`: the payload is the filtered
  share document without ids, sources, images, or action blocks, and frames
  leave only with the acknowledgement.
- `apps/server` `canvasPublicShareService.test.ts`: nothing is offered or sent
  while off, publish needs the approval and a local window, update reuses the
  link, revoke and purge revoke at the service, and the owner secret stays out
  of the journal. `canvasAgentTools.test.ts`: no agent operation shares,
  exports, or publishes.
- `packages/host-runtime` `credentialBroker.test.ts`: the owner secrets'
  namespace is out of reach of the provider and sync key routes.
- The service's tests (in `octant-webapp`): ids are 128-bit, owner secret, expiry, revocation (410),
  and password are enforced, viewer headers carry `noindex` and the policy,
  and frames are drawn from the user-content origin.
- The service's local end-to-end smoke starts it on `127.0.0.1`, publishes,
  views, revokes, and reads 410.
