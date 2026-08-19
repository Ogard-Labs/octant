import {
  SHIP_AGGREGATE_TYPE,
  SHIP_EVENT_NAMES,
  ShipReceipt,
  ShipTarget,
  type UtcTimestamp,
} from "@octant/contracts";
import { Schema } from "effect";
import type { EventRegistry } from "../persistence/eventRegistry";
import type { Journal } from "../persistence/journal";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * The journal frames a ship writes.
 *
 * Both outcomes are recorded. What was published, to which target, at which
 * revision, and on whose decision has to be answerable afterwards — and so does
 * what was refused, because "it did not publish and nobody knows why" is the
 * failure this record exists to prevent.
 */
export const ShipTargetChanged = Schema.Struct({ target: ShipTarget }).annotations(strict);
export const ShipRecorded = Schema.Struct({ receipt: ShipReceipt }).annotations(strict);

export function registerShipEvents(registry: EventRegistry): EventRegistry {
  return registry
    .register(SHIP_EVENT_NAMES.targetChanged, 1, ShipTargetChanged)
    .register(SHIP_EVENT_NAMES.shipped, 1, ShipRecorded);
}

export interface ShipEventStoreOptions {
  readonly journal: Pick<Journal, "append">;
  readonly uuid: () => string;
  readonly clock: () => UtcTimestamp;
  readonly actor: { readonly kind: "system" | "local-user"; readonly actorId: string };
}

export class ShipEventStore {
  readonly #options: ShipEventStoreOptions;

  constructor(options: ShipEventStoreOptions) {
    this.#options = options;
  }

  append(input: {
    readonly aggregateId: string;
    readonly eventName: string;
    readonly payload: unknown;
  }): void {
    this.#options.journal.append({
      aggregate: { aggregateType: SHIP_AGGREGATE_TYPE, aggregateId: input.aggregateId },
      expectedVersion: 0,
      events: [
        {
          eventId: this.#options.uuid(),
          eventName: input.eventName,
          eventVersion: 1,
          actor: this.#options.actor,
          occurredAt: this.#options.clock(),
          payload: input.payload,
        },
      ],
    });
  }
}
