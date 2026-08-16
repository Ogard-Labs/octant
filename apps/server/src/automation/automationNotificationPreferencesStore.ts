import {
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActor,
  EventId,
  decodeAutomationNotificationPreferences,
  decodeUpdateAutomationNotificationPreferences,
  DEFAULT_AUTOMATION_NOTIFICATION_PREFERENCES,
  type AutomationNotificationPreferences,
  type UpdateAutomationNotificationPreferences,
} from "@octant/contracts";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";
import { ConcurrencyConflict } from "../persistence/journalErrors";

const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);

export const AUTOMATION_NOTIFICATION_PREFERENCES_AGGREGATE_TYPE =
  "automation-notification-preferences";
export const AUTOMATION_NOTIFICATION_PREFERENCES_UPDATED =
  "automation-notification-preferences-updated@1";
export const AUTOMATION_NOTIFICATION_PREFERENCES_AGGREGATE_ID = decodeAggregateId(
  "00000000-0000-4000-8000-0000000000a2",
);

const JOURNAL_REPLAY_BATCH_SIZE = 1_000;

type JournalPort = Pick<Journal, "append" | "replayAggregate">;

export class AutomationNotificationPreferencesStoreError extends Error {
  override readonly name = "AutomationNotificationPreferencesStoreError";
  readonly category: "invalid" | "conflict";

  constructor(category: AutomationNotificationPreferencesStoreError["category"], message: string) {
    super(message);
    this.category = category;
  }
}

export interface AutomationNotificationPreferencesStoreOptions {
  readonly journal: JournalPort;
  readonly uuid: () => string;
  readonly actor: typeof EventActor.Type;
  readonly clock: () => string;
}

/**
 * Host-scoped Automation notification opt-in preferences. Default is disabled
 * (privacy-preserving). Journaled so restart rebuilds the same effective
 * policy without trusting client-side caches.
 */
export class AutomationNotificationPreferencesStore {
  readonly #journal: JournalPort;
  readonly #uuid: () => string;
  readonly #actor: typeof EventActor.Type;
  readonly #clock: () => string;
  #current: AutomationNotificationPreferences;

  constructor(options: AutomationNotificationPreferencesStoreOptions) {
    this.#journal = options.journal;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    try {
      this.#actor = decodeActor(options.actor);
    } catch {
      throw new AutomationNotificationPreferencesStoreError(
        "invalid",
        "Automation notification preferences actor is invalid.",
      );
    }
    this.#current = decodeAutomationNotificationPreferences({
      ...DEFAULT_AUTOMATION_NOTIFICATION_PREFERENCES,
      updatedAt: this.#clock(),
    });
    this.#hydrate();
  }

  current(): AutomationNotificationPreferences {
    return this.#current;
  }

  update(input: UpdateAutomationNotificationPreferences): AutomationNotificationPreferences {
    let command: UpdateAutomationNotificationPreferences;
    try {
      command = decodeUpdateAutomationNotificationPreferences(input);
    } catch {
      throw new AutomationNotificationPreferencesStoreError(
        "invalid",
        "Automation notification preferences update is invalid.",
      );
    }
    if (command.expectedVersion !== this.#current.version) {
      throw new AutomationNotificationPreferencesStoreError(
        "conflict",
        `Expected version ${command.expectedVersion}, current is ${this.#current.version}.`,
      );
    }
    const updatedAt = this.#clock();
    let preferences: AutomationNotificationPreferences;
    try {
      preferences = decodeAutomationNotificationPreferences({
        enabled: command.enabled,
        waiting: command.waiting,
        approvalNeeded: command.approvalNeeded,
        failure: command.failure,
        completion: command.completion,
        version: decodeAggregateVersion(this.#current.version + 1),
        updatedAt,
      });
    } catch {
      throw new AutomationNotificationPreferencesStoreError(
        "invalid",
        "Automation notification preferences update is invalid.",
      );
    }

    try {
      this.#journal.append({
        aggregate: {
          aggregateType: AUTOMATION_NOTIFICATION_PREFERENCES_AGGREGATE_TYPE,
          aggregateId: AUTOMATION_NOTIFICATION_PREFERENCES_AGGREGATE_ID,
        },
        expectedVersion: this.#current.version,
        events: [
          {
            eventId: decodeEventId(this.#uuid()),
            eventName: AUTOMATION_NOTIFICATION_PREFERENCES_UPDATED,
            eventVersion: 1,
            correlationId: decodeCorrelationId(this.#uuid()),
            actor: this.#actor,
            occurredAt: updatedAt,
            payload: preferences,
          },
        ],
      });
    } catch (error) {
      if (error instanceof ConcurrencyConflict) {
        throw new AutomationNotificationPreferencesStoreError(
          "conflict",
          "Automation notification preferences changed; reload before applying your update.",
        );
      }
      throw error;
    }

    this.#current = preferences;
    return preferences;
  }

  #hydrate(): void {
    let afterVersion = 0;
    let latest: AutomationNotificationPreferences | undefined;
    for (;;) {
      const batch = this.#journal.replayAggregate({
        aggregateType: AUTOMATION_NOTIFICATION_PREFERENCES_AGGREGATE_TYPE,
        aggregateId: AUTOMATION_NOTIFICATION_PREFERENCES_AGGREGATE_ID,
        afterVersion,
        limit: JOURNAL_REPLAY_BATCH_SIZE,
      });
      if (batch.length === 0) break;
      for (const envelope of batch) {
        afterVersion = envelope.aggregateVersion;
        if (envelope.eventName === AUTOMATION_NOTIFICATION_PREFERENCES_UPDATED) {
          latest = decodeAutomationNotificationPreferences(envelope.payload);
        }
      }
      if (batch.length < JOURNAL_REPLAY_BATCH_SIZE) break;
    }
    if (latest !== undefined) this.#current = latest;
  }
}
