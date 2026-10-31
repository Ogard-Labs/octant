import { Schema } from "effect";
import { ShieldDecision } from "./shield";
import {
  MAX_THREAD_TOOL_STEPS_PER_TURN,
  MAX_THREAD_TOOL_STEP_SUMMARY_BYTES,
  ThreadPublishedPage,
} from "./threadToolSteps";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const encoder = new TextEncoder();
const boundedNonEmptyText = (maximumBytes: number) =>
  Schema.NonEmptyTrimmedString.pipe(
    Schema.filter((value) => encoder.encode(value).byteLength <= maximumBytes),
  );

// Kept apart from `threadToolSteps` because a step may carry Octant Shield's
// decision, and the Shield schema reads the provider schema, which reads the
// published page defined there.
export const ThreadToolStepState = Schema.Literal("started", "running", "completed", "failed");
export type ThreadToolStepState = typeof ThreadToolStepState.Type;

/**
 * One tool call a Chat or Work turn made: its id, its name, how it stands, and
 * the provider's latest progress or result message. The same fields a Code
 * turn's tool step carries, and nothing more: no tool input and no tool output
 * is captured beyond a page the call published.
 */
export const ThreadToolStep = Schema.Struct({
  toolCallId: boundedNonEmptyText(255),
  toolName: boundedNonEmptyText(255),
  state: ThreadToolStepState,
  summary: Schema.optional(boundedNonEmptyText(MAX_THREAD_TOOL_STEP_SUMMARY_BYTES)),
  published: Schema.optional(ThreadPublishedPage),
  /**
   * Octant Shield's decision on an approval it answered or handed to the
   * person: the row is Shield's, not the provider's tool call.
   */
  shield: Schema.optional(ShieldDecision),
}).annotations(strict);
export type ThreadToolStep = typeof ThreadToolStep.Type;

/** In arrival order. The first steps are kept when a turn calls more tools than fit. */
export const ThreadToolStepList = Schema.Array(ThreadToolStep).pipe(
  Schema.filter((steps) => steps.length <= MAX_THREAD_TOOL_STEPS_PER_TURN),
);
export type ThreadToolStepList = typeof ThreadToolStepList.Type;

export const decodeThreadToolStep = Schema.decodeUnknownSync(ThreadToolStep);
export const decodeThreadToolStepList = Schema.decodeUnknownSync(ThreadToolStepList);
