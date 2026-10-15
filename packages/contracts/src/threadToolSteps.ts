import { Schema } from "effect";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const encoder = new TextEncoder();
const boundedNonEmptyText = (maximumBytes: number) =>
  Schema.NonEmptyTrimmedString.pipe(
    Schema.filter((value) => encoder.encode(value).byteLength <= maximumBytes),
  );

/** How many tool calls one Chat or Work turn keeps, as many as a Code turn does. */
export const MAX_THREAD_TOOL_STEPS_PER_TURN = 64;
/** The most a step's progress or result message keeps. */
export const MAX_THREAD_TOOL_STEP_SUMMARY_BYTES = 2_048;

export const ThreadToolStepState = Schema.Literal("started", "running", "completed", "failed");
export type ThreadToolStepState = typeof ThreadToolStepState.Type;

/**
 * One tool call a Chat or Work turn made: its id, its name, how it stands, and
 * the provider's latest progress or result message. The same fields a Code
 * turn's tool step carries, and nothing more: no tool input and no tool output
 * is captured.
 */
export const ThreadToolStep = Schema.Struct({
  toolCallId: boundedNonEmptyText(255),
  toolName: boundedNonEmptyText(255),
  state: ThreadToolStepState,
  summary: Schema.optional(boundedNonEmptyText(MAX_THREAD_TOOL_STEP_SUMMARY_BYTES)),
}).annotations(strict);
export type ThreadToolStep = typeof ThreadToolStep.Type;

/** In arrival order. The first steps are kept when a turn calls more tools than fit. */
export const ThreadToolStepList = Schema.Array(ThreadToolStep).pipe(
  Schema.filter((steps) => steps.length <= MAX_THREAD_TOOL_STEPS_PER_TURN),
);
export type ThreadToolStepList = typeof ThreadToolStepList.Type;

export const decodeThreadToolStep = Schema.decodeUnknownSync(ThreadToolStep);
export const decodeThreadToolStepList = Schema.decodeUnknownSync(ThreadToolStepList);
