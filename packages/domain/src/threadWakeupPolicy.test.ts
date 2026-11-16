import { describe, expect, it } from "vitest";
import {
  admitThreadWakeup,
  nextThreadWakeupFire,
  nextWakeupCronFire,
  parseWakeupCron,
  planCronWakeup,
  planDelayedWakeup,
  threadWakeupDue,
} from "./threadWakeupPolicy";

// Built from local fields: cron expressions name the host's local time.
const local = (year: number, month: number, day: number, hour: number, minute: number) =>
  new Date(year, month - 1, day, hour, minute, 0, 0);

describe("thread wake-up policy", () => {
  it("holds a delayed wake-up to between one minute and one hour and says when it did", () => {
    const now = local(2026, 11, 14, 10, 0);
    expect(planDelayedWakeup({ delaySeconds: 300, now })).toEqual({
      status: "planned",
      fireAt: local(2026, 11, 14, 10, 5),
      clampedDelaySeconds: 300,
      wasClamped: false,
    });
    expect(planDelayedWakeup({ delaySeconds: 5, now })).toMatchObject({
      clampedDelaySeconds: 60,
      wasClamped: true,
    });
    expect(planDelayedWakeup({ delaySeconds: 86_400, now })).toMatchObject({
      clampedDelaySeconds: 3_600,
      wasClamped: true,
    });
    expect(planDelayedWakeup({ delaySeconds: "soon", now })).toMatchObject({ status: "refused" });
  });

  it("finds a later minute, never an earlier one, when asked during the repeated hour of a daylight-saving fall-back", () => {
    const previousZone = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      const parsed = parseWakeupCron("*/5 * * * *");
      if (parsed.status !== "parsed") throw new Error("Expected a parsed expression");
      // 06:30Z on 1 November 2026 is 01:30 in New York's second, standard-time 01:00 hour.
      expect(nextWakeupCronFire(parsed.cron, new Date("2026-11-01T06:30:00Z"))).toEqual(
        new Date("2026-11-01T06:35:00Z"),
      );
      // The last minute of the first, daylight-time 01:00 hour moves on into the second.
      expect(nextWakeupCronFire(parsed.cron, new Date("2026-11-01T05:58:00Z"))).toEqual(
        new Date("2026-11-01T06:00:00Z"),
      );
    } finally {
      if (previousZone === undefined) delete process.env.TZ;
      else process.env.TZ = previousZone;
    }
  });

  it("finds the next local minute a cron expression matches, reading both day fields as either", () => {
    const parsed = parseWakeupCron("30 14 * * *");
    if (parsed.status !== "parsed") throw new Error("Expected a parsed expression");
    expect(nextWakeupCronFire(parsed.cron, local(2026, 11, 14, 14, 29))).toEqual(
      local(2026, 11, 14, 14, 30),
    );
    expect(nextWakeupCronFire(parsed.cron, local(2026, 11, 14, 14, 30))).toEqual(
      local(2026, 11, 15, 14, 30),
    );
    // The 1st of the month or any Monday.
    const either = parseWakeupCron("0 9 1 * 1");
    if (either.status !== "parsed") throw new Error("Expected a parsed expression");
    expect(nextWakeupCronFire(either.cron, local(2026, 11, 14, 12, 0))).toEqual(
      local(2026, 11, 16, 9, 0),
    );
    const never = parseWakeupCron("0 0 31 2 *");
    if (never.status !== "parsed") throw new Error("Expected a parsed expression");
    expect(nextWakeupCronFire(never.cron, local(2026, 11, 14, 12, 0))).toBeUndefined();
    expect(parseWakeupCron("every five minutes")).toMatchObject({ status: "refused" });
    expect(parseWakeupCron("61 * * * *")).toMatchObject({ status: "refused" });
  });

  it("lets a recurring wake-up fire as often as every minute, as cron does", () => {
    const now = local(2026, 11, 14, 10, 0);
    expect(planCronWakeup({ cron: "* * * * *", recurring: true, now })).toEqual({
      status: "planned",
      fireAt: local(2026, 11, 14, 10, 1),
      expiresAt: local(2026, 11, 21, 10, 0),
    });
    expect(planCronWakeup({ cron: "*/5 * * * *", recurring: true, now })).toMatchObject({
      status: "planned",
      fireAt: local(2026, 11, 14, 10, 5),
      expiresAt: local(2026, 11, 21, 10, 0),
    });
    // A one-time wake-up fires at its match, at least a minute away.
    expect(planCronWakeup({ cron: "0 * * * *", recurring: false, now })).toEqual({
      status: "planned",
      fireAt: local(2026, 11, 14, 11, 0),
    });
    expect(planCronWakeup({ cron: "0 0 31 2 *", recurring: false, now })).toMatchObject({
      status: "refused",
    });
  });

  it("keeps a recurring wake-up whose later fires come a minute apart", () => {
    const now = local(2026, 11, 14, 9, 55);
    expect(
      planCronWakeup({ cron: "0,10,20,30,40,41 * * * *", recurring: true, now }),
    ).toMatchObject({ status: "planned", fireAt: local(2026, 11, 14, 10, 0) });
  });

  it("refuses a recurring wake-up that first fires after its seven days", () => {
    const now = local(2026, 11, 14, 10, 0);
    // The 1st of December is more than seven days away.
    expect(planCronWakeup({ cron: "0 9 1 12 *", recurring: true, now })).toMatchObject({
      status: "refused",
    });
    expect(planCronWakeup({ cron: "0 9 1 12 *", recurring: false, now })).toMatchObject({
      status: "planned",
    });
  });

  it("caps how many wake-ups a thread may have waiting at the limit set in Settings", () => {
    expect(admitThreadWakeup({ waitingCount: 7, waitingLimit: 8 })).toEqual({
      status: "admitted",
    });
    expect(admitThreadWakeup({ waitingCount: 8, waitingLimit: 8 })).toMatchObject({
      status: "refused",
    });
    expect(admitThreadWakeup({ waitingCount: 8, waitingLimit: 12 })).toEqual({
      status: "admitted",
    });
  });

  it("fires a wake-up on time and calls one that came due while the host was down or asleep missed", () => {
    const hostStartedAt = local(2026, 11, 14, 9, 0);
    const due = local(2026, 11, 14, 10, 0);
    expect(
      threadWakeupDue({ nextFireAt: due, now: local(2026, 11, 14, 9, 59), hostStartedAt }),
    ).toBe("wait");
    expect(
      threadWakeupDue({ nextFireAt: due, now: local(2026, 11, 14, 10, 1), hostStartedAt }),
    ).toBe("fire");
    expect(
      threadWakeupDue({ nextFireAt: due, now: local(2026, 11, 14, 10, 30), hostStartedAt }),
    ).toBe("missed");
    expect(
      threadWakeupDue({
        nextFireAt: due,
        now: local(2026, 11, 14, 11, 0),
        hostStartedAt: local(2026, 11, 14, 10, 59),
      }),
    ).toBe("missed");
  });

  it("follows a recurring wake-up to its next match and stops it at the end of its lifetime", () => {
    expect(
      nextThreadWakeupFire({
        cron: "0 * * * *",
        recurring: true,
        expiresAt: local(2026, 11, 14, 12, 0),
        now: local(2026, 11, 14, 10, 0),
      }),
    ).toEqual(local(2026, 11, 14, 11, 0));
    expect(
      nextThreadWakeupFire({
        cron: "0 * * * *",
        recurring: true,
        expiresAt: local(2026, 11, 14, 12, 0),
        now: local(2026, 11, 14, 12, 0),
      }),
    ).toBeUndefined();
    expect(
      nextThreadWakeupFire({
        cron: "0 * * * *",
        recurring: false,
        expiresAt: undefined,
        now: local(2026, 11, 14, 10, 0),
      }),
    ).toBeUndefined();
  });
});
