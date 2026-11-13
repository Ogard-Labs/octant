/**
 * What a Chat or Work tool call was given and what it returned, kept so a
 * person can inspect afterwards what an agent ran and got back.
 *
 * A record is thread content held in purgeable storage outside the journal:
 * the journaled tool step stays the constant-size id, name, state and
 * message it was, and a record is found again by the thread, the turn and the
 * tool call id that step already names.
 */

import { Schema } from "effect";
import { UtcTimestamp } from "./events";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const encoder = new TextEncoder();
const boundedText = (maximumBytes: number) =>
  Schema.String.pipe(Schema.filter((value) => encoder.encode(value).byteLength <= maximumBytes));
const boundedNonEmptyText = (maximumBytes: number) =>
  Schema.NonEmptyTrimmedString.pipe(
    Schema.filter((value) => encoder.encode(value).byteLength <= maximumBytes),
  );

/** The most of one call's input a record keeps. */
export const MAX_TOOL_CALL_RECORD_INPUT_BYTES = 16_384;
/** The most of one call's output a record keeps. */
export const MAX_TOOL_CALL_RECORD_OUTPUT_BYTES = 65_536;
/**
 * The most one thread's records hold together. Past it the thread's oldest
 * records are dropped to make room, so the newest calls stay inspectable.
 */
export const MAX_TOOL_CALL_RECORD_THREAD_BYTES = 16 * 1024 * 1024;
/**
 * The most text one runtime event may carry toward a record. An adapter cuts
 * a longer input or output to this and says so; the store then applies the
 * byte bounds above.
 */
export const MAX_TOOL_CALL_CONTENT_EVENT_CHARACTERS = 65_536;

/** The modes whose tool calls keep a record. Code replays its own tool activity. */
export const ThreadToolCallRecordMode = Schema.Literal("chat", "work");
export type ThreadToolCallRecordMode = typeof ThreadToolCallRecordMode.Type;

/** `truncated` says the call's text was longer than what is kept. */
export const ThreadToolCallRecordInput = Schema.Struct({
  text: boundedText(MAX_TOOL_CALL_RECORD_INPUT_BYTES),
  truncated: Schema.Boolean,
}).annotations(strict);

export const ThreadToolCallRecordOutput = Schema.Struct({
  text: boundedText(MAX_TOOL_CALL_RECORD_OUTPUT_BYTES),
  truncated: Schema.Boolean,
}).annotations(strict);

export const ThreadToolCallRecord = Schema.Struct({
  toolCallId: boundedNonEmptyText(255),
  toolName: boundedNonEmptyText(255),
  input: Schema.optional(ThreadToolCallRecordInput),
  output: Schema.optional(ThreadToolCallRecordOutput),
  /**
   * The call's input named a protected secret file, so what it returned was
   * not kept: redaction recognises key shapes, not every credential a file
   * can hold.
   */
  outputWithheld: Schema.optional(Schema.Literal("protected-path")),
  recordedAt: UtcTimestamp,
}).annotations(strict);
export type ThreadToolCallRecord = typeof ThreadToolCallRecord.Type;

/** A Chat attempt id or a Work turn's request id. */
export const ThreadToolCallRecordTurnId = boundedNonEmptyText(255);

export const ThreadToolCallRecordsRequest = Schema.Struct({
  mode: ThreadToolCallRecordMode,
  threadId: Schema.UUID,
  turnId: ThreadToolCallRecordTurnId,
}).annotations(strict);
export type ThreadToolCallRecordsRequest = typeof ThreadToolCallRecordsRequest.Type;

/**
 * A turn with no record answers an empty list: the setting was off, the
 * runtime reported nothing, or the records were dropped or purged.
 */
export const ThreadToolCallRecordsResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("records"),
    records: Schema.Array(ThreadToolCallRecord),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: Schema.Literal("not-found", "unauthorized"),
  }).annotations(strict),
);
export type ThreadToolCallRecordsResult = typeof ThreadToolCallRecordsResult.Type;

/** A record as a thread export carries it: with the turn it belongs to. */
export const ThreadExportToolCall = Schema.Struct({
  turnId: ThreadToolCallRecordTurnId,
  ...ThreadToolCallRecord.fields,
}).annotations(strict);
export type ThreadExportToolCall = typeof ThreadExportToolCall.Type;

export const decodeThreadToolCallRecord = Schema.decodeUnknownSync(ThreadToolCallRecord);
export const decodeThreadToolCallRecordsRequest = Schema.decodeUnknownSync(
  ThreadToolCallRecordsRequest,
);
export const decodeThreadToolCallRecordsResult = Schema.decodeUnknownSync(
  ThreadToolCallRecordsResult,
);
