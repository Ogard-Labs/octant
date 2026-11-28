/**
 * Server-authoritative export of what one host holds about its owner.
 *
 * One local-owner read composes an existing thread bundle for every thread
 * with Projects, Project memory, Canvases, a non-secret settings summary,
 * usage rows, and retention state. It is not a legal package, and it is not
 * available to a remote or paired device.
 */

import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { CanvasDefinition, CanvasId } from "./canvas";
import { UtcTimestamp } from "./events";
import { HostId } from "./host";
import { OctantMode } from "./modes";
import {
  OrchestrationInstructionsText,
  PersonInstructionsText,
  ProjectInstructionsText,
} from "./octantInstructions";
import { PersonMemoryEntry } from "./personMemory";
import { ProjectId, ProjectMemoryView } from "./projects";
import { ThreadExportBundle } from "./threadExport";
import { ThreadPurgeTombstone, ThreadRetentionWindowEntry } from "./threadRetention";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const HOST_EXPORT_FORMAT = "octant.host-export/1" as const;
export const HostExportFormat = Schema.Literal(HOST_EXPORT_FORMAT);
export type HostExportFormat = typeof HostExportFormat.Type;

/** A streamed page never carries more records than this. */
export const HOST_EXPORT_MAX_PAGE_ITEMS = 64;

export const HostExportHeader = Schema.Struct({
  format: HostExportFormat,
  hostId: HostId,
  generatedAt: UtcTimestamp,
  threadCount: NonNegativeInt,
});
export type HostExportHeader = typeof HostExportHeader.Type;

/**
 * A Project without its binding. Filesystem paths are unrepresentable here.
 */
export const HostExportProject = Schema.Struct({
  projectId: ProjectId,
  name: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  type: Schema.Literals(["chat", "work", "code"]),
  lifecycle: Schema.Literals(["active", "archived"]),
});
export type HostExportProject = typeof HostExportProject.Type;

export const HostExportProjectMemory = ProjectMemoryView;
export type HostExportProjectMemory = typeof HostExportProjectMemory.Type;

/**
 * One Canvas the host holds, including the current definition an artifact
 * bundle would carry. Version history stays in the journal. A Canvas a Chat
 * thread owns outside every Project names no Project here; its owner is the
 * thread in `definition.provenance`. Older cuts always named a Project and
 * still decode.
 */
export const HostExportCanvas = Schema.Struct({
  canvasId: CanvasId,
  projectId: Schema.NullOr(ProjectId),
  mode: OctantMode,
  title: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  updatedAt: UtcTimestamp,
  definition: CanvasDefinition,
});
export type HostExportCanvas = typeof HostExportCanvas.Type;

/**
 * Settings a person can already see, reduced to flags. Paths, credentials,
 * and provider configuration are unrepresentable.
 */
export const HostExportSettingsSummary = Schema.Struct({
  chatEnabled: Schema.Boolean,
  workEnabled: Schema.Boolean,
  themeMode: Schema.Literals(["system", "light", "dark", "unknown"]),
  streamReplies: Schema.optional(Schema.Boolean),
});
export type HostExportSettingsSummary = typeof HostExportSettingsSummary.Type;

/**
 * One usage export row: reference ids, token counts, quality, and the
 * attribution categories. Prompt text and credential material are absent.
 */
export const HostExportUsageRow = Schema.Struct({
  reconciliationId: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  subjectType: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  /** Null for usage whose thread was purged: the row keeps its counts, not its identity. */
  subjectId: Schema.NullOr(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256))),
  providerInstanceId: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  modelId: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  requestShape: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
  quality: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(32)),
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reasoningTokens: Schema.optional(NonNegativeInt),
  cacheReadInputTokens: Schema.optional(NonNegativeInt),
  cacheWriteInputTokens: Schema.optional(NonNegativeInt),
  providerExecutionDurationMs: Schema.optional(NonNegativeInt),
  plannedInputTokens: Schema.optional(NonNegativeInt),
  varianceTokens: Schema.optional(Schema.Int),
  observedAt: UtcTimestamp,
  attributionCategories: Schema.String.check(Schema.isMaxLength(512)),
});
export type HostExportUsageRow = typeof HostExportUsageRow.Type;

export const HostExportOmissionSubject = Schema.Literals([
  "credentials",
  "filesystem-paths",
  "attachment-bytes",
  "raw-provider-payloads",
  "composer-drafts",
  "paired-device-keys",
  "window-capabilities",
  "unrepresentable-record",
]);
export type HostExportOmissionSubject = typeof HostExportOmissionSubject.Type;

export const HostExportOmission = Schema.Struct({
  subject: HostExportOmissionSubject,
  reason: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(400)),
});
export type HostExportOmission = typeof HostExportOmission.Type;

const pageItems = <S extends Schema.Top>(item: S) =>
  Schema.Array(item).check(Schema.isMaxLength(HOST_EXPORT_MAX_PAGE_ITEMS));

