import { afterEach, expect, it, vi } from "vitest";
import { LINUX_MEDIATION_PRODUCTION_MAXIMUM_MS } from "./linuxMediationBroker";
import { replaceLinuxMediationWorkerDeadline } from "./linuxMediationWorker";

afterEach(() => vi.useRealTimers());

it("replaces the configuration watchdog with the full segmented workload lifetime", async () => {
  vi.useFakeTimers();
  const clearConfigurationDeadline = vi.fn();
  const expire = vi.fn();
  const clear = replaceLinuxMediationWorkerDeadline(
    clearConfigurationDeadline,
    expire,
    LINUX_MEDIATION_PRODUCTION_MAXIMUM_MS,
  );

  expect(clearConfigurationDeadline).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(180_001);
  expect(expire).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(LINUX_MEDIATION_PRODUCTION_MAXIMUM_MS - 180_001);
  expect(expire).toHaveBeenCalledOnce();
  clear();
});
