/**
 * The host-wide artifact library.
 *
 * The per-Project canvas inventory answers "what did this Project make". The
 * library answers "what have I made", across every Project and mode on this
 * host. It is a read of the same journal-derived projection the inventory reads
 * — nothing here is a second source of truth, and nothing here depends on
 * whether an artifact was ever mirrored to a file.
 */

import { Schema } from "effect";
import { CanvasId, CanvasVersionId } from "./canvas";
import { UtcTimestamp } from "./events";
import { OctantMode } from "./modes";
import { ProjectId } from "./projects";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

export const MAX_ARTIFACT_LIBRARY_ENTRIES = 120;
export const MAX_ARTIFACT_PREVIEW_CHARACTERS = 4_096;

/**
 * What an artifact mostly is, derived from the blocks it carries.
 *
 * A Canvas has no declared type — it is a document of blocks — so this is a
 * reading of its content rather than a field someone set. It exists to make the
 * gallery filterable; nothing decides authority by it.
 */
export const ArtifactKind = Schema.Literal(
  "document",
  "diagram",
  "chart",
  "table",
  "code",
  "mixed",
);
export type ArtifactKind = typeof ArtifactKind.Type;

/**
 * A drawn preview of an artifact, rendered by the host.
 *
 * The markup is a self-contained SVG fragment with no external references, so a
 * card can draw it without fetching anything and without running script.
 */
export const ArtifactPreview = Schema.Struct({
  format: Schema.Literal("svg"),
  markup: Schema.String.pipe(
    Schema.maxLength(MAX_ARTIFACT_PREVIEW_CHARACTERS),
    Schema.filter((value) => value.startsWith("<svg") && !/<\s*script/i.test(value)),
  ),
}).annotations(strict);
export type ArtifactPreview = typeof ArtifactPreview.Type;

/** A computer's name, as it names itself in this person's replica. */
const ComputerName = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128));

/**
 * Where an artifact stands across this person's computers.
 *
 * `two-versions`: two computers revised the same version, or this computer's
 * version and another's both stand; neither wins until the person keeps one
 * or merges them. `deleted`: a deletion on another computer is all that is
 * left of it, and it can be restored.
 */
export const ArtifactSyncStatus = Schema.Literal("current", "two-versions", "deleted");
export type ArtifactSyncStatus = typeof ArtifactSyncStatus.Type;

export const ArtifactLibraryEntry = Schema.Struct({
  canvasId: CanvasId,
  projectId: ProjectId,
  /** The Project's own name, so a card names a Project rather than an id. */
  projectName: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
  mode: OctantMode,
  kind: ArtifactKind,
  title: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
  versionCount: Schema.Int.pipe(Schema.positive()),
  currentVersionId: CanvasVersionId,
  currentSequence: Schema.Int.pipe(Schema.positive()),
  updatedAt: UtcTimestamp,
  /** Whether a share of this artifact is live right now. */
  shared: Schema.Boolean,
  preview: Schema.optional(ArtifactPreview),
  /**
   * The computer that wrote the version shown. Present once this computer
   * belongs to a replica, or when the version came from another computer.
   */
  writtenOn: Schema.optional(ComputerName),
  /** Present only when sync has something to resolve; absent means current. */
  syncStatus: Schema.optional(ArtifactSyncStatus),
  /** The computer whose deletion is all that is left, when `syncStatus` is `deleted`. */
  deletedOn: Schema.optional(ComputerName),
}).annotations(strict);
export type ArtifactLibraryEntry = typeof ArtifactLibraryEntry.Type;

/**
 * An artifact another of this person's computers made, read from the replica
 * store and not bound to a thread here yet. It names the Project it was
 * filed under there and the computer that wrote its latest version, because
 * neither is a Project or a computer this host can open.
 */
export const ArtifactLibrarySyncedEntry = Schema.Struct({
  canvasId: CanvasId,
  /** The Project name on the computer that filed it. */
  projectName: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
  /** The computer that wrote the head shown, as that computer names itself. */
  computerName: ComputerName,
  mode: OctantMode,
  kind: ArtifactKind,
  title: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
  versionCount: Schema.Int.pipe(Schema.positive()),
  /**
   * How many heads its history has. Two computers that revised the same
   * version leave two; the person picks one or merges them.
   */
  headCount: Schema.Int.pipe(Schema.positive()),
  status: ArtifactSyncStatus,
  /** The computer whose deletion is all that is left, when `status` is `deleted`. */
  deletedOn: Schema.optional(ComputerName),
  updatedAt: UtcTimestamp,
  preview: Schema.optional(ArtifactPreview),
}).annotations(strict);
export type ArtifactLibrarySyncedEntry = typeof ArtifactLibrarySyncedEntry.Type;

