import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { CanvasId } from "./canvas";
import { AggregateVersion, UtcTimestamp } from "./events";
import { FolderBrowseMode, FolderCandidateId } from "./folderBrowse";
import { HostId } from "./host";
import { ProjectId } from "./projects";

// Where an export lands, and nothing else: the renderer names a folder the host
// already browsed and the host resolves it to a path, so no renderer-supplied
// path is ever stored here. A Project that has chosen for itself wins over the
// host's folder, which is what a thread filed nowhere exports to.

export const CANVAS_EXPORT_FOLDER_SCHEMA_VERSION = 1 as const;
export const CanvasExportFolderSchemaVersion = Schema.Literal(CANVAS_EXPORT_FOLDER_SCHEMA_VERSION);
export type CanvasExportFolderSchemaVersion = typeof CanvasExportFolderSchemaVersion.Type;

/** Per-project choices held at once. Old projects cannot crowd out new ones. */
export const MAX_CANVAS_EXPORT_FOLDER_OVERRIDES = 64;

/**
 * A folder on this machine, as the host canonicalized it.
 *
 * Absolute, bounded, and free of NUL. Whether it sits inside the person's home
 * is decided at the moment of choosing, not encoded here: a folder that was
 * inside home when it was chosen is still the same folder if home changes.
 */
export const CanvasExportFolder = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(4_096),
  Schema.makeFilter((value) => value.startsWith("/") && !value.includes("\0"), {
    message: "An export folder must be an absolute path with no NUL.",
  }),
);
export type CanvasExportFolder = typeof CanvasExportFolder.Type;

/** One Project exporting somewhere other than the host's folder. */
export const CanvasExportFolderOverride = Schema.Struct({
  projectId: ProjectId,
  folder: CanvasExportFolder,
});
export type CanvasExportFolderOverride = typeof CanvasExportFolderOverride.Type;

/**
 * Where exports go.
 *
 * An absent `fallback` is `not-connected`, never a guessed default: a person who
 * has chosen nothing gets the chooser, not a write into a folder Octant picked.
 */
export const CanvasExportFolderSettings = Schema.Struct({
  kind: Schema.Literal("canvas-export-folder-settings"),
  fallback: Schema.optional(CanvasExportFolder),
  overrides: Schema.Array(CanvasExportFolderOverride).check(
    Schema.makeFilter(
      (overrides) =>
        overrides.length <= MAX_CANVAS_EXPORT_FOLDER_OVERRIDES &&
        new Set(overrides.map((override) => String(override.projectId))).size === overrides.length,
      { message: "A Project may hold at most one export folder." },
    ),
  ),
  version: AggregateVersion,
  updatedAt: UtcTimestamp,
});
export type CanvasExportFolderSettings = typeof CanvasExportFolderSettings.Type;

/**
 * Which folder a choice applies to. `project` is the Canvas's own Project;
 * `host` is the folder a thread filed nowhere exports to.
 */
export const CanvasExportFolderScope = Schema.Literals(["project", "host"]);
export type CanvasExportFolderScope = typeof CanvasExportFolderScope.Type;

/**
 * A person chose a folder in the host's folder browser.
 *
 * The folder travels as the browser's opaque candidate id, never as a path: the
 * host resolves the id against the folder it already listed, so a renderer
 * cannot name where a file goes. `expectedVersion` is the version the client
 * read, so two windows cannot quietly overwrite each other's choice.
 */
export const CanvasExportFolderCommand = Schema.Struct({
  schemaVersion: CanvasExportFolderSchemaVersion,
  kind: Schema.Literal("choose-canvas-export-folder"),
  canvasId: CanvasId,
  mode: FolderBrowseMode,
  candidateId: FolderCandidateId,
  scope: CanvasExportFolderScope,
  expectedVersion: AggregateVersion,
});
export type CanvasExportFolderCommand = typeof CanvasExportFolderCommand.Type;

export type CanvasExportFolderRefusalReason =
  | "malformed"
  | "stale-version"
  | "canvas-unavailable"
  | "candidate-unavailable"
  | "outside-home"
  | "folder-unavailable";

export const CanvasExportFolderResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("canvas-export-folder-settings"),
    settings: CanvasExportFolderSettings,
  }),
  Schema.Struct({
    kind: Schema.Literal("canvas-export-folder-refused"),
    reason: Schema.Literals([
      "malformed",
      "stale-version",
      "canvas-unavailable",
      "candidate-unavailable",
      "outside-home",
      "folder-unavailable",
    ]),
    message: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  }),
]);
export type CanvasExportFolderResult = typeof CanvasExportFolderResult.Type;

export const CANVAS_EXPORT_FOLDER_AGGREGATE_TYPE = "canvas-export-folder";
export const CANVAS_EXPORT_FOLDER_CHANGED = "canvas.export-folder-changed@1";

/**
 * What this Canvas exports to right now.
 *
 * The host resolves it, so the renderer never re-derives which Project a Canvas
 * belongs to or which folder wins; it shows what it was told and sends the
 * choice back with the version it read. `hostId` and `mode` travel with it for
 * the same reason: browsing folders is host work on one host, and the renderer
 * echoes an identity it was given rather than inventing one.
 */
export const CanvasExportFolderView = Schema.Struct({
  kind: Schema.Literal("canvas-export-folder-view"),
  settings: CanvasExportFolderSettings,
  /** Absent until a folder is chosen for this Canvas's scope. */
  folder: Schema.optional(CanvasExportFolder),
  scope: CanvasExportFolderScope,
  hostId: HostId,
  mode: FolderBrowseMode,
});
export type CanvasExportFolderView = typeof CanvasExportFolderView.Type;

export const decodeCanvasExportFolderSettings = Schema.decodeUnknownSync(
  CanvasExportFolderSettings,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasExportFolderCommand = Schema.decodeUnknownSync(
  CanvasExportFolderCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasExportFolderResult = Schema.decodeUnknownSync(
  CanvasExportFolderResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasExportFolderView = Schema.decodeUnknownSync(
  CanvasExportFolderView,
  STRICT_DECODE_OPTIONS,
);
