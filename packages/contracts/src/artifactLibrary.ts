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
}).annotations(strict);
export type ArtifactLibraryEntry = typeof ArtifactLibraryEntry.Type;

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

export const decodeArtifactLibraryQuery = Schema.decodeUnknownSync(ArtifactLibraryQuery);
export const decodeArtifactLibraryEntry = Schema.decodeUnknownSync(ArtifactLibraryEntry);
export const decodeArtifactLibraryListing = Schema.decodeUnknownSync(ArtifactLibraryListing);
