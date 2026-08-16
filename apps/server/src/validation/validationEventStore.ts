import {
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActor,
  EventId,
  ReplayCursor,
  decodeValidationEvidenceRecord,
  decodeValidationPlan,
  decodeValidationReport,
  type ValidationEvidenceRecord,
  type ValidationPlan,
  type ValidationReport,
  type EventEnvelope,
} from "@octant/contracts";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";
import { ConcurrencyConflict } from "../persistence/journalErrors";

export const VALIDATION_PLAN_CREATED = "validation.plan-created@1";
export const VALIDATION_EVIDENCE_RECORDED = "validation.evidence-recorded@1";
export const VALIDATION_REPORT_COMPLETED = "validation.report-completed@1";
export const VALIDATION_AGGREGATE_TYPE = "validation-plan";
const JOURNAL_REPLAY_BATCH_SIZE = 1_000;

const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeReplayCursor = Schema.decodeUnknownSync(ReplayCursor);
const decodeActor = Schema.decodeUnknownSync(EventActor);

type JournalPort = Pick<Journal, "append" | "replay">;

export class ValidationEventStoreError extends Error {
  override readonly name = "ValidationEventStoreError";
  readonly category: "invalid" | "journal-mismatch";

  constructor(category: ValidationEventStoreError["category"], message: string) {
    super(message);
    this.category = category;
  }
}

export interface ValidationEventStoreOptions {
  readonly journal: JournalPort;
  readonly uuid: () => string;
  readonly actor: typeof EventActor.Type;
}

export interface AppendValidationPlanInput {
  readonly plan: ValidationPlan;
  readonly expectedVersion: number;
}

export interface AppendValidationEvidenceInput {
  readonly evidence: ValidationEvidenceRecord;
  readonly expectedVersion: number;
}

export interface AppendValidationReportInput {
  readonly report: ValidationReport;
  readonly expectedVersion: number;
}

/**
 * Server-authoritative validation event store. Appends
 * `validation.plan-created@1`, `validation.evidence-recorded@1`, and
 * `validation.report-completed@1` events to the authoritative journal. The
 * aggregate is the validation plan (`planId`); the aggregate version is the
 * plan version, backing optimistic concurrency on `expectedVersion`.
 *
 * Source references are opaque tokens — raw filesystem paths, prompt bodies,
 * file contents, credentials, and provider headers never enter event
 * payloads. Replay rebuilds validation evidence state idempotently so
 * projections can reconstruct snapshots after reconnect or restart.
 */
export class ValidationEventStore {
  readonly #journal: JournalPort;
  readonly #uuid: () => string;
  readonly #actor: typeof EventActor.Type;

  constructor(options: ValidationEventStoreOptions) {
    this.#journal = options.journal;
    this.#uuid = options.uuid;
    try {
      this.#actor = decodeActor(options.actor);
    } catch {
      throw new ValidationEventStoreError("invalid", "Validation event actor is invalid.");
    }
  }

  appendPlan(input: AppendValidationPlanInput): EventEnvelope {
    let plan: ValidationPlan;
    let aggregateId: typeof AggregateId.Type;
    let expectedVersion: typeof AggregateVersion.Type;
    let eventId: typeof EventId.Type;
    let correlationId: typeof CorrelationId.Type;
    try {
      plan = decodeValidationPlan(input.plan);
      expectedVersion = decodeAggregateVersion(input.expectedVersion);
      aggregateId = decodeAggregateId(plan.planId);
      eventId = decodeEventId(this.#uuid());
      correlationId = decodeCorrelationId(this.#uuid());
    } catch {
      throw new ValidationEventStoreError("invalid", "Validation plan append is invalid.");
    }

    let committed;
    try {
      committed = this.#journal.append({
        aggregate: { aggregateType: VALIDATION_AGGREGATE_TYPE, aggregateId },
        expectedVersion,
        events: [
          {
            eventId,
            eventName: VALIDATION_PLAN_CREATED,
            eventVersion: 1,
            correlationId,
            actor: this.#actor,
            occurredAt: plan.createdAt,
            payload: { plan },
          },
        ],
      });
    } catch (error) {
      if (error instanceof ConcurrencyConflict) {
        throw new ValidationEventStoreError(
          "invalid",
          "Validation plan expected version does not match the current head.",
        );
      }
      throw error;
    }

    const envelope = committed.events[0];
    if (
      committed.events.length !== 1 ||
      envelope === undefined ||
      envelope.aggregateType !== VALIDATION_AGGREGATE_TYPE ||
      envelope.aggregateId !== aggregateId ||
      envelope.eventName !== VALIDATION_PLAN_CREATED ||
      envelope.eventVersion !== 1
    ) {
      throw new ValidationEventStoreError(
        "journal-mismatch",
        "Committed validation plan event does not match its append.",
      );
    }
    return envelope;
  }

