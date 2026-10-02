import {
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActor,
  EventId,
  NATIVE_HARNESS_TRANSCRIPT_AGGREGATE_TYPE,
  NATIVE_HARNESS_TRANSCRIPT_EVENT_NAMES,
  decodeNativeHarnessTranscriptMessageAppended,
  decodeNativeHarnessTranscriptOpened,
  decodeNativeHarnessTranscriptToolSettled,
  type NativeHarnessTranscriptBinding,
  type NativeHarnessTranscriptForkOrigin,
  type NativeHarnessTranscriptMessage,
  type NativeHarnessTranscriptToolCall,
  type NativeHarnessTranscriptToolResult,
  type ProviderSessionId,
} from "@octant/contracts";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";

const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const REPLAY_BATCH_SIZE = 1_000;

/** A session's conversation as the journal holds it. */
export interface NativeHarnessTranscript {
  readonly binding: NativeHarnessTranscriptBinding;
  /** The conversation this one was forked from, and how many turns it brought. */
  readonly forkedFrom?: NativeHarnessTranscriptForkOrigin;
  /** Messages in order; settled tool calls appear as one results message after their call. */
  readonly messages: ReadonlyArray<NativeHarnessTranscriptMessage>;
  /**
   * The last step when the process stopped in the middle of it: the calls the
   * model asked for and the results that settled before the stop. Absent when
   * every step finished.
   */
  readonly openStep?: {
    readonly calls: ReadonlyArray<NativeHarnessTranscriptToolCall>;
    readonly settled: ReadonlyArray<NativeHarnessTranscriptToolResult>;
  };
}

export type NativeHarnessTranscriptEvent =
  | {
      readonly kind: "opened";
      readonly binding: NativeHarnessTranscriptBinding;
      readonly forkedFrom?: NativeHarnessTranscriptForkOrigin;
    }
  | { readonly kind: "message"; readonly message: NativeHarnessTranscriptMessage }
  | { readonly kind: "settled"; readonly result: NativeHarnessTranscriptToolResult };

export interface NativeHarnessTranscriptStore {
  /**
   * Starts a conversation. Starting again under the same id begins a new
   * generation: the earlier one stays in the journal but is no longer what a
   * resume rebuilds. A fork names where its copied turns came from.
   */
  readonly open: (
    sessionId: ProviderSessionId,
    binding: NativeHarnessTranscriptBinding,
    forkedFrom?: NativeHarnessTranscriptForkOrigin,
  ) => void;
  readonly load: (sessionId: ProviderSessionId) => NativeHarnessTranscript | undefined;
  readonly append: (sessionId: ProviderSessionId, message: NativeHarnessTranscriptMessage) => void;
  readonly settle: (
    sessionId: ProviderSessionId,
    result: NativeHarnessTranscriptToolResult,
  ) => void;
}

/**
 * Folds a transcript's events into the conversation a request is built from.
 * Results are gathered per call and emitted, in the order the model asked for
 * them, once every call of that step has settled — the shape both wire
 * protocols pair with the calls that preceded it.
 */
export function foldNativeHarnessTranscript(
  events: ReadonlyArray<NativeHarnessTranscriptEvent>,
): NativeHarnessTranscript | undefined {
  let binding: NativeHarnessTranscriptBinding | undefined;
  let forkedFrom: NativeHarnessTranscriptForkOrigin | undefined;
  const messages: NativeHarnessTranscriptMessage[] = [];
  let pendingCalls: ReadonlyArray<NativeHarnessTranscriptToolCall> = [];
  const pendingResults = new Map<string, NativeHarnessTranscriptToolResult>();
  const flush = () => {
    if (pendingCalls.length === 0) return;
    if (!pendingCalls.every((call) => pendingResults.has(call.toolCallId))) return;
    messages.push({
      role: "assistant",
      text: "",
      toolResults: pendingCalls.flatMap((call) => {
        const result = pendingResults.get(call.toolCallId);
        return result === undefined ? [] : [result];
      }),
    });
    pendingCalls = [];
    pendingResults.clear();
  };
  for (const event of events) {
    if (event.kind === "opened") {
      binding = event.binding;
      forkedFrom = event.forkedFrom;
      messages.length = 0;
      pendingCalls = [];
      pendingResults.clear();
    } else if (event.kind === "message") {
      messages.push(event.message);
      pendingCalls = event.message.toolCalls ?? [];
      pendingResults.clear();
    } else if (pendingCalls.some((call) => call.toolCallId === event.result.toolCallId)) {
      pendingResults.set(event.result.toolCallId, event.result);
      flush();
    }
  }
  if (binding === undefined) return undefined;
  return {
    binding,
    ...(forkedFrom === undefined ? {} : { forkedFrom }),
    messages,
    ...(pendingCalls.length === 0
      ? {}
      : { openStep: { calls: pendingCalls, settled: [...pendingResults.values()] } }),
  };
}

/** A transcript store that lives only as long as the process; for tests and probes. */
export class MemoryNativeHarnessTranscriptStore implements NativeHarnessTranscriptStore {
  readonly #events = new Map<string, NativeHarnessTranscriptEvent[]>();

  open(
    sessionId: ProviderSessionId,
    binding: NativeHarnessTranscriptBinding,
    forkedFrom?: NativeHarnessTranscriptForkOrigin,
  ): void {
    const events = this.#events.get(String(sessionId)) ?? [];
    events.push({ kind: "opened", binding, ...(forkedFrom === undefined ? {} : { forkedFrom }) });
    this.#events.set(String(sessionId), events);
  }

