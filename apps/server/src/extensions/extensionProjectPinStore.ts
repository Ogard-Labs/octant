import {
  AggregateId,
  AggregateVersion,
  EventActor,
  EventId,
  EventName,
  UtcTimestamp,
  type EventActor as EventActorValue,
} from "@octant/contracts";
import {
  EXTENSION_PROJECT_PIN_AGGREGATE,
  EXTENSION_PROJECT_PIN_EVENT_NAMES,
  decodeExtensionProjectPinChanged,
} from "@octant/contracts/extension-events";
import { Schema } from "effect";
import { readAggregateVersion } from "../persistence/chatProjection";
import { readExtensionProjectPins } from "../persistence/extensionProjectPinProjection";
import type { Journal } from "../persistence/journal";
import {
  ConcurrencyConflict,
  EventPayloadInvalid,
  JournalInputInvalid,
} from "../persistence/journalErrors";
import type { SqliteConnection } from "../persistence/sqlitePort";

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

const MAX_APPEND_ATTEMPTS = 3;

export interface ExtensionProjectPinStoreOptions {
  readonly journal: Pick<Journal, "append">;
  readonly connection: SqliteConnection;
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly actor: EventActorValue;
}

/**
 * Plugins pinned to Projects. A pin is the person's standing choice to offer
 * a plugin on every Work or Code turn in one Project without naming it each
 * time; it grants nothing, since every tool call still asks or uses a
 * remembered approval. The journal is the record; the projection answers.
 */
export class ExtensionProjectPinStore {
  readonly #journal: Pick<Journal, "append">;
  readonly #connection: SqliteConnection;
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #actor: EventActorValue;

  constructor(options: ExtensionProjectPinStoreOptions) {
    this.#journal = options.journal;
    this.#connection = options.connection;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    this.#actor = decodeActor(options.actor);
  }

  /** The plugins pinned to one Project, by extension id. */
  list(projectId: string): ReadonlyArray<string> {
    return readExtensionProjectPins(this.#connection, projectId).map((pin) => pin.extensionId);
  }

  listAll(): ReadonlyArray<{ readonly projectId: string; readonly extensionId: string }> {
    return readExtensionProjectPins(this.#connection);
  }

  set(projectId: string, extensionId: string, pinned: boolean): "recorded" | "refused" {
    let payload: ReturnType<typeof decodeExtensionProjectPinChanged>;
    try {
      payload = decodeExtensionProjectPinChanged({ projectId, extensionId, pinned });
    } catch {
      return "refused";
    }
    const current = this.list(projectId).includes(extensionId);
    if (current === pinned) return "recorded";
    return this.#append(projectId, payload) ? "recorded" : "refused";
  }

  /** Unpins a plugin everywhere, once it is gone. */
  forgetExtension(extensionId: string): void {
    for (const pin of this.listAll()) {
      if (pin.extensionId === extensionId) this.set(pin.projectId, extensionId, false);
    }
  }

  #append(projectId: string, payload: unknown): boolean {
    const aggregateId = decodeAggregateId(projectId);
    for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
      const expectedVersion = decodeAggregateVersion(
        readAggregateVersion(this.#connection, EXTENSION_PROJECT_PIN_AGGREGATE, aggregateId),
      );
      try {
        const eventId = decodeEventId(this.#uuid());
        this.#journal.append({
          aggregate: { aggregateType: EXTENSION_PROJECT_PIN_AGGREGATE, aggregateId },
          expectedVersion,
          events: [
            {
              eventId,
              eventName: decodeEventName(EXTENSION_PROJECT_PIN_EVENT_NAMES.changed),
              eventVersion: 1,
              correlationId: eventId,
              actor: this.#actor,
              occurredAt: decodeTimestamp(this.#clock()),
              payload,
            },
          ],
        });
        return true;
      } catch (error) {
        if (error instanceof ConcurrencyConflict) continue;
        if (error instanceof JournalInputInvalid || error instanceof EventPayloadInvalid) {
          return false;
        }
        throw error;
      }
    }
    return false;
  }
}
