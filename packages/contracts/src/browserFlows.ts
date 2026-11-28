import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { UtcTimestamp } from "./events";
import { ProjectId } from "./projects";
import { BrowserThreadId } from "./browserAutomation";
import { ProviderModelId } from "./providers";

/**
 * Limits on what the host keeps. A run is at most 50 steps, a Project keeps at
 * most 50 flows, and a flow's stored form is at most 256 KiB, so a runaway
 * recording cannot grow a Project's data without bound.
 */
export const MAX_BROWSER_FLOW_STEPS = 50;
export const MAX_BROWSER_FLOWS_PER_PROJECT = 50;
export const MAX_BROWSER_FLOW_BYTES = 256 * 1024;
export const MAX_BROWSER_FLOW_NAME_LENGTH = 80;

/** One aggregate per Project (aggregate id = Project id). */
export const BROWSER_FLOW_AGGREGATE_TYPE = "browser-flow";
export const BROWSER_FLOW_EVENT_NAMES = {
  saved: "browser.flow-saved@1",
  deleted: "browser.flow-deleted@1",
} as const;

export const BrowserFlowName = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_BROWSER_FLOW_NAME_LENGTH),
);
export type BrowserFlowName = typeof BrowserFlowName.Type;

/**
 * The element a step acted on, as the page showed it when the flow was
 * recorded: its role and accessible name, plus the snapshot's selector as a
 * hint for a reader. A ref id is never stored; it means nothing on a fresh page.
 */
export const BrowserFlowTarget = Schema.Struct({
  role: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
  name: Schema.String.check(Schema.isMaxLength(512)),
  selector: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
});
export type BrowserFlowTarget = typeof BrowserFlowTarget.Type;

/** What the page showed after a step: its path and title, never its text. */
export const BrowserFlowOutcome = Schema.Struct({
  path: Schema.String.check(Schema.isMaxLength(2048)),
  title: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
});
export type BrowserFlowOutcome = typeof BrowserFlowOutcome.Type;

/**
 * One fixed operation, written as the tool would take it. `targets` names the
 * elements the operation's refs stood for, keyed by the field that held the ref
 * (`ref`, `toRef`, or `conditions.N`); replay finds each on the fresh page.
 * Replay reads `input` with the tool's own parser, so a stored step cannot
 * carry anything a call could not.
 */
export const BrowserFlowStep = Schema.Struct({
  operation: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(32)),
  input: Schema.Record(Schema.String, Schema.Unknown),
  targets: Schema.optional(Schema.Record(Schema.String, BrowserFlowTarget)),
  expect: BrowserFlowOutcome,
});
export type BrowserFlowStep = typeof BrowserFlowStep.Type;

export const BrowserFlow = Schema.Struct({
  name: BrowserFlowName,
  steps: Schema.Array(BrowserFlowStep).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_BROWSER_FLOW_STEPS),
  ),
  savedAt: UtcTimestamp,
});
export type BrowserFlow = typeof BrowserFlow.Type;

export const BrowserFlowSaved = Schema.Struct({
  kind: Schema.Literal("browser-flow-saved"),
  projectId: ProjectId,
  flow: BrowserFlow,
});
export type BrowserFlowSaved = typeof BrowserFlowSaved.Type;

export const BrowserFlowDeleted = Schema.Struct({
  kind: Schema.Literal("browser-flow-deleted"),
  projectId: ProjectId,
  name: BrowserFlowName,
});
export type BrowserFlowDeleted = typeof BrowserFlowDeleted.Type;

/** A flow as a list shows it. */
export const BrowserFlowSummary = Schema.Struct({
  projectId: ProjectId,
  projectLabel: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  name: BrowserFlowName,
  stepCount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_BROWSER_FLOW_STEPS })),
  /** The address the first navigation went to, when the flow opens with one. */
  firstAddress: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
  savedAt: UtcTimestamp,
});
export type BrowserFlowSummary = typeof BrowserFlowSummary.Type;

