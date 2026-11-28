import { Schema } from "effect";
import { GuidString, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { UtcTimestamp } from "./events";

export const MAX_AUTOMATION_SOURCE_FILES = 256;
export const MAX_AUTOMATION_SOURCE_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_AUTOMATION_SOURCE_SCAN_BYTES = 64 * 1024 * 1024;
export const MAX_AUTOMATION_SOURCE_DIRECTORY_ENTRIES = 4096;
export const DEFAULT_AUTOMATION_FILE_START_LIMIT = 8;
export const MAX_AUTOMATION_FILE_START_LIMIT = 32;
/**
 * A file routine's activity window: the runs it started since its input was
 * last seen quiet. 64 is the default; the person may raise it per routine up
 * to the maximum, journaled with the routine so replay rebuilds the same
 * overflow ([Octant's own limits become settings]).
 */
export const DEFAULT_AUTOMATION_FILE_ACTIVITY_WINDOW = 64;
export const MAX_AUTOMATION_FILE_ACTIVITY_WINDOW = 1024;
export const AutomationFileActivityWindowLimit = Schema.Int.check(
  Schema.isBetween({
    minimum: DEFAULT_AUTOMATION_FILE_ACTIVITY_WINDOW,
    maximum: MAX_AUTOMATION_FILE_ACTIVITY_WINDOW,
  }),
);
const counter = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const positiveCounter = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);

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
export const AutomationSourceRelativePath = Schema.String.check(
  Schema.makeFilter(isAutomationSourceRelativePath),
);
export const AutomationSourceDirectory = Schema.String.check(
  Schema.makeFilter((value) => value === "." || isAutomationSourceRelativePath(value)),
);
export const AutomationSourceDigest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const AutomationFileArrivalTrigger = Schema.Struct({
  kind: Schema.Literal("file-arrival"),
  directory: AutomationSourceDirectory,
  includeExtensions: Schema.Array(
    Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,31}$/)),
  ).check(Schema.isMaxLength(16)),
  excludeDirectories: Schema.Array(AutomationSourceRelativePath).check(Schema.isMaxLength(16)),
  settleSeconds: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 60 })),
  automaticStartLimit: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: MAX_AUTOMATION_FILE_START_LIMIT }),
  ),
});
export type AutomationFileArrivalTrigger = typeof AutomationFileArrivalTrigger.Type;

export const AutomationSourceFile = Schema.Struct({
  path: AutomationSourceRelativePath,
  digest: AutomationSourceDigest,
  size: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: MAX_AUTOMATION_SOURCE_FILE_BYTES }),
  ),
});
export type AutomationSourceFile = typeof AutomationSourceFile.Type;
export const AutomationSourceSnapshot = Schema.Array(AutomationSourceFile).check(
  Schema.isMaxLength(MAX_AUTOMATION_SOURCE_FILES),
  Schema.makeFilter(
    (files) =>
      new Set(files.map((file) => file.path)).size === files.length &&
      files.reduce((sum, file) => sum + file.size, 0) <= MAX_AUTOMATION_SOURCE_SCAN_BYTES,
  ),
);
export type AutomationSourceSnapshot = typeof AutomationSourceSnapshot.Type;

export const AutomationFileSourcePhase = Schema.Literals([
  "arming",
  "watching",
  "held",
  "unavailable",
  "needs-rearm",
]);
export const AutomationFileSourceReason = Schema.Literals([
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
]);
export const AutomationFileHeldBatch = Schema.Struct({
  files: Schema.Array(AutomationSourceRelativePath).check(
    Schema.isMaxLength(MAX_AUTOMATION_SOURCE_FILES),
  ),
  snapshot: AutomationSourceSnapshot,
  digest: AutomationSourceDigest,
  observedAt: UtcTimestamp,
});
export type AutomationFileHeldBatch = typeof AutomationFileHeldBatch.Type;

/** The existing routine journal owns this one bounded cursor, not a second inventory. */
export const AutomationFileSourceCheckpoint = Schema.Struct({
  sourceIdentity: AutomationSourceDigest,
  observationRevision: positiveCounter,
  armGeneration: positiveCounter,
  automaticStarts: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: MAX_AUTOMATION_FILE_START_LIMIT }),
  ),
  baselineReady: Schema.Boolean,
  baseline: AutomationSourceSnapshot,
  baselineDigest: AutomationSourceDigest,
  observedAt: UtcTimestamp,
  phase: AutomationFileSourcePhase,
  reason: Schema.optional(AutomationFileSourceReason),
  coverageGap: Schema.Boolean,
  activityWindow: Schema.Array(GuidString).check(
    Schema.isMaxLength(MAX_AUTOMATION_FILE_ACTIVITY_WINDOW),
  ),
  /** Absent is the default window; set only by the person's journaled raise. */
  activityWindowLimit: Schema.optional(AutomationFileActivityWindowLimit),
  busyChangeObserved: Schema.Boolean,
  held: Schema.optional(AutomationFileHeldBatch),
}).check(
  Schema.makeFilter(
    (checkpoint) =>
      new Set(checkpoint.activityWindow).size === checkpoint.activityWindow.length &&
      checkpoint.activityWindow.length <= automationFileActivityWindowLimit(checkpoint) &&
      (checkpoint.phase !== "watching" || checkpoint.baselineReady) &&
      (checkpoint.phase !== "held" || checkpoint.held !== undefined) &&
      (checkpoint.baselineReady ||
        (checkpoint.baseline.length === 0 && checkpoint.automaticStarts === 0)),
  ),
);
export type AutomationFileSourceCheckpoint = typeof AutomationFileSourceCheckpoint.Type;

/** How many runs this routine's activity window holds before it overflows. */
export function automationFileActivityWindowLimit(checkpoint: {
  readonly activityWindowLimit?: number | undefined;
}): number {
  return checkpoint.activityWindowLimit ?? DEFAULT_AUTOMATION_FILE_ACTIVITY_WINDOW;
}

export const AutomationFileSourceSummary = Schema.Struct({
  phase: Schema.Union([AutomationFileSourcePhase, Schema.Literal("paused")]),
  reason: Schema.optional(AutomationFileSourceReason),
  observationRevision: counter,
  remainingStarts: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: MAX_AUTOMATION_FILE_START_LIMIT }),
  ),
  observedAt: Schema.optional(UtcTimestamp),
  coverageGap: Schema.Boolean,
  heldFiles: Schema.Array(AutomationSourceRelativePath).check(
    Schema.isMaxLength(MAX_AUTOMATION_SOURCE_FILES),
  ),
  heldDigest: Schema.optional(AutomationSourceDigest),
  sourceIdentity: Schema.optional(AutomationSourceDigest),
  reviewDigest: Schema.optional(AutomationSourceDigest),
  activityWindowRuns: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({ minimum: 0, maximum: MAX_AUTOMATION_FILE_ACTIVITY_WINDOW }),
    ),
  ),
  activityWindowLimit: Schema.optional(AutomationFileActivityWindowLimit),
});
export type AutomationFileSourceSummary = typeof AutomationFileSourceSummary.Type;
export const decodeAutomationFileSourceCheckpoint = Schema.decodeUnknownSync(
  AutomationFileSourceCheckpoint,
  STRICT_DECODE_OPTIONS,
);
export const decodeAutomationSourceSnapshot = Schema.decodeUnknownSync(
  AutomationSourceSnapshot,
  STRICT_DECODE_OPTIONS,
);
