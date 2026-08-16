import {
  AggregateId,
  AggregateVersion,
  AutomationBlocked,
  AutomationCancellationTombstone as AutomationCancellationTombstoneSchema,
  AutomationDefinitionCreated,
  AutomationDefinitionExhausted,
  AutomationDefinitionLifecycleChanged,
  AutomationDefinitionUpdated,
  AutomationDispatchIntentRecorded,
  AutomationFirstTurnAccepted,
  AutomationFirstTurnDispatchCancelled,
  AutomationFirstTurnRuntimeClaimed,
  AutomationOccurrenceClaimed,
  AutomationOccurrenceSkipped,
  AutomationRunCreated,
  AutomationRunStatusChanged,
  AutomationNotificationRefRecorded,
  CorrelationId,
  EventActor,
  ReplayCursor,
  EventId,
  deriveAutomationOccurrenceKey,
  type AutomationBlockReason,
  type AutomationCancellationTombstone,
  type AutomationDefinition,
  type AutomationDispatchIntent,
  type AutomationFirstTurnAcceptanceReceipt,
  type AutomationId,
  type AutomationLifecycle,
  type AutomationOccurrence,
  type AutomationRun,
  type AutomationRunFailure,
  type AutomationRunId,
  type AutomationRunLifecycle,
  type AutomationRuntimeLaunchClaim,
  type AutomationScheduledOccurrence,
  type EventEnvelope,
  type UtcTimestamp,
} from "@octant/contracts";
import { Schema } from "effect";
import type { EventRegistry } from "../persistence/eventRegistry";
import type { Journal } from "../persistence/journal";
import { ConcurrencyConflict, DuplicateEventIdentity } from "../persistence/journalErrors";

export const AUTOMATION_DEFINITION_AGGREGATE_TYPE = "automation-definition";
export const AUTOMATION_RUN_AGGREGATE_TYPE = "automation-run";

export const AUTOMATION_DEFINITION_CREATED = "automation-definition-created@1";
export const AUTOMATION_DEFINITION_UPDATED = "automation-definition-updated@1";
export const AUTOMATION_DEFINITION_LIFECYCLE_CHANGED = "automation-definition-lifecycle-changed@1";
export const AUTOMATION_DEFINITION_EXHAUSTED = "automation-definition-exhausted@1";
export const AUTOMATION_OCCURRENCE_CLAIMED = "automation-occurrence-claimed@1";
export const AUTOMATION_OCCURRENCE_SKIPPED = "automation-occurrence-skipped@1";
export const AUTOMATION_RUN_CREATED = "automation-run-created@1";
export const AUTOMATION_RUN_STATUS_CHANGED = "automation-run-status-changed@1";
export const AUTOMATION_BLOCKED = "automation-blocked@1";
export const AUTOMATION_DISPATCH_INTENT_RECORDED = "automation-dispatch-intent-recorded@1";
export const AUTOMATION_FIRST_TURN_RUNTIME_CLAIMED = "automation-first-turn-runtime-claimed@1";
export const AUTOMATION_FIRST_TURN_DISPATCH_CANCELLED =
  "automation-first-turn-dispatch-cancelled@1";
export const AUTOMATION_FIRST_TURN_ACCEPTED = "automation-first-turn-accepted@1";
export const AUTOMATION_NOTIFICATION_REF_RECORDED = "automation-notification-ref-recorded@1";

const JOURNAL_REPLAY_BATCH_SIZE = 1_000;
const MAX_JOURNAL_SCAN_EVENTS = 100_000;

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeReplayCursor = Schema.decodeUnknownSync(ReplayCursor);
const decodeDefinitionCreated = Schema.decodeUnknownSync(AutomationDefinitionCreated);
const decodeDefinitionUpdated = Schema.decodeUnknownSync(AutomationDefinitionUpdated);
const decodeDefinitionLifecycleChanged = Schema.decodeUnknownSync(
  AutomationDefinitionLifecycleChanged,
);
const decodeRunCreated = Schema.decodeUnknownSync(AutomationRunCreated);
const decodeRunStatusChanged = Schema.decodeUnknownSync(AutomationRunStatusChanged);
const decodeCancellationTombstone = Schema.decodeUnknownSync(AutomationCancellationTombstoneSchema);
const decodeDispatchCancelled = Schema.decodeUnknownSync(AutomationFirstTurnDispatchCancelled);
const decodeOccurrenceClaimed = Schema.decodeUnknownSync(AutomationOccurrenceClaimed);
const decodeOccurrenceSkipped = Schema.decodeUnknownSync(AutomationOccurrenceSkipped);
const decodeBlocked = Schema.decodeUnknownSync(AutomationBlocked);
const decodeDefinitionExhausted = Schema.decodeUnknownSync(AutomationDefinitionExhausted);
const decodeDispatchIntentRecorded = Schema.decodeUnknownSync(AutomationDispatchIntentRecorded);
const decodeFirstTurnRuntimeClaimed = Schema.decodeUnknownSync(AutomationFirstTurnRuntimeClaimed);
const decodeFirstTurnAccepted = Schema.decodeUnknownSync(AutomationFirstTurnAccepted);
const decodeNotificationRefRecorded = Schema.decodeUnknownSync(AutomationNotificationRefRecorded);

