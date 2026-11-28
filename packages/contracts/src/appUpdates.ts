/**
 * The update feed and what Octant does with it.
 *
 * The feed is a document served over HTTPS and signed with a key only the
 * maintainer holds. Octant verifies that signature against a public key
 * compiled into the app before it will look at anything the document says.
 * Trust comes from that signature and never from the host: a feed served from
 * the expected domain over a valid certificate proves only that somebody
 * controls that domain today (see docs/architecture.md, "Current Release Boundary").
 *
 * The document names one release and where its bytes are. That location is not
 * assumed to be anywhere in particular — the artifact may sit beside the feed
 * or in a release on another host — because the artifact is verified against
 * the signed hash before it is installed, which is what makes its location a
 * free choice rather than something to trust.
 */

import { Schema } from "effect";
import { NonNegativeInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { UtcTimestamp } from "./events";

/**
 * `MAJOR.MINOR.PATCH` with an optional prerelease tag. Deliberately narrower
 * than semver: build metadata and arbitrary tags give two names to one release,
 * and an updater that cannot say which of two versions is newer cannot refuse
 * to go backwards.
 */
export const AppVersion = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]{1,64})?$/),
    Schema.isMaxLength(64),
  ),
  Schema.brand("AppVersion"),
);
export type AppVersion = typeof AppVersion.Type;

/**
 * Platforms that may appear in a signed update feed.
 *
 * `darwin` is the Apple Silicon technical preview. `linux` is the x64
 * portable-image feed, the same document shape as `<ring>/linux-x64.json`.
 * `win32` is the x64 per-user installer, signed with Authenticode; a Windows
 * app reads its feed only once its installer hand-off is wired in.
 */
export const AppUpdatePlatform = Schema.Literals(["darwin", "linux", "win32"]);
export type AppUpdatePlatform = typeof AppUpdatePlatform.Type;

export const AppUpdateArchitecture = Schema.Literals(["arm64", "x64"]);
export type AppUpdateArchitecture = typeof AppUpdateArchitecture.Type;

/**
 * Which stream of releases a build follows.
 *
 * `stable` is what a release tag produces. `preview` is the current state of
 * `main`, built on a schedule, and its versions carry a `-preview.…` tag so
 * they sort below the release they lead to — which is what lets someone on a
 * preview move to stable the day stable catches up, without anything having to
 * special-case the handover. `candidate` is a build produced on demand from a
 * chosen ref, published to its own feed so a test install can follow it and
 * exercise the real update path; its versions carry a `-candidate.…` tag.
 */
export const AppReleaseRing = Schema.Literals(["stable", "preview", "candidate"]);
export type AppReleaseRing = typeof AppReleaseRing.Type;

export const APP_RELEASE_RINGS: ReadonlyArray<AppReleaseRing> = ["stable", "preview", "candidate"];

