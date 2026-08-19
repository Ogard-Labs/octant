import { describe, expect, it } from "vitest";
import { hydrateJournalProjection, requireJournalHydration } from "./journalHydration";

describe("journal hydration", () => {
  it("replays every envelope when the scan stays inside the cap", () => {
    const applied: Array<number> = [];
    const status = hydrateJournalProjection({
      replay: (cursor) =>
        cursor.afterSequence === 0
          ? [
              {
                globalSequence: 1,
                eventName: "example.recorded@1",
                eventVersion: 1,
                payload: {},
              },
            ]
          : [],
      apply: (envelope) => {
        applied.push(envelope.globalSequence);
      },
    });
    expect(status).toBe("ok");
    expect(applied).toEqual([1]);
  });

  it("fails closed instead of serving a truncated rebuild", () => {
    const status = hydrateJournalProjection({
      maxScan: 1,
      replay: (cursor) => [
        {
          globalSequence: cursor.afterSequence + 1,
          eventName: "example.recorded@1",
          eventVersion: 1,
          payload: {},
        },
        {
          globalSequence: cursor.afterSequence + 2,
          eventName: "example.recorded@1",
          eventVersion: 1,
          payload: {},
        },
      ],
      apply: () => {},
    });
    expect(status).toBe("snapshot-required");
    expect(() => requireJournalHydration(status, "Example")).toThrow(
      /Example hydration exceeded the journal scan cap/,
    );
  });

  it("asks the journal for one aggregate so unrelated history does not count", () => {
    const asked: Array<string | undefined> = [];
    hydrateJournalProjection({
      aggregateType: "work-thread",
      replay: (cursor) => {
        asked.push(cursor.aggregateType);
        return [];
      },
      apply: () => {},
    });
    expect(asked).toEqual(["work-thread"]);
  });
});
