import { describe, expect, it } from "vitest";
import {
  decodeNativeHarnessSlotCandidate,
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
