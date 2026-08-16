import {
  ActorId,
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActor,
  EventId,
  EventName,
  UtcTimestamp,
  ZenSpaceSnapshotRecorded,
  ZenWidgetMutationRecorded,
  type ZenSpace,
  type ZenWidgetMutation,
  type EventActor as EventActorValue,
} from "@octant/contracts";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";
import { ConcurrencyConflict } from "../persistence/journalErrors";

export const ZEN_SPACE_SNAPSHOT_RECORDED = "zen.space-snapshot-recorded@2";
export const ZEN_WIDGET_MUTATION_RECORDED = "zen.widget-mutation-recorded@1";

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeSnapshot = Schema.decodeUnknownSync(ZenSpaceSnapshotRecorded);
const decodeWidgetMutation = Schema.decodeUnknownSync(ZenWidgetMutationRecorded);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

export interface ZenEventStoreOptions {
  readonly journal: Pick<Journal, "append">;
  readonly uuid: () => string;
  readonly actor: EventActorValue;
  readonly clock: () => string;
}

export class ZenEventStore {
  readonly #journal: Pick<Journal, "append">;
  readonly #uuid: () => string;
  readonly #actor: EventActorValue;
  readonly #clock: () => string;

  constructor(options: ZenEventStoreOptions) {
    this.#journal = options.journal;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    const actor = decodeActor(options.actor);
    decodeActorId(actor.actorId);
    this.#actor = actor;
  }

  append(space: ZenSpace, expectedVersion: number): ZenSpace {
    const expected = decodeAggregateVersion(expectedVersion);
    const committedVersion = decodeAggregateVersion(expectedVersion + 1);
    const persistedSpace = { ...space, version: committedVersion };
    const snapshot = decodeSnapshot({ spaceId: space.spaceId, space: persistedSpace });
    const aggregateId = decodeAggregateId(space.spaceId);
    const committed = this.#journal.append({
      aggregate: { aggregateType: "zen-space", aggregateId },
      expectedVersion: expected,
      events: [
        {
          eventId: decodeEventId(this.#uuid()),
          eventName: decodeEventName(ZEN_SPACE_SNAPSHOT_RECORDED),
          eventVersion: 1,
          correlationId: decodeCorrelationId(this.#uuid()),
          actor: this.#actor,
          occurredAt: decodeTimestamp(this.#clock()),
          payload: snapshot,
        },
      ],
    });
    const event = committed.events[0];
    if (event === undefined || event.aggregateVersion !== expectedVersion + 1) {
      throw new Error("Zen journal commit did not produce the expected version.");
    }
    return { ...persistedSpace, version: event.aggregateVersion };
  }

  appendWidgetMutation(
    space: ZenSpace,
    expectedVersion: number,
    mutation: ZenWidgetMutation,
  ): ZenSpace {
    const expected = decodeAggregateVersion(expectedVersion);
    const committedVersion = decodeAggregateVersion(expectedVersion + 1);
    const persistedSpace = { ...space, version: committedVersion };
    const payload = decodeWidgetMutation({
      spaceId: space.spaceId,
      space: persistedSpace,
      mutation,
    });
    const aggregateId = decodeAggregateId(space.spaceId);
    const committed = this.#journal.append({
      aggregate: { aggregateType: "zen-space", aggregateId },
      expectedVersion: expected,
      events: [
        {
          eventId: decodeEventId(this.#uuid()),
          eventName: decodeEventName(ZEN_WIDGET_MUTATION_RECORDED),
          eventVersion: 1,
          correlationId: decodeCorrelationId(this.#uuid()),
          actor: this.#actor,
          occurredAt: decodeTimestamp(this.#clock()),
          payload,
        },
      ],
    });
    const event = committed.events[0];
    if (event === undefined || event.aggregateVersion !== expectedVersion + 1) {
      throw new Error("Zen widget journal commit did not produce the expected version.");
    }
    return { ...persistedSpace, version: event.aggregateVersion };
  }

  isConcurrencyConflict(error: unknown): boolean {
    return error instanceof ConcurrencyConflict;
  }
}
