import { Schema } from "effect";
import { UtcTimestamp } from "./events";
import { ProjectId } from "./projects";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

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

export const BrowserFlowName = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(MAX_BROWSER_FLOW_NAME_LENGTH),
);
export type BrowserFlowName = typeof BrowserFlowName.Type;

/**
 * The element a step acted on, as the page showed it when the flow was
 * recorded: its role and accessible name, plus the snapshot's selector as a
 * hint for a reader. A ref id is never stored; it means nothing on a fresh page.
 */
export const BrowserFlowTarget = Schema.Struct({
  role: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64)),
  name: Schema.String.pipe(Schema.maxLength(512)),
  selector: Schema.optional(Schema.String.pipe(Schema.maxLength(4096))),
}).annotations(strict);
export type BrowserFlowTarget = typeof BrowserFlowTarget.Type;

/** What the page showed after a step: its path and title, never its text. */
export const BrowserFlowOutcome = Schema.Struct({
  path: Schema.String.pipe(Schema.maxLength(2048)),
  title: Schema.optional(Schema.String.pipe(Schema.maxLength(1024))),
}).annotations(strict);
export type BrowserFlowOutcome = typeof BrowserFlowOutcome.Type;

/**
 * One fixed operation, written as the tool would take it. `targets` names the
 * elements the operation's refs stood for, keyed by the field that held the ref
 * (`ref`, `toRef`, or `conditions.N`); replay finds each on the fresh page.
 * Replay reads `input` with the tool's own parser, so a stored step cannot
 * carry anything a call could not.
 */
export const BrowserFlowStep = Schema.Struct({
  operation: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(32)),
  input: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  targets: Schema.optional(Schema.Record({ key: Schema.String, value: BrowserFlowTarget })),
  expect: BrowserFlowOutcome,
}).annotations(strict);
export type BrowserFlowStep = typeof BrowserFlowStep.Type;

export const BrowserFlow = Schema.Struct({
  name: BrowserFlowName,
  steps: Schema.Array(BrowserFlowStep).pipe(
    Schema.minItems(1),
    Schema.maxItems(MAX_BROWSER_FLOW_STEPS),
  ),
  savedAt: UtcTimestamp,
}).annotations(strict);
export type BrowserFlow = typeof BrowserFlow.Type;

export const BrowserFlowSaved = Schema.Struct({
  kind: Schema.Literal("browser-flow-saved"),
  projectId: ProjectId,
  flow: BrowserFlow,
}).annotations(strict);
export type BrowserFlowSaved = typeof BrowserFlowSaved.Type;

export const BrowserFlowDeleted = Schema.Struct({
  kind: Schema.Literal("browser-flow-deleted"),
  projectId: ProjectId,
  name: BrowserFlowName,
}).annotations(strict);
export type BrowserFlowDeleted = typeof BrowserFlowDeleted.Type;

/** A flow as a list shows it. */
export const BrowserFlowSummary = Schema.Struct({
  projectId: ProjectId,
  projectLabel: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
  name: BrowserFlowName,
  stepCount: Schema.Int.pipe(Schema.between(1, MAX_BROWSER_FLOW_STEPS)),
  /** The address the first navigation went to, when the flow opens with one. */
  firstAddress: Schema.optional(Schema.String.pipe(Schema.maxLength(4096))),
  savedAt: UtcTimestamp,
}).annotations(strict);
export type BrowserFlowSummary = typeof BrowserFlowSummary.Type;

/** The person's commands about the flows this host keeps; local windows only. */
export const BrowserFlowsCommand = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("list") }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("delete"),
    projectId: ProjectId,
    name: BrowserFlowName,
  }).annotations(strict),
);
export type BrowserFlowsCommand = typeof BrowserFlowsCommand.Type;

export const BrowserFlowsResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("browser-flows"),
    flows: Schema.Array(BrowserFlowSummary).pipe(Schema.maxItems(4_096)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("browser-flow-deleted"),
    projectId: ProjectId,
    name: BrowserFlowName,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("browser-flows-refused"),
    reason: Schema.Literal("not-local", "not-found"),
    message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  }).annotations(strict),
);
export type BrowserFlowsResult = typeof BrowserFlowsResult.Type;

export const decodeBrowserFlow = Schema.decodeUnknownSync(BrowserFlow);
export const decodeBrowserFlowSaved = Schema.decodeUnknownSync(BrowserFlowSaved);
export const decodeBrowserFlowDeleted = Schema.decodeUnknownSync(BrowserFlowDeleted);
export const decodeBrowserFlowsCommand = Schema.decodeUnknownSync(BrowserFlowsCommand);
export const decodeBrowserFlowsResult = Schema.decodeUnknownSync(BrowserFlowsResult);