/**
 * Register every Automation journal event so append-time and replay decoding
 * use the strict A1 contracts. Shared by the runtime registry and tests.
 */
export function registerAutomationEvents(registry: EventRegistry): EventRegistry {
  return registry
    .register(AUTOMATION_DEFINITION_CREATED, 1, AutomationDefinitionCreated)
    .register(AUTOMATION_DEFINITION_UPDATED, 1, AutomationDefinitionUpdated)
    .register(AUTOMATION_DEFINITION_LIFECYCLE_CHANGED, 1, AutomationDefinitionLifecycleChanged)
    .register(AUTOMATION_DEFINITION_EXHAUSTED, 1, AutomationDefinitionExhausted)
    .register(AUTOMATION_OCCURRENCE_CLAIMED, 1, AutomationOccurrenceClaimed)
    .register(AUTOMATION_OCCURRENCE_SKIPPED, 1, AutomationOccurrenceSkipped)
    .register(AUTOMATION_RUN_CREATED, 1, AutomationRunCreated)
    .register(AUTOMATION_RUN_STATUS_CHANGED, 1, AutomationRunStatusChanged)
    .register(AUTOMATION_BLOCKED, 1, AutomationBlocked)
    .register(AUTOMATION_DISPATCH_INTENT_RECORDED, 1, AutomationDispatchIntentRecorded)
    .register(AUTOMATION_FIRST_TURN_RUNTIME_CLAIMED, 1, AutomationFirstTurnRuntimeClaimed)
    .register(AUTOMATION_FIRST_TURN_DISPATCH_CANCELLED, 1, AutomationFirstTurnDispatchCancelled)
    .register(AUTOMATION_FIRST_TURN_ACCEPTED, 1, AutomationFirstTurnAccepted)
    .register(AUTOMATION_NOTIFICATION_REF_RECORDED, 1, AutomationNotificationRefRecorded);
}

type JournalPort = Pick<Journal, "append" | "replay">;

export class AutomationEventStoreError extends Error {
  override readonly name = "AutomationEventStoreError";
  readonly category: "invalid" | "conflict" | "journal-mismatch";

  constructor(category: AutomationEventStoreError["category"], message: string) {
    super(message);
    this.category = category;
  }
}

export interface AutomationEventStoreOptions {
  readonly journal: JournalPort;
  readonly uuid: () => string;
  readonly actor: typeof EventActor.Type;
}

export interface AppendAutomationDefinitionCreatedInput {
  readonly automation: AutomationDefinition;
}

export interface AppendAutomationDefinitionUpdatedInput {
  readonly automation: AutomationDefinition;
  readonly previousDefinitionRevision: number;
  readonly expectedVersion: number;
}

export interface AppendAutomationDefinitionLifecycleChangedInput {
  readonly automation: AutomationDefinition;
  readonly previousLifecycle: AutomationLifecycle;
  readonly expectedVersion: number;
}

export interface AppendAutomationRunCreatedInput {
  readonly run: AutomationRun;
}

export interface AppendAutomationRunStatusChangedInput {
  readonly automationId: AutomationId;
  readonly runId: AutomationRunId;
  readonly previousLifecycle: AutomationRunLifecycle;
  readonly lifecycle: AutomationRunLifecycle;
  readonly version: number;
  readonly expectedVersion: number;
  readonly failure?: AutomationRunFailure;
  readonly updatedAt: UtcTimestamp;
}

export interface AppendAutomationRunCancellationInput {
  readonly automationId: AutomationId;
  readonly runId: AutomationRunId;
  readonly previousLifecycle: AutomationRunLifecycle;
  readonly tombstone: AutomationCancellationTombstone;
  readonly expectedVersion: number;
  readonly updatedAt: UtcTimestamp;
}

