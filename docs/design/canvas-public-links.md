# Canvas public links

This topic specification owns public share links for a Canvas: the Settings
switch, publishing through the export approval card, what leaves the host,
the link's terms, the host's record of each link, and the reference Canvas
share service that stores and serves them, which lives at `apps/share` in this
repository and is self-hosted: every user runs it on their own host (or points
Octant at another service they choose), and Ogard Labs operates no instance.
Architecture owns the
boundary: the external call it adds
([Overview and principles](../architecture.md#overview-and-principles)), what
a share carries
([Canvas documents, designs, and prototypes](../architecture.md#canvas-documents-designs-and-prototypes)),
and the release scope
([Current Release Boundary](../architecture.md#current-release-boundary)).
Authenticated snapshots and exports to a folder or a gist stay as
[Canvas: Shares](canvas.md#shares) describes them.

Scope hold: public Canvas links take no new scope until
[the Full access rule](../architecture.md#security-and-authority) is built
(maintainer request, 2026-11-12).

Approved by the maintainer on 2026-10-20: the service can read what it is
sent, so it can draw the page and link previews. The host side, the wire
contract, and the reference service (`apps/share`) are implemented. On
2026-11-07 the maintainer decided the service is self-hosted only: no
Ogard-operated instance, no default service address, and the reference app
moved into this repository for one-command deploys (see
[Current Release Boundary](../architecture.md#current-release-boundary)).

## Off until the person turns it on

- Settings › Permissions › **Public links** is off by default, and no service
  address is set by default: Octant operates no share service, so the person
  enters the address of one they run or trust (the reference app at
  `apps/share`). A service address is `https:`; `http:` is accepted only for a
  loopback address (`127.0.0.1`, `::1`, `localhost`) so a self-hosted service
  can be tried on one computer.
- While the switch is off, or no address is set, the Public link destination is
  not offered, no request reaches any service, and nothing is prepared for it.
  Turning the switch on sends nothing either: the first request is the person's
  first publish.
- Turning the switch off does not delete links that exist. They live at the
  service until they expire or are revoked, so the Canvas still lists them and
  **Revoke** still works: withdrawing a link only narrows access. **Update**
  and a new publish are refused while the switch is off.

## Publishing is the person's act

- A link is published only through the Canvas export flow, destination
  `public-link`, format `share-document`, and only after the person approves
  the export approval card, in a local window or on a paired device (maintainer
  decision, 2026-11-12). Not built yet: today only a local window approves; a
  paired device may see the links and copy one, but prepare, approve, update,
  and revoke are refused for it, as minting an authenticated share already is.
  Paired Chat, Work and Code threads use the same Canvas reader and link list
  as the host. Opening a Canvas exposes its existing public links and Copy link
  through the authenticated device session and current Canvas read grant. Its
  client omits creation, editing, export and owner-management methods; their
  controls are absent. Changing thread, mode or host client closes the reader.
- A paired device's Canvas read grant is **thread read authority**: the host
  serves a thread's Canvas cards, and a Canvas's content, history, design
  images, HTML file, running-design page and public-link list, when the
  device may open the thread the Canvas
  belongs to, by the same check that thread's own routes run (Chat's thread
  read rule, Work's and Code's thread reads). The thread must still be filed
  in the Project and mode the request names or the Canvas carries; a Canvas a
  Chat thread owned before it was filed stays the thread's. A refusal reads as
  an empty card list or `unauthorized`, the same for a Canvas that does not
  exist, so a device learns nothing about Canvases it cannot read. A window on
  this host keeps its active-Project rule. A paired device makes every Canvas
  write, share, export, public-link change and Settings change as a local window
  does (maintainer decision, 2026-11-12). Not built yet: today each keeps the
  window rule and stays refused to a paired device.
  _Rationale:_ a paired device's window has no active Project, and the shell
  route that sets one is local-only, so the window rule left every paired
  thread with no Canvas cards (seen on a real pairing in November 2026).
  Letting a device switch the host's Project was rejected: it is a remote
  workspace mutation that would widen a read into control of the host's
  shell, and the device already holds the narrower grant that matters, the
  threads it can open.
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
  no source manifest; no source ids on any block; no file contents; and an
  action block refuses the whole publish;
- every image the document displays (maintainer decision, 2026-11-22): each
  image block's generated image and each image a design declares (a generated
  image, a Project file, or a Browser capture), resolved under the Canvas
  version's own authority as a reader's draw resolves it, as sniffed PNG,
  JPEG, GIF, or WebP bytes in the document's `images`, named by the share's
  own `image-<n>` references, never by an image id, capture id, or path.
  Which images a design displays is found by the best-effort reading of its
  markup described under the service below, with its known limits; nothing
  that reading finds undrawn leaves, and an image that does not resolve is
  not carried and its frame draws a placeholder. Each image is at
  most 3 MiB and all of them at
  most 4 MiB (`CANVAS_SHARE_IMAGES_MAX_BYTES`), counted apart from the
  document's text budget (the export body limit), so the card still shows the
  text whole. The card lists every image that leaves, as a thumbnail with its
  size, and the approved digest covers each image's SHA-256, so approving the
  card approves exactly those images. There is no separate acknowledgement:
  the person sees what is sent, and the card is the safeguard. _Rationale:_
  peers show a guest the images that appear in shared content, a placeholder
  made a shared document look broken, and limiting the share to generated
  images would have restricted a feature the card already makes visible;
- a design's frames only with the card's acknowledgement.

The document is self-contained: the service draws it from its typed blocks
without calling back to the host. It is a frozen copy. Nothing syncs; a
change to the Canvas reaches the link only when the person approves an
update. The document's text, everything but its images, is bounded at
262,144 bytes of UTF-8, the export body budget, and the service refuses a
larger one; its images are bounded apart, at 3 MiB each and 4 MiB together,
and the service stores them with the share, counting them once toward its
total storage cap. A view counts in a small file beside the share, so a share's
images are never rewritten when it is read, and an image request reads only
that image's bytes ([Stored shares](#stored-shares)). The service serves each carried image once, at its own content-addressed address beside the page that shows it: `/s/<id>/images/<sha256>` for the viewer and `/f/<id>/<block>/images/<sha256>?t=<image token>` for a design's frame. Every reference names that address, so a page that shows one image many times stays small and the browser fetches it once. An image address answers only as its page does: a live link, its password grant when it has a password (the viewer's cookie is scoped to the link's path), or, for a frame, an image token the frame page signs for its link, revision and block, lasting as long as a view grant so a prototype left open past its frame token still draws later screens; and only for an image the document carries by that digest (and, for a frame, one its design names). Image requests count against a per-client image limit. The response is the raster with its sniffed type and `nosniff`, with the digest as its ETag and `Cache-Control: private, no-cache`, so the browser checks again before reusing a copy and a revoked or expired link, a lapsed grant, or an expired token stops serving even a kept one; a page that shows an image many times still loads it once. A frame's image responses allow any origin (`Access-Control-Allow-Origin: *`), since a sandboxed frame's origin is opaque and the token in the address is the authority. _Rationale:_ writing each reference as a `data:` image grows the page with every repeat, and capping the repeats would make a large image shown many times fall back to its description; one address per image is how the web shares a picture across a page. Only a reference a browser would draw counts, both for what a share carries and for what a frame draws: one in a `src`, `srcset`, `poster`, or `background` attribute, in CSS, or in a script or inline event handler, outside comments. A reference in a comment, in text, or in another attribute such as `alt` is left as written: it draws nothing and is not carried. The reading follows the browser's: character references in a handler are decoded first, a line comment ends at any line terminator, and strings and regular expression literals hide no comment. It is a best-effort reading for finding references, not an HTML or JavaScript parser, and its known limits are accepted (maintainer decision, 2026-11-22): a regular expression right after a keyword, a `/*` inside a quoted CSS string, a reference a script builds at run time, and other forms a parser would read differently can be misread. A misreading can leave out an image the design shows, which then draws nothing, or carry an image named only where nothing draws it; the approval card and the share panel list every image before it leaves, so the person sees such an image and can decline. Later narrow cases are recorded as known limits and changed only for an over-share in a common form. _Follow-up:_ an exact answer would come from the browser, by rendering the frame and reading which images it actually loads, not from adding a parser.

## Link terms

- **Ids.** Current hosts derive a 128-bit opaque id from their random owner proof,
  written as 22 characters of URL-safe base64. Legacy clients receive an id minted
  by the service from 16 random bytes. The link is
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
  content-free tombstone with id, time and, for owned-create, the owner hash, so the viewer answers 410. A tombstone is
  removed after 90 days, after which the link answers 404.

## Owner proof

There are no accounts. Before a first-party create sends any document, the
host generates a 32-byte owner secret with its platform
CSPRNG, stores the secret in the credential broker and commits a non-secret
publication intent naming the exact service, share id and credential reference.
The id is the first 16 bytes of SHA-256 over UTF-8
`octant-canvas-public-share-id-v1` followed by a NUL byte and the 43-character
owner secret, encoded as URL-safe base64 without padding. The service verifies
this binding before accepting owned-create. A missing-id DELETE can therefore
cancel only the future id proven by its bearer secret, never an unrelated id.
A same-owner cancellation writes a durable content-free tombstone holding only
the owner hash before acknowledging success. It fences a delayed owned-create,
which rechecks after password hashing immediately before the synchronous store
write. The fence survives restart, makes DELETE idempotent for that owner and
refuses a wrong proof without mutation. A new cancellation consumes the existing
create-rate bucket as well as the owner-rate bucket. Tombstone retention remains
90 days. A generic unauthorized or not-found response never confirms withdrawal:
the host keeps the intent and owner proof until an acknowledged cancellation or
gone response. A vault or intent failure sends no document. The owned-create request uses the
explicit `canvas-public-share-owned-create` discriminator; a service which does
not implement it refuses before publication. The host never retries using the
legacy create shape. The reference service still accepts the legacy shape for
older hosts, but current hosts require owned-create support.

The service stores only the owner's SHA-256 and an owner-keyed HMAC of the
approved document and link terms. The keyed digest does not provide a cheap
standalone password test. An identical owned-create retry returns the same
original receipt without replacing content, expiry or password; it authenticates
the owner before comparing terms. A different request under that id is refused
with a conflict and changes nothing. An incorrect owner is refused as on the
other owner routes. Concurrent identical requests have the same result.

The host keeps the secret in the credential broker's own namespace for it
(`/v1/canvas-public-share-secrets/*`; a Keychain service and a Secret Service
attribute of its own) under a random credential reference, never in the
journal, a projection, a response to a window, or a log. Keeping it apart from
provider credentials means a provider purge never strands a link its owner
can no longer revoke. Update, revoke,
and status present it as `Authorization: Bearer`; the service compares hashes
in constant time and answers a wrong or missing secret with 403, the same
answer for an id that does not exist, except a DELETE whose proof derives that
exact missing id may create its cancellation fence. This grants no authority over
another id. The host deletes the secret once the service confirms revocation or the
link has expired. Expiry is settled by a host sweep that runs once the host is
serving and hourly after that: it deletes the secret first, then journals
`canvas.public-share-expired@1`, so a failed delete is retried on the next pass
and a settled link is not visited again.

The publication intent is `canvas.public-share-publication-pending@1` in the
same link-owned aggregate as pending revocations. It contains no document,
password, owner secret or Canvas identity. While its create is in flight,
listing retries cannot withdraw it. A durable published record resolves that
publication intent only; it never resolves a later real revocation. The
aggregate's version remains the fence for that later revocation.

If a create's answer is uncertain, or the published record cannot be committed,
the host retains the already-stored secret and durable intent and withdraws the
known id. Restart and listing retries recover it even if no published record
exists. Withdrawal is reported as complete only for a matching confirmed
receipt or a response establishing that the intended link is gone. Until then
the host reports that it keeps trying. Publishes, updates, revokes and expiry
for one Canvas run one at a time; settings are rechecked after awaited vault
persistence and before the document is sent, and a changed setting after a
create triggers withdrawal instead of a successful publication.

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
from a local window or a device the host's own person paired, against the version it read.

## The service

The reference service is a Bun app at `apps/share` in this repository,
deployable by anyone with `bun apps/share/src/main.ts` or Docker (see its README). Settings › Permissions › Public links includes a
Compose setup guide for the two HTTPS origins, the operator token and abuse
contact, the viewer health check, and a test publish with embedded content. It reads the share document from this repository's
`@octant/contracts` and draws blocks with the `@octant/domain` layout code
through `apps/share/src/shareKit.ts`, which names exactly the modules the
service uses — in-repo, so there is no pinned-bundle sync to redo. A host that
publishes a share format or wire version the running service does not know is
refused, and nothing is stored. A link published under an earlier share
version keeps opening, and its owner keeps managing it, after the service is
redeployed with a newer one. The operator serves two origins from two
listeners — a public origin for the API and viewer pages, and a separate
user-content origin for design frames — configured with
`OCTANT_SHARE_PUBLIC_ORIGIN` and `OCTANT_SHARE_USERCONTENT_ORIGIN`; the service
refuses to start when the two are the same. TLS is terminated in front of it by
the operator's reverse proxy.

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
with a code (`malformed`, `conflict`, `too-large`, `unauthorized`, `not-found`, `gone`,
`rate-limited`, `unavailable`). Revoked or expired viewers answer 410. Owned
DELETE repeats acknowledge cancellation with 200 only for that owner; wrong
proofs answer 403. Other authenticated owner routes answer 410 for gone links.

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
  own `sandbox` directive. A frame that shows carried images adds its own
  image route's path (`<user-content origin>/f/<id>/<block>/images/`) to
  `img-src`, and nothing wider, so even a running frame reaches only those
  images. Frame responses carry `frame-ancestors` naming the
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
- Limits (configurable): a document text of 262,144 bytes, with images of
  at most 4 MiB beside it; 10 creates, 60 owner
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

### Stored shares

A share is one JSON file, `shares/<id>.json` in the data directory. Its terms
(times, byte length, password hash, owner secret hash, revision) come first,
with an image index: each carried image's SHA-256, type, and byte range in the
file, and which images each design names. The document comes last, with the
images' base64 text at its end. The file opens with its head's length as a
fixed eight-digit `headBytes`, so an image request, on the page or in a frame,
reads the head, runs the link's checks on it, and reads that one image's range.
It neither reads nor decodes the document's text or its other images. Both
reads use one open file, so an update landing between them never mixes two
revisions. The page and the frame page still read the whole share.

- A file with no such head, or whose index does not fit the file, is read
  whole. That covers every share an earlier version stored. Reading never
  rewrites one; its owner's next update does.
- An earlier version of the service reads the same file whole and ignores the
  head, so an operator can go back to it and keep every link, including links
  published or updated since. A share it updates there is read whole again
  after the next upgrade.
- A publish or update is one atomic rename, and a revoke, expiry, takedown, or
  owner delete is one unlink, so a share's images never outlive it and are
  never missing from it. A temporary file left by a stop before its rename is
  removed at the next start.
- The index is metadata and is not counted toward the storage cap. Each image
  counts once, as its base64 text in the document.

_Rationale:_ a file per image was rejected. An earlier version cannot read a
share whose images are in other files, so going back would close every link
published since; keeping the images in both places would store and write them
twice; and either way, publish, update, and delete would span several files, with
cleanup owed after a stop between them.

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
- The service's tests (in `apps/share`): ids are 128-bit, owner secret, expiry, revocation (410),
  and password are enforced, viewer headers carry `noindex` and the policy,
  and frames are drawn from the user-content origin. An image request reads
  only its image and the share's head, measured in bytes, and shares the
  earlier version stored keep opening.
- The service's local end-to-end smoke (`bun apps/share/src/shareService.smoke.ts`)
  starts it on `127.0.0.1`, publishes, views, revokes, and reads 410.
