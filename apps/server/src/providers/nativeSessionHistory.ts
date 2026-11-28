/**
 * The earlier conversation of a provider session a Work or Code thread was
 * started from, imported into the thread at adoption (maintainer decision,
 * 2026-11-20).
 *
 * The driver reads what its runtime already stores; the host bounds it here
 * and journals it once, in the same unit as the adoption, under its own
 * aggregate keyed by the thread. No turn, handoff, or usage read folds that
 * aggregate, so the imported messages are the thread's record only: the
 * provider already holds them and is never sent them again, and they cost
 * nothing. Replay and thread search read the journaled record.
 */
import {
  type ImportedSessionHistory,
  type ImportedSessionMessage,
  MAX_IMPORTED_SESSION_BYTES,
  MAX_IMPORTED_SESSION_MESSAGE_BYTES,
  MAX_IMPORTED_SESSION_MESSAGE_TOOLS,
  MAX_IMPORTED_SESSION_MESSAGES,
  MAX_IMPORTED_SESSION_TOOL_BYTES,
  NATIVE_SESSION_HISTORY_AGGREGATE_TYPE,
  NATIVE_SESSION_HISTORY_IMPORTED_EVENT,
  type EventActor,
  type ProviderInstanceId,
  decodeNativeSessionHistoryImported,
} from "@octant/contracts";
import type {
  ProviderNativeSessionHistory,
  ProviderNativeSessions,
} from "@octant/provider-sdk/driver";
import { Duration, Effect } from "effect";

/** How long a driver's history read may take before the thread imports none. */
export const NATIVE_SESSION_HISTORY_READ_TIMEOUT_MS = 30_000;

const encoder = new TextEncoder();

/** The longest start of `text` that fits in `maximumBytes` of UTF-8, never splitting a character. */
function clipBytes(
  text: string,
  maximumBytes: number,
): { readonly text: string; readonly clipped: boolean } {
  if (encoder.encode(text).byteLength <= maximumBytes) return { text, clipped: false };
  let bytes = 0;
  let kept = "";
  for (const character of text) {
    const size = encoder.encode(character).byteLength;
    if (bytes + size > maximumBytes) break;
    bytes += size;
    kept += character;
  }
  return { text: kept, clipped: true };
}

function normalizedMessage(
  message: ProviderNativeSessionHistory extends infer H
    ? H extends { readonly status: "read"; readonly messages: ReadonlyArray<infer M> }
      ? M
      : never
    : never,
): ImportedSessionMessage | undefined {
  const text = clipBytes(message.text.trim(), MAX_IMPORTED_SESSION_MESSAGE_BYTES);
  const tools = (message.tools ?? [])
    .map((tool) =>
      clipBytes(tool.trim().split(/\r?\n/u)[0] ?? "", MAX_IMPORTED_SESSION_TOOL_BYTES).text.trim(),
    )
    .filter((tool) => tool.length > 0)
    .slice(0, MAX_IMPORTED_SESSION_MESSAGE_TOOLS);
  if (text.text.length === 0 && tools.length === 0) return undefined;
  return {
    role: message.role,
    text: text.text,
    ...(tools.length === 0 ? {} : { tools }),
    ...(text.clipped ? { clipped: true as const } : {}),
  };
}

/**
 * What the thread keeps of a driver's read: the newest messages that fit
 * the message and byte bounds, each clipped to its own bound, and a count of
 * the earlier ones left out.
 */
export function boundImportedSessionHistory(
  read: ProviderNativeSessionHistory | "unreadable",
): ImportedSessionHistory {
  if (read === "unreadable") return { status: "none", reason: "unreadable" };
  if (read.status === "unsupported") return { status: "none", reason: "unsupported" };
  const normalized = read.messages.flatMap((message) => {
    const kept = normalizedMessage(message);
    return kept === undefined ? [] : [kept];
  });
  const kept: ImportedSessionMessage[] = [];
  let bytes = 0;
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const message = normalized[index];
    if (message === undefined || kept.length >= MAX_IMPORTED_SESSION_MESSAGES) break;
    const size =
      encoder.encode(message.text).byteLength +
      (message.tools ?? []).reduce((total, tool) => total + encoder.encode(tool).byteLength, 0);
    if (bytes + size > MAX_IMPORTED_SESSION_BYTES) break;
    bytes += size;
    kept.unshift(message);
  }
  const omitted = normalized.length - kept.length + Math.max(0, Math.trunc(read.omitted ?? 0));
  if (kept.length === 0) return { status: "none", reason: omitted > 0 ? "unreadable" : "empty" };
  return {
    status: "imported",
    messages: kept,
    ...(omitted > 0 ? { omittedMessages: omitted } : {}),
  };
}

