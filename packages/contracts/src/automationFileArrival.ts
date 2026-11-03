import { Schema } from "effect";
import { UtcTimestamp } from "./events";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
export const MAX_AUTOMATION_SOURCE_FILES = 256;
export const MAX_AUTOMATION_SOURCE_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_AUTOMATION_SOURCE_SCAN_BYTES = 64 * 1024 * 1024;
export const MAX_AUTOMATION_SOURCE_DIRECTORY_ENTRIES = 4096;
export const DEFAULT_AUTOMATION_FILE_START_LIMIT = 8;
export const MAX_AUTOMATION_FILE_START_LIMIT = 32;
const counter = Schema.Int.pipe(Schema.between(0, Number.MAX_SAFE_INTEGER));
const positiveCounter = Schema.Int.pipe(Schema.between(1, Number.MAX_SAFE_INTEGER));

/** Relative to the captured main Work root; no path is itself a grant. */
export function isAutomationSourceRelativePath(value: string): boolean {
  return (
    value !== "" &&
    value.length <= 1024 &&
    !value.includes("\\") &&
    !value.includes(":") &&
    !Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    !value.startsWith("/") &&
    value
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== ".." && !part.startsWith("."))
  );
}
export const AutomationSourceRelativePath = Schema.String.pipe(
  Schema.filter(isAutomationSourceRelativePath),
);
export const AutomationSourceDirectory = Schema.String.pipe(
  Schema.filter((value) => value === "." || isAutomationSourceRelativePath(value)),
);
export const AutomationSourceDigest = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/));
export const AutomationFileArrivalTrigger = Schema.Struct({
  kind: Schema.Literal("file-arrival"),
  directory: AutomationSourceDirectory,
  includeExtensions: Schema.Array(
    Schema.String.pipe(Schema.pattern(/^[a-z0-9][a-z0-9_-]{0,31}$/)),
  ).pipe(Schema.maxItems(16)),
  excludeDirectories: Schema.Array(AutomationSourceRelativePath).pipe(Schema.maxItems(16)),
  settleSeconds: Schema.Int.pipe(Schema.between(2, 60)),
  automaticStartLimit: Schema.Int.pipe(Schema.between(1, MAX_AUTOMATION_FILE_START_LIMIT)),
}).annotations(strict);
export type AutomationFileArrivalTrigger = typeof AutomationFileArrivalTrigger.Type;

export const AutomationSourceFile = Schema.Struct({
  path: AutomationSourceRelativePath,
  digest: AutomationSourceDigest,
  size: Schema.Int.pipe(Schema.between(0, MAX_AUTOMATION_SOURCE_FILE_BYTES)),
}).annotations(strict);
export type AutomationSourceFile = typeof AutomationSourceFile.Type;
export const AutomationSourceSnapshot = Schema.Array(AutomationSourceFile).pipe(
  Schema.maxItems(MAX_AUTOMATION_SOURCE_FILES),
  Schema.filter(
    (files) =>
      new Set(files.map((file) => file.path)).size === files.length &&
      files.reduce((sum, file) => sum + file.size, 0) <= MAX_AUTOMATION_SOURCE_SCAN_BYTES,
  ),
);
export type AutomationSourceSnapshot = typeof AutomationSourceSnapshot.Type;

export const AutomationFileSourcePhase = Schema.Literal(
  "arming",
  "watching",
  "held",
  "unavailable",
  "needs-rearm",
);
export const AutomationFileSourceReason = Schema.Literal(
  "input-changed-while-running",
  "automatic-start-limit",
  "source-unavailable",
  "source-changed",
  "authority-changed",
  "source-limit",
  "coverage-gap",
  "definition-changed",
  "known-activity",
  "activity-unknown",
  "activity-history-limit",
);
export const AutomationFileHeldBatch = Schema.Struct({
  files: Schema.Array(AutomationSourceRelativePath).pipe(
    Schema.maxItems(MAX_AUTOMATION_SOURCE_FILES),
  ),
  snapshot: AutomationSourceSnapshot,
  digest: AutomationSourceDigest,
  observedAt: UtcTimestamp,
}).annotations(strict);
export type AutomationFileHeldBatch = typeof AutomationFileHeldBatch.Type;

