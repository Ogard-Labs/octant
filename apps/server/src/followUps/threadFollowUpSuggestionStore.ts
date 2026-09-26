import {
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActor,
  EventId,
  NATIVE_HARNESS_SESSION_AGGREGATE_TYPE,
  NATIVE_HARNESS_SESSION_EVENT_NAMES,
  THREAD_FOLLOW_UP_SUGGESTIONS_AGGREGATE_TYPE,
  THREAD_FOLLOW_UP_SUGGESTION_EVENT_NAMES,
  ThreadFollowUpActivated,
  ThreadFollowUpsSuggested,
  decodeNativeHarnessSession,
  decodeNativeHarnessTurnId,
  decodeThreadFollowUpSuggestions,
  decodeThreadFollowUpsSuggested,
  type FollowUpSuggestedBy,
  type NativeHarnessFollowUpCreation,
  type NativeHarnessFollowUpId,
  type NativeHarnessFollowUpSet,
  type OctantMode,
  type ProjectId,
  type ThreadFollowUpSuggestions,
} from "@octant/contracts";
import { Schema } from "effect";
import type { EventRegistry } from "../persistence/eventRegistry";
import type { Journal } from "../persistence/journal";

const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const JOURNAL_REPLAY_BATCH_SIZE = 1_000;

type JournalPort = Pick<Journal, "append" | "replay">;

export function registerFollowUpSuggestionEvents(registry: EventRegistry): EventRegistry {
  return registry
    .register(THREAD_FOLLOW_UP_SUGGESTION_EVENT_NAMES.suggested, 1, ThreadFollowUpsSuggested)
    .register(THREAD_FOLLOW_UP_SUGGESTION_EVENT_NAMES.activated, 1, ThreadFollowUpActivated);
}

interface SuggestionRecord {
  current: ThreadFollowUpsSuggested;
  activated: NativeHarnessFollowUpId[];
  /** What each activation created, so a retried confirmation gets the same answer. */
  created: Map<string, NativeHarnessFollowUpCreation>;
  /** Frames on this thread's own aggregate; harness frames replayed below do not count. */
  version: number;
}

/**
 * The latest reply's follow-up suggestions on each thread, rebuilt from the
 * journal. Suggestions a harness session journaled before they belonged to
 * every provider are read from those frames too, so a harness thread keeps
 * the offer it had.
 */
export class ThreadFollowUpSuggestionStore {
  readonly #journal: JournalPort;
  readonly #uuid: () => string;
  readonly #actor: typeof EventActor.Type;
  readonly #clock: () => string;
  readonly #records = new Map<string, SuggestionRecord>();

  constructor(options: {
    readonly journal: JournalPort;
    readonly uuid: () => string;
    readonly actor: typeof EventActor.Type;
    readonly clock: () => string;
  }) {
    this.#journal = options.journal;
    this.#uuid = options.uuid;
    this.#actor = decodeActor(options.actor);
    this.#clock = options.clock;
    this.#hydrate();
  }

  /** What activating this suggestion of the current set created, if it was activated. */
  activation(threadId: string, suggestionId: string): NativeHarnessFollowUpCreation | undefined {
    return this.#records.get(threadId)?.created.get(suggestionId);
  }

  read(threadId: string): ThreadFollowUpSuggestions | undefined {
    const record = this.#records.get(threadId);
    if (record === undefined) return undefined;
    return decodeThreadFollowUpSuggestions({
      ...record.current,
      activatedFollowUpIds: record.activated,
    });
  }