export interface AppendAutomationDispatchIntentInput {
  readonly automationId: AutomationId;
  readonly runId: AutomationRunId;
  readonly intent: AutomationDispatchIntent;
  readonly expectedVersion: number;
}

export interface AppendAutomationFirstTurnRuntimeClaimedInput {
  readonly automationId: AutomationId;
  readonly runId: AutomationRunId;
  readonly claim: AutomationRuntimeLaunchClaim;
  readonly expectedVersion: number;
}

export interface AppendAutomationFirstTurnAcceptedInput {
  readonly automationId: AutomationId;
  readonly runId: AutomationRunId;
  readonly receipt: AutomationFirstTurnAcceptanceReceipt;
  readonly expectedVersion: number;
}

export interface AppendAutomationNotificationRefInput {
  readonly automationId: AutomationId;
  readonly runId: AutomationRunId;
  readonly notificationRef: string;
  readonly expectedVersion: number;
  readonly recordedAt: UtcTimestamp;
}

/** One typed frame of a scheduler occurrence-ledger append batch. */
export type AutomationOccurrenceLedgerEvent =
  | {
      readonly kind: "occurrence-skipped";
      readonly occurrence: AutomationScheduledOccurrence;
      readonly reason: "missed-run-policy" | "missed-run-cap-recovery";
      readonly at: UtcTimestamp;
    }
  | {
      readonly kind: "occurrence-claimed";
      readonly occurrence: AutomationOccurrence;
      readonly runId: AutomationRunId;
      readonly at: UtcTimestamp;
    }
  | {
      readonly kind: "blocked";
      readonly reason: AutomationBlockReason;
      readonly runId?: AutomationRunId;
      readonly examinedFrom?: UtcTimestamp;
      readonly examinedThrough?: UtcTimestamp;
      readonly nextFutureOccurrence?: UtcTimestamp;
      readonly at: UtcTimestamp;
    }
  | {
      readonly kind: "exhausted";
      readonly definitionRevision: number;
      readonly consumedScheduledAt: UtcTimestamp;
      readonly at: UtcTimestamp;
    };

export interface AppendAutomationOccurrenceLedgerInput {
  readonly automationId: AutomationId;
  readonly expectedVersion: number;
  readonly events: ReadonlyArray<AutomationOccurrenceLedgerEvent>;
}

export type AutomationReplay =
  | { readonly status: "ok"; readonly events: ReadonlyArray<EventEnvelope> }
  | {
      readonly status: "snapshot-required";
      readonly reason: "identity-mismatch" | "invalid-frame" | "scan-limit";
    };

const AUTOMATION_AGGREGATE_TYPES: ReadonlySet<string> = new Set([
  AUTOMATION_DEFINITION_AGGREGATE_TYPE,
  AUTOMATION_RUN_AGGREGATE_TYPE,
]);

const DEFINITION_EVENT_NAMES: ReadonlySet<string> = new Set([
  AUTOMATION_DEFINITION_CREATED,
  AUTOMATION_DEFINITION_UPDATED,
  AUTOMATION_DEFINITION_LIFECYCLE_CHANGED,
  AUTOMATION_DEFINITION_EXHAUSTED,
  AUTOMATION_OCCURRENCE_CLAIMED,
  AUTOMATION_OCCURRENCE_SKIPPED,
  AUTOMATION_BLOCKED,
]);

const RUN_EVENT_NAMES: ReadonlySet<string> = new Set([
  AUTOMATION_RUN_CREATED,
  AUTOMATION_RUN_STATUS_CHANGED,
  AUTOMATION_DISPATCH_INTENT_RECORDED,
  AUTOMATION_FIRST_TURN_RUNTIME_CLAIMED,
  AUTOMATION_FIRST_TURN_DISPATCH_CANCELLED,
  AUTOMATION_FIRST_TURN_ACCEPTED,
  AUTOMATION_NOTIFICATION_REF_RECORDED,
]);

/**
 * Server-authoritative Automation event store. Definition and run aggregates
 * append to the immutable journal with optimistic concurrency on their own
 * aggregate versions; a run id doubles as the occurrence claim, so a duplicate
 * claim surfaces as a typed conflict instead of a second run. Replay rebuilds
 * both aggregates for projection catch-up after reconnect or restart and fails
 * closed on identity drift rather than silently repairing it.
 */
