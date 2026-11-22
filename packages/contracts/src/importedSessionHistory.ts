import { Schema } from "effect";
import { ProviderNativeSessionId } from "./providerNativeSession";
import { ProviderInstanceId } from "./providers";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const encoder = new TextEncoder();
const boundedText = (maximumBytes: number) =>
  Schema.String.pipe(Schema.filter((value) => encoder.encode(value).byteLength <= maximumBytes));
const boundedNonEmptyText = (maximumBytes: number) =>
  Schema.NonEmptyTrimmedString.pipe(
    Schema.filter((value) => encoder.encode(value).byteLength <= maximumBytes),
  );

/** The most earlier messages a thread keeps of a session it was started from; the newest are kept. */
export const MAX_IMPORTED_SESSION_MESSAGES = 200;
/** One imported message keeps at most this much of its text, from its start. */
export const MAX_IMPORTED_SESSION_MESSAGE_BYTES = 8 * 1024;
/** All imported messages together keep at most this much text; the newest are kept. */
export const MAX_IMPORTED_SESSION_BYTES = 256 * 1024;
/** One imported agent message names at most this many of the tools it called. */
export const MAX_IMPORTED_SESSION_MESSAGE_TOOLS = 16;
export const MAX_IMPORTED_SESSION_TOOL_BYTES = 255;

/**
 * One earlier message of a provider session begun outside Octant, as the
 * runtime kept it: the person's words or the agent's reply, with the agent's
 * tool calls named rather than replayed. `clipped` marks a message whose text
 * was longer than one imported message keeps.
 */
export const ImportedSessionMessage = Schema.Struct({
  role: Schema.Literal("person", "agent"),
  text: boundedText(MAX_IMPORTED_SESSION_MESSAGE_BYTES),
  tools: Schema.optional(
    Schema.Array(boundedNonEmptyText(MAX_IMPORTED_SESSION_TOOL_BYTES)).pipe(
      Schema.minItems(1),
      Schema.maxItems(MAX_IMPORTED_SESSION_MESSAGE_TOOLS),
    ),
  ),
  clipped: Schema.optional(Schema.Literal(true)),
}).annotations(strict);
export type ImportedSessionMessage = typeof ImportedSessionMessage.Type;

/**
 * What a thread started from a provider session holds of that session's
 * earlier conversation. `imported` keeps the newest messages within the
 * bounds above; `omittedMessages` counts the earlier ones it left out.
 * `none` says why nothing was imported: the runtime offers no readable
 * history (`unsupported`), the session held no messages (`empty`), or the
 * read failed or ran out of time (`unreadable`). It is the thread's record,
 * never prompt context: the provider already holds the session.
 */
export const ImportedSessionHistory = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("imported"),
    messages: Schema.Array(ImportedSessionMessage).pipe(
      Schema.minItems(1),
      Schema.maxItems(MAX_IMPORTED_SESSION_MESSAGES),
    ),
    omittedMessages: Schema.optional(Schema.Int.pipe(Schema.positive())),
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("none"),
    reason: Schema.Literal("unsupported", "empty", "unreadable"),
  }).annotations(strict),
);
export type ImportedSessionHistory = typeof ImportedSessionHistory.Type;

/**
 * Journaled once per thread, in the same unit as the adoption it belongs to:
 * the earlier conversation of the session a Work or Code thread was started
 * from. Its own aggregate (`native-session-history`, keyed by the thread id),
 * so no turn, handoff, or usage read ever folds it.
 */
export const NativeSessionHistoryImported = Schema.Struct({
  threadId: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
  mode: Schema.Literal("work", "code"),
  providerInstanceId: ProviderInstanceId,
  nativeSessionId: ProviderNativeSessionId,
  history: ImportedSessionHistory,
}).annotations(strict);
export type NativeSessionHistoryImported = typeof NativeSessionHistoryImported.Type;
export const decodeNativeSessionHistoryImported = Schema.decodeUnknownSync(
  NativeSessionHistoryImported,
);
export const NATIVE_SESSION_HISTORY_AGGREGATE_TYPE = "native-session-history";
export const NATIVE_SESSION_HISTORY_IMPORTED_EVENT = "native-session.history-imported@1";