/** One Project, as the library's filter offers it. */
export const ArtifactLibraryProject = Schema.Struct({
  projectId: ProjectId,
  name: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
  mode: OctantMode,
  artifactCount: Schema.Int.pipe(Schema.nonNegative()),
}).annotations(strict);
export type ArtifactLibraryProject = typeof ArtifactLibraryProject.Type;

export const ArtifactLibraryTab = Schema.Literal("all", "by-project", "shared");
export type ArtifactLibraryTab = typeof ArtifactLibraryTab.Type;

/**
 * What the caller asked the library for.
 *
 * The host applies every field itself. A renderer that filtered locally would
 * be filtering a list the host had already decided it may see, which is a
 * different and weaker thing.
 */
export const ArtifactLibraryQuery = Schema.Struct({
  tab: ArtifactLibraryTab,
  query: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256))),
  projectId: Schema.optional(ProjectId),
  mode: Schema.optional(OctantMode),
  kind: Schema.optional(ArtifactKind),
}).annotations(strict);
export type ArtifactLibraryQuery = typeof ArtifactLibraryQuery.Type;

export const ArtifactLibraryListing = Schema.Struct({
  kind: Schema.Literal("artifact-library-listing"),
  entries: Schema.Array(ArtifactLibraryEntry).pipe(
    Schema.filter(
      (entries) =>
        entries.length <= MAX_ARTIFACT_LIBRARY_ENTRIES &&
        new Set(entries.map((entry) => String(entry.canvasId))).size === entries.length,
    ),
  ),
  /** Every Project the caller may see artifacts from, whether or not filtered. */
  projects: Schema.Array(ArtifactLibraryProject).pipe(
    Schema.filter(
      (projects) =>
        new Set(projects.map((project) => String(project.projectId))).size === projects.length,
    ),
  ),
  /**
   * Artifacts synced from this person's other computers and not bound here.
   * Only a window on this host sees them; a paired device does not.
   */
  synced: Schema.optional(
    Schema.Array(ArtifactLibrarySyncedEntry).pipe(Schema.maxItems(MAX_ARTIFACT_LIBRARY_ENTRIES)),
  ),
  /** How many artifacts matched before the page ceiling, so a cut list says so. */
  matchCount: Schema.Int.pipe(Schema.nonNegative()),
  truncated: Schema.Boolean,
  generatedAt: UtcTimestamp,
})
  .annotations(strict)
  .pipe(
    Schema.filter((listing) => listing.truncated === listing.entries.length < listing.matchCount),
  )
  .pipe(Schema.filter((listing) => listing.entries.length <= listing.matchCount));
export type ArtifactLibraryListing = typeof ArtifactLibraryListing.Type;

// ── Synced artifacts: provenance, two versions, and deletions ──────────────

/** One version in an artifact's synced history, with the computer that wrote it. */
export const ArtifactSyncedVersion = Schema.Struct({
  versionId: CanvasVersionId,
  title: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
  computerName: ComputerName,
  /** Written on this computer rather than read in from another one. */
  thisComputer: Schema.Boolean,
  createdAt: UtcTimestamp,
  /** One of the versions the person chooses between, or the one standing. */
  candidate: Schema.Boolean,
  /** Drawn only for a candidate, so two can be compared side by side. */
  preview: Schema.optional(ArtifactPreview),
}).annotations(strict);
export type ArtifactSyncedVersion = typeof ArtifactSyncedVersion.Type;

/** A thread here that an artifact can be opened in without widening anything. */
export const ArtifactSyncedThread = Schema.Struct({
  threadId: Schema.UUID,
  mode: OctantMode,
  projectId: ProjectId,
  projectName: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
  title: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
}).annotations(strict);
export type ArtifactSyncedThread = typeof ArtifactSyncedThread.Type;

