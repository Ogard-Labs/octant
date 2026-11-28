/**
 * The native harness's own conversation record: every message the loop sent
 * or received, and every tool call it settled, journaled step by step.
 *
 * A harness session is resumable only because this record exists. A request
 * the process never finished is rebuilt from it, and a tool call that was
 * requested but never settled is visible as exactly that, so recovery can tell
 * the model the truth instead of guessing whether a side effect ran.
 */

import { Schema } from "effect";
import { NonEmptyTrimmedString, PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { OctantMode } from "./modes";
import { ProviderInstanceId, ProviderModelId, ProviderSessionId } from "./providers";

const TranscriptText = Schema.String.check(Schema.isMaxLength(1_000_000));
const TranscriptJson = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_000_000));
const TranscriptId = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128));

export const NATIVE_HARNESS_TRANSCRIPT_AGGREGATE_TYPE = "native-harness-transcript";
export const NATIVE_HARNESS_TRANSCRIPT_EVENT_NAMES = {
  opened: "native-harness-transcript-opened@1",
  messageAppended: "native-harness-transcript-message-appended@1",
  toolSettled: "native-harness-transcript-tool-settled@1",
  compacted: "native-harness-transcript-compacted@1",
} as const;

/** Where a session may be resumed: the same endpoint, model, root, and mode it started under. */
export const NativeHarnessTranscriptBinding = Schema.Struct({
  instanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  projectRoot: NonEmptyTrimmedString,
  mode: OctantMode,
});
export type NativeHarnessTranscriptBinding = typeof NativeHarnessTranscriptBinding.Type;

export const NativeHarnessTranscriptToolCall = Schema.Struct({
  toolCallId: TranscriptId,
  toolName: TranscriptId,
  argumentsJson: TranscriptJson,
});
export type NativeHarnessTranscriptToolCall = typeof NativeHarnessTranscriptToolCall.Type;

/**
 * A settled tool call. Images a tool returned are sent to the model live but
 * not journaled; `imagesOmitted` says how many a resumed request no longer has.
 */
export const NativeHarnessTranscriptToolResult = Schema.Struct({
  toolCallId: TranscriptId,
  resultJson: TranscriptJson,
  isError: Schema.Boolean,
  imagesOmitted: Schema.optional(PositiveInt),
});
export type NativeHarnessTranscriptToolResult = typeof NativeHarnessTranscriptToolResult.Type;

export const NativeHarnessTranscriptMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  text: TranscriptText,
  toolCalls: Schema.optional(Schema.Array(NativeHarnessTranscriptToolCall)),
  toolResults: Schema.optional(Schema.Array(NativeHarnessTranscriptToolResult)),
});
export type NativeHarnessTranscriptMessage = typeof NativeHarnessTranscriptMessage.Type;

/**
 * The conversation a forked transcript was copied from. `turns` is how many of
 * the copy's turns came from there, so a fork of this fork can tell its own
 * turns from the inherited ones and the ancestry survives a replay.
 */
export const NativeHarnessTranscriptForkOrigin = Schema.Struct({
  sessionId: ProviderSessionId,
  turns: PositiveInt,
});
export type NativeHarnessTranscriptForkOrigin = typeof NativeHarnessTranscriptForkOrigin.Type;

export const NativeHarnessTranscriptOpened = Schema.Struct({
  sessionId: ProviderSessionId,
  binding: NativeHarnessTranscriptBinding,
  forkedFrom: Schema.optional(NativeHarnessTranscriptForkOrigin),
});
export type NativeHarnessTranscriptOpened = typeof NativeHarnessTranscriptOpened.Type;

export const NativeHarnessTranscriptMessageAppended = Schema.Struct({
  sessionId: ProviderSessionId,
  message: NativeHarnessTranscriptMessage,
});
export type NativeHarnessTranscriptMessageAppended =
  typeof NativeHarnessTranscriptMessageAppended.Type;

export const NativeHarnessTranscriptToolSettled = Schema.Struct({
  sessionId: ProviderSessionId,
  result: NativeHarnessTranscriptToolResult,
});
export type NativeHarnessTranscriptToolSettled = typeof NativeHarnessTranscriptToolSettled.Type;

/**
 * The model reads `summary` in place of the conversation's first `turns`
 * turns, counted from the transcript's own first turn, from the turn after
 * the first `afterTurns`: a compaction asked for between turns is read by the
 * next one, and one made part-way through a turn by that turn itself, whose
 * own steps are never summarized. So a summary never stands for a turn that
 * had not run before the first turn that reads it. Those messages stay in the
 * aggregate; only what a request is built from changes, and a later
 * compaction supersedes an earlier one.
 */
export const NativeHarnessTranscriptCompacted = Schema.Struct({
  sessionId: ProviderSessionId,
  summary: TranscriptText.check(Schema.isMinLength(1)),
  turns: PositiveInt,
  afterTurns: PositiveInt,
}).check(Schema.makeFilter((compacted) => compacted.turns <= compacted.afterTurns));
export type NativeHarnessTranscriptCompacted = typeof NativeHarnessTranscriptCompacted.Type;

export const decodeNativeHarnessTranscriptOpened = Schema.decodeUnknownSync(
  NativeHarnessTranscriptOpened,
  STRICT_DECODE_OPTIONS,
);
export const decodeNativeHarnessTranscriptMessageAppended = Schema.decodeUnknownSync(
  NativeHarnessTranscriptMessageAppended,
  STRICT_DECODE_OPTIONS,
);
export const decodeNativeHarnessTranscriptToolSettled = Schema.decodeUnknownSync(
  NativeHarnessTranscriptToolSettled,
  STRICT_DECODE_OPTIONS,
);
export const decodeNativeHarnessTranscriptCompacted = Schema.decodeUnknownSync(
  NativeHarnessTranscriptCompacted,
  STRICT_DECODE_OPTIONS,
);