/** Narrow an unchecked value to a ring, for the boundaries a schema does not cover. */
export function isAppReleaseRing(value: unknown): value is AppReleaseRing {
  return value === "stable" || value === "preview" || value === "candidate";
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
 * The prerelease tag that marks a build as belonging to the candidate ring,
 * derived the same way the preview tag is.
 */
export const CANDIDATE_PRERELEASE_TAG = "candidate";

/**
 * Which app a release is for.
 *
 * Octant and Octant Nightly are two apps, and each updater installs only its
 * own. The ring already separates them (Octant follows `stable` and
 * `candidate`, Nightly only `preview`), but Octant builds were once published
 * on `preview`, and on Linux nothing below the feed checks which app a
 * portable image is. Naming the app inside the signature makes the refusal
 * the feed's own, on every platform.
 */
export const AppUpdateProduct = Schema.Literals(["octant", "octant-nightly"]);
export type AppUpdateProduct = typeof AppUpdateProduct.Type;

/**
 * The release a feed offers.
 *
 * These are exactly the fields that are signed. Anything the app decides from
 * — which version, which platform, which bytes, from where — has to be inside
 * the signature, or the signature is decoration.
 */
export const AppUpdateRelease = Schema.Struct({
  /**
   * The app this release is. Signed, and required: a feed without it is
   * malformed, because every signer has emitted it since the field was added
   * and nothing published before then is read at a name that carries it.
   */
  product: AppUpdateProduct,
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
  url: Schema.String.check(
    Schema.isMaxLength(2048),
    Schema.makeFilter((value) => value.startsWith("https://")),
  ),
  /**
   * Lowercase hex SHA-256 of the artifact. Signed, and checked against the
   * downloaded bytes before the platform updater is told anything — this is
   * what turns a signed notice into a verified artifact, and what stops
   * whoever serves the download from substituting something else.
   */
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  releasedAt: UtcTimestamp,
  notes: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
});
export type AppUpdateRelease = typeof AppUpdateRelease.Type;

export const AppUpdateFeed = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  release: AppUpdateRelease,
  /** Base64 Ed25519 signature over the canonical encoding of `release`. */
  signature: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9+/]{86}==$/)),
});
export type AppUpdateFeed = typeof AppUpdateFeed.Type;

/** The systems a headless build is published for, as `octant-<version>-<target>.tar.gz` names them. */
export const HeadlessBuildTarget = Schema.Literals(["darwin-arm64", "linux-x64", "linux-arm64"]);
export type HeadlessBuildTarget = typeof HeadlessBuildTarget.Type;

/**
 * One headless build a ring publishes, as its signed feed document lists it,
 * so a host can download the build for a server it installs over SSH with the
 * feed signature as the trust root (docs/design/hub-and-spokes.md, "Adding a
 * computer over SSH").
 *
 * Every field is signed, for the reasons the desktop release's are. It names
 * a `target` where a desktop release names `platform` and `arch`, so the
 * canonical bytes of the two never coincide and neither document's signature
 * verifies as the other.
 */
export const HeadlessBuildRelease = Schema.Struct({
  product: Schema.Literal("octant"),
  version: AppVersion,
  target: HeadlessBuildTarget,
  ring: AppReleaseRing,
  /** The build on the release, `octant-<version>-<target>.tar.gz`; any HTTPS location. */
  url: Schema.String.check(
    Schema.isMaxLength(2048),
    Schema.makeFilter((value) => value.startsWith("https://")),
  ),
  /** Lowercase hex SHA-256 of the tarball, checked before anything else reads it. */
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  releasedAt: UtcTimestamp,
});
export type HeadlessBuildRelease = typeof HeadlessBuildRelease.Type;

export const HeadlessBuildFeed = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  release: HeadlessBuildRelease,
  /** Base64 Ed25519 signature over the canonical encoding of `release`. */
  signature: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9+/]{86}==$/)),
});
export type HeadlessBuildFeed = typeof HeadlessBuildFeed.Type;

/**
 * Why no update is being offered.
 *
 * A person deciding whether to worry needs the difference between "the server
 * is down" and "the signature is wrong", so the reasons stay distinct instead
 * of collapsing into one failure.
 */
export const AppUpdateRefusal = Schema.Literals([
  "unreachable",
  "malformed",
  "untrusted-signature",
  "corrupt-artifact",
  "not-newer",
  "wrong-platform",
  "wrong-ring",
  "wrong-app",
  "unsupported-install",
  "not-writable",
]);
export type AppUpdateRefusal = typeof AppUpdateRefusal.Type;

export const AppUpdateStatus = Schema.Literals([
  "idle",
  "checking",
  "up-to-date",
  "available",
  "downloading",
  "ready",
  "refused",
  "failed",
]);
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
  message: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
  checkedAt: Schema.optional(UtcTimestamp),
  /** Whether Octant may check on its own. Off means it does not check at all. */
  automaticChecks: Schema.Boolean,
  /** The ring this app is following, which decides which feed it reads. */
  ring: AppReleaseRing,
  /** Choices belonging to this running application, not another installed app. */
  allowedRings: Schema.optional(Schema.Array(AppReleaseRing).check(Schema.isMaxLength(3))),
});
export type AppUpdateState = typeof AppUpdateState.Type;

