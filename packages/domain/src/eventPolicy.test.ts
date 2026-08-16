import { describe, expect, it } from "vitest";
import { assignAggregateVersions, classifyCheckpoint } from "./eventPolicy";

describe("assignAggregateVersions", () => {
  it("assigns contiguous versions after an exact expected version", () => {
    expect(assignAggregateVersions(2, 2, 3)).toEqual({ ok: true, versions: [3, 4, 5] });
  });

  it("returns the actual version for stale work", () => {
    expect(assignAggregateVersions(1, 2, 1)).toEqual({
      ok: false,
      expectedVersion: 1,
      actualVersion: 2,
    });
  });

  it("rejects empty event batches", () => {
    expect(() => assignAggregateVersions(0, 0, 0)).toThrow("eventCount must be positive");
  });
});

describe("classifyCheckpoint", () => {
  it.each([
    [3, 3, "current"],
    [1, 3, "lagging"],
    [4, 3, "invalid"],
  ] as const)("classifies %s against %s as %s", (checkpoint, head, expected) => {
    expect(classifyCheckpoint(checkpoint, head)).toBe(expected);
  });
});
