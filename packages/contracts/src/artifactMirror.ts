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
import { NonEmptyTrimmedString, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { CanvasId, CanvasVersionId } from "./canvas";
import { AggregateVersion, UtcTimestamp } from "./events";
import { ProjectId } from "./projects";

export const MAX_ARTIFACT_MIRROR_OVERRIDES = 64;
export const MAX_ARTIFACT_BUNDLE_BYTES = 4 * 1024 * 1024;

/**
 * A directory a mirror may write, relative to the root it is anchored to.
 *
 * One or more plain segments. No traversal, no leading slash, no backslash, and
 * no `.git`: a mirror that could write there would be rewriting the repository
 * it was asked to sit inside.
 */
export const ArtifactMirrorRelativePath = Schema.String.check(
  Schema.isMaxLength(512),
  Schema.makeFilter(
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
const CanonicalRoot = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(4_096),
  Schema.makeFilter((value) => value.startsWith("/") && !value.includes("\0")),
);

/**
 * Where an artifact's files go.
 *
 * `internal-only` is the default and writes nothing: an artifact still exists,
 * is still versioned, and is still readable — it simply has no file. The other
 * two name a place, and the host still checks its own authority before writing
 * to either.
 */
export const ArtifactMirrorDestination = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("internal-only") }),
  Schema.Struct({
    kind: Schema.Literal("global-folder"),
    canonicalRoot: CanonicalRoot,
  }),
  Schema.Struct({
    kind: Schema.Literal("project-repository"),
    /** Where inside the Project's bound repository, e.g. `docs/artifacts`. */
    relativeDirectory: ArtifactMirrorRelativePath,
  }),
]);
export type ArtifactMirrorDestination = typeof ArtifactMirrorDestination.Type;

/** One Project choosing something other than the host-wide default. */
export const ArtifactMirrorOverride = Schema.Struct({
  projectId: ProjectId,
  destination: ArtifactMirrorDestination,
});
export type ArtifactMirrorOverride = typeof ArtifactMirrorOverride.Type;

export const ArtifactMirrorSettings = Schema.Struct({
  kind: Schema.Literal("artifact-mirror-settings"),
  /** What every Project does unless it says otherwise. */
  fallback: ArtifactMirrorDestination,
  overrides: Schema.Array(ArtifactMirrorOverride).check(
    Schema.makeFilter(
      (overrides) =>
        overrides.length <= MAX_ARTIFACT_MIRROR_OVERRIDES &&
        new Set(overrides.map((override) => String(override.projectId))).size === overrides.length,
    ),
  ),
  /**
   * Whether a repository destination commits what it writes.
   *
   * Off by default: a repository destination writes the working tree and stops
   * there, leaving the commit to the person. On, the host commits the artifact
   * files it just wrote and nothing else — anything else already staged refuses
   * the commit instead of being swept into it. Nothing is ever pushed, at any
   * setting; reaching a remote stays an act the user takes themselves.
   */
  autoCommit: Schema.Boolean,
  version: AggregateVersion,
  updatedAt: UtcTimestamp,
}).pipe(
  // Committing is meaningless without a repository to commit in, and leaving
  // the flag set while nothing uses it is how it gets forgotten and surprises
  // someone later.
  Schema.check(
    Schema.makeFilter(
      (settings) =>
        !settings.autoCommit ||
        settings.fallback.kind === "project-repository" ||
        settings.overrides.some((override) => override.destination.kind === "project-repository"),
    ),
  ),
);
export type ArtifactMirrorSettings = typeof ArtifactMirrorSettings.Type;

/**
 * What auto-commit did with the files a materialization just wrote.
 *
 * Writing and committing are separate acts: a repository destination always
 * gets the working-tree write, and this records whether the host went on to
 * commit it. There is no outcome here that reaches a remote, because nothing
 * is ever pushed at any setting.
 */
export const ArtifactMirrorCommitOutcome = Schema.Union([
  Schema.Struct({ status: Schema.Literal("not-requested") }),
  Schema.Struct({ status: Schema.Literal("committed") }),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: Schema.Literals([
      "index-holds-other-work",
      "nothing-to-commit",
      "commit-unavailable",
      "commit-rejected",
    ]),
  }),
]);
export type ArtifactMirrorCommitOutcome = typeof ArtifactMirrorCommitOutcome.Type;

/**
 * Why a materialization wrote nothing although the Project names a destination,
 * as a code a reader can act on rather than words it can only show.
 */
export const ArtifactMirrorRefusal = Schema.Literals([
  "destination-unavailable",
  "destination-unauthorized",
  "project-not-bound",
  "plan-mode-is-read-only",
]);
export type ArtifactMirrorRefusal = typeof ArtifactMirrorRefusal.Type;

