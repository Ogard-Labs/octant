# 0032. Signed, notarized, user-controlled updates

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
local-first app does that contacts a server the user did not choose, and it
discloses an IP address and, if we are careless, a version and a machine. The
compliance package is a separate piece of work; this record is written so that
package finds nothing to apologise for.

## Decision

- **The boundary graduates for one deliverable, not three.** Developer ID
  signing, notarization, and in-app update ship together or not at all. A
  packaging pipeline that can produce a signed build but no updater is fine —
  that is this deliverable half-built. An updater that runs against unsigned
  builds is not, and the code refuses to be configured that way rather than
  trusting a release process to remember. Intel, Windows and Linux packaging,
  mobile store distribution, and hosted relay stay outside the boundary.
- **Two independent gates stand between a feed and a running binary, and both
  fail closed.** Octant verifies an Ed25519 signature over the feed document
  against a public key compiled into the app, and independently checks that the
  offered version is strictly newer and built for this platform and
  architecture. Only then is the payload handed to the platform updater, which
  verifies the replacement's code signature against the running app's
  designated requirement. Neither gate is permitted to stand in for the other:
  ours proves the release is one we published, the platform's proves the bytes
  on disk are that release.
- **Unverifiable is refused, never downgraded.** A feed that will not parse, is
  signed by a key we do not hold, carries a version that is not strictly newer,
  names another platform, or cannot be reached at all yields no update offer
  and no download. There is no "install anyway", no prompt that lets a person
  wave a bad signature through, and no fallback to an unsigned path. A refusal
  says which gate refused, because a person deciding whether to worry needs to
  know the difference between "the server is down" and "the signature is wrong".
- **The platform updater never sees a URL Octant has not verified.** It is
  handed the verified release through a loopback feed Octant serves for the
  length of the download, rather than being pointed at the public feed. Pointing
  it at the public feed would have it fetch and download before our gate had run
  — the exact ordering this design exists to prevent — and a mirrored URL field
  checked for agreement would be one transcription error away from the same
  hole.
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
  along.** It is a plain HTTPS GET of a static feed. The version comparison
  happens on the device, so the request carries no version, no identifier, no
  Project or thread, no configuration, and no counter — the server learns an IP
  address and that some Octant asked, which is what any network request
  discloses and no more. Nothing else is added to it later: this path is not a
  telemetry channel, and a request for one is a new decision, not an extension
  of this one.
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
  re-release; its compromise is code execution on every installed copy, which
  is the reason the second gate exists and the reason neither gate may be
  relaxed for convenience.
- The feed is static and cacheable, so it can sit on any static host and behind
  a CDN. There is no server to run and nothing that could accumulate a request
  log richer than an ordinary web server's.
- Users on an unsigned build cannot update to a signed one in place: the
  designated requirement changes, so the first signed release is a download.
  That is a one-time cost of graduating the boundary and is stated in the
  release notes rather than worked around.

## Related

- 0009 Sandbox confinement, approvals, and Plan mode
- 0014 Apple development and validation as an app-managed capability
- 0020 Checkpoints and restore by forking