  /**
   * What a completed reply offered. A reply without suggestions retires the
   * previous offer, which otherwise would sit over the composer long after
   * the conversation moved on; a thread that never had one writes nothing.
   */
  recordReply(input: {
    readonly threadId: string;
    readonly mode: OctantMode;
    readonly projectId?: ProjectId | undefined;
    readonly suggestedBy: FollowUpSuggestedBy;
    readonly followUps: NativeHarnessFollowUpSet | undefined;
  }): void {
    const record = this.#records.get(input.threadId);
    if (input.followUps === undefined) {
      const open = record?.current.followUps.suggestions.some(
        (suggestion) => !record.activated.includes(suggestion.id),
      );
      if (open !== true) return;
    }
    const suggested = decodeThreadFollowUpsSuggested({
      threadId: input.threadId,
      mode: input.mode,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      suggestedBy: {
        providerInstanceId: input.suggestedBy.providerInstanceId,
        modelId: input.suggestedBy.modelId,
      },
      followUps: input.followUps ?? {
        turnId: decodeNativeHarnessTurnId(this.#uuid()),
        suggestions: [],
      },
    });
    const version = record?.version ?? 0;
    this.#append(
      input.threadId,
      version,
      THREAD_FOLLOW_UP_SUGGESTION_EVENT_NAMES.suggested,
      suggested,
    );
    this.#records.set(input.threadId, {
      current: suggested,
      activated: [],
      created: new Map(),
      version: version + 1,
    });
  }

  activate(
    threadId: string,
    suggestionId: NativeHarnessFollowUpId,
    created: NativeHarnessFollowUpCreation,
  ): "activated" | "suggestion-not-found" | "already-activated" {
    const record = this.#records.get(threadId);
    const suggestion = record?.current.followUps.suggestions.find(
      (entry) => String(entry.id) === String(suggestionId),
    );
    if (record === undefined || suggestion === undefined) return "suggestion-not-found";
    if (record.activated.some((id) => String(id) === String(suggestionId)))
      return "already-activated";
    this.#append(threadId, record.version, THREAD_FOLLOW_UP_SUGGESTION_EVENT_NAMES.activated, {
      suggestionId,
      created,
    });
    record.version += 1;
    record.activated.push(suggestion.id);
    record.created.set(String(suggestion.id), created);
    return "activated";
  }

  #append(threadId: string, version: number, eventName: string, payload: unknown): void {
    this.#journal.append({
      aggregate: {
        aggregateType: THREAD_FOLLOW_UP_SUGGESTIONS_AGGREGATE_TYPE,
        aggregateId: decodeAggregateId(threadId),
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
  }

  #hydrate(): void {
    const harnessOrigins = new Map<
      string,
      Pick<ThreadFollowUpSuggestions, "mode" | "projectId" | "suggestedBy">
    >();
    let afterSequence = 0;
    for (;;) {
      const batch = this.#journal.replay({
        afterSequence: afterSequence as never,
        limit: JOURNAL_REPLAY_BATCH_SIZE,
      });
      if (batch.length === 0) break;
      for (const envelope of batch) {
        afterSequence = envelope.globalSequence;
        const threadId = String(envelope.aggregateId);
        if (envelope.aggregateType === THREAD_FOLLOW_UP_SUGGESTIONS_AGGREGATE_TYPE) {
          this.#apply(threadId, envelope.eventName, envelope.payload);
        } else if (envelope.aggregateType === NATIVE_HARNESS_SESSION_AGGREGATE_TYPE) {
          this.#applyHarnessFrame(harnessOrigins, threadId, envelope.eventName, envelope.payload);
        }
      }
      if (batch.length < JOURNAL_REPLAY_BATCH_SIZE) break;
    }
  }

  #apply(threadId: string, eventName: string, payload: unknown): void {
    const record = this.#records.get(threadId);
    if (eventName === THREAD_FOLLOW_UP_SUGGESTION_EVENT_NAMES.suggested) {
      this.#records.set(threadId, {
        current: payload as ThreadFollowUpsSuggested,
        activated: [],
        created: new Map(),
        version: (record?.version ?? 0) + 1,
      });
    } else if (
      eventName === THREAD_FOLLOW_UP_SUGGESTION_EVENT_NAMES.activated &&
      record !== undefined
    ) {
      record.version += 1;
      applyActivation(record, payload);
    }
  }

  #applyHarnessFrame(
    origins: Map<string, Pick<ThreadFollowUpSuggestions, "mode" | "projectId" | "suggestedBy">>,
    threadId: string,
    eventName: string,
    payload: unknown,
  ): void {
    const names = NATIVE_HARNESS_SESSION_EVENT_NAMES;
    if (eventName === names.started) {
      const session = decodeNativeHarnessSession(payload);
      origins.set(threadId, {
        mode: session.mode,
        ...(session.projectId === undefined ? {} : { projectId: session.projectId }),
        suggestedBy: {
          providerInstanceId: session.lead.providerInstanceId,
          modelId: session.lead.modelId,
        },
      });
      return;
    }
    const origin = origins.get(threadId);
    if (origin === undefined) return;
    if (eventName === names.followUpsSuggested) {
      const version = this.#records.get(threadId)?.version ?? 0;
      this.#records.set(threadId, {
        current: { threadId, ...origin, followUps: payload as NativeHarnessFollowUpSet },
        activated: [],
        created: new Map(),
        version,
      });
    } else if (eventName === names.followUpActivated) {
      const record = this.#records.get(threadId);
      if (record !== undefined) applyActivation(record, payload);
    }
  }
}

function applyActivation(record: SuggestionRecord, payload: unknown): void {
  const activation = payload as {
    readonly suggestionId: NativeHarnessFollowUpId;
    readonly created: NativeHarnessFollowUpCreation;
  };
  record.activated.push(activation.suggestionId);
  record.created.set(String(activation.suggestionId), activation.created);
}
