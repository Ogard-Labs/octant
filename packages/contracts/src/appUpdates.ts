/**
 * The update feed and what Octant does with it.
 *
 * The feed is a document served over HTTPS and signed with a key only the
 * maintainer holds. Octant verifies that signature against a public key
 * compiled into the app before it will look at anything the document says.
 * Trust comes from that signature and never from the host: a feed served from
 * the expected domain over a valid certificate proves only that somebody
 * controls that domain today (see `docs/decisions/0034`).
 *
 * The document names one release and where its bytes are. That location is not
 * assumed to be anywhere in particular — the artifact may sit beside the feed
 * or in a release on another host — because the artifact is verified against
 * the signed hash before it is installed, which is what makes its location a
 * free choice rather than something to trust.
 */

import { Schema } from "effect";
import { UtcTimestamp } from "./events";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * `MAJOR.MINOR.PATCH` with an optional prerelease tag. Deliberately narrower
 * than semver: build metadata and arbitrary tags give two names to one release,
 * and an updater that cannot say which of two versions is newer cannot refuse
 * to go backwards.
 */
export const AppVersion = Schema.String.pipe(
  Schema.pattern(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]{1,64})?$/),
  Schema.maxLength(64),
  Schema.brand("AppVersion"),
);
export type AppVersion = typeof AppVersion.Type;

export const AppUpdatePlatform = Schema.Literal("darwin");
export type AppUpdatePlatform = typeof AppUpdatePlatform.Type;

export const AppUpdateArchitecture = Schema.Literal("arm64");
export type AppUpdateArchitecture = typeof AppUpdateArchitecture.Type;

/**
 * Which stream of releases a build follows.
 *
 * `stable` is what a release tag produces. `preview` is the current state of
 * `main`, built on a schedule, and its versions carry a `-preview.…` tag so
 * they sort below the release they lead to — which is what lets someone on a
 * preview move to stable the day stable catches up, without anything having to
 * special-case the handover.
 */
export const AppReleaseRing = Schema.Literal("stable", "preview");
export type AppReleaseRing = typeof AppReleaseRing.Type;

export const APP_RELEASE_RINGS: ReadonlyArray<AppReleaseRing> = ["stable", "preview"];

/** Narrow an unchecked value to a ring, for the boundaries a schema does not cover. */
export function isAppReleaseRing(value: unknown): value is AppReleaseRing {
  return value === "stable" || value === "preview";
}

/**
 * The prerelease tag that marks a build as belonging to the preview ring.
 *
 * The ring is read from the version rather than compiled in beside it. Two
 * declarations of the same fact can disagree, and the one that would have been
 * wrong here is the one deciding which feed an app reads.
 */
export const PREVIEW_PRERELEASE_TAG = "preview";

/**
 * The release a feed offers.
 *
 * These are exactly the fields that are signed. Anything the app decides from
 * — which version, which platform, which bytes, from where — has to be inside
 * the signature, or the signature is decoration.
 */
export const AppUpdateRelease = Schema.Struct({
  version: AppVersion,
  platform: AppUpdatePlatform,
  arch: AppUpdateArchitecture,
  /**
   * The ring this release was published to.
   *
   * Signed, and checked against the ring the app asked for. Both rings are
   * signed by the same key, so without this a preview feed document is a
   * valid stable one: anyone who could write to the stable feed's location
   * could put a preview build in front of every stable user without forging
   * anything. The ring belongs inside the signature for the same reason the
   * version does.
   */
  ring: AppReleaseRing,
  /**
   * Where the replacement is. Any HTTPS location: the artifact is verified
   * against `sha256` before anything is installed, so whichever host serves it
   * is not being trusted. HTTPS is required as transport hygiene, so what a
   * person is downloading is not readable on the wire.
   */
  url: Schema.String.pipe(
    Schema.maxLength(2048),
    Schema.filter((value) => value.startsWith("https://")),
  ),
  /**
   * Lowercase hex SHA-256 of the artifact. Signed, and checked against the
   * downloaded bytes before the platform updater is told anything — this is
   * what turns a signed notice into a verified artifact, and what stops
   * whoever serves the download from substituting something else.
   */
  sha256: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/)),
  releasedAt: UtcTimestamp,
  notes: Schema.optional(Schema.String.pipe(Schema.maxLength(4096))),
}).annotations(strict);
export type AppUpdateRelease = typeof AppUpdateRelease.Type;

