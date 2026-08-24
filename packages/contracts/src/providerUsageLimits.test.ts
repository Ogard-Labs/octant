import { describe, expect, it } from "vitest";
import { decodeProviderUsageLimitsSnapshot } from "./providerUsageLimits";
import type { ProviderInstanceId } from "./providers";

const providerInstanceId = "11111111-1111-4111-8111-111111111111" as ProviderInstanceId;

describe("provider usage limits", () => {
  it("keeps unavailable limits distinct from zero capacity", () => {
    const snapshot = decodeProviderUsageLimitsSnapshot({
      version: 1,
      refreshedAt: "2026-08-23T12:00:00.000Z",
      entries: [
        {
          providerInstanceId,
          status: "unavailable",
          source: "provider-runtime",
          reason: "unsupported",
          observedAt: "2026-08-23T12:00:00.000Z",
        },
      ],
    });

    expect(snapshot.entries[0]).toMatchObject({ status: "unavailable", reason: "unsupported" });
    expect(snapshot.entries[0]).not.toHaveProperty("limits");
  });

  it("represents a failed refresh with the last successful limits visibly stale", () => {
    const snapshot = decodeProviderUsageLimitsSnapshot({
      version: 1,
      refreshedAt: "2026-08-23T12:05:00.000Z",
      entries: [
        {
          providerInstanceId,
          status: "failed",
          source: "provider-runtime",
          observedAt: "2026-08-23T12:05:00.000Z",
          failure: {
            category: "rate-limited",
            message: "Refresh is rate limited.",
            retryAt: "2026-08-23T12:10:00.000Z",
          },
          staleLimits: {
            providerInstanceId,
            scope: "account",
            requests: { status: "available", limit: 100, remaining: 40 },
            tokens: { status: "unavailable" },
            concurrency: { status: "unavailable" },
            retry: { status: "inactive" },
            quota: "available",
            source: "observed-evidence",
            confidence: "high",
            updatedAt: "2026-08-23T11:55:00.000Z",
          },
          lastSuccessfulAt: "2026-08-23T11:55:00.000Z",
        },
      ],
    });

    expect(snapshot.entries[0]).toMatchObject({
      status: "failed",
      staleLimits: { requests: { remaining: 40 } },
    });
  });

  it("rejects raw provider payloads and excess account data", () => {
    expect(() =>
      decodeProviderUsageLimitsSnapshot({
        version: 1,
        refreshedAt: "2026-08-23T12:00:00.000Z",
        entries: [
          {
            providerInstanceId,
            status: "unavailable",
            source: "provider-runtime",
            reason: "unsupported",
            observedAt: "2026-08-23T12:00:00.000Z",
            rawResponse: "must not cross",
          },
        ],
      }),
    ).toThrow();
  });
});
