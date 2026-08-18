import { decodeWindowId, decodeZenSpaceId, type ZenFocusZone } from "@octant/contracts";
import { createZenFocusZone } from "@octant/domain";
import { describe, expect, it, vi } from "vitest";
import { ConcurrencyConflict } from "../persistence/journalErrors";
import {
  ZEN_FOCUS_ZONE_AGGREGATE_TYPE,
  ZenFocusZoneStore,
  ZenFocusZoneStoreError,
} from "./zenFocusZoneStore";

const window = decodeWindowId("11111111-1111-4111-8111-111111111111");
const first = decodeZenSpaceId("22222222-2222-4222-8222-222222222222");
const second = decodeZenSpaceId("33333333-3333-4333-8333-333333333333");
const now = "2026-08-14T09:00:00.000Z" as never;

function zone(): ZenFocusZone {
  return createZenFocusZone(window, first, "Focus", now);
}

/** A journal that commits every append at the version the payload claims. */
function journal(replay: ReadonlyArray<unknown> = []) {
  const append = vi.fn((request: { readonly events: ReadonlyArray<{ payload: unknown }> }) => ({
    events: request.events.map((event) => ({
      ...event,
      aggregateVersion: (event.payload as { zone: ZenFocusZone }).zone.version,
    })),
  }));
  const replayAggregateType = vi.fn((request: { afterSequence: number }) =>
    request.afterSequence === 0 ? replay : [],
  );
  return { append, replayAggregateType };
}

function envelope(recorded: ZenFocusZone, globalSequence: number) {
  return {
    globalSequence,
    aggregateType: ZEN_FOCUS_ZONE_AGGREGATE_TYPE,
    aggregateId: String(recorded.windowId),
    aggregateVersion: recorded.version,
    eventName: "zen.focus-zone-updated@1",
    eventVersion: 1,
    payload: { windowId: recorded.windowId, zone: recorded },
  };
}

describe("ZenFocusZoneStore", () => {
  it("reports no spaces for a window that never opened a focus zone", () => {
    const store = new ZenFocusZoneStore({ journal: journal() as never, uuid: () => "id" });

    expect(store.read(window)).toBeNull();
  });

  it("serves the spaces a window held before the last restart", () => {
    const restored: ZenFocusZone = {
      ...zone(),
      version: 2 as never,
      spaces: [
        { spaceId: first, name: "Focus", position: 0 },
        { spaceId: second, name: "Review", position: 1 },
      ],
      activeSpaceId: second,
    };
    const store = new ZenFocusZoneStore({
      journal: journal([envelope(zone(), 1), envelope(restored, 2)]) as never,
      uuid: () => "id",
    });

    expect(store.read(window)).toMatchObject({ activeSpaceId: second, version: 2 });
  });

  it("journals a focus zone against the version the writer observed", () => {
    const backing = journal();
    const store = new ZenFocusZoneStore({ journal: backing as never, uuid: () => "id" });

    const written = store.write(zone());

    expect(written.activeSpaceId).toBe(first);
    expect(store.read(window)).toMatchObject({ activeSpaceId: first });
    expect(backing.append).toHaveBeenCalledWith(
      expect.objectContaining({
        aggregate: { aggregateType: ZEN_FOCUS_ZONE_AGGREGATE_TYPE, aggregateId: String(window) },
        expectedVersion: 0,
      }),
    );
  });

  it("refuses a focus zone another writer moved under it, leaving the served zone alone", () => {
    const backing = journal();
    const store = new ZenFocusZoneStore({ journal: backing as never, uuid: () => "id" });
    backing.append.mockImplementationOnce(() => {
      throw new ConcurrencyConflict({
        aggregateType: ZEN_FOCUS_ZONE_AGGREGATE_TYPE,
        aggregateId: String(window),
        expectedVersion: 0,
        actualVersion: 1,
      });
    });

    expect(() => store.write(zone())).toThrow(ZenFocusZoneStoreError);
    expect(store.read(window)).toBeNull();
  });
});
