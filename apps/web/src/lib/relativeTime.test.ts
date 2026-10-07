import { describe, expect, it } from "vitest";
import { elapsedLabel } from "./relativeTime";

const START = "2026-10-06T09:00:00.000Z";
const at = (minutes: number) => Date.parse(START) + minutes * 60_000;

describe("how long something has been running", () => {
  it("reads in minutes, then hours and minutes, then days", () => {
    expect(elapsedLabel(START, at(0) + 30_000)).toBe("<1m");
    expect(elapsedLabel(START, at(4))).toBe("4m");
    expect(elapsedLabel(START, at(60))).toBe("1h");
    expect(elapsedLabel(START, at(65))).toBe("1h 5m");
    expect(elapsedLabel(START, at(60 * 49))).toBe("2d");
  });

  it("never reads a negative span when the clocks disagree", () => {
    expect(elapsedLabel(START, at(-5))).toBe("<1m");
  });
});
