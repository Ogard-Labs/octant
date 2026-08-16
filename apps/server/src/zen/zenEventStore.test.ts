import { decodeWindowId } from "@octant/contracts";
import { createZenSpace } from "@octant/domain";
import { describe, expect, it, vi } from "vitest";
import { ZenEventStore } from "./zenEventStore";

describe("ZenEventStore", () => {
  it("appends a versioned snapshot and returns the journal authority", () => {
    const append = vi.fn(
      () =>
        ({
          events: [{ aggregateVersion: 1 }],
        }) as never,
    );
    const store = new ZenEventStore({
      journal: { append },
      uuid: vi
        .fn()
        .mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
        .mockReturnValueOnce("22222222-2222-4222-8222-222222222222"),
      actor: {
        kind: "local-user",
        actorId: "33333333-3333-4333-8333-333333333333" as never,
      },
      clock: () => "2026-07-24T12:00:00.000Z",
    });
    const space = createZenSpace(
      decodeWindowId("44444444-4444-4444-8444-444444444444"),
      "local" as never,
    );

    const committed = store.append(space, 0);

    expect(committed.version).toBe(1);
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        aggregate: { aggregateType: "zen-space", aggregateId: space.spaceId },
        expectedVersion: 0,
        events: [
          expect.objectContaining({
            eventName: "zen.space-snapshot-recorded@2",
            payload: {
              spaceId: space.spaceId,
              space: expect.objectContaining({ ...space, version: 1 }),
            },
          }),
        ],
      }),
    );
  });

  it("appends a typed widget mutation with the committed space snapshot", () => {
    const append = vi.fn(
      () =>
        ({
          events: [{ aggregateVersion: 1 }],
        }) as never,
    );
    const store = new ZenEventStore({
      journal: { append },
      uuid: vi
        .fn()
        .mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
        .mockReturnValueOnce("22222222-2222-4222-8222-222222222222"),
      actor: {
        kind: "local-user",
        actorId: "33333333-3333-4333-8333-333333333333" as never,
      },
      clock: () => "2026-07-24T12:00:00.000Z",
    });
    const space = createZenSpace(
      decodeWindowId("44444444-4444-4444-8444-444444444444"),
      "local" as never,
    );
    const elementId = "55555555-5555-4555-8555-555555555555" as never;

    const committed = store.appendWidgetMutation(space, 0, {
      operation: "widget-created",
      kind: "notes",
      elementId,
      widgetVersion: 0 as never,
    });

    expect(committed.version).toBe(1);
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedVersion: 0,
        events: [
          expect.objectContaining({
            eventName: "zen.widget-mutation-recorded@1",
            payload: {
              spaceId: space.spaceId,
              space: expect.objectContaining({ version: 1 }),
              mutation: {
                operation: "widget-created",
                kind: "notes",
                elementId,
                widgetVersion: 0,
              },
            },
          }),
        ],
      }),
    );
  });
});