export class AutomationEventStore {
  readonly #journal: JournalPort;
  readonly #uuid: () => string;
  readonly #actor: typeof EventActor.Type;

  constructor(options: AutomationEventStoreOptions) {
    this.#journal = options.journal;
    this.#uuid = options.uuid;
    try {
      this.#actor = decodeActor(options.actor);
    } catch {
      throw new AutomationEventStoreError("invalid", "Automation event actor is invalid.");
    }
  }

  appendDefinitionCreated(input: AppendAutomationDefinitionCreatedInput): EventEnvelope {
    let payload: AutomationDefinitionCreated;
    let aggregateId: typeof AggregateId.Type;
    try {
      payload = decodeDefinitionCreated({ automation: input.automation });
      if (payload.automation.version !== 1) {
        throw new Error("created definition must start at version 1");
      }
      aggregateId = decodeAggregateId(payload.automation.id);
    } catch {
      throw new AutomationEventStoreError(
        "invalid",
        "Automation definition create append is invalid.",
      );
    }
    return this.#appendOne({
      aggregateType: AUTOMATION_DEFINITION_AGGREGATE_TYPE,
      aggregateId,
      expectedVersion: 0,
      eventName: AUTOMATION_DEFINITION_CREATED,
      occurredAt: payload.automation.createdAt,
      payload,
      aggregateVersion: 1,
      label: "Automation definition create",
    });
  }

  appendDefinitionUpdated(input: AppendAutomationDefinitionUpdatedInput): EventEnvelope {
    let payload: AutomationDefinitionUpdated;
    let aggregateId: typeof AggregateId.Type;
    let expectedVersion: typeof AggregateVersion.Type;
    try {
      expectedVersion = decodeAggregateVersion(input.expectedVersion);
      payload = decodeDefinitionUpdated({
        automation: input.automation,
        previousDefinitionRevision: input.previousDefinitionRevision,
      });
      if (payload.automation.version !== expectedVersion + 1) {
        throw new Error("updated definition version must extend the expected head");
      }
      aggregateId = decodeAggregateId(payload.automation.id);
    } catch {
      throw new AutomationEventStoreError(
        "invalid",
        "Automation definition update append is invalid.",
      );
    }
    return this.#appendOne({
      aggregateType: AUTOMATION_DEFINITION_AGGREGATE_TYPE,
      aggregateId,
      expectedVersion,
      eventName: AUTOMATION_DEFINITION_UPDATED,
      occurredAt: payload.automation.updatedAt,
      payload,
      aggregateVersion: expectedVersion + 1,
      label: "Automation definition update",
    });
  }

  appendDefinitionLifecycleChanged(
    input: AppendAutomationDefinitionLifecycleChangedInput,
  ): EventEnvelope {
    let payload: AutomationDefinitionLifecycleChanged;
    let aggregateId: typeof AggregateId.Type;
    let expectedVersion: typeof AggregateVersion.Type;
    try {
      expectedVersion = decodeAggregateVersion(input.expectedVersion);
      payload = decodeDefinitionLifecycleChanged({
        automation: input.automation,
        previousLifecycle: input.previousLifecycle,
      });
      if (payload.automation.version !== expectedVersion + 1) {
        throw new Error("lifecycle change version must extend the expected head");
      }
      aggregateId = decodeAggregateId(payload.automation.id);
    } catch {
      throw new AutomationEventStoreError(
        "invalid",
        "Automation definition lifecycle append is invalid.",
      );
    }
    return this.#appendOne({
      aggregateType: AUTOMATION_DEFINITION_AGGREGATE_TYPE,
      aggregateId,
      expectedVersion,
      eventName: AUTOMATION_DEFINITION_LIFECYCLE_CHANGED,
      occurredAt: payload.automation.updatedAt,
      payload,
      aggregateVersion: expectedVersion + 1,
      label: "Automation definition lifecycle change",
    });
  }

  /**
   * Atomically journal one scheduler reconciliation outcome on the definition
   * aggregate: skipped-occurrence receipts, at most one occurrence claim, a
   * blocked receipt, and/or an exhausted transition commit together or not at
   * all. Optimistic concurrency on the definition head makes simultaneous
   * claim attempts resolve to exactly one winner.
   */
  appendOccurrenceLedger(
    input: AppendAutomationOccurrenceLedgerInput,
  ): ReadonlyArray<EventEnvelope> {
    let aggregateId: typeof AggregateId.Type;
    let expectedVersion: typeof AggregateVersion.Type;
    let prepared: Array<{ readonly eventName: string; readonly payload: unknown }>;
    try {
      if (input.events.length === 0) {
        throw new Error("occurrence ledger batches must contain at least one event");
      }
      aggregateId = decodeAggregateId(input.automationId);
      expectedVersion = decodeAggregateVersion(input.expectedVersion);
      prepared = input.events.map((event, index) => {
        switch (event.kind) {
          case "occurrence-skipped":
            return {
              eventName: AUTOMATION_OCCURRENCE_SKIPPED,
              payload: decodeOccurrenceSkipped({
                automationId: input.automationId,
                occurrence: event.occurrence,
                occurrenceKey: deriveAutomationOccurrenceKey(event.occurrence),
                skippedAt: event.at,
                reason: event.reason,
              }),
            };
          case "occurrence-claimed":
            return {
              eventName: AUTOMATION_OCCURRENCE_CLAIMED,
              payload: decodeOccurrenceClaimed({
                automationId: input.automationId,
                runId: event.runId,
                occurrence: event.occurrence,
                occurrenceKey: deriveAutomationOccurrenceKey(event.occurrence),
                claimedAt: event.at,
              }),
            };
          case "blocked":
            return {
              eventName: AUTOMATION_BLOCKED,
              payload: decodeBlocked({
                automationId: input.automationId,
                ...(event.runId === undefined ? {} : { runId: event.runId }),
                reason: event.reason,
                ...(event.examinedFrom === undefined ? {} : { examinedFrom: event.examinedFrom }),
                ...(event.examinedThrough === undefined
                  ? {}
                  : { examinedThrough: event.examinedThrough }),
                ...(event.nextFutureOccurrence === undefined
                  ? {}
                  : { nextFutureOccurrence: event.nextFutureOccurrence }),
                recordedAt: event.at,
              }),
            };
          case "exhausted":
            return {
              eventName: AUTOMATION_DEFINITION_EXHAUSTED,
              payload: decodeDefinitionExhausted({
                automationId: input.automationId,
                definitionRevision: event.definitionRevision,
                consumedScheduledAt: event.consumedScheduledAt,
                version: expectedVersion + index + 1,
              }),
            };
        }
      });
    } catch {
      throw new AutomationEventStoreError(
        "invalid",
        "Automation occurrence ledger append is invalid.",
      );
    }

    let committed;
    try {
      committed = this.#journal.append({
        aggregate: { aggregateType: AUTOMATION_DEFINITION_AGGREGATE_TYPE, aggregateId },
        expectedVersion,
        events: prepared.map((event, index) => ({
          eventId: decodeEventId(this.#uuid()),
          eventName: event.eventName,
          eventVersion: 1,
          correlationId: decodeCorrelationId(this.#uuid()),
          actor: this.#actor,
          occurredAt: (input.events[index] as AutomationOccurrenceLedgerEvent).at,
          payload: event.payload,
        })),
      });
    } catch (error) {
      throw this.#wrapAppendFailure(error);
    }

    const versionsMatch = committed.events.every(
      (event, index) => event.aggregateVersion === expectedVersion + index + 1,
    );
    if (committed.events.length !== prepared.length || !versionsMatch) {
      throw new AutomationEventStoreError(
        "journal-mismatch",
        "Committed Automation occurrence ledger does not match its append.",
      );
    }
    return committed.events;
  }

  appendRunCreated(input: AppendAutomationRunCreatedInput): EventEnvelope {
    let payload: AutomationRunCreated;
    let aggregateId: typeof AggregateId.Type;
    try {
      payload = decodeRunCreated({ run: input.run });
      if (payload.run.version !== 1 || payload.run.lifecycle !== "queued") {
        throw new Error("created run must start queued at version 1");
      }
      aggregateId = decodeAggregateId(payload.run.id);
    } catch {
      throw new AutomationEventStoreError("invalid", "Automation run create append is invalid.");
    }
    return this.#appendOne({
      aggregateType: AUTOMATION_RUN_AGGREGATE_TYPE,
      aggregateId,
      expectedVersion: 0,
      eventName: AUTOMATION_RUN_CREATED,
      occurredAt: payload.run.createdAt,
      payload,
      aggregateVersion: 1,
      label: "Automation run create",
    });
  }

  appendRunStatusChanged(input: AppendAutomationRunStatusChangedInput): EventEnvelope {
    let payload: AutomationRunStatusChanged;
    let aggregateId: typeof AggregateId.Type;
    let expectedVersion: typeof AggregateVersion.Type;
    try {
      expectedVersion = decodeAggregateVersion(input.expectedVersion);
      payload = decodeRunStatusChanged({
        automationId: input.automationId,
        runId: input.runId,
        previousLifecycle: input.previousLifecycle,
        lifecycle: input.lifecycle,
        version: input.version,
        ...(input.failure === undefined ? {} : { failure: input.failure }),
        updatedAt: input.updatedAt,
      });
      if (payload.version !== expectedVersion + 1) {
        throw new Error("status version must extend the expected head");
      }
      aggregateId = decodeAggregateId(payload.runId);
    } catch {
      throw new AutomationEventStoreError("invalid", "Automation run status append is invalid.");
    }
    return this.#appendOne({
      aggregateType: AUTOMATION_RUN_AGGREGATE_TYPE,
      aggregateId,
      expectedVersion,
      eventName: AUTOMATION_RUN_STATUS_CHANGED,
      occurredAt: payload.updatedAt,
      payload,
      aggregateVersion: expectedVersion + 1,
      label: "Automation run status change",
    });
  }

  /**
   * Atomically journal a cancellation tombstone plus the terminal cancelled
   * status so a crash between the receipt and the transition cannot happen.
   */
  appendRunCancellation(input: AppendAutomationRunCancellationInput): ReadonlyArray<EventEnvelope> {
    let tombstonePayload: AutomationFirstTurnDispatchCancelled;
    let statusPayload: AutomationRunStatusChanged;
    let aggregateId: typeof AggregateId.Type;
    let expectedVersion: typeof AggregateVersion.Type;
    try {
      expectedVersion = decodeAggregateVersion(input.expectedVersion);
      tombstonePayload = decodeDispatchCancelled({
        automationId: input.automationId,
        runId: input.runId,
        tombstone: decodeCancellationTombstone(input.tombstone),
      });
      statusPayload = decodeRunStatusChanged({
        automationId: input.automationId,
        runId: input.runId,
        previousLifecycle: input.previousLifecycle,
        lifecycle: "cancelled",
        version: expectedVersion + 2,
        updatedAt: input.updatedAt,
      });
      aggregateId = decodeAggregateId(input.runId);
    } catch {
      throw new AutomationEventStoreError(
        "invalid",
        "Automation run cancellation append is invalid.",
      );
    }

    let committed;
    try {
      committed = this.#journal.append({
        aggregate: { aggregateType: AUTOMATION_RUN_AGGREGATE_TYPE, aggregateId },
        expectedVersion,
        events: [
          {
            eventId: decodeEventId(this.#uuid()),
            eventName: AUTOMATION_FIRST_TURN_DISPATCH_CANCELLED,
            eventVersion: 1,
            correlationId: decodeCorrelationId(this.#uuid()),
            actor: this.#actor,
            occurredAt: input.updatedAt,
            payload: tombstonePayload,
          },
          {
            eventId: decodeEventId(this.#uuid()),
            eventName: AUTOMATION_RUN_STATUS_CHANGED,
            eventVersion: 1,
            correlationId: decodeCorrelationId(this.#uuid()),
            actor: this.#actor,
            occurredAt: input.updatedAt,
            payload: statusPayload,
          },
        ],
      });
    } catch (error) {
      throw this.#wrapAppendFailure(error);
    }

    const [tombstoneEnvelope, statusEnvelope] = committed.events;
    if (
      committed.events.length !== 2 ||
      tombstoneEnvelope === undefined ||
      statusEnvelope === undefined ||
      tombstoneEnvelope.aggregateVersion !== expectedVersion + 1 ||
      statusEnvelope.aggregateVersion !== expectedVersion + 2
    ) {
      throw new AutomationEventStoreError(
        "journal-mismatch",
        "Committed Automation run cancellation does not match its append.",
      );
    }
    return committed.events;
  }

  appendDispatchIntentRecorded(input: AppendAutomationDispatchIntentInput): EventEnvelope {
    let payload: AutomationDispatchIntentRecorded;
    let aggregateId: typeof AggregateId.Type;
    let expectedVersion: typeof AggregateVersion.Type;
    try {
      expectedVersion = decodeAggregateVersion(input.expectedVersion);
      payload = decodeDispatchIntentRecorded({
        automationId: input.automationId,
        runId: input.runId,
        intent: input.intent,
      });
      aggregateId = decodeAggregateId(payload.runId);
    } catch {
      throw new AutomationEventStoreError(
        "invalid",
        "Automation dispatch intent append is invalid.",
      );
    }
    return this.#appendOne({
      aggregateType: AUTOMATION_RUN_AGGREGATE_TYPE,
      aggregateId,
      expectedVersion,
      eventName: AUTOMATION_DISPATCH_INTENT_RECORDED,
      occurredAt: payload.intent.recordedAt,
      payload,
      aggregateVersion: expectedVersion + 1,
      label: "Automation dispatch intent",
    });
  }

  appendFirstTurnRuntimeClaimed(
    input: AppendAutomationFirstTurnRuntimeClaimedInput,
  ): EventEnvelope {
    let payload: AutomationFirstTurnRuntimeClaimed;
    let aggregateId: typeof AggregateId.Type;
    let expectedVersion: typeof AggregateVersion.Type;
    try {
      expectedVersion = decodeAggregateVersion(input.expectedVersion);
      payload = decodeFirstTurnRuntimeClaimed({
        automationId: input.automationId,
        runId: input.runId,
        claim: input.claim,
      });
      aggregateId = decodeAggregateId(payload.runId);
    } catch {
      throw new AutomationEventStoreError(
        "invalid",
        "Automation first-turn runtime claim append is invalid.",
      );
    }
    return this.#appendOne({
      aggregateType: AUTOMATION_RUN_AGGREGATE_TYPE,
      aggregateId,
      expectedVersion,
      eventName: AUTOMATION_FIRST_TURN_RUNTIME_CLAIMED,
      occurredAt: payload.claim.claimedAt,
      payload,
      aggregateVersion: expectedVersion + 1,
      label: "Automation first-turn runtime claim",
    });
  }

  appendFirstTurnAccepted(input: AppendAutomationFirstTurnAcceptedInput): EventEnvelope {
    let payload: AutomationFirstTurnAccepted;
    let aggregateId: typeof AggregateId.Type;
    let expectedVersion: typeof AggregateVersion.Type;
    try {
      expectedVersion = decodeAggregateVersion(input.expectedVersion);
      payload = decodeFirstTurnAccepted({
        automationId: input.automationId,
        runId: input.runId,
        receipt: input.receipt,
      });
      aggregateId = decodeAggregateId(payload.runId);
    } catch {
      throw new AutomationEventStoreError(
        "invalid",
        "Automation first-turn acceptance append is invalid.",
      );
    }
    return this.#appendOne({
      aggregateType: AUTOMATION_RUN_AGGREGATE_TYPE,
      aggregateId,
      expectedVersion,
      eventName: AUTOMATION_FIRST_TURN_ACCEPTED,
      occurredAt: payload.receipt.acceptedAt,
      payload,
      aggregateVersion: expectedVersion + 1,
      label: "Automation first-turn acceptance",
    });
  }

  appendNotificationRefRecorded(input: AppendAutomationNotificationRefInput): EventEnvelope {
    let payload: AutomationNotificationRefRecorded;
    let aggregateId: typeof AggregateId.Type;
    let expectedVersion: typeof AggregateVersion.Type;
    try {
      expectedVersion = decodeAggregateVersion(input.expectedVersion);
      payload = decodeNotificationRefRecorded({
        automationId: input.automationId,
        runId: input.runId,
        notificationRef: input.notificationRef,
        version: expectedVersion + 1,
        recordedAt: input.recordedAt,
      });
      aggregateId = decodeAggregateId(payload.runId);
    } catch {
      throw new AutomationEventStoreError(
        "invalid",
        "Automation notification ref append is invalid.",
      );
    }
    return this.#appendOne({
      aggregateType: AUTOMATION_RUN_AGGREGATE_TYPE,
      aggregateId,
      expectedVersion,
      eventName: AUTOMATION_NOTIFICATION_REF_RECORDED,
      occurredAt: payload.recordedAt,
      payload,
      aggregateVersion: expectedVersion + 1,
      label: "Automation notification delivery reference",
    });
  }

  /**
   * Replay every automation definition and run event in journal order. Fails
   * closed with `snapshot-required` when a frame is malformed or attributed to
   * the wrong aggregate, so hydration never trusts a partially valid stream.
   */
  replayAll(): AutomationReplay {
    const events: Array<EventEnvelope> = [];
    let afterSequence = 0;
    let scannedEvents = 0;

    for (;;) {
      const batch = this.#journal.replay(
        decodeReplayCursor({ afterSequence, limit: JOURNAL_REPLAY_BATCH_SIZE }),
      );
      if (batch.length === 0) break;
      for (const envelope of batch) {
        afterSequence = envelope.globalSequence;
        if (!AUTOMATION_AGGREGATE_TYPES.has(envelope.aggregateType)) continue;
        scannedEvents += 1;
        if (scannedEvents > MAX_JOURNAL_SCAN_EVENTS) {
          return { status: "snapshot-required", reason: "scan-limit" };
        }
        const inspection = inspectAutomationFrame(envelope);
        if (inspection !== "ok") return { status: "snapshot-required", reason: inspection };
        events.push(envelope);
      }
      if (batch.length < JOURNAL_REPLAY_BATCH_SIZE) break;
    }
    return { status: "ok", events };
  }

  #appendOne(input: {
    readonly aggregateType: string;
    readonly aggregateId: typeof AggregateId.Type;
    readonly expectedVersion: number;
    readonly eventName: string;
    readonly occurredAt: UtcTimestamp;
    readonly payload: unknown;
    readonly aggregateVersion: number;
    readonly label: string;
  }): EventEnvelope {
    let committed;
    try {
      committed = this.#journal.append({
        aggregate: { aggregateType: input.aggregateType, aggregateId: input.aggregateId },
        expectedVersion: input.expectedVersion,
        events: [
          {
            eventId: decodeEventId(this.#uuid()),
            eventName: input.eventName,
            eventVersion: 1,
            correlationId: decodeCorrelationId(this.#uuid()),
            actor: this.#actor,
            occurredAt: input.occurredAt,
            payload: input.payload,
          },
        ],
      });
    } catch (error) {
      throw this.#wrapAppendFailure(error);
    }

    const envelope = committed.events[0];
    if (
      committed.events.length !== 1 ||
      envelope === undefined ||
      envelope.aggregateType !== input.aggregateType ||
      envelope.aggregateId !== input.aggregateId ||
      envelope.aggregateVersion !== input.aggregateVersion ||
      envelope.eventName !== input.eventName ||
      envelope.eventVersion !== 1
    ) {
      throw new AutomationEventStoreError(
        "journal-mismatch",
        `Committed ${input.label} event does not match its append.`,
      );
    }
    return envelope;
  }

  #wrapAppendFailure(error: unknown): AutomationEventStoreError {
    if (error instanceof ConcurrencyConflict) {
      return new AutomationEventStoreError(
        "conflict",
        "Automation expected version does not match the current head.",
      );
    }
    if (error instanceof DuplicateEventIdentity) {
      return new AutomationEventStoreError(
        "conflict",
        "Automation event identity is already committed.",
      );
    }
    throw error;
  }
}

