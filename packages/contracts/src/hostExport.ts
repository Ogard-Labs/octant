/**
 * Server-authoritative export of what one host holds about its owner.
 *
 * One local-owner read composes an existing thread bundle for every thread
 * with Projects, Project memory, Canvases, a non-secret settings summary,
 * usage rows, and retention state. It is not a legal package, and it is not
 * available to a remote or paired device.
 */

import { Schema } from "effect";
import { CanvasDefinition, CanvasId } from "./canvas";
import { UtcTimestamp } from "./events";
import { HostId } from "./host";
import { OctantMode } from "./modes";
import { ProjectId, ProjectMemoryView } from "./projects";
import { ThreadExportBundle } from "./threadExport";
import { ThreadPurgeTombstone, ThreadRetentionWindowEntry } from "./threadRetention";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const NonNegativeInt = Schema.Int.pipe(Schema.nonNegative());

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
}).annotations(strict);
export type HostExportHeader = typeof HostExportHeader.Type;

/**
 * A Project without its binding. Filesystem paths are unrepresentable here.
 */
export const HostExportProject = Schema.Struct({
  projectId: ProjectId,
  name: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
  type: Schema.Literal("chat", "work", "code"),
  lifecycle: Schema.Literal("active", "archived"),
}).annotations(strict);
export type HostExportProject = typeof HostExportProject.Type;

export const HostExportProjectMemory = ProjectMemoryView;
export type HostExportProjectMemory = typeof HostExportProjectMemory.Type;

/**
 * One Canvas the host holds, including the current definition an artifact
 * bundle would carry. Version history stays in the journal.
 */
export const HostExportCanvas = Schema.Struct({
  canvasId: CanvasId,
  projectId: ProjectId,
  mode: OctantMode,
  title: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
  updatedAt: UtcTimestamp,
  definition: CanvasDefinition,
}).annotations(strict);
export type HostExportCanvas = typeof HostExportCanvas.Type;

/**
 * Settings a person can already see, reduced to flags. Paths, credentials,
 * and provider configuration are unrepresentable.
 */
export const HostExportSettingsSummary = Schema.Struct({
  chatEnabled: Schema.Boolean,
  workEnabled: Schema.Boolean,
  themeMode: Schema.Literal("system", "light", "dark", "unknown"),
  streamReplies: Schema.optional(Schema.Boolean),
}).annotations(strict);
export type HostExportSettingsSummary = typeof HostExportSettingsSummary.Type;

/**
 * One usage export row: reference ids, token counts, quality, and the
 * attribution categories. Prompt text and credential material are absent.
 */
export const HostExportUsageRow = Schema.Struct({
  reconciliationId: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
  subjectType: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
  subjectId: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
  providerInstanceId: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
  modelId: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
  requestShape: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64)),
  quality: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(32)),
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reasoningTokens: Schema.optional(NonNegativeInt),
  cacheReadInputTokens: Schema.optional(NonNegativeInt),
  cacheWriteInputTokens: Schema.optional(NonNegativeInt),
  providerExecutionDurationMs: Schema.optional(NonNegativeInt),
  plannedInputTokens: Schema.optional(NonNegativeInt),
  varianceTokens: Schema.optional(Schema.Int),
  observedAt: UtcTimestamp,
  attributionCategories: Schema.String.pipe(Schema.maxLength(512)),
}).annotations(strict);
export type HostExportUsageRow = typeof HostExportUsageRow.Type;

export const HostExportOmissionSubject = Schema.Literal(
  "credentials",
  "filesystem-paths",
  "attachment-bytes",
  "raw-provider-payloads",
  "composer-drafts",
  "paired-device-keys",
  "window-capabilities",
  "unrepresentable-record",
);
export type HostExportOmissionSubject = typeof HostExportOmissionSubject.Type;

export const HostExportOmission = Schema.Struct({
  subject: HostExportOmissionSubject,
  reason: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(400)),
}).annotations(strict);
export type HostExportOmission = typeof HostExportOmission.Type;

const pageItems = <A, I, R>(item: Schema.Schema<A, I, R>) =>
  Schema.Array(item).pipe(Schema.maxItems(HOST_EXPORT_MAX_PAGE_ITEMS));

export const HostExportPage = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("header"), octant: HostExportHeader }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("threads"),
    threads: pageItems(ThreadExportBundle),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("projects"),
    projects: pageItems(HostExportProject),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("project-memory"),
    projectMemory: pageItems(HostExportProjectMemory),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("canvases"),
    canvases: pageItems(HostExportCanvas),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("settings"),
    settings: HostExportSettingsSummary,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("usage"),
    usage: pageItems(HostExportUsageRow),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("retention-windows"),
    windows: pageItems(ThreadRetentionWindowEntry),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("retention-tombstones"),
    tombstones: pageItems(ThreadPurgeTombstone),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("omissions"),
    omissions: Schema.Array(HostExportOmission).pipe(Schema.maxItems(16)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("complete"),
    threadCount: NonNegativeInt,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: Schema.Literal("local-owner-only", "unrepresentable"),
  }).annotations(strict),
);
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
  canvases: Schema.Array(HostExportCanvas),
  settings: HostExportSettingsSummary,
  usage: Schema.Array(HostExportUsageRow),
  retention: Schema.Struct({
    windows: Schema.Array(ThreadRetentionWindowEntry),
    tombstones: Schema.Array(ThreadPurgeTombstone),
  }).annotations(strict),
  omissions: Schema.Array(HostExportOmission).pipe(Schema.maxItems(16)),
}).annotations(strict);
export type HostExportBundle = typeof HostExportBundle.Type;

export const decodeHostExportBundle = Schema.decodeUnknownSync(HostExportBundle);
export const decodeHostExportPage = Schema.decodeUnknownSync(HostExportPage);
export const decodeHostExportSettingsSummary = Schema.decodeUnknownSync(HostExportSettingsSummary);
export const decodeHostExportProject = Schema.decodeUnknownSync(HostExportProject);
export const decodeHostExportCanvas = Schema.decodeUnknownSync(HostExportCanvas);
export const decodeHostExportUsageRow = Schema.decodeUnknownSync(HostExportUsageRow);
