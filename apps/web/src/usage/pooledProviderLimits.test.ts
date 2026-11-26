import type { ProviderRateLimitWindow } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { rateWindowShare } from "./pooledProviderLimits";

describe("rateWindowShare", () => {
  it("leaves nothing included in a spent allowance that overage lets work go on past", () => {
    const window = {
      window: "five_hour",
      status: "exhausted",
      utilization: 0.95,
      observedAt: "2026-11-26T10:00:00.000Z",
      overage: { status: "allowed" },
    } as unknown as ProviderRateLimitWindow;
    expect(rateWindowShare(window)).toEqual({ remainingPercent: 0, exhausted: false });
  });
});
