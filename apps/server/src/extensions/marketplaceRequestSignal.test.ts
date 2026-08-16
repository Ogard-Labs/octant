import { describe, expect, it, vi } from "vitest";
import { createMarketplaceRequestSignal } from "./marketplaceRequestSignal";

describe("marketplace request signal", () => {
  it("aborts on the caller signal and on the bounded request timeout", async () => {
    vi.useFakeTimers();
    try {
      const caller = new AbortController();
      const callerBound = createMarketplaceRequestSignal(caller.signal, 1_000);
      caller.abort();
      expect(callerBound.signal.aborted).toBe(true);
      callerBound.dispose();

      const timed = createMarketplaceRequestSignal(undefined, 1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(timed.signal.aborted).toBe(true);
      timed.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
