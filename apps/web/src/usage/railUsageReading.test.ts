import { decodeProviderUsageLimitsSnapshot } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { railUsageReadings, resetPhrase, windowHours } from "./railUsageReading";

const now = Date.parse("2026-10-20T12:00:00.000Z");
const providerInstanceId = "10000000-0000-4000-8000-000000000001";

function entries(entry: unknown) {
  return decodeProviderUsageLimitsSnapshot({
    version: 1,
    refreshedAt: "2026-10-20T12:00:00.000Z",
    entries: [entry],
  }).entries;
}

describe("rail usage rings", () => {
  it("draws the week as the outer arc and five hours as the inner one, as % left", () => {
    const [reading] = railUsageReadings(
      entries({
        providerInstanceId,
        status: "available",
        source: "provider-runtime",
        observedAt: "2026-10-20T12:00:00.000Z",
        limits: {
          providerInstanceId,
          scope: "account",
          requests: { status: "unavailable" },
          tokens: { status: "unavailable" },
          concurrency: { status: "unavailable" },
          retry: { status: "inactive" },
          quota: "available",
          source: "observed-evidence",
          confidence: "high",
          updatedAt: "2026-10-20T12:00:00.000Z",
          rateLimitWindows: [
            {
              window: "five_hour",
              status: "allowed",
              utilization: 0.15,
              resetsAt: "2026-10-20T14:52:00.000Z",
              observedAt: "2026-10-20T12:00:00.000Z",
            },
            {
              window: "seven_day",
              status: "allowed",
              utilization: 0.57,
              observedAt: "2026-10-20T12:00:00.000Z",
            },
          ],
        },
      }),
      now,
    );
    expect(reading?.outer).toMatchObject({ window: "seven_day", percent: 43 });
    expect(reading?.inner).toMatchObject({ window: "five_hour", percent: 85 });
    expect(resetPhrase(reading?.resetsAt.get("five_hour"), now)).toBe("Resets in 2h 52m");
  });

  it("picks the arcs by window length when the provider scopes its window ids", () => {
    const window = (id: string, utilization: number) => ({
      window: id,
      status: "allowed",
      utilization,
      observedAt: "2026-10-20T12:00:00.000Z",
    });
    const [reading] = railUsageReadings(
      entries({
        providerInstanceId,
        status: "available",
        source: "provider-runtime",
        observedAt: "2026-10-20T12:00:00.000Z",
        limits: {
          providerInstanceId,
          scope: "account",
          requests: { status: "unavailable" },
          tokens: { status: "unavailable" },
          concurrency: { status: "unavailable" },
          retry: { status: "inactive" },
          quota: "available",
          source: "observed-evidence",
          confidence: "high",
          updatedAt: "2026-10-20T12:00:00.000Z",
          rateLimitWindows: [window("codex:secondary_7d", 0.2), window("codex:primary_5h", 0.1)],
        },
      }),
      now,
    );
    expect(reading?.outer).toMatchObject({ window: "codex:secondary_7d", percent: 80 });
    expect(reading?.inner).toMatchObject({ window: "codex:primary_5h", percent: 90 });
  });

  it("treats a monthly window as the longest, so five hours and the month are the pair", () => {
    const window = (id: string, utilization: number) => ({
      window: id,
      status: "allowed",
      utilization,
      observedAt: "2026-10-20T12:00:00.000Z",
    });
    const [reading] = railUsageReadings(
      entries({
        providerInstanceId,
        status: "available",
        source: "provider-runtime",
        observedAt: "2026-10-20T12:00:00.000Z",
        limits: {
          providerInstanceId,
          scope: "account",
          requests: { status: "unavailable" },
          tokens: { status: "unavailable" },
          concurrency: { status: "unavailable" },
          retry: { status: "inactive" },
          quota: "available",
          source: "observed-evidence",
          confidence: "high",
          updatedAt: "2026-10-20T12:00:00.000Z",
          rateLimitWindows: [
            window("five_hour", 0.15),
            window("seven_day", 0.3),
            window("monthly", 0.6),
          ],
        },
      }),
      now,
    );
    expect(reading?.inner).toMatchObject({ window: "five_hour", percent: 85 });
    expect(reading?.outer).toMatchObject({ window: "monthly", percent: 40 });
    expect(windowHours("monthly")).toBeGreaterThan(windowHours("seven_day"));
  });

  it("gives no ring to a provider that reported no window figure", () => {
    expect(
      railUsageReadings(
        entries({
          providerInstanceId,
          status: "unavailable",
          source: "provider-runtime",
          reason: "unsupported",
          observedAt: "2026-10-20T12:00:00.000Z",
        }),
        now,
      ),
    ).toEqual([]);
  });
});