/** The instructions the person wrote for Octant, exactly as written. */
export const HostExportInstructions = Schema.Struct({
  yours: PersonInstructionsText,
  /** The orchestration text for coordinator threads. Absent in older cuts. */
  orchestration: Schema.optional(OrchestrationInstructionsText),
});
export type HostExportInstructions = typeof HostExportInstructions.Type;

/**
 * One Project's instructions, exactly as written. A host can hold more
 * Projects than a page carries, so these travel on their own bounded pages
 * rather than inside the one `instructions` page.
 */
export const HostExportProjectInstructions = Schema.Struct({
  projectId: ProjectId,
  instructions: ProjectInstructionsText,
});
export type HostExportProjectInstructions = typeof HostExportProjectInstructions.Type;

export const HostExportPage = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("header"), octant: HostExportHeader }),
  Schema.Struct({
    kind: Schema.Literal("threads"),
    threads: pageItems(ThreadExportBundle),
  }),
  Schema.Struct({
    kind: Schema.Literal("projects"),
    projects: pageItems(HostExportProject),
  }),
  Schema.Struct({
    kind: Schema.Literal("project-memory"),
    projectMemory: pageItems(HostExportProjectMemory),
  }),
  Schema.Struct({
    kind: Schema.Literal("person-memory"),
    entries: pageItems(PersonMemoryEntry),
  }),
  Schema.Struct({
    kind: Schema.Literal("instructions"),
    instructions: HostExportInstructions,
  }),
  Schema.Struct({
    kind: Schema.Literal("project-instructions"),
    projectInstructions: pageItems(HostExportProjectInstructions),
  }),
  Schema.Struct({
    kind: Schema.Literal("canvases"),
    canvases: pageItems(HostExportCanvas),
  }),
  Schema.Struct({
    kind: Schema.Literal("settings"),
    settings: HostExportSettingsSummary,
  }),
  Schema.Struct({
    kind: Schema.Literal("ssh-targets"),
    sshTargets: Schema.Array(Schema.Unknown),
  }),
  Schema.Struct({
    kind: Schema.Literal("usage"),
    usage: pageItems(HostExportUsageRow),
  }),
  Schema.Struct({
    kind: Schema.Literal("retention-windows"),
    windows: pageItems(ThreadRetentionWindowEntry),
  }),
  Schema.Struct({
    kind: Schema.Literal("retention-tombstones"),
    tombstones: pageItems(ThreadPurgeTombstone),
  }),
  Schema.Struct({
    kind: Schema.Literal("omissions"),
    omissions: Schema.Array(HostExportOmission).check(Schema.isMaxLength(16)),
  }),
  Schema.Struct({
    kind: Schema.Literal("complete"),
    threadCount: NonNegativeInt,
  }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: Schema.Literals(["local-owner-only", "unrepresentable"]),
  }),
]);
export type HostExportPage = typeof HostExportPage.Type;

/**
 * The inspectable cut. Pages on the wire assemble into this object; a reader
 * does not have to understand the stream to see what the host held.
 */
export const HostExportBundle = Schema.Struct({
  octant: HostExportHeader,
  threads: Schema.Array(ThreadExportBundle),
  projects: Schema.Array(HostExportProject),
  projectMemory: Schema.Array(HostExportProjectMemory),
  /** The person's memory entries, each with the threads it came from. Absent in older cuts. */
  personMemory: Schema.optional(Schema.Array(PersonMemoryEntry)),
  /** The person's instructions for Octant. Absent in older cuts. */
  instructions: Schema.optional(HostExportInstructions),
  /** Each Project's instructions that are not empty. Absent in older cuts. */
  projectInstructions: Schema.optional(Schema.Array(HostExportProjectInstructions)),
  canvases: Schema.Array(HostExportCanvas),
  settings: HostExportSettingsSummary,
  usage: Schema.Array(HostExportUsageRow),
  retention: Schema.Struct({
    windows: Schema.Array(ThreadRetentionWindowEntry),
    tombstones: Schema.Array(ThreadPurgeTombstone),
  }),
  omissions: Schema.Array(HostExportOmission).check(Schema.isMaxLength(16)),
});
export type HostExportBundle = typeof HostExportBundle.Type;

export const decodeHostExportBundle = Schema.decodeUnknownSync(
  HostExportBundle,
  STRICT_DECODE_OPTIONS,
);
export const decodeHostExportPage = Schema.decodeUnknownSync(HostExportPage, STRICT_DECODE_OPTIONS);
export const decodeHostExportSettingsSummary = Schema.decodeUnknownSync(
  HostExportSettingsSummary,
  STRICT_DECODE_OPTIONS,
);
export const decodeHostExportProject = Schema.decodeUnknownSync(
  HostExportProject,
  STRICT_DECODE_OPTIONS,
);
export const decodeHostExportCanvas = Schema.decodeUnknownSync(
  HostExportCanvas,
  STRICT_DECODE_OPTIONS,
);
export const decodeHostExportUsageRow = Schema.decodeUnknownSync(
  HostExportUsageRow,
  STRICT_DECODE_OPTIONS,
);