/** A chosen existing task. This names authority; it never creates a task or changes its model. */
export const BrowserFlowTask = Schema.Struct({
  threadId: BrowserThreadId,
  mode: Schema.Literals(["work", "code"]),
  title: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  modelId: ProviderModelId,
  accessLabel: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(80)),
  profileLabel: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
});
export type BrowserFlowTask = typeof BrowserFlowTask.Type;

export const BrowserFlowRunId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("BrowserFlowRunId"),
);
export type BrowserFlowRunId = typeof BrowserFlowRunId.Type;

export const BrowserFlowRunValue = Schema.Struct({
  /** Zero-based step index; only recorded text and expected title values are editable. */
  step: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_BROWSER_FLOW_STEPS - 1 })),
  text: Schema.optional(Schema.String.check(Schema.isMaxLength(8192))),
  expectedTitle: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
}).check(
  Schema.makeFilter((value) => value.text !== undefined || value.expectedTitle !== undefined),
);
export type BrowserFlowRunValue = typeof BrowserFlowRunValue.Type;

export const BrowserFlowRun = Schema.Struct({
  id: BrowserFlowRunId,
  projectId: ProjectId,
  task: BrowserFlowTask,
  flow: BrowserFlow,
  state: Schema.Literals([
    "review",
    "running",
    "paused",
    "completed",
    "failed",
    "cancelled",
    "expired",
  ]),
  completed: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_BROWSER_FLOW_STEPS })),
  expiresAt: UtcTimestamp,
  message: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
});
export type BrowserFlowRun = typeof BrowserFlowRun.Type;

/** The person's commands about the flows this host keeps; local windows only. */
export const BrowserFlowsCommand = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("list") }),
  Schema.Struct({ kind: Schema.Literal("run-tasks"), projectId: ProjectId }),
  Schema.Struct({
    kind: Schema.Literal("review-run"),
    projectId: ProjectId,
    name: BrowserFlowName,
    threadId: BrowserThreadId,
    mode: Schema.Literals(["work", "code"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("start-run"),
    runId: BrowserFlowRunId,
    values: Schema.Array(BrowserFlowRunValue).check(Schema.isMaxLength(MAX_BROWSER_FLOW_STEPS)),
  }),
  Schema.Struct({
    kind: Schema.Literals(["inspect-run", "resume-run", "cancel-run"]),
    runId: BrowserFlowRunId,
  }),
  Schema.Struct({
    kind: Schema.Literal("delete"),
    projectId: ProjectId,
    name: BrowserFlowName,
  }),
]);
export type BrowserFlowsCommand = typeof BrowserFlowsCommand.Type;

export const BrowserFlowsResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("browser-flow-tasks"),
    tasks: Schema.Array(BrowserFlowTask).check(Schema.isMaxLength(256)),
  }),
  Schema.Struct({ kind: Schema.Literal("browser-flow-run"), run: BrowserFlowRun }),
  Schema.Struct({
    kind: Schema.Literal("browser-flows"),
    flows: Schema.Array(BrowserFlowSummary).check(Schema.isMaxLength(4_096)),
  }),
  Schema.Struct({
    kind: Schema.Literal("browser-flow-deleted"),
    projectId: ProjectId,
    name: BrowserFlowName,
  }),
  Schema.Struct({
    kind: Schema.Literal("browser-flows-refused"),
    reason: Schema.Literals([
      "not-local",
      "not-found",
      "task-unavailable",
      "run-stale",
      "run-busy",
      "invalid-values",
    ]),
    message: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  }),
]);
export type BrowserFlowsResult = typeof BrowserFlowsResult.Type;

export const decodeBrowserFlow = Schema.decodeUnknownSync(BrowserFlow, STRICT_DECODE_OPTIONS);
export const decodeBrowserFlowSaved = Schema.decodeUnknownSync(
  BrowserFlowSaved,
  STRICT_DECODE_OPTIONS,
);
export const decodeBrowserFlowDeleted = Schema.decodeUnknownSync(
  BrowserFlowDeleted,
  STRICT_DECODE_OPTIONS,
);
export const decodeBrowserFlowsCommand = Schema.decodeUnknownSync(
  BrowserFlowsCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeBrowserFlowsResult = Schema.decodeUnknownSync(
  BrowserFlowsResult,
  STRICT_DECODE_OPTIONS,
);