/**
 * Why the Octant Nightly row did not install, open or remove Nightly.
 *
 * Each names the check that refused, so the row can say which one it was. The
 * feed and artifact reasons mean what they mean for Octant's own updates.
 */
export const NightlyInstallRefusal = Schema.Literals([
  "unreachable",
  "malformed",
  "untrusted-signature",
  "wrong-platform",
  "wrong-ring",
  "wrong-app",
  "corrupt-artifact",
  "no-release",
  "code-signature",
  "not-newer",
  "installed-version-unreadable",
  "remove-unverified",
  "nightly-running",
  "launch-failed",
  "timed-out",
  "check-unavailable",
  "occupied",
  "not-writable",
  "unsupported-install",
  "unsupported-platform",
  "not-on-preview",
  "not-installed",
]);
export type NightlyInstallRefusal = typeof NightlyInstallRefusal.Type;

/**
 * The Octant Nightly row in Octant's Settings › Updates.
 *
 * `unavailable` hides the row: Nightly itself, a development build, or Octant
 * on Stable with no Nightly installed. `not-installed` offers the install,
 * which only Octant on Preview does; `installed` offers open and remove on
 * either ring.
 */
export const NightlyInstallState = Schema.Struct({
  status: Schema.Literals(["unavailable", "not-installed", "installing", "installed", "removing"]),
  refusal: Schema.optional(NightlyInstallRefusal),
  message: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
});
export type NightlyInstallState = typeof NightlyInstallState.Type;

/**
 * Octant Nightly's Data setting: Octant's data through Octant's host, or a
 * host of its own on separate test data. `running` is the role this launch
 * started with; `chosen` applies on the next launch. `removal` reports the
 * last request to move the test data to the Trash.
 */
export const NightlyDataChoice = Schema.Literals(["octant", "test-data"]);
export type NightlyDataChoice = typeof NightlyDataChoice.Type;
export const NightlyDataState = Schema.Struct({
  running: NightlyDataChoice,
  chosen: NightlyDataChoice,
  testDataPresent: Schema.Boolean,
  removal: Schema.optional(
    Schema.Literals([
      "removed",
      "absent",
      "test-host-running",
      "unsafe-folder",
      "not-nightly",
      "failed",
    ]),
  ),
});
export type NightlyDataState = typeof NightlyDataState.Type;

/**
 * What Nightly's Settings may know before it offers to import Octant's data
 * (docs/design/nightly-app.md#importing-from-octant). The request carries no
 * path: Nightly's main process resolves both fixed folders. `lastImportedAt`
 * is the end of the newest import Nightly finished.
 */
export const NightlyOctantImportPreview = Schema.Struct({
  octantDataPresent: Schema.Boolean,
  /** An ISO 8601 UTC time. */
  lastImportedAt: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
});
export type NightlyOctantImportPreview = typeof NightlyOctantImportPreview.Type;

const ImportCount = NonNegativeInt;

/**
 * Saved keys do not pass through the import: the main process reads each
 * allowlisted item from Octant's Keychain names and writes it under Nightly's,
 * never replacing one Nightly already has. `unavailable` says the keys could
 * not be listed or reached, so nothing was copied.
 */
export const NightlyOctantImportKeys = Schema.Union([
  Schema.Struct({ status: Schema.Literal("not-requested") }),
  Schema.Struct({
    status: Schema.Literal("copied"),
    copied: ImportCount,
    /** Items Nightly already had, left as they were. */
    existing: ImportCount,
    failed: ImportCount,
  }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: Schema.Literals(["cannot-list", "unsupported-platform"]),
  }),
]);
export type NightlyOctantImportKeys = typeof NightlyOctantImportKeys.Type;