function inspectAutomationFrame(
  envelope: EventEnvelope,
): "ok" | "identity-mismatch" | "invalid-frame" {
  if (envelope.eventVersion !== 1) return "invalid-frame";
  if (envelope.aggregateType === AUTOMATION_DEFINITION_AGGREGATE_TYPE) {
    if (!DEFINITION_EVENT_NAMES.has(envelope.eventName)) return "invalid-frame";
    const owner = definitionFrameOwner(envelope);
    if (owner === undefined) return "invalid-frame";
    return String(owner) === String(envelope.aggregateId) ? "ok" : "identity-mismatch";
  }
  if (!RUN_EVENT_NAMES.has(envelope.eventName)) return "invalid-frame";
  const owner = runFrameOwner(envelope);
  if (owner === undefined) return "invalid-frame";
  return String(owner) === String(envelope.aggregateId) ? "ok" : "identity-mismatch";
}

function definitionFrameOwner(envelope: EventEnvelope): string | undefined {
  const payload = envelope.payload as {
    readonly automation?: { readonly id?: unknown };
    readonly automationId?: unknown;
  };
  if (payload.automation !== undefined && typeof payload.automation.id === "string") {
    return payload.automation.id;
  }
  return typeof payload.automationId === "string" ? payload.automationId : undefined;
}

function runFrameOwner(envelope: EventEnvelope): string | undefined {
  const payload = envelope.payload as {
    readonly run?: { readonly id?: unknown };
    readonly runId?: unknown;
  };
  if (payload.run !== undefined && typeof payload.run.id === "string") {
    return payload.run.id;
  }
  return typeof payload.runId === "string" ? payload.runId : undefined;
}