export const MAX_ARTIFACT_SYNCED_VERSIONS = 200;
export const MAX_ARTIFACT_SYNCED_THREADS = 50;

/** Everything the library's sync view shows for one artifact. */
export const ArtifactSyncedDetail = Schema.Struct({
  kind: Schema.Literal("artifact-synced-detail"),
  canvasId: CanvasId,
  title: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
  /** The Project it is filed under: here when it is open here, else where it came from. */
  projectName: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
  mode: OctantMode,
  status: ArtifactSyncStatus,
  deletedOn: Schema.optional(ComputerName),
  /** Whether it is open in a thread on this computer. */
  openHere: Schema.Boolean,
  /** Newest first. */
  versions: Schema.Array(ArtifactSyncedVersion).pipe(Schema.maxItems(MAX_ARTIFACT_SYNCED_VERSIONS)),
  /**
   * Threads it may be opened in here. Empty when it is already open here or
   * when no thread on this computer is compatible.
   */
  threads: Schema.Array(ArtifactSyncedThread).pipe(Schema.maxItems(MAX_ARTIFACT_SYNCED_THREADS)),
}).annotations(strict);
export type ArtifactSyncedDetail = typeof ArtifactSyncedDetail.Type;

/**
 * What a person can do with a synced artifact. Open binds it to a thread
 * here. Keep publishes a version that resolves two into the one chosen.
 * Merge opens a new version made from both through the revise path, so it
 * needs a thread when the artifact is not open here yet. Restore publishes a
 * version that supersedes a deletion.
 */
export const ArtifactSyncedCommand = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("detail"), canvasId: CanvasId }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("open"),
    canvasId: CanvasId,
    threadId: Schema.UUID,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("keep"),
    canvasId: CanvasId,
    versionId: CanvasVersionId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("merge"),
    canvasId: CanvasId,
    threadId: Schema.optional(Schema.UUID),
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("restore"), canvasId: CanvasId }).annotations(strict),
);
export type ArtifactSyncedCommand = typeof ArtifactSyncedCommand.Type;

export const ArtifactSyncedRefusalReason = Schema.Literal(
  /** Nothing synced is known for this artifact here. */
  "not-found",
  /** No thread on this computer can take it without widening its authority. */
  "no-compatible-thread",
  /** The thread named cannot take it: wrong mode, read-only, or not active. */
  "incompatible-thread",
  /** It is already open in a thread here; open it from there. */
  "already-open-here",
  /** Merge needs a thread to open the merged version in. */
  "thread-required",
  "not-two-versions",
  "unknown-version",
  "not-deleted",
  /** Publishing needs sync on and this computer in a replica. */
  "sync-off",
  /** The host refused the version itself; the message says why. */
  "refused",
);
export type ArtifactSyncedRefusalReason = typeof ArtifactSyncedRefusalReason.Type;

export const ArtifactSyncedResult = Schema.Union(
  ArtifactSyncedDetail,
  Schema.Struct({
    kind: Schema.Literal("artifact-synced-opened"),
    /** The artifact as the library now lists it, open in the chosen thread. */
    entry: ArtifactLibraryEntry,
    /**
     * Blocks a merge left out: one that names a source the version it was
     * merged into does not list, or one past the block ceiling.
     */
    omittedBlocks: Schema.optional(Schema.Int.pipe(Schema.positive())),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("artifact-synced-published"),
    canvasId: CanvasId,
    versionId: CanvasVersionId,
    /** False while the store cannot be reached: the version waits here and goes out later. */
    published: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("artifact-synced-refused"),
    reason: ArtifactSyncedRefusalReason,
    message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  }).annotations(strict),
);
export type ArtifactSyncedResult = typeof ArtifactSyncedResult.Type;

export const decodeArtifactSyncedCommand = Schema.decodeUnknownSync(ArtifactSyncedCommand);
export const decodeArtifactSyncedResult = Schema.decodeUnknownSync(ArtifactSyncedResult);
export const decodeArtifactLibraryQuery = Schema.decodeUnknownSync(ArtifactLibraryQuery);
export const decodeArtifactLibraryEntry = Schema.decodeUnknownSync(ArtifactLibraryEntry);
export const decodeArtifactLibraryListing = Schema.decodeUnknownSync(ArtifactLibraryListing);
