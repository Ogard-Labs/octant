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
import { OctantMode } from "./modes";
import { ProviderInstanceId, ProviderModelId, ProviderSessionId } from "./providers";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

const TranscriptText = Schema.String.pipe(Schema.maxLength(1_000_000));
const TranscriptJson = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1_000_000));
const TranscriptId = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128));

export const NATIVE_HARNESS_TRANSCRIPT_AGGREGATE_TYPE = "native-harness-transcript";
export const NATIVE_HARNESS_TRANSCRIPT_EVENT_NAMES = {
  opened: "native-harness-transcript-opened@1",
  messageAppended: "native-harness-transcript-message-appended@1",
  toolSettled: "native-harness-transcript-tool-settled@1",
} as const;

/** Where a session may be resumed: the same endpoint, model, root, and mode it started under. */
export const NativeHarnessTranscriptBinding = Schema.Struct({
  instanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  projectRoot: Schema.NonEmptyTrimmedString,
  mode: OctantMode,
}).annotations(strict);
export type NativeHarnessTranscriptBinding = typeof NativeHarnessTranscriptBinding.Type;

export const NativeHarnessTranscriptToolCall = Schema.Struct({
  toolCallId: TranscriptId,
  toolName: TranscriptId,
  argumentsJson: TranscriptJson,
}).annotations(strict);
export type NativeHarnessTranscriptToolCall = typeof NativeHarnessTranscriptToolCall.Type;

/**
 * A settled tool call. Images a tool returned are sent to the model live but
 * not journaled; `imagesOmitted` says how many a resumed request no longer has.
 */
export const NativeHarnessTranscriptToolResult = Schema.Struct({
  toolCallId: TranscriptId,
  resultJson: TranscriptJson,
  isError: Schema.Boolean,
  imagesOmitted: Schema.optional(Schema.Int.pipe(Schema.positive())),
}).annotations(strict);
export type NativeHarnessTranscriptToolResult = typeof NativeHarnessTranscriptToolResult.Type;

export const NativeHarnessTranscriptMessage = Schema.Struct({
  role: Schema.Literal("user", "assistant"),
  text: TranscriptText,
  toolCalls: Schema.optional(Schema.Array(NativeHarnessTranscriptToolCall)),
  toolResults: Schema.optional(Schema.Array(NativeHarnessTranscriptToolResult)),
}).annotations(strict);
export type NativeHarnessTranscriptMessage = typeof NativeHarnessTranscriptMessage.Type;

export const NativeHarnessTranscriptOpened = Schema.Struct({
  sessionId: ProviderSessionId,
  binding: NativeHarnessTranscriptBinding,
}).annotations(strict);
export type NativeHarnessTranscriptOpened = typeof NativeHarnessTranscriptOpened.Type;

export const NativeHarnessTranscriptMessageAppended = Schema.Struct({
  sessionId: ProviderSessionId,
  message: NativeHarnessTranscriptMessage,
}).annotations(strict);
export type NativeHarnessTranscriptMessageAppended =
  typeof NativeHarnessTranscriptMessageAppended.Type;

export const NativeHarnessTranscriptToolSettled = Schema.Struct({
  sessionId: ProviderSessionId,
  result: NativeHarnessTranscriptToolResult,
}).annotations(strict);
export type NativeHarnessTranscriptToolSettled = typeof NativeHarnessTranscriptToolSettled.Type;

export const decodeNativeHarnessTranscriptOpened = Schema.decodeUnknownSync(
  NativeHarnessTranscriptOpened,
);
export const decodeNativeHarnessTranscriptMessageAppended = Schema.decodeUnknownSync(
  NativeHarnessTranscriptMessageAppended,
);
export const decodeNativeHarnessTranscriptToolSettled = Schema.decodeUnknownSync(
  NativeHarnessTranscriptToolSettled,
);
