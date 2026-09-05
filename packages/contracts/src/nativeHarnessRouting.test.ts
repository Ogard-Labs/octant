import { describe, expect, it } from "vitest";
import {
  DEFAULT_NATIVE_HARNESS_JOB_SLOTS,
  DEFAULT_NATIVE_HARNESS_ROUTING_SETTINGS,
  NATIVE_HARNESS_BUILT_IN_SLOT_IDS,
  NativeHarnessJob,
  decodeNativeHarnessProjectRoutingCommand,
  decodeNativeHarnessRouteDecision,
  decodeNativeHarnessRoutingConfiguration,
  decodeNativeHarnessSlot,
  decodeNativeHarnessSlotId,
  decodeUpdateNativeHarnessRoutingSettings,
} from "./nativeHarnessRouting";

const host = "00000000-0000-4000-8000-0000000000aa";
const at = "2026-09-05T10:00:00.000Z";
const opus = {
  hostId: host,
  providerInstanceId: "00000000-0000-4000-8000-000000000001",
  modelId: "frontier-large",
};
const haiku = {
  hostId: host,
  providerInstanceId: "00000000-0000-4000-8000-000000000002",
  modelId: "small-fast",
  reasoning: "low",
};
const wide = {
  hostId: host,
  providerInstanceId: "00000000-0000-4000-8000-000000000003",
  modelId: "long-context",
};

describe("native harness slots", () => {
  it("keeps the seven built-in slot ids the jobs default onto", () => {
    expect([...NATIVE_HARNESS_BUILT_IN_SLOT_IDS]).toEqual([
      "default",
      "plan",
      "slow",
      "task",
      "smol",
      "vision",
      "advisor",
    ]);
    for (const id of NATIVE_HARNESS_BUILT_IN_SLOT_IDS) {
      expect(decodeNativeHarnessSlotId(id)).toBe(id);
    }
  });

  it("accepts a custom slot id in the same shape and refuses one that is not", () => {
    expect(decodeNativeHarnessSlotId("cheap-reads")).toBe("cheap-reads");
    expect(() => decodeNativeHarnessSlotId("Cheap Reads")).toThrow();
    expect(() => decodeNativeHarnessSlotId("-leading")).toThrow();
  });

  it("maps every job to a slot by default so no job is ever unrouted", () => {
    const mapped = new Set(DEFAULT_NATIVE_HARNESS_JOB_SLOTS.map((binding) => binding.job));
    expect([...mapped].sort()).toEqual([...NativeHarnessJob.literals].sort());
    expect(DEFAULT_NATIVE_HARNESS_JOB_SLOTS.find((b) => b.job === "reviewer")?.slotId).toBe("slow");
    expect(DEFAULT_NATIVE_HARNESS_JOB_SLOTS.find((b) => b.job === "compaction")?.slotId).toBe(
      "smol",
    );
  });

  it("starts a fresh host with bindings but no configured slots", () => {
    expect(DEFAULT_NATIVE_HARNESS_ROUTING_SETTINGS.configuration.slots).toEqual([]);
    expect(DEFAULT_NATIVE_HARNESS_ROUTING_SETTINGS.configuration.jobSlots.length).toBe(
      NativeHarnessJob.literals.length,
    );
  });

  it("orders a slot's candidates primary first and refuses a duplicate entry", () => {
    const slot = decodeNativeHarnessSlot({ id: "task", candidates: [haiku, opus] });
    expect(slot.candidates[0]?.modelId).toBe("small-fast");
    expect(() => decodeNativeHarnessSlot({ id: "task", candidates: [haiku, haiku] })).toThrow();
    expect(() => decodeNativeHarnessSlot({ id: "task", candidates: [] })).toThrow();
  });

  it("refuses an overflow promotion target that already sits in the failure chain", () => {
    expect(
      decodeNativeHarnessSlot({ id: "default", candidates: [opus], overflowPromotion: wide })
        .overflowPromotion?.modelId,
    ).toBe("long-context");
    expect(() =>
      decodeNativeHarnessSlot({ id: "default", candidates: [opus, wide], overflowPromotion: wide }),
    ).toThrow();
  });

  it("refuses a configuration that names one slot or one job twice", () => {
    expect(() =>
      decodeNativeHarnessRoutingConfiguration({
        slots: [
          { id: "default", candidates: [opus] },
          { id: "default", candidates: [haiku] },
        ],
        jobSlots: [],
      }),
    ).toThrow();
    expect(() =>
      decodeNativeHarnessRoutingConfiguration({
        slots: [],
        jobSlots: [
          { job: "lead", slotId: "default" },
          { job: "lead", slotId: "plan" },
        ],
      }),
    ).toThrow();
  });

  it("lets a binding name a slot that is not configured, leaving the warning to resolution", () => {
    const configuration = decodeNativeHarnessRoutingConfiguration({
      slots: [{ id: "default", candidates: [opus] }],
      jobSlots: [{ job: "reviewer", slotId: "slow" }],
    });
    expect(configuration.jobSlots[0]?.slotId).toBe("slow");
  });
});