/** Window preferences come over from Octant's renderer storage, on a fixed allowlist. */
export const NightlyOctantImportPreferences = Schema.Union([
  Schema.Struct({ status: Schema.Literal("copied"), copied: ImportCount }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: Schema.Literals([
      "origin-differs",
      "octant-storage-missing",
      "relaunch-needed",
      "failed",
    ]),
  }),
]);
export type NightlyOctantImportPreferences = typeof NightlyOctantImportPreferences.Type;

export const NIGHTLY_OCTANT_IMPORT_REFUSALS = [
  "octant-missing",
  "octant-newer",
  "busy",
  "unsafe-folder",
  "unreadable-event",
  "not-test-host",
] as const;

/** The server's import stages, then the desktop's own steps around them. */
export const NIGHTLY_OCTANT_IMPORT_STAGES = [
  "snapshot",
  "migrate-snapshot",
  "settle",
  "open-nightly",
  "backup",
  "merge",
  "rebuild",
  "verify",
  "swap",
  "stop-host",
  "maintenance",
  /** The import finished, but its report could not be read. */
  "report",
  "start-host",
] as const;

export const NightlyOctantImportOutcome = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("imported"),
    counts: Schema.Struct({
      events: ImportCount,
      threads: ImportCount,
      contentRows: ImportCount,
      settled: ImportCount,
    }),
    /** Threads both apps changed since the last import; Nightly's stayed as they were. */
    conflicts: ImportCount,
    /** Settings, Projects and other records both changed; Nightly's value stayed. */
    heldBack: ImportCount,
    keys: NightlyOctantImportKeys,
    preferences: NightlyOctantImportPreferences,
  }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: Schema.Literals(NIGHTLY_OCTANT_IMPORT_REFUSALS),
  }),
  Schema.Struct({
    kind: Schema.Literal("failed"),
    stage: Schema.Literals(NIGHTLY_OCTANT_IMPORT_STAGES),
  }),
]);
export type NightlyOctantImportOutcome = typeof NightlyOctantImportOutcome.Type;

/**
 * Everything an update check discloses, in the words the user guide uses.
 *
 * Kept in the contract rather than only in prose so the claim and the code
 * that has to honour it sit together: if the request ever carries more than
 * this, this list is wrong and the test that reads it fails.
 */
export const OCTANT_UPDATE_CHECK_DISCLOSURE = [
  "The Octant version you are running, so the service can say whether anything is newer.",
  "Your platform and processor architecture, so it offers a build that runs on this machine.",
  "Which release ring you follow — stable, preview, or candidate — because each ring has its own feed address.",
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

export const decodeAppVersion = Schema.decodeUnknownSync(AppVersion, STRICT_DECODE_OPTIONS);
export const decodeAppReleaseRing = Schema.decodeUnknownSync(AppReleaseRing, STRICT_DECODE_OPTIONS);
export const decodeAppUpdateFeed = Schema.decodeUnknownSync(AppUpdateFeed, STRICT_DECODE_OPTIONS);
export const decodeAppUpdateRelease = Schema.decodeUnknownSync(
  AppUpdateRelease,
  STRICT_DECODE_OPTIONS,
);
export const decodeAppUpdateState = Schema.decodeUnknownSync(AppUpdateState, STRICT_DECODE_OPTIONS);
export const decodeNightlyInstallState = Schema.decodeUnknownSync(
  NightlyInstallState,
  STRICT_DECODE_OPTIONS,
);
export const decodeHeadlessBuildFeed = Schema.decodeUnknownSync(
  HeadlessBuildFeed,
  STRICT_DECODE_OPTIONS,
);
export const decodeHeadlessBuildRelease = Schema.decodeUnknownSync(
  HeadlessBuildRelease,
  STRICT_DECODE_OPTIONS,
);
