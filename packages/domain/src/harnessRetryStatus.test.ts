import {
  decodeProviderRuntimeEvent,
  decodeUtcTimestamp,
  type HarnessRetryNotice,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { harnessRetryRemainingMs, harnessRetryStatusText } from "./harnessRetryStatus";
import { observeTurnMetrics, startTurnMetrics } from "./turnMetricsPolicy";

const announcedAt = "2026-10-06T12:00:00.000Z";
const announcedMs = Date.parse(announcedAt);

function notice(overrides: Partial<HarnessRetryNotice> = {}): HarnessRetryNotice {
  return {
    attempt: 2,
    maxAttempts: 5,
    delayMs: 4_000,
    reason: "unavailable",
    announcedAt: decodeUtcTimestamp(announcedAt),
    ...overrides,
  };
}

describe("harness retry status", () => {
  it("words a quiet retry as the attempt about to start and the wait still left", () => {
    expect(harnessRetryStatusText(notice(), announcedMs)).toBe(
      "Provider busy, retrying 2/5 in 4 s",
    );
  });

  it("counts the wait down and holds at zero until content clears it", () => {
    const waiting = notice();
    expect(harnessRetryRemainingMs(waiting, announcedMs + 1_000)).toBe(3_000);
    expect(harnessRetryStatusText(waiting, announcedMs + 1_000)).toBe(
      "Provider busy, retrying 2/5 in 3 s",
    );
    expect(harnessRetryStatusText(waiting, announcedMs + 4_000)).toBe(
      "Provider busy, retrying 2/5 in 0 s",
    );
    expect(harnessRetryStatusText(waiting, announcedMs + 9_000)).toBe(
      "Provider busy, retrying 2/5 in 0 s",
    );
  });

  it("counts the same retrying event the turn stats line counts", () => {
    const event = decodeProviderRuntimeEvent({
      kind: "retrying",
      attempt: 2,
      maxAttempts: 5,
      delayMs: 4_000,
      reason: "unavailable",
      occurredAt: announcedAt,
      instanceId: "00000000-0000-4000-8000-000000000001",
      sessionId: "00000000-0000-4000-8000-000000000002",
      sequence: 1,
      correlationId: "00000000-0000-4000-8000-000000000003",
    });
    if (event.kind !== "retrying") throw new Error("Expected a retrying event.");
    const measured = observeTurnMetrics(startTurnMetrics(announcedAt), event);
    expect(measured.retries).toBe(1);
    expect(
      harnessRetryStatusText(
        {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          reason: event.reason,
          announcedAt: event.occurredAt,
        },
        announcedMs,
      ),
    ).toBe("Provider busy, retrying 2/5 in 4 s");
  });
});