describe("native harness routing commands", () => {
  it("carries an expected version and refuses excess properties", () => {
    const update = decodeUpdateNativeHarnessRoutingSettings({
      configuration: { slots: [], jobSlots: [] },
      expectedVersion: 4,
    });
    expect(update.expectedVersion).toBe(4);
    expect(() =>
      decodeUpdateNativeHarnessRoutingSettings({
        configuration: { slots: [], jobSlots: [] },
        expectedVersion: 4,
        vendorPriority: ["anyone"],
      }),
    ).toThrow();
  });

  it("clears a Project override without carrying a configuration", () => {
    const cleared = decodeNativeHarnessProjectRoutingCommand({
      kind: "clear-project-routing-override",
      projectId: "00000000-0000-4000-8000-0000000000cc",
      expectedVersion: 1,
    });
    expect(cleared.kind).toBe("clear-project-routing-override");
  });
});

describe("native harness route decisions", () => {
  const base = { job: "lead", decidedAt: at, rejected: [] } as const;

  it("records the primary route with nothing rejected", () => {
    const decision = decodeNativeHarnessRouteDecision({
      ...base,
      kind: "primary",
      slotId: "default",
      candidate: opus,
    });
    expect(decision.kind).toBe("primary");
  });

  it("refuses a failure fallback that lands on the candidate it left", () => {
    expect(() =>
      decodeNativeHarnessRouteDecision({
        ...base,
        kind: "failure-fallback",
        slotId: "default",
        candidate: opus,
        from: opus,
        reason: "rate-limited",
        cooldownUntil: at,
      }),
    ).toThrow();
    const stepped = decodeNativeHarnessRouteDecision({
      ...base,
      kind: "failure-fallback",
      slotId: "default",
      candidate: haiku,
      from: opus,
      reason: "rate-limited",
      cooldownUntil: at,
    });
    expect(stepped.kind).toBe("failure-fallback");
  });

  it("only promotes for overflow when the request really did not fit the window", () => {
    const promotion = {
      ...base,
      kind: "overflow-promotion",
      slotId: "default",
      candidate: wide,
      from: opus,
      requiredTokens: 250_000,
      windowTokens: 200_000,
    };
    expect(decodeNativeHarnessRouteDecision(promotion).kind).toBe("overflow-promotion");
    expect(() =>
      decodeNativeHarnessRouteDecision({ ...promotion, requiredTokens: 100_000 }),
    ).toThrow();
  });

  it("records an unconfigured slot as a warning that resolved somewhere else", () => {
    const warned = decodeNativeHarnessRouteDecision({
      ...base,
      job: "reviewer",
      kind: "unconfigured-slot",
      requestedSlotId: "slow",
      slotId: "default",
      candidate: opus,
    });
    expect(warned.kind).toBe("unconfigured-slot");
    expect(() =>
      decodeNativeHarnessRouteDecision({
        ...base,
        kind: "unconfigured-slot",
        requestedSlotId: "default",
        slotId: "default",
        candidate: opus,
      }),
    ).toThrow();
    // `default` is the only place an unconfigured slot may land.
    expect(() =>
      decodeNativeHarnessRouteDecision({
        ...base,
        kind: "unconfigured-slot",
        requestedSlotId: "slow",
        slotId: "task",
        candidate: opus,
      }),
    ).toThrow();
  });

  it("cannot claim no candidate was eligible without saying which were refused and why", () => {
    expect(() =>
      decodeNativeHarnessRouteDecision({
        ...base,
        kind: "unroutable",
        slotId: "default",
        reason: "no-eligible-candidate",
      }),
    ).toThrow();
    const refused = decodeNativeHarnessRouteDecision({
      ...base,
      kind: "unroutable",
      slotId: "default",
      reason: "no-eligible-candidate",
      rejected: [{ candidate: haiku, reasons: ["mixed-vendor-disabled"] }],
    });
    expect(refused.rejected[0]?.reasons).toEqual(["mixed-vendor-disabled"]);
  });
});
