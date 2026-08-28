# 0034. Signed, notarized, user-controlled updates

**Status:** Proposed

## Context

The release boundary forbade signing, notarization, and an updater. That was
right while the preview was a build you fetched once: an unsigned app the user
deliberately opens is an honest thing, and shipping an update path before there
was anything to update would have been scope for its own sake.

The maintainer has now decided the technical preview must update itself, and
that changes what the boundary is protecting. Once the app can replace its own
binary, "unsigned" stops meaning "the user took a visible risk once" and starts
meaning "anything that can answer an HTTPS request can put code on this
machine." The three items the boundary listed separately are not three
decisions:

- An updater on an unsigned app is an unauthenticated code-delivery channel.
  Whoever controls the feed, or the network between the app and the feed,
  chooses what executes.
- macOS refuses the swap anyway. Squirrel.Mac checks that the replacement
  satisfies the running app's designated requirement, and an unsigned app has
  no requirement to satisfy. Gatekeeper quarantines what arrives.
- So signing and notarization are prerequisites of the updater, not follow-ups
  to it. Shipping the updater first would ship a hole and a broken feature at
  the same time.

The audience decision — prosumers and small teams under GDPR — makes the update
path a data-protection surface as well. An update check is the first thing this
local-first app does that contacts a server the user did not choose, and every
such request discloses an IP address. The compliance package is a separate piece
of work; this record is written so that package finds nothing to apologise for,
which means saying what a check sends and what a server can infer from it rather
than only that it is small.

## Decision

- **The boundary graduates for one deliverable, not three.** Developer ID
  signing, notarization, and in-app update ship together or not at all. A
  packaging pipeline that can produce a signed build but no updater is fine —
  that is this deliverable half-built. An updater that runs against unsigned
  builds is not, and the code refuses to be configured that way rather than
  trusting a release process to remember. Mobile store distribution and hosted
  relay stay outside the boundary. Desktop packaging beyond the first Apple
  Silicon surface is opened by 0058 under the same signing and updater rules.
- **Trust comes from the signature, never from the host.** A feed served from
  the expected domain over a valid certificate proves only that somebody
  controls that domain today, which is not a claim about a release. Octant
  verifies an Ed25519 signature over the feed document against a public key
  compiled into the app, and independently checks that the offered version is
  strictly newer and built for this platform and architecture. A host that is
  compromised, swapped, or impersonated can therefore serve nothing that
  installs.
- **A signed notice is not a verified artifact, so the bytes are checked too.**
  The release's SHA-256 is inside the signature, and the downloaded bytes are
  hashed against it before the platform updater is told anything exists. Without
  that step the signature would cover only a promise and whoever served the
  download could substitute anything. The platform updater then verifies the
  replacement's code signature against the running app's designated requirement.
  No gate stands in for another: ours proves the release is one we published and
  that these are its bytes; the platform's proves the app on disk is signed by
  us.
- **Unverifiable is refused, never downgraded.** A feed that will not parse, is
  signed by a key we do not hold, carries a version that is not strictly newer,
  names another platform, cannot be reached, or whose artifact does not hash to
  what was signed yields no update and no install. There is no "install anyway",
  no prompt that waves a bad signature through, and no fallback to an unsigned
  path. A refusal says which check refused, because a person deciding whether to
  worry needs the difference between "the server is down", "the signature is
  wrong", and "the download did not match".
- **The platform updater never fetches anything Octant has not verified.** It is
  handed the verified bytes through a loopback server Octant runs for the length
  of the install, rather than being pointed at the public feed. Pointing it at
  the public feed would have it fetch and download before our gates had run —
  the exact ordering this design exists to prevent — and handing it a remote URL
  we had checked would leave a second fetch that could return different bytes.
  It also means the artifact's host is contacted once, by us.
- **Two rings, one key, and the ring inside the signature.** Releases are
  published to `stable` (a tagged release) and `preview` (a scheduled build of
  `main`), each its own feed at `<base>/<ring>/<platform>-<arch>.json`. The ring
  a build belongs to is read from its own version — a preview carries a
  `-preview.…` prerelease tag — rather than stored beside it, because two
  declarations of one fact can disagree and the one that would be wrong here
  decides which feed an app reads. The person may follow either ring; the
  version ordering makes both directions safe on its own, since a prerelease
  sorts below the release it leads to and no ring may offer a version that is
  not strictly newer. The ring is one of the signed fields and is checked
  against the ring the app asked for. Without that check a preview feed
  document is a valid stable one, and whoever could write to the stable feed's
  location could put unreviewed `main` in front of every stable user without
  forging anything. One key signs both rings, so this check — not the
  signature — is what actually separates the streams.
