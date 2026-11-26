import { describe, expect, it } from "vitest";
import { currentUsageLimitStop, limitedThreadFact } from "./usageLimitStopPolicy";

const resetsAt = "2026-07-19T13:00:00.000Z" as never;
const limit = { kind: "exhausted", resetsAt } as const;
const stop = { state: "waiting", limit, turnId: "turn-1" };
const resume = (status: "scheduled" | "dispatched", turnId = "turn-1") =>
  ({
    status,
    record: { turnId },
  }) as never;

describe("the current usage-limit stop", () => {
  it("holds while the latest turn waits on a limit", () => {
    expect(currentUsageLimitStop({}, stop)?.limit).toEqual(limit);
  });

  it("is gone once the turn runs, ends, or stopped on something other than a limit", () => {
    expect(currentUsageLimitStop({}, { ...stop, state: "running" })).toBeUndefined();
    expect(currentUsageLimitStop({}, { ...stop, state: "completed" })).toBeUndefined();
    expect(currentUsageLimitStop({}, { ...stop, limit: undefined })).toBeUndefined();
    expect(currentUsageLimitStop({}, undefined)).toBeUndefined();
  });

  it("drops a released stop unless a resume is still scheduled for it", () => {
    const released = { providerHandoff: { releasedStopId: "turn-1" } };
    expect(currentUsageLimitStop(released, stop)).toBeUndefined();
    expect(
      currentUsageLimitStop({ ...released, usageResume: resume("dispatched") }, stop),
    ).toBeUndefined();
    expect(
      currentUsageLimitStop({ ...released, usageResume: resume("scheduled", "turn-0") }, stop),
    ).toBeUndefined();
    expect(
      currentUsageLimitStop({ ...released, usageResume: resume("scheduled") }, stop)?.released,
    ).toBe(true);
  });

  it("matches a Chat stop on its attempt, not only its turn", () => {
    const attempt = { ...stop, attemptId: "attempt-2" };
    const earlier = {
      status: "scheduled",
      record: { turnId: "turn-1", attemptId: "attempt-1" },
    } as never;
    expect(currentUsageLimitStop({ usageResume: earlier }, attempt)?.resume).toBeUndefined();
    expect(currentUsageLimitStop({ releasedStopId: "attempt-2" }, attempt)).toBeUndefined();
  });

  it("names the reset a row counts down to, and none for a billing stop", () => {
    expect(limitedThreadFact(limit)).toEqual({ resetsAt });
    expect(limitedThreadFact({ kind: "exhausted" })).toEqual({});
    expect(limitedThreadFact({ kind: "billing", resetsAt })).toEqual({});
  });
});
