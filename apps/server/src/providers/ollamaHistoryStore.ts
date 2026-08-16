import {
  ActorId,
  AggregateId,
  AggregateType,
  AggregateVersion,
  CorrelationId,
  EventId,
  EventName,
  UtcTimestamp,
  decodeOllamaHistoryRecorded,
  decodeOllamaHistorySnapshot,
  type OllamaHistorySnapshot,
  type ProviderSessionId,
} from "@octant/contracts";
import { Schema } from "effect";
import type { PersistenceService } from "../persistence/persistenceService";

const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateType = Schema.decodeUnknownSync(AggregateType);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

const AGGREGATE_TYPE = decodeAggregateType("ollama-session-history");
const EVENT_NAME = decodeEventName("ollama.history-recorded@1");
const LOCAL_ACTOR_ID = decodeActorId("00000000-0000-4000-8000-000000000002");

export interface OllamaHistoryStore {
  readonly load: (sessionId: ProviderSessionId) => Promise<OllamaHistorySnapshot | undefined>;
  readonly save: (snapshot: OllamaHistorySnapshot) => Promise<void>;
}

export class MemoryOllamaHistoryStore implements OllamaHistoryStore {
  readonly #snapshots = new Map<ProviderSessionId, OllamaHistorySnapshot>();

  async load(sessionId: ProviderSessionId): Promise<OllamaHistorySnapshot | undefined> {
    const snapshot = this.#snapshots.get(sessionId);
    return snapshot === undefined ? undefined : clone(snapshot);
  }

  async save(snapshot: OllamaHistorySnapshot): Promise<void> {
    this.#snapshots.set(snapshot.sessionId, clone(decodeOllamaHistorySnapshot(snapshot)));
  }
}

export class JournalOllamaHistoryStore implements OllamaHistoryStore {
  readonly #persistence: PersistenceService;
  readonly #uuid: () => string;
  readonly #clock: () => string;

  constructor(options: {
    readonly persistence: PersistenceService;
    readonly uuid: () => string;
    readonly clock: () => string;
  }) {
    this.#persistence = options.persistence;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
  }

  async load(sessionId: ProviderSessionId): Promise<OllamaHistorySnapshot | undefined> {
    const row = this.#persistence.connection
      .prepare(
        `SELECT payload_json
         FROM event_journal
         WHERE aggregate_type = ? AND aggregate_id = ?
           AND event_name = ? AND event_version = 1
         ORDER BY aggregate_version DESC
         LIMIT 1`,
      )
      .get(AGGREGATE_TYPE, sessionId, EVENT_NAME) as { readonly payload_json: string } | undefined;
    if (row === undefined) return undefined;
    return decodeOllamaHistoryRecorded(JSON.parse(row.payload_json)).snapshot;
  }

  async save(input: OllamaHistorySnapshot): Promise<void> {
    const snapshot = decodeOllamaHistorySnapshot(input);
    const aggregateId = decodeAggregateId(snapshot.sessionId);
    const head = this.#persistence.connection
      .prepare(
        `SELECT aggregate_version
         FROM aggregate_heads
         WHERE aggregate_type = ? AND aggregate_id = ?`,
      )
      .get(AGGREGATE_TYPE, aggregateId) as { readonly aggregate_version: number } | undefined;
    this.#persistence.journal.append({
      aggregate: { aggregateType: AGGREGATE_TYPE, aggregateId },
      expectedVersion: decodeAggregateVersion(head?.aggregate_version ?? 0),
      events: [
        {
          eventId: decodeEventId(this.#uuid()),
          eventName: EVENT_NAME,
          eventVersion: 1,
          correlationId: decodeCorrelationId(this.#uuid()),
          actor: { kind: "local-user", actorId: LOCAL_ACTOR_ID },
          occurredAt: decodeTimestamp(this.#clock()),
          payload: { snapshot },
        },
      ],
    });
  }
}

function clone(snapshot: OllamaHistorySnapshot): OllamaHistorySnapshot {
  return {
    ...snapshot,
    history: snapshot.history.map((message) => ({ ...message })),
  };
}
