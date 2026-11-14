import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMinuteNow, useMinuteTick } from "./useMinuteTick";

describe("useMinuteTick", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T10:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports the time once a minute and stops when the hook unmounts", () => {
    const { result, unmount } = renderHook(() => useMinuteTick());
    expect(result.current.toISOString()).toBe("2026-09-07T10:00:00.000Z");
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current.toISOString()).toBe("2026-09-07T10:01:00.000Z");
    unmount();
    expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
  });

  it("never reads earlier than the real time when the shell's clock is stale", () => {
    // The shell's snooze clock last moved 45 minutes ago.
    const staleSeed = Date.parse("2026-09-07T09:15:00.000Z");
    const { result } = renderHook(() => useMinuteNow(staleSeed));
    expect(new Date(result.current).toISOString()).toBe("2026-09-07T10:00:00.000Z");
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(new Date(result.current).toISOString()).toBe("2026-09-07T10:01:00.000Z");
    // Well past the shell clock's lag window, it still keeps real time.
    act(() => {
      vi.advanceTimersByTime(90 * 60_000);
    });
    expect(new Date(result.current).toISOString()).toBe("2026-09-07T11:31:00.000Z");
  });
});
