import {
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActor,
  EventId,
  decodeAutomationNotificationDeliveryReceipt,
  decodeAutomationNotificationDeliveryRecorded,
  type AutomationId,
  type AutomationNotificationDeliveryOutcome,
  type AutomationNotificationDeliveryReceipt,
  type AutomationNotificationKind,
  type AutomationRunId,
  type UtcTimestamp,
} from "@octant/contracts";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";
import { ConcurrencyConflict } from "../persistence/journalErrors";
import { deterministicAutomationUuid } from "./automationRunIdentity";

const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);

export const AUTOMATION_NOTIFICATION_DELIVERY_AGGREGATE_TYPE = "automation-notification-delivery";
export const AUTOMATION_NOTIFICATION_DELIVERY_RECORDED =
  "automation-notification-delivery-recorded@1";

const JOURNAL_REPLAY_BATCH_SIZE = 1_000;

type JournalPort = Pick<Journal, "append" | "replayAggregateType">;

export class AutomationNotificationDeliveryStoreError extends Error {
  override readonly name = "AutomationNotificationDeliveryStoreError";
  readonly category: "invalid" | "conflict";

  constructor(category: AutomationNotificationDeliveryStoreError["category"], message: string) {
    super(message);
    this.category = category;
  }
}

export interface AutomationNotificationDeliveryStoreOptions {
  readonly journal: JournalPort;
  readonly uuid: () => string;
  readonly actor: typeof EventActor.Type;
  readonly clock: () => string;
}

export interface RecordAutomationNotificationDeliveryInput {
  readonly receiptId: string;
  readonly automationId: AutomationId;
  readonly runId: AutomationRunId;
  readonly kind: AutomationNotificationKind;
  readonly dedupeKey: string;
  readonly outcome: AutomationNotificationDeliveryOutcome;
  readonly attemptCount: number;
  readonly destinationCount: number;
  readonly failureCategory?: string;
  readonly recordedAt?: UtcTimestamp;
}

/**
 * Durable delivery receipt ledger keyed by dedupe key. Replay rebuilds the
 * in-memory index so restart cannot double-send a completed (run, kind).
 */
export class AutomationNotificationDeliveryStore {
  readonly #journal: JournalPort;
  readonly #uuid: () => string;
  readonly #actor: typeof EventActor.Type;
  readonly #clock: () => string;
  readonly #byDedupeKey = new Map<string, AutomationNotificationDeliveryReceipt>();
  readonly #versions = new Map<string, number>();

  constructor(options: AutomationNotificationDeliveryStoreOptions) {
    this.#journal = options.journal;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    try {
      this.#actor = decodeActor(options.actor);
    } catch {
      throw new AutomationNotificationDeliveryStoreError(
        "invalid",
        "Automation notification delivery actor is invalid.",
      );
    }
    this.#hydrate();
  }

  getByDedupeKey(dedupeKey: string): AutomationNotificationDeliveryReceipt | undefined {
    return this.#byDedupeKey.get(dedupeKey);
  }

  getByReceiptId(receiptId: string): AutomationNotificationDeliveryReceipt | undefined {
    for (const receipt of this.#byDedupeKey.values()) {
      if (String(receipt.receiptId) === receiptId) return receipt;
    }
    return undefined;
  }

  list(): ReadonlyArray<AutomationNotificationDeliveryReceipt> {
    return [...this.#byDedupeKey.values()];
  }

  listByRunId(runId: string): ReadonlyArray<AutomationNotificationDeliveryReceipt> {
    return this.list().filter((receipt) => String(receipt.runId) === runId);
  }

  listByAutomationId(automationId: string): ReadonlyArray<AutomationNotificationDeliveryReceipt> {
    return this.list().filter((receipt) => String(receipt.automationId) === automationId);
  }

  record(input: RecordAutomationNotificationDeliveryInput): AutomationNotificationDeliveryReceipt {
    const recordedAt = input.recordedAt ?? (this.#clock() as UtcTimestamp);
    let receipt: AutomationNotificationDeliveryReceipt;
    try {
      receipt = decodeAutomationNotificationDeliveryReceipt({
        receiptId: input.receiptId,
        automationId: input.automationId,
        runId: input.runId,
        kind: input.kind,
        dedupeKey: input.dedupeKey,
        outcome: input.outcome,
        attemptCount: input.attemptCount,
        destinationCount: input.destinationCount,
        recordedAt,
        ...(input.failureCategory === undefined ? {} : { failureCategory: input.failureCategory }),
      });
    } catch {
      throw new AutomationNotificationDeliveryStoreError(
        "invalid",
        "Automation notification delivery receipt is invalid.",
      );
    }

    const aggregateId = decodeAggregateId(
      deterministicAutomationUuid(`automation-notification-delivery:${input.dedupeKey}`),
    );
    const expectedVersion = this.#versions.get(input.dedupeKey) ?? 0;
    try {
      this.#journal.append({
        aggregate: {
          aggregateType: AUTOMATION_NOTIFICATION_DELIVERY_AGGREGATE_TYPE,
          aggregateId,
        },
        expectedVersion: decodeAggregateVersion(expectedVersion),
        events: [
          {
            eventId: decodeEventId(this.#uuid()),
            eventName: AUTOMATION_NOTIFICATION_DELIVERY_RECORDED,
            eventVersion: 1,
            correlationId: decodeCorrelationId(this.#uuid()),
            actor: this.#actor,
            occurredAt: recordedAt,
            payload: decodeAutomationNotificationDeliveryRecorded({ receipt }),
          },
        ],
      });
    } catch (error) {
      if (error instanceof ConcurrencyConflict) {
        throw new AutomationNotificationDeliveryStoreError(
          "conflict",
          "Automation notification delivery receipt changed concurrently.",
        );
      }
      throw error;
    }

    this.#byDedupeKey.set(input.dedupeKey, receipt);
    this.#versions.set(input.dedupeKey, expectedVersion + 1);
    return receipt;
  }

  #hydrate(): void {
    let afterSequence = 0;
    for (;;) {
      const batch = this.#journal.replayAggregateType({
        aggregateType: AUTOMATION_NOTIFICATION_DELIVERY_AGGREGATE_TYPE,
        afterSequence,
        limit: JOURNAL_REPLAY_BATCH_SIZE,
      });
      if (batch.length === 0) break;
      for (const envelope of batch) {
        afterSequence = envelope.globalSequence;
        if (envelope.eventName !== AUTOMATION_NOTIFICATION_DELIVERY_RECORDED) continue;
        try {
          const recorded = decodeAutomationNotificationDeliveryRecorded(envelope.payload);
          this.#byDedupeKey.set(recorded.receipt.dedupeKey, recorded.receipt);
          this.#versions.set(recorded.receipt.dedupeKey, envelope.aggregateVersion);
        } catch {
          // Skip corrupt frames; journal quarantine owns fail-closed recovery.
        }
      }
      if (batch.length < JOURNAL_REPLAY_BATCH_SIZE) break;
    }
  }
}