/**
 * Reads and bounds the session's earlier conversation. Never fails: a driver
 * without a history read imports none as `unsupported`, and one that fails,
 * dies, or runs past the timeout imports none as `unreadable`, so a history
 * read never refuses an adoption.
 */
export async function readImportedSessionHistory(
  nativeSessions: ProviderNativeSessions,
  input: {
    readonly instanceId: ProviderInstanceId;
    readonly projectRoot: string;
    readonly nativeSessionId: string;
  },
  timeoutMs: number = NATIVE_SESSION_HISTORY_READ_TIMEOUT_MS,
): Promise<ImportedSessionHistory> {
  const history = nativeSessions.history;
  if (history === undefined) return { status: "none", reason: "unsupported" };
  const read = await Effect.runPromise(
    Effect.suspend(() => history(input)).pipe(
      Effect.timeout(Duration.millis(timeoutMs)),
      Effect.map((value): ProviderNativeSessionHistory | "unreadable" => value),
      Effect.catchCause(() => Effect.succeed("unreadable" as const)),
    ),
  );
  try {
    return boundImportedSessionHistory(read);
  } catch {
    return { status: "none", reason: "unreadable" };
  }
}

/** The journal append that records a thread's imported history; first and only on its aggregate. */
export function nativeSessionHistoryAppend(input: {
  readonly threadId: string;
  readonly mode: "work" | "code";
  readonly providerInstanceId: ProviderInstanceId;
  readonly nativeSessionId: string;
  readonly history: ImportedSessionHistory;
  readonly eventId: string;
  readonly correlationId: string;
  readonly actor: EventActor;
  readonly occurredAt: string;
}) {
  return {
    aggregate: {
      aggregateType: NATIVE_SESSION_HISTORY_AGGREGATE_TYPE,
      aggregateId: input.threadId,
    },
    expectedVersion: 0,
    events: [
      {
        eventId: input.eventId,
        eventName: NATIVE_SESSION_HISTORY_IMPORTED_EVENT,
        eventVersion: 1 as const,
        correlationId: input.correlationId,
        actor: input.actor,
        occurredAt: input.occurredAt,
        payload: decodeNativeSessionHistoryImported({
          threadId: input.threadId,
          mode: input.mode,
          providerInstanceId: input.providerInstanceId,
          nativeSessionId: input.nativeSessionId,
          history: input.history,
        }),
      },
    ],
  };
}

/**
 * The imported history the journal holds for a thread of this mode, or
 * undefined for a thread adopted before history was imported, or one never
 * adopted.
 */
export function readJournaledSessionHistory(
  journal: {
    readonly latestAggregateEvent: (input: {
      readonly aggregateType: string;
      readonly aggregateId: string;
    }) =>
      | { readonly eventName: string; readonly eventVersion: number; readonly payload: unknown }
      | undefined;
  },
  threadId: string,
  mode: "work" | "code",
): ImportedSessionHistory | undefined {
  try {
    const envelope = journal.latestAggregateEvent({
      aggregateType: NATIVE_SESSION_HISTORY_AGGREGATE_TYPE,
      aggregateId: threadId,
    });
    if (
      envelope === undefined ||
      envelope.eventName !== NATIVE_SESSION_HISTORY_IMPORTED_EVENT ||
      envelope.eventVersion !== 1
    )
      return undefined;
    const recorded = decodeNativeSessionHistoryImported(envelope.payload);
    return recorded.threadId === threadId && recorded.mode === mode ? recorded.history : undefined;
  } catch {
    return undefined;
  }
}
