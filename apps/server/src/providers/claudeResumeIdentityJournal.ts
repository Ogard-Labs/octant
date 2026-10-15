import {
  ActorId,
  AggregateId,
  AggregateType,
  AggregateVersion,
  CorrelationId,
  EventId,
  EventName,
  UtcTimestamp,
  decodeClaudeResumeIdentityRecorded,
  type ProviderInstanceId,
} from "@octant/contracts";
import { Schema } from "effect";
import type { PersistenceService } from "../persistence/persistenceService";
import type { ClaudeResumeIdentity } from "./claudeDriver";

const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateType = Schema.decodeUnknownSync(AggregateType);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

const AGGREGATE_TYPE = decodeAggregateType("claude-resume-identity");
const EVENT_NAME = decodeEventName("claude.resume-identity-recorded@1");
const LOCAL_ACTOR_ID = decodeActorId("00000000-0000-4000-8000-000000000002");

/**
 * Durable copy of the Claude resume identities, one journal aggregate per
 * Octant session. Without it a host restart empties the identity map and every
 * resume of an existing Claude thread, a compaction included, is refused as a
 * stale resume although the session still exists on disk.
 */
export class ClaudeResumeIdentityJournal {
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

  /** The newest record for this SDK session decides: a removal hides older identities. */
  load(input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly sdkSessionId: string;
  }): ClaudeResumeIdentity | undefined {
    const row = this.#persistence.connection
      .prepare(
        `SELECT payload_json
         FROM event_journal
         WHERE aggregate_type = ? AND event_name = ? AND event_version = 1
           AND json_extract(payload_json, '$.providerInstanceId') = ?
           AND json_extract(payload_json, '$.sdkSessionId') = ?
         ORDER BY global_sequence DESC
         LIMIT 1`,
      )
      .get(AGGREGATE_TYPE, EVENT_NAME, input.providerInstanceId, input.sdkSessionId) as
      | { readonly payload_json: string }
      | undefined;
    if (row === undefined) return undefined;
    return decodeClaudeResumeIdentityRecorded(JSON.parse(row.payload_json)).identity;
  }

  save(identity: ClaudeResumeIdentity): void {
    this.#append({
      providerInstanceId: identity.providerInstanceId,
      octantSessionId: identity.octantSessionId,
      sdkSessionId: identity.sdkSessionId,
      identity,
    });
  }

  remove(input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly sdkSessionId: string;
  }): void {
    const identity = this.load(input);
    if (identity === undefined) return;
    this.#append({
      providerInstanceId: identity.providerInstanceId,
      octantSessionId: identity.octantSessionId,
      sdkSessionId: identity.sdkSessionId,
    });
  }

  removeProvider(providerInstanceId: ProviderInstanceId): void {
    const rows = this.#persistence.connection
      .prepare(
        `SELECT payload_json
         FROM event_journal
         WHERE aggregate_type = ? AND event_name = ? AND event_version = 1
           AND json_extract(payload_json, '$.providerInstanceId') = ?
         ORDER BY global_sequence ASC`,
      )
      .all(AGGREGATE_TYPE, EVENT_NAME, providerInstanceId) as ReadonlyArray<{
      readonly payload_json: string;
    }>;
    const latest = new Map<string, ReturnType<typeof decodeClaudeResumeIdentityRecorded>>();
    for (const row of rows) {
      const record = decodeClaudeResumeIdentityRecorded(JSON.parse(row.payload_json));
      latest.set(`${record.octantSessionId}\0${record.sdkSessionId}`, record);
    }
    for (const record of latest.values()) {
      if (record.identity === undefined) continue;
      this.remove({ providerInstanceId, sdkSessionId: record.sdkSessionId });
    }
  }

  #append(payload: ReturnType<typeof decodeClaudeResumeIdentityRecorded>): void {
    const aggregateId = decodeAggregateId(payload.octantSessionId);
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
          payload,
        },
      ],
    });
  }
}
