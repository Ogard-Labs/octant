import type { HostReadModelCache } from "@octant/client-runtime/host-federation-merged-reads";
import type { HostFederationTransports } from "@octant/client-runtime/host-federation-transports";
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createRefreshTicks, usePairedComputerReads } from "./usePairedComputerReads";

afterEach(() => {
  vi.useRealTimers();
});

it("says when each refresh starts, even while a slow computer still holds the last one", async () => {
  vi.useFakeTimers();
  const transports = {
    fanOut: () => new Promise(() => undefined),
  } as unknown as HostFederationTransports;
  const ticks = createRefreshTicks();
  const heard = vi.fn();
  const stop = ticks.subscribe(heard);
  renderHook(() =>
    usePairedComputerReads({
      transports,
      cache: {} as HostReadModelCache,
      onRefreshStarted: ticks.tick,
    }),
  );
  expect(ticks.read()).toBe(1);
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(ticks.read()).toBe(3);
  expect(heard).toHaveBeenCalledTimes(3);
  stop();
});
