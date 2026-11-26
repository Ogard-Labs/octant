import { decodeUtcTimestamp, type ProviderRateLimitWindow } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { rateWindowShare } from "./pooledProviderLimits";

describe("rateWindowShare", () => {
  it("leaves nothing included in a spent allowance that overage lets work go on past", () => {
    const window: ProviderRateLimitWindow = {
      window: "five_hour",
      status: "exhausted",
      utilization: 0.95,
      observedAt: decodeUtcTimestamp("2026-11-26T10:00:00.000Z"),
      overage: { status: "allowed" },
    };
    expect(rateWindowShare(window)).toEqual({ remainingPercent: 0, exhausted: false });
  });
});
