# 0060. In-app changelog rides the update path

**Status:** Proposed

## Context

People need to see what changed when a build lands on their machine. The
roadmap holds an in-app changelog in the later ring until a design exists.
Without one it is too easy to invent a second HTTPS path for "release notes",
which would leak IP traffic under a friendlier name than telemetry, or to bolt
a marketing page onto first run where it does not belong.

0034 already defines the only desktop host-initiated update network: a signed
feed check the person can turn off, minimum disclosure, and no ride-along
payloads. Marketplace fetches are a separate, action-gated path. The changelog
must decide where it lives in the UI, what is bundled versus carried on that
feed, and how it fails when checking is off, before any renderer work starts.

## Decision

- **Primary home is the update UI, not first run.** After a version the person
  chose to install finishes applying on relaunch, the desktop shows what that
  version changed. The same surface may show a short summary when an update is
  offered, before they apply it. First-run setup (0019, 0033) stays profile,
  workspace, providers, and related host questions. It never becomes a release
  blog.
- **Settings keeps an always-available archive.** Settings → General → Updates
  (or the adjacent About strip that already names the running version) links to
  "What's new" for the build on disk. That entry is how someone re-reads notes
  without waiting for another update prompt.
- **Notes for the running build are bundled.** The packaged app ships a local
  changelog document for its own version. Opening What's new for the current
  build never contacts a network. A missing or unreadable local document shows
  an empty state rather than fetching a substitute.
- **Short notes for an offered update travel inside the signed feed.** The feed
  document 0034 already verifies may carry a bounded plain-text summary for the
  offered version. That summary is covered by the same Ed25519 signature as
  version, ring, platform, and artifact hash. It is not a second GET, not a CMS
  URL, and not HTML from an unsigned host. Unverifiable feed notes are refused
  with the rest of a bad feed.
- **No new network path.** Changelog display does not introduce its own HTTPS
  endpoint, beacon, or view counter. When automatic update checking is off and
  the person has not checked by hand, there is no feed traffic and therefore no
  remote summary for an uninstalled build. Bundled notes for the running build
  still work. Turning checking off remains off for notes the same way it is off
  for versions.
- **Remote clients do not own this surface.** Only the desktop updates itself
  (0034). Paired browsers and mobile show host state; they do not fetch release
  notes or pretend to update the Machine.

### Non-goals

- Implementing UI, feed schema fields, or packaging hooks in this change.
- A fetched full changelog, release blog, or marketing site inside the app.
- Push, toast spam, or first-run interruption for release notes.
- Telemetry that someone opened What's new.
- Treating GitHub releases, issue trackers, or the public docs site as the
  in-app source of truth.
- Auto-applying updates because notes exist.

## Consequences

- Feed schema work, when implementation is promoted from later, extends the
  signed document under 0034 rather than adding a notes URL. Packaging must
  embed the local changelog beside the binary the same way other release
  metadata already ships.
- Privacy copy next to Settings → General → Updates stays accurate: checking off
  still means no update-service contact, and What's new for the installed build
  does not create an exception.
- Implementation is blocked until this record is accepted and the later-ring
  parent is promoted. Until then the app has no in-app changelog surface.

## Related

- 0034 Signed, notarized, user-controlled updates
- 0019 User profile and first-run setup
- 0033 First run asks what to call you
- 0058 One desktop app across macOS, Linux, and Windows
