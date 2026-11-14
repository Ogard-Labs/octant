import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSnoozeClock } from "./useSnoozeClock";

describe("useSnoozeClock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T10:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("moves when a snoozed thread wakes, not on every minute", () => {
    const renders = vi.fn();
    const { result } = renderHook(() => {
      renders();
      return useSnoozeClock(["2026-09-07T13:00:00.000Z"]);
    });
    const before = renders.mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(20 * 60_000);
    });
    // Three hours out the label reads in hours, so twenty minutes draw nothing new.
    expect(renders.mock.calls.length).toBe(before);
    act(() => {
      vi.advanceTimersByTime(160 * 60_000 + 1_000);
    });
    expect(result.current.getTime()).toBeGreaterThanOrEqual(
      Date.parse("2026-09-07T13:00:00.000Z"),
    );
  });
});