/** What one materialization did, recorded so a file can be traced to a version. */
export const ArtifactMirrorReceipt = Schema.Struct({
  canvasId: CanvasId,
  versionId: CanvasVersionId,
  /** The Canvas's Project; null for a Chat Canvas owned by its thread, which is never mirrored. */
  projectId: Schema.NullOr(ProjectId),
  destination: ArtifactMirrorDestination,
  /** Paths written, relative to the destination's own root. */
  paths: Schema.Array(ArtifactMirrorRelativePath).check(
    Schema.makeFilter((paths) => paths.length <= 8 && new Set(paths).size === paths.length),
  ),
  outcome: Schema.Literals(["written", "skipped", "refused", "failed"]),
  /**
   * Why a refused materialization wrote nothing. Receipts journaled before it
   * was recorded carry only `detail`.
   */
  reason: Schema.optional(ArtifactMirrorRefusal),
  /** Whether the files written were also committed, and why not when they were not. */
  commit: ArtifactMirrorCommitOutcome,
  /** Present on anything but a plain write, in the words the user reads. */
  detail: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512))),
  observedAt: UtcTimestamp,
})
  .check(
    Schema.makeFilter((receipt) => (receipt.outcome === "written") === receipt.paths.length > 0),
  )
  .check(
    Schema.makeFilter((receipt) => receipt.reason === undefined || receipt.outcome === "refused"),
  )
  .check(
    Schema.makeFilter((receipt) => receipt.outcome === "written" || receipt.detail !== undefined),
  )
  // Nothing was written, so there was nothing to commit: a receipt claiming
  // otherwise would be describing a commit of files that do not exist.
  .check(
    Schema.makeFilter(
      (receipt) => receipt.commit.status === "not-requested" || receipt.outcome === "written",
    ),
  );
export type ArtifactMirrorReceipt = typeof ArtifactMirrorReceipt.Type;

/**
 * What the newest materialization in one Project did, for the destination the
 * Project uses now.
 *
 * The host derives it from the journaled receipts so a mirror that stopped
 * writing is visible where the destination is chosen, not only in the
 * journal. A receipt for a destination the Project no longer uses is not one,
 * and neither is a Plan-mode refusal, which says nothing about the destination.
 */
export const ArtifactMirrorProjectStatus = Schema.Struct({
  projectId: ProjectId,
  projectName: NonEmptyTrimmedString,
  /** Whether the destination is the Project's own choice or the host-wide one. */
  source: Schema.Literals(["project", "host"]),
  destination: ArtifactMirrorDestination,
  outcome: Schema.Literals(["written", "skipped", "refused", "failed"]),
  reason: Schema.optional(ArtifactMirrorRefusal),
  detail: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512))),
  observedAt: UtcTimestamp,
});
export type ArtifactMirrorProjectStatus = typeof ArtifactMirrorProjectStatus.Type;

/** The mirror settings read: the settings in effect and how each Project's mirror last went. */
export const ArtifactMirrorView = Schema.Struct({
  settings: ArtifactMirrorSettings,
  projects: Schema.Array(ArtifactMirrorProjectStatus),
});
export type ArtifactMirrorView = typeof ArtifactMirrorView.Type;

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
});
export type ArtifactMirrorDrift = typeof ArtifactMirrorDrift.Type;

export const ArtifactMirrorCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("set-artifact-mirror-fallback"),
    expectedVersion: AggregateVersion,
    destination: ArtifactMirrorDestination,
  }),
  Schema.Struct({
    kind: Schema.Literal("set-artifact-mirror-override"),
    expectedVersion: AggregateVersion,
    projectId: ProjectId,
    destination: ArtifactMirrorDestination,
  }),
  Schema.Struct({
    kind: Schema.Literal("clear-artifact-mirror-override"),
    expectedVersion: AggregateVersion,
    projectId: ProjectId,
  }),
  Schema.Struct({
    kind: Schema.Literal("set-artifact-mirror-auto-commit"),
    expectedVersion: AggregateVersion,
    autoCommit: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("reimport-artifact-from-file"),
    canvasId: CanvasId,
    /** The version the caller believes is current, so a stale ask is refused. */
    expectedVersionId: CanvasVersionId,
  }),
]);
export type ArtifactMirrorCommand = typeof ArtifactMirrorCommand.Type;

export const ArtifactMirrorResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("mirror-settings"),
    settings: ArtifactMirrorSettings,
  }),
  Schema.Struct({
    kind: Schema.Literal("artifact-reimported"),
    canvasId: CanvasId,
    versionId: CanvasVersionId,
  }),
  Schema.Struct({
    kind: Schema.Literal("mirror-refused"),
    reason: Schema.Literals([
      "stale-version",
      "destination-unavailable",
      "destination-unauthorized",
      "project-not-bound",
      "file-missing",
      "file-unreadable",
      "file-not-a-bundle",
      "file-unchanged",
      "commit-needs-repository",
    ]),
    message: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  }),
]);
export type ArtifactMirrorResult = typeof ArtifactMirrorResult.Type;

export const ARTIFACT_MIRROR_AGGREGATE_TYPE = "artifact-mirror";
export const ARTIFACT_MIRROR_EVENT_NAMES = {
  settingChanged: "artifact.mirror-setting-changed@1",
  written: "artifact.mirror-written@1",
  reimported: "artifact.mirror-reimported@1",
} as const;

export const decodeArtifactMirrorSettings = Schema.decodeUnknownSync(
  ArtifactMirrorSettings,
  STRICT_DECODE_OPTIONS,
);
export const decodeArtifactMirrorCommand = Schema.decodeUnknownSync(
  ArtifactMirrorCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeArtifactMirrorResult = Schema.decodeUnknownSync(
  ArtifactMirrorResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeArtifactMirrorView = Schema.decodeUnknownSync(
  ArtifactMirrorView,
  STRICT_DECODE_OPTIONS,
);
export const decodeArtifactMirrorReceipt = Schema.decodeUnknownSync(
  ArtifactMirrorReceipt,
  STRICT_DECODE_OPTIONS,
);
export const decodeArtifactMirrorDrift = Schema.decodeUnknownSync(
  ArtifactMirrorDrift,
  STRICT_DECODE_OPTIONS,
);
export const decodeArtifactMirrorCommitOutcome = Schema.decodeUnknownSync(
  ArtifactMirrorCommitOutcome,
  STRICT_DECODE_OPTIONS,
);
