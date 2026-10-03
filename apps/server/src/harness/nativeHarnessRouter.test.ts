import { describe, expect, it } from "vitest";
import {
  decodeNativeHarnessSlotCandidate,
  decodeUtcTimestamp,
  DEFAULT_NATIVE_HARNESS_ROUTING_SETTINGS,
  NATIVE_HARNESS_BUILT_IN_SLOTS,
  type NativeHarnessRoutingSettings,
} from "@octant/contracts";
import { NativeHarnessRouter } from "./nativeHarnessRouter";

const host = "00000000-0000-4000-8000-0000000000aa";
const big = decodeNativeHarnessSlotCandidate({
  hostId: host,
  providerInstanceId: "00000000-0000-4000-8000-000000000001",
  modelId: "big",
});
const spare = decodeNativeHarnessSlotCandidate({
  hostId: host,
  providerInstanceId: "00000000-0000-4000-8000-000000000002",
  modelId: "spare",
});

function router(now: () => number) {
  const settings: NativeHarnessRoutingSettings = {
    configuration: {
      slots: [{ id: "default" as never, candidates: [big, spare] }],
      jobSlots: [],
    },
    version: 1 as never,
    updatedAt: "2026-09-05T12:00:00.000Z" as never,
  };
  return new NativeHarnessRouter({
    store: { host: () => settings, projectOverride: () => undefined },
    isReady: () => true,
    now,
  });
}

describe("native harness router", () => {
  it("only inherits an offered parent while its cooldown and the empty slot's breaker allow it", () => {
    let clock = 1_000_000;
    const subject = new NativeHarnessRouter({
      store: {
        host: () => ({
          ...DEFAULT_NATIVE_HARNESS_ROUTING_SETTINGS,
          updatedAt: decodeUtcTimestamp("2026-10-03T10:00:00.000Z"),
        }),
        projectOverride: () => undefined,
      },
      isReady: () => true,
      now: () => clock,
    });
    expect(subject.resolve({ job: "researcher" })).toMatchObject({
      kind: "unroutable",
      reason: "slot-empty",
    });
    const input = { job: "researcher", inheritParent: big } as const;
    expect(subject.resolve(input)).toMatchObject({ kind: "inherited-parent", candidate: big });
    subject.reportFailure({
      slotId: NATIVE_HARNESS_BUILT_IN_SLOTS.task,
      candidate: big,
      reason: "rate-limited",
      retryAfterMs: 1_000,
    });
    expect(subject.resolve(input)).toMatchObject({
      kind: "unroutable",
      reason: "no-eligible-candidate",
      rejected: [{ candidate: big }],
    });
    clock += 1_001;
    expect(subject.resolve(input)).toMatchObject({ kind: "inherited-parent", candidate: big });
    for (let index = 0; index < 4; index += 1)
      subject.reportFailure({
        slotId: NATIVE_HARNESS_BUILT_IN_SLOTS.task,
        candidate: big,
        reason: "server-error",
      });
    expect(subject.resolve(input)).toMatchObject({ kind: "unroutable", reason: "circuit-open" });
  });

  it("steps around a candidate that just failed and reverts once its cooldown expires", () => {
    let clock = 1_000_000;
    const subject = router(() => clock);
    expect(subject.resolve({ job: "lead" })).toMatchObject({ kind: "primary", candidate: big });
    subject.reportFailure({
      slotId: "default" as never,
      candidate: big,
      reason: "rate-limited",
      retryAfterMs: 30_000,
    });
    expect(subject.resolve({ job: "lead" })).toMatchObject({
      kind: "failure-fallback",
      candidate: spare,
      from: big,
      reason: "rate-limited",
    });
    clock += 31_000;
    expect(subject.resolve({ job: "lead" })).toMatchObject({ kind: "primary", candidate: big });
  });

  it("uses only configured fallbacks allowed by the calling parent's policy", () => {
    const subject = router(() => 1_000_000);
    expect(
      subject.resolve({
        job: "lead",
        isEligible: (candidate) => candidate.modelId === spare.modelId,
      }),
    ).toMatchObject({ kind: "failure-fallback", candidate: spare });
    expect(subject.resolve({ job: "lead", isEligible: () => false })).toMatchObject({
      kind: "unroutable",
      reason: "no-eligible-candidate",
    });
    expect(subject.resolve({ job: "lead" })).toMatchObject({ kind: "primary", candidate: big });
  });

  it("opens the slot's breaker after repeated failures so a tight loop cannot burn the chain", () => {
    let clock = 1_000_000;
    const subject = router(() => clock);
    for (let index = 0; index < 5; index += 1) {
      subject.reportFailure({
        slotId: "default" as never,
        candidate: index % 2 === 0 ? big : spare,
        reason: "server-error",
      });
      clock += 100;
    }
    expect(subject.resolve({ job: "lead" })).toMatchObject({
      kind: "unroutable",
      reason: "circuit-open",
    });
    clock += 61_000;
    expect(subject.resolve({ job: "lead" }).kind).not.toBe("unroutable");
  });
});
