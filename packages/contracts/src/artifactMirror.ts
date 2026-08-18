/**
 * Mirroring artifacts to files.
 *
 * The journal is the record of what an artifact is; a mirrored file is a copy
 * of it, written so other tools can read it. Everything here describes that
 * copy — where it goes, what it looks like, and what happens when someone edits
 * it. Nothing here can change what an artifact is: a file is output, and the
 * one path back in creates a new version rather than overwriting one.
 */

import { Schema } from "effect";
import { CanvasId, CanvasVersionId } from "./canvas";
import { AggregateVersion, UtcTimestamp } from "./events";
import { ProjectId } from "./projects";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

export const MAX_ARTIFACT_MIRROR_OVERRIDES = 64;
export const MAX_ARTIFACT_BUNDLE_BYTES = 4 * 1024 * 1024;

/**
 * A directory a mirror may write, relative to the root it is anchored to.
 *
 * One or more plain segments. No traversal, no leading slash, no backslash, and
 * no `.git`: a mirror that could write there would be rewriting the repository
 * it was asked to sit inside.
 */
export const ArtifactMirrorRelativePath = Schema.String.pipe(
  Schema.maxLength(512),
  Schema.filter(
    (value) =>
      value.length > 0 &&
      value === value.normalize("NFC") &&
      !value.startsWith("/") &&
      !value.endsWith("/") &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      value
        .split("/")
        .every(
          (segment) =>
            segment.length > 0 &&
            segment !== "." &&
            segment !== ".." &&
            segment !== ".git" &&
            !segment.startsWith("-"),
        ),
  ),
);

/** An absolute path the user picked, as the host canonicalized it. */
const CanonicalRoot = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(4_096),
  Schema.filter((value) => value.startsWith("/") && !value.includes("\0")),
);

/**
 * Where an artifact's files go.
 *
 * `internal-only` is the default and writes nothing: an artifact still exists,
 * is still versioned, and is still readable — it simply has no file. The other
 * two name a place, and the host still checks its own authority before writing
 * to either.
 */
export const ArtifactMirrorDestination = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("internal-only") }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("global-folder"),
    canonicalRoot: CanonicalRoot,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("project-repository"),
    /** Where inside the Project's bound repository, e.g. `docs/artifacts`. */
    relativeDirectory: ArtifactMirrorRelativePath,
  }).annotations(strict),
);
export type ArtifactMirrorDestination = typeof ArtifactMirrorDestination.Type;

/** One Project choosing something other than the host-wide default. */
export const ArtifactMirrorOverride = Schema.Struct({
  projectId: ProjectId,
  destination: ArtifactMirrorDestination,
}).annotations(strict);
export type ArtifactMirrorOverride = typeof ArtifactMirrorOverride.Type;

export const ArtifactMirrorSettings = Schema.Struct({
  kind: Schema.Literal("artifact-mirror-settings"),
  /** What every Project does unless it says otherwise. */
  fallback: ArtifactMirrorDestination,
  overrides: Schema.Array(ArtifactMirrorOverride).pipe(
    Schema.filter(
      (overrides) =>
        overrides.length <= MAX_ARTIFACT_MIRROR_OVERRIDES &&
        new Set(overrides.map((override) => String(override.projectId))).size === overrides.length,
    ),
  ),
  /**
   * Whether a repository destination commits what it writes.
   *
   * Off by default, and on it still runs the ordinary approval-gated commit —
   * it changes who starts the commit, never whether one is gated. Nothing is
   * ever pushed automatically, at any setting.
   */
  autoCommit: Schema.Boolean,
  version: AggregateVersion,
  updatedAt: UtcTimestamp,
})
  .annotations(strict)
  .pipe(
    // Committing is meaningless without a repository to commit in, and leaving
    // the flag set while nothing uses it is how it gets forgotten and surprises
    // someone later.
    Schema.filter(
      (settings) =>
        !settings.autoCommit ||
        settings.fallback.kind === "project-repository" ||
        settings.overrides.some((override) => override.destination.kind === "project-repository"),
    ),
  );
