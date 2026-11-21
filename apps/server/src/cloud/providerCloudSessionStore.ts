import { randomUUID } from "node:crypto";
import { Schema } from "effect";
import {
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActor,
  EventId,
  PROVIDER_CLOUD_TURN_REQUEST_SHAPE,
  decodeUtcTimestamp,
  type EventActor as EventActorValue,
} from "@octant/contracts";
import {
  PROVIDER_CLOUD_EVENT_NAMES,
  PROVIDER_CLOUD_EVENT_NAMES_V2,
  PROVIDER_CLOUD_USAGE_AGGREGATE_TYPE,
  ProviderCloudJobChangedV1Payload,
  ProviderCloudJobChangedV2Payload,
  ProviderCloudOptInChangedV1Payload,
  ProviderCloudOptInChangedV2Payload,
  decodeProviderCloudJob,
  decodeProviderCloudJobChangedV1Payload,
  decodeProviderCloudJobChangedV2Payload,
  decodeProviderCloudOptInChangedV1Payload,
  decodeProviderCloudOptInChangedV2Payload,
  type ProviderCloudJob as Job,
} from "@octant/contracts/provider-cloud-sessions";
import type { EventRegistry } from "../persistence/eventRegistry";
import type { Journal } from "../persistence/journal";
import type { SqliteConnection } from "../persistence/sqlitePort";

export const PROVIDER_CLOUD_JOB_AGGREGATE = "provider-cloud-session";
const SYSTEM_ACTOR: EventActorValue = Schema.decodeUnknownSync(EventActor)({
  kind: "system",
  actorId: "00000000-0000-4000-8000-000000000001",
});

/**
 * Who initiated a person's cloud-job act. Absent (or local-window) writes v1
 * so journals no paired device touched stay readable by older builds; a
 * person-paired device writes v2 with its credential generation and remote-device
 * envelope actor so an older build never reads a device's act as a window's.
 */
export type ProviderCloudEventRecordPrincipal =
  | { readonly kind: "local-window" }
  | {
      readonly kind: "person-paired-device";
      readonly credentialGeneration: number;
      readonly actor: EventActorValue;
    };

const Row = Schema.Struct({
  event_name: Schema.String,
  payload_json: Schema.String,
  aggregate_version: Schema.Number,
});
const rows = Schema.decodeUnknownSync(Schema.Array(Row));

export function registerProviderCloudSessionEvents(events: EventRegistry): void {
  events.register(PROVIDER_CLOUD_EVENT_NAMES.jobChanged, 1, ProviderCloudJobChangedV1Payload);
  events.register(PROVIDER_CLOUD_EVENT_NAMES_V2.jobChanged, 1, ProviderCloudJobChangedV2Payload);
  events.register(PROVIDER_CLOUD_EVENT_NAMES.optInChanged, 1, ProviderCloudOptInChangedV1Payload);
  events.register(
    PROVIDER_CLOUD_EVENT_NAMES_V2.optInChanged,
    1,
    ProviderCloudOptInChangedV2Payload,
  );
}

function decodeJobRow(row: typeof Row.Type): Job {
  const parsed: unknown = JSON.parse(row.payload_json);
  return row.event_name === PROVIDER_CLOUD_EVENT_NAMES_V2.jobChanged
    ? decodeProviderCloudJobChangedV2Payload(parsed).job
    : decodeProviderCloudJobChangedV1Payload(parsed).job;
}

function decodeOptInRow(row: typeof Row.Type): boolean {
  const parsed: unknown = JSON.parse(row.payload_json);
  return row.event_name === PROVIDER_CLOUD_EVENT_NAMES_V2.optInChanged
    ? decodeProviderCloudOptInChangedV2Payload(parsed).enabled
    : decodeProviderCloudOptInChangedV1Payload(parsed).enabled;
}

/** The journal is the only durable state; reads cannot replay a remote submission. */
export class ProviderCloudSessionStore {
  readonly #connection: SqliteConnection;
  readonly #journal: Pick<Journal, "append">;
  readonly #now: () => string;

  constructor(input: {
    readonly connection: SqliteConnection;
    readonly journal: Pick<Journal, "append">;
    readonly now: () => string;
  }) {
    this.#connection = input.connection;
    this.#journal = input.journal;
    this.#now = input.now;
  }

  enabled(instanceId: string): boolean {
    const row = this.#latest("provider-cloud-opt-in", instanceId);
    if (row === undefined) return false;
    return decodeOptInRow(row);
  }

