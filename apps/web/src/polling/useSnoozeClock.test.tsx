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
    // Each re-render schedules the next look, so the time passes in steps.
    for (let minute = 0; minute < 161; minute += 1) {
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
    }
    expect(result.current.getTime()).toBeGreaterThanOrEqual(Date.parse("2026-09-07T13:00:00.000Z"));
  });

  it("reads a newly delivered snooze against the current time, not the last tick", () => {
    const { result, rerender } = renderHook(
      (props: { readonly snoozes: ReadonlyArray<string> }) => useSnoozeClock(props.snoozes),
      { initialProps: { snoozes: [] as ReadonlyArray<string> } },
    );
    // Forty-five quiet minutes: with no snooze the clock has no reason to move.
    act(() => {
      vi.advanceTimersByTime(45 * 60_000);
    });
    expect(result.current.toISOString()).toBe("2026-09-07T10:00:00.000Z");
    rerender({ snoozes: ["2026-09-07T11:45:00.000Z"] });
    expect(result.current.toISOString()).toBe("2026-09-07T10:45:00.000Z");
  });
});
