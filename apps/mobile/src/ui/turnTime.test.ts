import { describe, expect, it } from "vitest";
import { messageTime, turnElapsed } from "./turnTime";

const now = new Date(2026, 10, 25, 17, 47);
const at = (year: number, month: number, day: number, hour: number, minute: number) =>
  new Date(year, month, day, hour, minute).toISOString();

describe("a message's time", () => {
  it("is the clock alone today, and names the day before that", () => {
    const today = messageTime(at(2026, 10, 25, 16, 45), now);
    expect(today).toMatch(/45/);
    expect(today).not.toMatch(/25/);
    expect(messageTime(at(2026, 10, 24, 16, 45), now)).toMatch(/24.*45/);
    expect(messageTime(at(2025, 10, 24, 16, 45), now)).toMatch(/2025/);
  });

  it("says nothing of a time it cannot read", () => {
    expect(messageTime("soon", now)).toBe("");
    expect(turnElapsed("soon", now)).toBe("");
  });
});

describe("a running turn's time", () => {
  it("counts seconds, then minutes, then hours", () => {
    const since = (seconds: number) => new Date(now.getTime() - seconds * 1_000).toISOString();
    expect(turnElapsed(since(1), now)).toBe("1s");
    expect(turnElapsed(since(44 * 60), now)).toBe("44m");
    expect(turnElapsed(since(3_900), now)).toBe("1h 5m");
    // A computer whose clock runs ahead never shows a negative time.
    expect(turnElapsed(since(-30), now)).toBe("0s");
  });
});
