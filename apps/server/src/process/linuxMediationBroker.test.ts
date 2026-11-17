import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LINUX_MEDIATION_PRODUCTION_MAXIMUM_MS,
  linuxMediationStatusMatchesProduction,
  scheduleLinuxMediationDeadline,
} from "./linuxMediationBroker";

afterEach(() => vi.useRealTimers());

describe("Linux mediation broker deadline", () => {
  it("preserves the full production deadline across Node timer limits", async () => {
    vi.useFakeTimers();
    const expire = vi.fn();
    const cancel = scheduleLinuxMediationDeadline(expire, LINUX_MEDIATION_PRODUCTION_MAXIMUM_MS);

    await vi.advanceTimersByTimeAsync(LINUX_MEDIATION_PRODUCTION_MAXIMUM_MS - 1);
    expect(expire).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(expire).toHaveBeenCalledOnce();
    cancel();
  });

  it("cancels a segmented production deadline", async () => {
    vi.useFakeTimers();
    const expire = vi.fn();
    const cancel = scheduleLinuxMediationDeadline(expire, LINUX_MEDIATION_PRODUCTION_MAXIMUM_MS);

    await vi.advanceTimersByTimeAsync(25 * 24 * 60 * 60 * 1_000);
    cancel();
    await vi.advanceTimersByTimeAsync(10 * 24 * 60 * 60 * 1_000);
    expect(expire).not.toHaveBeenCalled();
  });
});

describe("Linux mediation broker status", () => {
  it("requires coverage one for production and zero for a candidate", () => {
    const candidate = Buffer.alloc(24);
    const production = Buffer.alloc(24);
    production.writeBigUInt64LE(1n, 16);

    expect(linuxMediationStatusMatchesProduction(candidate, false)).toBe(true);
    expect(linuxMediationStatusMatchesProduction(candidate, true)).toBe(false);
    expect(linuxMediationStatusMatchesProduction(production, false)).toBe(false);
    expect(linuxMediationStatusMatchesProduction(production, true)).toBe(true);
  });
});
