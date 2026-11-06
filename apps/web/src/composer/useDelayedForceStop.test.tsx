import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useDelayedForceStop } from "./useDelayedForceStop";

describe("force-stopping an owned attempt", () => {
  it("waits after Stop and removes the offer for a replacement or unsupported attempt", () => {
    vi.useFakeTimers();
    try {
      const hook = renderHook(({ attempt, supported }) => useDelayedForceStop(attempt, supported), {
        initialProps: { attempt: "first", supported: true },
      });
      expect(hook.result.current.offered).toBe(false);
      act(() => hook.result.current.requestStop());
      act(() => vi.advanceTimersByTime(9999));
      expect(hook.result.current.offered).toBe(false);
      act(() => vi.advanceTimersByTime(1));
      expect(hook.result.current.offered).toBe(true);
      hook.rerender({ attempt: "replacement", supported: true });
      expect(hook.result.current.offered).toBe(false);
      act(() => hook.result.current.requestStop());
      hook.rerender({ attempt: "replacement", supported: false });
      act(() => vi.advanceTimersByTime(10000));
      expect(hook.result.current.offered).toBe(false);
      hook.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