export type ArtifactMirrorSettings = typeof ArtifactMirrorSettings.Type;

/** What one materialization did, recorded so a file can be traced to a version. */
export const ArtifactMirrorReceipt = Schema.Struct({
  canvasId: CanvasId,
  versionId: CanvasVersionId,
  projectId: ProjectId,
  destination: ArtifactMirrorDestination,
  /** Paths written, relative to the destination's own root. */
  paths: Schema.Array(ArtifactMirrorRelativePath).pipe(
    Schema.filter((paths) => paths.length <= 8 && new Set(paths).size === paths.length),
  ),
  outcome: Schema.Literal("written", "skipped", "refused", "failed"),
  /** Present on anything but a plain write, in the words the user reads. */
  detail: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512))),
  observedAt: UtcTimestamp,
})
  .annotations(strict)
  .pipe(Schema.filter((receipt) => (receipt.outcome === "written") === receipt.paths.length > 0))
  .pipe(Schema.filter((receipt) => receipt.outcome === "written" || receipt.detail !== undefined));
export type ArtifactMirrorReceipt = typeof ArtifactMirrorReceipt.Type;

/**
 * A file the host found differing from what it last wrote.
 *
 * Reported, never absorbed. The only way it becomes part of the artifact is the
 * user asking for it, which appends a version.
 */
export const ArtifactMirrorDrift = Schema.Struct({
  canvasId: CanvasId,
  /** The version the host last wrote there. */
  mirroredVersionId: CanvasVersionId,
  path: ArtifactMirrorRelativePath,
  observedAt: UtcTimestamp,
}).annotations(strict);
export type ArtifactMirrorDrift = typeof ArtifactMirrorDrift.Type;

export const ArtifactMirrorCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("set-artifact-mirror-fallback"),
    expectedVersion: AggregateVersion,
    destination: ArtifactMirrorDestination,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("set-artifact-mirror-override"),
    expectedVersion: AggregateVersion,
    projectId: ProjectId,
    destination: ArtifactMirrorDestination,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("clear-artifact-mirror-override"),
    expectedVersion: AggregateVersion,
    projectId: ProjectId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("set-artifact-mirror-auto-commit"),
    expectedVersion: AggregateVersion,
    autoCommit: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("reimport-artifact-from-file"),
    canvasId: CanvasId,
    /** The version the caller believes is current, so a stale ask is refused. */
    expectedVersionId: CanvasVersionId,
  }).annotations(strict),
);
export type ArtifactMirrorCommand = typeof ArtifactMirrorCommand.Type;

export const ArtifactMirrorResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("mirror-settings"),
    settings: ArtifactMirrorSettings,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("artifact-reimported"),
    canvasId: CanvasId,
    versionId: CanvasVersionId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("mirror-refused"),
    reason: Schema.Literal(
      "stale-version",
      "destination-unavailable",
      "destination-unauthorized",
      "project-not-bound",
      "file-missing",
      "file-unreadable",
      "file-not-a-bundle",
      "file-unchanged",
    ),
    message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  }).annotations(strict),
);
export type ArtifactMirrorResult = typeof ArtifactMirrorResult.Type;

export const ARTIFACT_MIRROR_AGGREGATE_TYPE = "artifact-mirror";
export const ARTIFACT_MIRROR_EVENT_NAMES = {
  settingChanged: "artifact.mirror-setting-changed@1",
  written: "artifact.mirror-written@1",
  reimported: "artifact.mirror-reimported@1",
} as const;

export const decodeArtifactMirrorSettings = Schema.decodeUnknownSync(ArtifactMirrorSettings);
export const decodeArtifactMirrorCommand = Schema.decodeUnknownSync(ArtifactMirrorCommand);
export const decodeArtifactMirrorResult = Schema.decodeUnknownSync(ArtifactMirrorResult);
export const decodeArtifactMirrorReceipt = Schema.decodeUnknownSync(ArtifactMirrorReceipt);
export const decodeArtifactMirrorDrift = Schema.decodeUnknownSync(ArtifactMirrorDrift);
