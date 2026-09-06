import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMinuteTick } from "./useMinuteTick";

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
});