export const AppUpdateFeed = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  release: AppUpdateRelease,
  /** Base64 Ed25519 signature over the canonical encoding of `release`. */
  signature: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9+/]{86}==$/)),
}).annotations(strict);
export type AppUpdateFeed = typeof AppUpdateFeed.Type;

/**
 * Why no update is being offered.
 *
 * A person deciding whether to worry needs the difference between "the server
 * is down" and "the signature is wrong", so the reasons stay distinct instead
 * of collapsing into one failure.
 */
export const AppUpdateRefusal = Schema.Literal(
  "unreachable",
  "malformed",
  "untrusted-signature",
  /**
   * The artifact downloaded, but its bytes did not hash to what the signed
   * release said they would. Distinct from a bad signature: the notice was
   * genuine and the delivery was not, which is a different thing to tell
   * somebody and a different thing to investigate.
   */
  "corrupt-artifact",
  "not-newer",
  "wrong-platform",
  /**
   * The release is genuine, but it was published to a ring this app did not
   * ask for. Distinct from a bad signature: nothing was forged, the feed at
   * that location is simply not the one it claims to be.
   */
  "wrong-ring",
);
export type AppUpdateRefusal = typeof AppUpdateRefusal.Type;

export const AppUpdateStatus = Schema.Literal(
  "idle",
  "checking",
  "up-to-date",
  "available",
  "downloading",
  "ready",
  "refused",
  "failed",
);
export type AppUpdateStatus = typeof AppUpdateStatus.Type;

/**
 * What the update surface shows.
 *
 * `ready` means a verified replacement is staged and waiting for a relaunch the
 * person asks for. Nothing here ever applies itself.
 */
export const AppUpdateState = Schema.Struct({
  status: AppUpdateStatus,
  currentVersion: AppVersion,
  available: Schema.optional(AppUpdateRelease),
  refusal: Schema.optional(AppUpdateRefusal),
  message: Schema.optional(Schema.String.pipe(Schema.maxLength(512))),
  checkedAt: Schema.optional(UtcTimestamp),
  /** Whether Octant may check on its own. Off means it does not check at all. */
  automaticChecks: Schema.Boolean,
  /** The ring this app is following, which decides which feed it reads. */
  ring: AppReleaseRing,
}).annotations(strict);
export type AppUpdateState = typeof AppUpdateState.Type;

/**
 * Everything an update check discloses, in the words the user guide uses.
 *
 * Kept in the contract rather than only in prose so the claim and the code
 * that has to honour it sit together: if the request ever carries more than
 * this, this list is wrong and the test that reads it fails.
 */
export const OCTANT_UPDATE_CHECK_DISCLOSURE = [
  "The Octant version you are running, so the service can say whether anything is newer.",
  "Your platform and processor architecture, so it offers a build that runs on this Mac.",
  "Which release ring you follow, stable or preview, because each ring has its own feed address.",
  "The IP address the request comes from, as any network request discloses.",
  "The time of the request.",
] as const;

/**
 * What a server can work out from those, said plainly.
 *
 * Written down because "we send almost nothing" is easy to say and harder to
 * keep honest. Anyone assessing this deserves the inference, not just the
 * field list.
 */
export const OCTANT_UPDATE_CHECK_INFERENCE = [
  "That someone at that IP address runs Octant, which version, on which ring, and roughly how often it is open.",
  "Nothing that names you: no account, no install identifier, no Project or thread, no usage, and no cookie.",
  "Nothing across endpoints: an update check is the only request this path makes.",
] as const;

export const decodeAppVersion = Schema.decodeUnknownSync(AppVersion);
export const decodeAppReleaseRing = Schema.decodeUnknownSync(AppReleaseRing);
export const decodeAppUpdateFeed = Schema.decodeUnknownSync(AppUpdateFeed);
export const decodeAppUpdateRelease = Schema.decodeUnknownSync(AppUpdateRelease);
export const decodeAppUpdateState = Schema.decodeUnknownSync(AppUpdateState);