- **The path is part of what a check discloses, and is written down as such.**
  Addressing a feed by ring keeps it a static file a CDN can cache and a
  self-hoster can mirror by copying a directory, at the cost of telling the
  feed host which ring a person follows. That is disclosed alongside the
  version, platform, and architecture rather than treated as incidental
  because it sits in a path rather than a parameter.
- **Where the feed and the artifact live is configuration; what they must prove
  is not.** The feed endpoint defaults to the published one and is overridable,
  so the maintainer can move it and a self-hosting person or team can point at
  their own; an override that is not HTTPS is refused rather than silently
  replaced by the default, because updating from a place you did not choose is
  worse than not updating. The artifact's location is likewise a free choice —
  beside the feed, or in a release on another host — and is settled per release
  rather than compiled in. That freedom exists precisely because nothing trusts
  a host: the signature and the hash decide, so moving either endpoint changes
  who serves bytes and nothing about the bar they clear.
- **The person chooses when an update applies.** Octant downloads nothing until
  asked unless automatic checking is on, and even then it never replaces a
  running app on its own. An update is staged and applied on a relaunch the
  person initiates.
- **An update never interrupts work in flight.** Live agent work is work the
  person has not seen the end of, and replacing the binary under it loses that;
  a thread waiting on an approval counts too, because restarting throws the
  unanswered question away. Readiness is read from the same host activity the
  quit guard already trusts to decide whether stopping would interrupt
  something — a second notion of "busy" would disagree with the first exactly
  when it mattered. It is a policy, not a race: install is refused and says what
  it is waiting for, and the person waits or checkpoints. This is the same rule
  0020 already applies to restoring — work in flight is finished or written down
  before it is disturbed, never dropped.
- **An update check sends the minimum a check requires, and nothing rides
  along.** It is a plain HTTPS GET carrying three parameters: the running
  version, the platform, and the architecture. Those are what select a release,
  and the version comparison still happens on the device, so a service that
  ignores them behaves identically. Nothing else is sent — no account, no
  install identifier, no Project or thread, no configuration, no counter, and no
  cookie — and the user agent names the app without a version so it cannot
  reconstruct one. What a server can work out is therefore: someone at an IP
  address runs Octant, which version, and roughly how often it is open. That is
  more than an IP alone and is written down as such rather than described as
  anonymous. Nothing is added later: this path is not a telemetry channel, and a
  request for one is a new decision, not an extension of this one.
- **Automatic checking is switchable off, and off means off.** The setting
  suppresses the periodic check entirely rather than checking quietly and
  staying silent about the answer, and the host starts with checking off until
  it is told what the person chose — a host that defaulted to on would check
  once per launch before it learned otherwise. Checks are daily, which is often
  enough to hear about a release and infrequent enough to say little about when
  the app is used. What the check transmits is documented in the user guide in
  plain language, next to the switch.

## Consequences

- Releases now require credentials the build host must hold: a Developer ID
  Application certificate, an App Store Connect key for notarization, and the
  Ed25519 private key that signs feeds. None of them belong in the repository,
  and a build without them produces an unsigned local artifact that says so
  rather than a release that looks signed.
- The signing key becomes the thing to protect. Its loss is a rotation and a
  re-release; its compromise is code execution on every installed copy, which is
  why the platform's own check is kept as an independent second opinion and why
  no check may be relaxed for convenience.
- The feed is static and cacheable, so it can sit on any static host and behind
  a CDN. There is no server to run and nothing that could accumulate a request
  log richer than an ordinary web server's — which does mean the endpoint's
  operator holds ordinary access logs, and the disclosure says so rather than
  claiming otherwise.
- Hosting artifacts away from the feed has a privacy consequence, so it is a
  decision to make per release rather than a default: if a release points at
  assets on a code-hosting service, that service sees the IP address of everyone
  who downloads. It is a download rather than a check, and only happens when a
  person asks for one, but it is a second party seeing traffic the feed host
  would otherwise have seen alone.
- Preview builds are notarized like stable ones, so the ring buys no shortcut:
  a nightly costs a full sign-and-notarize cycle. That is why previews are built
  on a schedule and skipped when `main` has not moved, rather than per merge —
  ten merges in a day are one useful preview.
- Publishing runs from CI, so the build host holds the Developer ID, the notary
  credentials, and the feed signing key as secrets. They are scoped to a
  deployment environment rather than the repository, and the stable environment
  requires a human approval before any of them is readable — a tag proposes a
  release and a person approves it. The preview environment does not, which is
  the trade being made: a nightly nobody has to approve, signed by the same key
  that signs stable.
- Users on an unsigned build cannot update to a signed one in place: the
  designated requirement changes, so the first signed release is a download.
  That is a one-time cost of graduating the boundary and is stated in the
  release notes rather than worked around.

## Related

- 0009 Sandbox confinement, approvals, and Plan mode
- 0014 Apple development and validation as an app-managed capability
- 0020 Checkpoints and restore by forking