/** The existing routine journal owns this one bounded cursor, not a second inventory. */
export const AutomationFileSourceCheckpoint = Schema.Struct({
  sourceIdentity: AutomationSourceDigest,
  observationRevision: positiveCounter,
  armGeneration: positiveCounter,
  automaticStarts: Schema.Int.pipe(Schema.between(0, MAX_AUTOMATION_FILE_START_LIMIT)),
  baselineReady: Schema.Boolean,
  baseline: AutomationSourceSnapshot,
  baselineDigest: AutomationSourceDigest,
  observedAt: UtcTimestamp,
  phase: AutomationFileSourcePhase,
  reason: Schema.optional(AutomationFileSourceReason),
  coverageGap: Schema.Boolean,
  activityWindow: Schema.Array(Schema.UUID).pipe(Schema.maxItems(64)),
  busyChangeObserved: Schema.Boolean,
  held: Schema.optional(AutomationFileHeldBatch),
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (checkpoint) =>
        new Set(checkpoint.activityWindow).size === checkpoint.activityWindow.length &&
        (checkpoint.phase !== "watching" || checkpoint.baselineReady) &&
        (checkpoint.phase !== "held" || checkpoint.held !== undefined) &&
        (checkpoint.baselineReady ||
          (checkpoint.baseline.length === 0 && checkpoint.automaticStarts === 0)),
    ),
  );
export type AutomationFileSourceCheckpoint = typeof AutomationFileSourceCheckpoint.Type;

export const AutomationFileSourceReview = Schema.Struct({
  expectedDefinitionVersion: positiveCounter,
  previousObservationRevision: positiveCounter,
  previousSourceIdentity: AutomationSourceDigest,
  previousBatchDigest: AutomationSourceDigest,
  disposition: Schema.Literal("skip", "run-once"),
  reviewedWindowId: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
  reviewedCapabilityGeneration: counter,
  reviewedAt: UtcTimestamp,
}).annotations(strict);
export type AutomationFileSourceReview = typeof AutomationFileSourceReview.Type;

export const AutomationFileArrivalReceipt = Schema.Struct({
  checkpoint: AutomationFileSourceCheckpoint,
  files: Schema.Array(AutomationSourceRelativePath).pipe(
    Schema.minItems(1),
    Schema.maxItems(MAX_AUTOMATION_SOURCE_FILES),
  ),
  automaticStartOrdinal: Schema.Int.pipe(Schema.between(1, MAX_AUTOMATION_FILE_START_LIMIT)),
  rearm: Schema.optional(AutomationFileSourceReview),
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (receipt) =>
        (receipt.rearm === undefined || receipt.rearm.disposition === "run-once") &&
        receipt.automaticStartOrdinal === receipt.checkpoint.automaticStarts &&
        receipt.checkpoint.baselineReady &&
        (receipt.checkpoint.phase === "watching" ||
          (receipt.checkpoint.phase === "needs-rearm" &&
            receipt.checkpoint.reason === "automatic-start-limit")) &&
        new Set(receipt.files).size === receipt.files.length &&
        receipt.files.every((path) =>
          receipt.checkpoint.baseline.some((file) => file.path === path),
        ),
    ),
  );
export type AutomationFileArrivalReceipt = typeof AutomationFileArrivalReceipt.Type;

export const AutomationFileSourceSummary = Schema.Struct({
  phase: Schema.Union(AutomationFileSourcePhase, Schema.Literal("paused")),
  reason: Schema.optional(AutomationFileSourceReason),
  observationRevision: counter,
  remainingStarts: Schema.Int.pipe(Schema.between(0, MAX_AUTOMATION_FILE_START_LIMIT)),
  observedAt: Schema.optional(UtcTimestamp),
  coverageGap: Schema.Boolean,
  heldFiles: Schema.Array(AutomationSourceRelativePath).pipe(
    Schema.maxItems(MAX_AUTOMATION_SOURCE_FILES),
  ),
  heldDigest: Schema.optional(AutomationSourceDigest),
  sourceIdentity: Schema.optional(AutomationSourceDigest),
  reviewDigest: Schema.optional(AutomationSourceDigest),
}).annotations(strict);
export type AutomationFileSourceSummary = typeof AutomationFileSourceSummary.Type;
export const decodeAutomationFileSourceCheckpoint = Schema.decodeUnknownSync(
  AutomationFileSourceCheckpoint,
);
export const decodeAutomationSourceSnapshot = Schema.decodeUnknownSync(AutomationSourceSnapshot);