  setEnabled(
    instanceId: Job["instanceId"],
    enabled: boolean,
    person?: ProviderCloudEventRecordPrincipal,
  ): void {
    if (person?.kind === "person-paired-device") {
      this.#append(
        "provider-cloud-opt-in",
        instanceId,
        PROVIDER_CLOUD_EVENT_NAMES_V2.optInChanged,
        {
          instanceId,
          enabled,
          principal: {
            kind: "person-paired-device",
            credentialGeneration: person.credentialGeneration,
          },
        },
        undefined,
        person.actor,
      );
      return;
    }
    this.#append("provider-cloud-opt-in", instanceId, PROVIDER_CLOUD_EVENT_NAMES.optInChanged, {
      instanceId,
      enabled,
    });
  }

  get(id: string): Job | undefined {
    const row = this.#latest(PROVIDER_CLOUD_JOB_AGGREGATE, id);
    return row === undefined ? undefined : decodeJobRow(row);
  }

  list(threadId?: string): ReadonlyArray<Job> {
    const result = rows(
      this.#connection
        .prepare(`
      SELECT event_name, payload_json, aggregate_version FROM (
        SELECT event_name, payload_json, aggregate_version, global_sequence,
          row_number() OVER (PARTITION BY aggregate_id ORDER BY aggregate_version DESC) AS rank
        FROM event_journal WHERE aggregate_type = ?
          AND (? IS NULL OR json_extract(payload_json, '$.threadId') = ?)
      ) WHERE rank = 1 ORDER BY global_sequence DESC LIMIT 100
    `)
        .all(PROVIDER_CLOUD_JOB_AGGREGATE, threadId ?? null, threadId ?? null),
    );
    return result.map(decodeJobRow);
  }

  active(): ReadonlyArray<Job> {
    return rows(
      this.#connection
        .prepare(`SELECT event_name, payload_json, aggregate_version FROM (
      SELECT event_name, payload_json, aggregate_version,
        row_number() OVER (PARTITION BY aggregate_id ORDER BY aggregate_version DESC) AS rank
      FROM event_journal WHERE aggregate_type = ?
    ) WHERE rank = 1 AND json_extract(payload_json, '$.job.state') NOT IN
      ('completed', 'failed', 'cancelled', 'unavailable')
      AND NOT (json_extract(payload_json, '$.job.state') = 'submission-uncertain'
        AND json_extract(payload_json, '$.job.uncertaintyAcknowledgedAt') IS NOT NULL)
      LIMIT 100`)
        .all(PROVIDER_CLOUD_JOB_AGGREGATE),
    ).map(decodeJobRow);
  }

  put(input: Job, person?: ProviderCloudEventRecordPrincipal): Job {
    const job = decodeProviderCloudJob({
      ...input,
      version: (this.#latest(PROVIDER_CLOUD_JOB_AGGREGATE, input.id)?.aggregate_version ?? 0) + 1,
    });
    if (person?.kind === "person-paired-device") {
      this.#append(
        PROVIDER_CLOUD_JOB_AGGREGATE,
        job.id,
        PROVIDER_CLOUD_EVENT_NAMES_V2.jobChanged,
        {
          threadId: job.threadId,
          job,
          principal: {
            kind: "person-paired-device",
            credentialGeneration: person.credentialGeneration,
          },
        },
        undefined,
        person.actor,
      );
      return job;
    }
    this.#append(PROVIDER_CLOUD_JOB_AGGREGATE, job.id, PROVIDER_CLOUD_EVENT_NAMES.jobChanged, {
      threadId: job.threadId,
      job,
    });
    return job;
  }

  recordCreateDispatch(job: Job): void {
    if (this.hasCreateDispatch(job.id)) return;
    this.#append(
      PROVIDER_CLOUD_USAGE_AGGREGATE_TYPE,
      job.threadId,
      "context.usage-reconciled@1",
      {
        reconciliation: {
          id: randomUUID(),
          providerInstanceId: job.instanceId,
          modelId: job.modelId,
          requestShape: PROVIDER_CLOUD_TURN_REQUEST_SHAPE,
          plannedInputTokens: 0,
          actualInputTokens: 0,
          actualOutputTokens: 0,
          varianceTokens: 0,
          providerReported: false,
          observedAt: decodeUtcTimestamp(this.#now()),
        },
      },
      job.id,
    );
  }

  hasCreateDispatch(jobId: string): boolean {
    return (
      this.#connection
        .prepare(`SELECT 1 FROM event_journal WHERE aggregate_type = ?
      AND event_name = 'context.usage-reconciled@1' AND correlation_id = ? LIMIT 1`)
        .get(PROVIDER_CLOUD_USAGE_AGGREGATE_TYPE, jobId) !== undefined
    );
  }

  #latest(type: string, id: string): typeof Row.Type | undefined {
    const row = this.#connection
      .prepare(`SELECT event_name, payload_json, aggregate_version FROM event_journal
      WHERE aggregate_type = ? AND aggregate_id = ? ORDER BY aggregate_version DESC LIMIT 1`)
      .get(type, id);
    return row === undefined ? undefined : Schema.decodeUnknownSync(Row)(row);
  }

  #append(
    type: string,
    id: string,
    name: string,
    payload: unknown,
    correlationId?: string,
    actor: EventActorValue = SYSTEM_ACTOR,
  ): void {
    const version = this.#latest(type, id)?.aggregate_version ?? 0;
    this.#journal.append({
      aggregate: { aggregateType: type, aggregateId: Schema.decodeUnknownSync(AggregateId)(id) },
      expectedVersion: Schema.decodeUnknownSync(AggregateVersion)(version),
      events: [
        {
          eventId: Schema.decodeUnknownSync(EventId)(randomUUID()),
          eventName: name,
          eventVersion: 1,
          correlationId: Schema.decodeUnknownSync(CorrelationId)(correlationId ?? randomUUID()),
          actor: Schema.decodeUnknownSync(EventActor)(actor),
          occurredAt: decodeUtcTimestamp(this.#now()),
          payload,
        },
      ],
    });
  }
}
