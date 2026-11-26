import { describe, expect, it, vi } from "vitest";
import type { ProviderUsageLimit, UtcTimestamp } from "@octant/contracts";
import {
  PersonSentTurns,
  UsageLimitDefaults,
  usageLimitStopOf,
  type UsageLimitDefaultsOptions,
  type UsageLimitStop,
} from "./usageLimitDefaults";

const NOW = new Date("2026-07-19T12:00:00.000Z");
const AHEAD = "2026-07-19T13:00:00.000Z" as UtcTimestamp;
const PASSED = "2026-07-19T11:00:00.000Z" as UtcTimestamp;
const THREAD = "40000000-0000-4000-8000-000000000001";
const TURN = "40000000-0000-4000-8000-000000000002";

const stop = (usageLimit: ProviderUsageLimit, turnId = TURN): UsageLimitStop => ({
  mode: "work",
  threadId: THREAD,
  turnId,
  usageLimit,
});

function defaults(
  overrides: Partial<UsageLimitDefaultsOptions> = {},
  sent: ReadonlyArray<string> = [TURN],
) {
  const people = new PersonSentTurns();
  for (const turnId of sent) people.note("work", turnId);
  const scheduleResume = vi.fn(async () => undefined);
  const snoozeAtReset = vi.fn(async () => undefined);
  const service = new UsageLimitDefaults({
    settings: () => ({ resumeAtReset: true, snoozeUntilReset: true }),
    personSent: (mode, turnId) => people.sent(mode, turnId),
    providerInstanceOf: () => "provider-1",
    refusesHostContinuations: () => false,
    clock: () => NOW,
    scheduleResume,
    snoozeAtReset,
    ...overrides,
  });
  return { service, scheduleResume, snoozeAtReset };
}

describe("usage-limit defaults", () => {
  it("arm nothing while both settings are off, as they are by default", async () => {
    const { service, scheduleResume, snoozeAtReset } = defaults({
      settings: () => ({ resumeAtReset: false, snoozeUntilReset: false }),
    });
    await service.arm(stop({ kind: "exhausted", resetsAt: AHEAD }));
    expect(scheduleResume).not.toHaveBeenCalled();
    expect(snoozeAtReset).not.toHaveBeenCalled();
  });

  it("arm the resume and the snooze for a person's turn stopped with a reset ahead", async () => {
    const { service, scheduleResume, snoozeAtReset } = defaults();
    const armed = await service.arm(stop({ kind: "temporary", resetsAt: AHEAD }));
    expect(armed).toEqual({ resumed: true, snoozed: true });
    expect(scheduleResume).toHaveBeenCalledTimes(1);
    expect(snoozeAtReset).toHaveBeenCalledTimes(1);
  });

  it("arm only the setting that is on", async () => {
    const { service, scheduleResume, snoozeAtReset } = defaults({
      settings: () => ({ resumeAtReset: false, snoozeUntilReset: true }),
    });
    await service.arm(stop({ kind: "exhausted", resetsAt: AHEAD }));
    expect(scheduleResume).not.toHaveBeenCalled();
    expect(snoozeAtReset).toHaveBeenCalledTimes(1);
  });

  it("never arm for a billing stop, an unknown reset or a reset already passed", async () => {
    const { service, scheduleResume, snoozeAtReset } = defaults();
    await service.arm(stop({ kind: "billing", resetsAt: AHEAD }));
    await service.arm(stop({ kind: "exhausted" }));
    await service.arm(stop({ kind: "exhausted", resetsAt: PASSED }));
    expect(scheduleResume).not.toHaveBeenCalled();
    expect(snoozeAtReset).not.toHaveBeenCalled();
  });

  it("never arm for a turn no person sent", async () => {
    const { service, scheduleResume, snoozeAtReset } = defaults({}, []);
    await service.arm(stop({ kind: "exhausted", resetsAt: AHEAD }));
    expect(scheduleResume).not.toHaveBeenCalled();
    expect(snoozeAtReset).not.toHaveBeenCalled();
  });

  it("never arm a resume on an account that refuses the host's continuations, but still snooze", async () => {
    const { service, scheduleResume, snoozeAtReset } = defaults({
      refusesHostContinuations: () => true,
    });
    const armed = await service.arm(stop({ kind: "exhausted", resetsAt: AHEAD }));
    expect(armed).toEqual({ resumed: false, snoozed: true });
    expect(scheduleResume).not.toHaveBeenCalled();
    expect(snoozeAtReset).toHaveBeenCalledTimes(1);
  });

  it("a cancelled default stays cancelled: the same stop is armed once", async () => {
    const { service, scheduleResume } = defaults({
      settings: () => ({ resumeAtReset: true, snoozeUntilReset: false }),
    });
    const limited = stop({ kind: "exhausted", resetsAt: AHEAD });
    await service.arm(limited);
    // The person cancels; the stop is journaled again (another projection
    // update of the same waiting turn).
    await service.arm(limited);
    expect(scheduleResume).toHaveBeenCalledTimes(1);
  });

  it("reads a waiting usage-limited Work turn update as a stop, and nothing else", () => {
    const envelope = (status: string, usageLimit?: ProviderUsageLimit) =>
      ({
        eventName: "work.turn-updated@1",
        payload: {
          kind: "turn-updated",
          requestId: "40000000-0000-4000-8000-000000000003",
          threadId: THREAD,
          turnId: TURN,
          status,
          ...(usageLimit === undefined
            ? {}
            : { failure: { category: "rate-limited", message: "Limit.", usageLimit } }),
          updatedAt: NOW.toISOString(),
        },
      }) as never;
    expect(usageLimitStopOf(envelope("waiting", { kind: "exhausted", resetsAt: AHEAD }))).toEqual(
      stop({ kind: "exhausted", resetsAt: AHEAD }),
    );
    expect(usageLimitStopOf(envelope("completed"))).toBeUndefined();
    expect(usageLimitStopOf(envelope("waiting"))).toBeUndefined();
  });
});
