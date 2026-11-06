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
} from "@octant/contracts";
import {
  ProviderCloudJob,
  PROVIDER_CLOUD_USAGE_AGGREGATE_TYPE,
  decodeProviderCloudJob,
  type ProviderCloudJob as Job,
} from "@octant/contracts/provider-cloud-sessions";
import type { EventRegistry } from "../persistence/eventRegistry";
import type { Journal } from "../persistence/journal";
import type { SqliteConnection } from "../persistence/sqlitePort";

export const PROVIDER_CLOUD_JOB_AGGREGATE = "provider-cloud-session";
const JOB_CHANGED = "provider-cloud.job-changed@1";
const OPT_IN_CHANGED = "provider-cloud.opt-in-changed@1";
const strict = { parseOptions: { onExcessProperty: "error" as const } };
const JobChanged = Schema.Struct({
  threadId: ProviderCloudJob.fields.threadId,
  job: ProviderCloudJob,
}).annotations(strict);
const OptInChanged = Schema.Struct({
  instanceId: ProviderCloudJob.fields.instanceId,
  enabled: Schema.Boolean,
}).annotations(strict);
const Row = Schema.Struct({ payload_json: Schema.String, aggregate_version: Schema.Number });
const rows = Schema.decodeUnknownSync(Schema.Array(Row));

export function registerProviderCloudSessionEvents(events: EventRegistry): void {
  events.register(JOB_CHANGED, 1, JobChanged);
  events.register(OPT_IN_CHANGED, 1, OptInChanged);
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
    return Schema.decodeUnknownSync(OptInChanged)(JSON.parse(row.payload_json)).enabled;
  }

  setEnabled(instanceId: Job["instanceId"], enabled: boolean): void {
    this.#append("provider-cloud-opt-in", instanceId, OPT_IN_CHANGED, { instanceId, enabled });
  }

  get(id: string): Job | undefined {
    const row = this.#latest(PROVIDER_CLOUD_JOB_AGGREGATE, id);
    return row === undefined
      ? undefined
      : Schema.decodeUnknownSync(JobChanged)(JSON.parse(row.payload_json)).job;
  }

  list(threadId?: string): ReadonlyArray<Job> {
    const result = rows(
      this.#connection
        .prepare(`
      SELECT payload_json, aggregate_version FROM (
        SELECT payload_json, aggregate_version, global_sequence,
          row_number() OVER (PARTITION BY aggregate_id ORDER BY aggregate_version DESC) AS rank
        FROM event_journal WHERE aggregate_type = ?
          AND (? IS NULL OR json_extract(payload_json, '$.threadId') = ?)
      ) WHERE rank = 1 ORDER BY global_sequence DESC LIMIT 100
    `)
        .all(PROVIDER_CLOUD_JOB_AGGREGATE, threadId ?? null, threadId ?? null),
    );
    return result.map(
      (row) => Schema.decodeUnknownSync(JobChanged)(JSON.parse(row.payload_json)).job,
    );
  }

  active(): ReadonlyArray<Job> {
    return rows(
      this.#connection
        .prepare(`SELECT payload_json, aggregate_version FROM (
      SELECT payload_json, aggregate_version,
        row_number() OVER (PARTITION BY aggregate_id ORDER BY aggregate_version DESC) AS rank
      FROM event_journal WHERE aggregate_type = ?
    ) WHERE rank = 1 AND json_extract(payload_json, '$.job.state') NOT IN
      ('completed', 'failed', 'cancelled', 'unavailable')
      AND NOT (json_extract(payload_json, '$.job.state') = 'submission-uncertain'
        AND json_extract(payload_json, '$.job.uncertaintyAcknowledgedAt') IS NOT NULL)
      LIMIT 100`)
        .all(PROVIDER_CLOUD_JOB_AGGREGATE),
    ).map((row) => Schema.decodeUnknownSync(JobChanged)(JSON.parse(row.payload_json)).job);
  }

  put(input: Job): Job {
    const job = decodeProviderCloudJob({
      ...input,
      version: (this.#latest(PROVIDER_CLOUD_JOB_AGGREGATE, input.id)?.aggregate_version ?? 0) + 1,
    });
    this.#append(PROVIDER_CLOUD_JOB_AGGREGATE, job.id, JOB_CHANGED, {
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
      .prepare(`SELECT payload_json, aggregate_version FROM event_journal
      WHERE aggregate_type = ? AND aggregate_id = ? ORDER BY aggregate_version DESC LIMIT 1`)
      .get(type, id);
    return row === undefined ? undefined : Schema.decodeUnknownSync(Row)(row);
  }

  #append(type: string, id: string, name: string, payload: unknown, correlationId?: string): void {
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
          actor: Schema.decodeUnknownSync(EventActor)({
            kind: "system",
            actorId: "00000000-0000-4000-8000-000000000001",
          }),
          occurredAt: decodeUtcTimestamp(this.#now()),
          payload,
        },
      ],
    });
  }
}