  load(sessionId: ProviderSessionId): NativeHarnessTranscript | undefined {
    const events = this.#events.get(String(sessionId));
    return events === undefined ? undefined : foldNativeHarnessTranscript(events);
  }

  append(sessionId: ProviderSessionId, message: NativeHarnessTranscriptMessage): void {
    this.#events.get(String(sessionId))?.push({ kind: "message", message });
  }

  settle(sessionId: ProviderSessionId, result: NativeHarnessTranscriptToolResult): void {
    this.#events.get(String(sessionId))?.push({ kind: "settled", result });
  }
}

/**
 * The durable store: one journal aggregate per session, one event per step.
 * Appending a step at a time — rather than snapshotting the conversation —
 * keeps each write small and leaves the last thing the process did as the
 * last event, which is what recovery needs to read.
 */
export class JournalNativeHarnessTranscriptStore implements NativeHarnessTranscriptStore {
  readonly #journal: Pick<Journal, "append" | "replayAggregate">;
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #actor: typeof EventActor.Type;
  readonly #versions = new Map<string, number>();

  constructor(options: {
    readonly journal: Pick<Journal, "append" | "replayAggregate">;
    readonly uuid: () => string;
    readonly clock: () => string;
    readonly actor: typeof EventActor.Type;
  }) {
    this.#journal = options.journal;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    this.#actor = decodeActor(options.actor);
  }

  open(
    sessionId: ProviderSessionId,
    binding: NativeHarnessTranscriptBinding,
    forkedFrom?: NativeHarnessTranscriptForkOrigin,
  ): void {
    this.#append(
      sessionId,
      NATIVE_HARNESS_TRANSCRIPT_EVENT_NAMES.opened,
      decodeNativeHarnessTranscriptOpened({
        sessionId,
        binding,
        ...(forkedFrom === undefined ? {} : { forkedFrom }),
      }),
    );
  }

  load(sessionId: ProviderSessionId): NativeHarnessTranscript | undefined {
    return foldNativeHarnessTranscript(this.#replay(sessionId).events);
  }

  append(sessionId: ProviderSessionId, message: NativeHarnessTranscriptMessage): void {
    this.#append(
      sessionId,
      NATIVE_HARNESS_TRANSCRIPT_EVENT_NAMES.messageAppended,
      decodeNativeHarnessTranscriptMessageAppended({ sessionId, message }),
    );
  }

  settle(sessionId: ProviderSessionId, result: NativeHarnessTranscriptToolResult): void {
    this.#append(
      sessionId,
      NATIVE_HARNESS_TRANSCRIPT_EVENT_NAMES.toolSettled,
      decodeNativeHarnessTranscriptToolSettled({ sessionId, result }),
    );
  }

  #replay(sessionId: ProviderSessionId): {
    readonly events: ReadonlyArray<NativeHarnessTranscriptEvent>;
  } {
    const events: NativeHarnessTranscriptEvent[] = [];
    let version = 0;
    for (;;) {
      const batch = this.#journal.replayAggregate({
        aggregateType: NATIVE_HARNESS_TRANSCRIPT_AGGREGATE_TYPE,
        aggregateId: String(sessionId),
        afterVersion: version,
        limit: REPLAY_BATCH_SIZE,
      });
      for (const envelope of batch) {
        version = envelope.aggregateVersion;
        const event = decodeEvent(envelope.eventName, envelope.payload);
        if (event !== undefined) events.push(event);
      }
      if (batch.length < REPLAY_BATCH_SIZE) break;
    }
    this.#versions.set(String(sessionId), version);
    return { events };
  }

  #append(sessionId: ProviderSessionId, eventName: string, payload: unknown): void {
    if (!this.#versions.has(String(sessionId))) this.#replay(sessionId);
    const version = this.#versions.get(String(sessionId)) ?? 0;
    this.#journal.append({
      aggregate: {
        aggregateType: NATIVE_HARNESS_TRANSCRIPT_AGGREGATE_TYPE,
        aggregateId: decodeAggregateId(String(sessionId)),
      },
      expectedVersion: decodeAggregateVersion(version),
      events: [
        {
          eventId: decodeEventId(this.#uuid()),
          eventName,
          eventVersion: 1,
          correlationId: decodeCorrelationId(this.#uuid()),
          actor: this.#actor,
          occurredAt: this.#clock(),
          payload,
        },
      ],
    });
    this.#versions.set(String(sessionId), version + 1);
  }
}

function decodeEvent(
  eventName: string,
  payload: unknown,
): NativeHarnessTranscriptEvent | undefined {
  const names = NATIVE_HARNESS_TRANSCRIPT_EVENT_NAMES;
  if (eventName === names.opened) {
    const opened = decodeNativeHarnessTranscriptOpened(payload);
    return {
      kind: "opened",
      binding: opened.binding,
      ...(opened.forkedFrom === undefined ? {} : { forkedFrom: opened.forkedFrom }),
    };
  }
  if (eventName === names.messageAppended) {
    return {
      kind: "message",
      message: decodeNativeHarnessTranscriptMessageAppended(payload).message,
    };
  }
  if (eventName === names.toolSettled) {
    return { kind: "settled", result: decodeNativeHarnessTranscriptToolSettled(payload).result };
  }
  return undefined;
}