  appendEvidence(input: AppendValidationEvidenceInput): EventEnvelope {
    let evidence: ValidationEvidenceRecord;
    let aggregateId: typeof AggregateId.Type;
    let expectedVersion: typeof AggregateVersion.Type;
    let eventId: typeof EventId.Type;
    let correlationId: typeof CorrelationId.Type;
    try {
      evidence = decodeValidationEvidenceRecord(input.evidence);
      expectedVersion = decodeAggregateVersion(input.expectedVersion);
      aggregateId = decodeAggregateId(evidence.planId);
      eventId = decodeEventId(this.#uuid());
      correlationId = decodeCorrelationId(this.#uuid());
    } catch {
      throw new ValidationEventStoreError("invalid", "Validation evidence append is invalid.");
    }

    let committed;
    try {
      committed = this.#journal.append({
        aggregate: { aggregateType: VALIDATION_AGGREGATE_TYPE, aggregateId },
        expectedVersion,
        events: [
          {
            eventId,
            eventName: VALIDATION_EVIDENCE_RECORDED,
            eventVersion: 1,
            correlationId,
            ...(evidence.source.correlationId !== undefined
              ? { causationId: evidence.source.correlationId }
              : {}),
            actor: this.#actor,
            occurredAt: evidence.observedAt,
            payload: { evidence },
          },
        ],
      });
    } catch (error) {
      if (error instanceof ConcurrencyConflict) {
        throw new ValidationEventStoreError(
          "invalid",
          "Validation evidence expected version does not match the current head.",
        );
      }
      throw error;
    }

    const envelope = committed.events[0];
    if (
      committed.events.length !== 1 ||
      envelope === undefined ||
      envelope.aggregateType !== VALIDATION_AGGREGATE_TYPE ||
      envelope.aggregateId !== aggregateId ||
      envelope.eventName !== VALIDATION_EVIDENCE_RECORDED ||
      envelope.eventVersion !== 1
    ) {
      throw new ValidationEventStoreError(
        "journal-mismatch",
        "Committed validation evidence event does not match its append.",
      );
    }
    return envelope;
  }

  appendReport(input: AppendValidationReportInput): EventEnvelope {
    let report: ValidationReport;
    let aggregateId: typeof AggregateId.Type;
    let expectedVersion: typeof AggregateVersion.Type;
    let eventId: typeof EventId.Type;
    let correlationId: typeof CorrelationId.Type;
    try {
      report = decodeValidationReport(input.report);
      expectedVersion = decodeAggregateVersion(input.expectedVersion);
      aggregateId = decodeAggregateId(report.planId);
      eventId = decodeEventId(this.#uuid());
      correlationId = decodeCorrelationId(this.#uuid());
    } catch {
      throw new ValidationEventStoreError("invalid", "Validation report append is invalid.");
    }

    let committed;
    try {
      committed = this.#journal.append({
        aggregate: { aggregateType: VALIDATION_AGGREGATE_TYPE, aggregateId },
        expectedVersion,
        events: [
          {
            eventId,
            eventName: VALIDATION_REPORT_COMPLETED,
            eventVersion: 1,
            correlationId,
            actor: this.#actor,
            occurredAt: report.completedAt,
            payload: { report },
          },
        ],
      });
    } catch (error) {
      if (error instanceof ConcurrencyConflict) {
        throw new ValidationEventStoreError(
          "invalid",
          "Validation report expected version does not match the current head.",
        );
      }
      throw error;
    }

    const envelope = committed.events[0];
    if (
      committed.events.length !== 1 ||
      envelope === undefined ||
      envelope.aggregateType !== VALIDATION_AGGREGATE_TYPE ||
      envelope.aggregateId !== aggregateId ||
      envelope.eventName !== VALIDATION_REPORT_COMPLETED ||
      envelope.eventVersion !== 1
    ) {
      throw new ValidationEventStoreError(
        "journal-mismatch",
        "Committed validation report event does not match its append.",
      );
    }
    return envelope;
  }

  /**
   * Replays all validation events across every plan from the authoritative
   * journal, in global sequence order. Used to hydrate the projection after
   * restart or reconnect. Returns events whose aggregate type is
   * `validation-plan`.
   */
  replayAll(): ReadonlyArray<EventEnvelope> {
    const events: Array<EventEnvelope> = [];
    let afterSequence = 0;
    for (;;) {
      const batch = this.#journal.replay(
        decodeReplayCursor({ afterSequence, limit: JOURNAL_REPLAY_BATCH_SIZE }),
      );
      if (batch.length === 0) break;
      for (const envelope of batch) {
        afterSequence = envelope.globalSequence;
        if (envelope.aggregateType !== VALIDATION_AGGREGATE_TYPE) continue;
        events.push(envelope);
      }
      if (batch.length < JOURNAL_REPLAY_BATCH_SIZE) break;
    }
    return events;
  }
}
