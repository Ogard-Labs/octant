/**
 * The update feed and what Octant does with it.
 *
 * The feed is a static document served over HTTPS and signed with a key only
 * the maintainer holds. Octant verifies that signature against a public key
 * compiled into the app before it will look at anything the document says, so
 * a feed that was tampered with, served from somewhere else, or signed by a
 * key we do not hold is refused rather than read (see `docs/decisions/0032`).
 *
 * The document names one release. Which release is newer is decided on the
 * device, so the request that fetches this carries no version and no
 * identifier — see `OCTANT_UPDATE_CHECK_DISCLOSURE`.
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
   * Where the replacement is. HTTPS only: the payload's own code signature is
   * checked before it is installed, but a plaintext download is a needless
   * disclosure of what the person is running.
   */
  url: Schema.String.pipe(
    Schema.maxLength(2048),
    Schema.filter((value) => value.startsWith("https://")),
  ),
  /** Lowercase hex SHA-256 of the payload, so a truncated download is caught. */
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
  "not-newer",
  "wrong-platform",
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
  "The IP address the request comes from, as any network request discloses.",
  "That an Octant client asked, from a user agent naming the app and no version.",
  "The time of the request.",
] as const;

export const decodeAppVersion = Schema.decodeUnknownSync(AppVersion);
export const decodeAppUpdateFeed = Schema.decodeUnknownSync(AppUpdateFeed);
export const decodeAppUpdateRelease = Schema.decodeUnknownSync(AppUpdateRelease);
export const decodeAppUpdateState = Schema.decodeUnknownSync(AppUpdateState);
