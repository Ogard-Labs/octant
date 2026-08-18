import {
  ZEN_FOCUS_ZONE_EVENT_NAMES,
  decodeZenFocusZoneRecorded,
  type EventEnvelope,
  type WindowId,
  type ZenFocusZone,
  type ZenFocusZoneRecorded,
} from "@octant/contracts";
import type { Journal } from "../persistence/journal";
import { ConcurrencyConflict } from "../persistence/journalErrors";

export const ZEN_FOCUS_ZONE_AGGREGATE_TYPE = "zen-focus-zone";

/**
 * A focus zone is commanded through the loopback Zen API, which authenticates
 * the window rather than a journal principal, so the durable write is
 * attributed to the Zen service itself.
 */
const ZEN_FOCUS_ZONE_ACTOR = {
  kind: "system",
  actorId: "00000000-0000-4000-8000-000000000878",
} as const;

const REPLAY_BATCH_SIZE = 1_000;

export class ZenFocusZoneStoreError extends Error {
  override readonly name = "ZenFocusZoneStoreError";
  constructor(
    readonly category: "conflict" | "failed",
    message: string,
  ) {
    super(message);
  }
}

export interface ZenFocusZoneStoreOptions {
  readonly journal: Pick<Journal, "append" | "replayAggregateType">;
  readonly uuid: () => string;
}

/**
 * The spaces each window holds, in the journal.
 *
 * Keyed by window, and separate from the spaces themselves: switching spaces
 * writes only which one is in front, never anything that is pinned to either.
 * Construction rebuilds every window's zone by replaying this aggregate type,
 * so the switcher survives a restart without a snapshot table, and the
 * in-memory view only advances after the journal has committed.
 */
export class ZenFocusZoneStore {
  readonly #journal: ZenFocusZoneStoreOptions["journal"];
  readonly #uuid: () => string;
  readonly #byWindow = new Map<string, ZenFocusZone>();

  constructor(options: ZenFocusZoneStoreOptions) {
    this.#journal = options.journal;
    this.#uuid = options.uuid;
    this.#rebuild();
  }

  read(windowId: WindowId): ZenFocusZone | null {
    return this.#byWindow.get(String(windowId)) ?? null;
  }

  write(zone: ZenFocusZone): ZenFocusZone {
    let payload: ZenFocusZoneRecorded;
    try {
      payload = decodeZenFocusZoneRecorded({ windowId: zone.windowId, zone });
    } catch {
      throw new ZenFocusZoneStoreError("failed", "Focus zone is not a durable focus-zone update.");
    }
    // The policy assigns `version = expectedVersion + 1`, so the journal head
    // the caller observed is exactly one behind what is being written.
    const expectedVersion = zone.version - 1;
    let committed;
    try {
      committed = this.#journal.append({
        aggregate: {
          aggregateType: ZEN_FOCUS_ZONE_AGGREGATE_TYPE,
          aggregateId: String(zone.windowId) as never,
        },
        expectedVersion: expectedVersion as never,
        events: [
          {
            eventId: this.#uuid() as never,
            eventName: ZEN_FOCUS_ZONE_EVENT_NAMES.updated as never,
            eventVersion: 1,
            correlationId: this.#uuid() as never,
            actor: ZEN_FOCUS_ZONE_ACTOR as never,
            occurredAt: zone.updatedAt,
            payload,
          },
        ],
      });
    } catch (error) {
      if (error instanceof ConcurrencyConflict) {
        throw new ZenFocusZoneStoreError("conflict", "Focus zone changed; reload and retry.");
      }
      throw new ZenFocusZoneStoreError("failed", "Focus zone could not be saved.");
    }
    const envelope = committed.events[0];
    if (
      committed.events.length !== 1 ||
      envelope === undefined ||
      envelope.aggregateVersion !== zone.version
    ) {
      throw new ZenFocusZoneStoreError(
        "failed",
        "Committed focus-zone event does not match its append.",
      );
    }
    this.#apply(payload);
    return zone;
  }

  #rebuild(): void {
    let afterSequence = 0;
    for (;;) {
      const batch = this.#journal.replayAggregateType({
        aggregateType: ZEN_FOCUS_ZONE_AGGREGATE_TYPE,
        afterSequence,
        limit: REPLAY_BATCH_SIZE,
      });
      if (batch.length === 0) return;
      for (const envelope of batch) {
        afterSequence = envelope.globalSequence;
        this.#apply(decodeEnvelope(envelope));
      }
      if (batch.length < REPLAY_BATCH_SIZE) return;
    }
  }

  #apply(payload: ZenFocusZoneRecorded): void {
    const key = String(payload.windowId);
    const retained = this.#byWindow.get(key);
    if (retained !== undefined && payload.zone.version <= retained.version) return;
    this.#byWindow.set(key, payload.zone);
  }
}

function decodeEnvelope(envelope: EventEnvelope): ZenFocusZoneRecorded {
  if (
    envelope.eventName !== ZEN_FOCUS_ZONE_EVENT_NAMES.updated ||
    envelope.eventVersion !== 1 ||
    envelope.aggregateType !== ZEN_FOCUS_ZONE_AGGREGATE_TYPE
  ) {
    throw new ZenFocusZoneStoreError("failed", "Journaled event is not a focus-zone update.");
  }
  let payload: ZenFocusZoneRecorded;
  try {
    payload = decodeZenFocusZoneRecorded(envelope.payload);
  } catch {
    throw new ZenFocusZoneStoreError("failed", "Journaled focus-zone payload is invalid.");
  }
  if (
    String(envelope.aggregateId) !== String(payload.windowId) ||
    envelope.aggregateVersion !== payload.zone.version
  ) {
    throw new ZenFocusZoneStoreError(
      "failed",
      "Journaled focus-zone event does not match its aggregate.",
    );
  }
  return payload;
}
