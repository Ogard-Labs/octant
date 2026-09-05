import { describe, expect, it } from "vitest";
import {
  decodeNativeHarnessSlotCandidate,
  decodeUtcTimestamp,
  type NativeHarnessRoutingConfiguration,
} from "@octant/contracts";
import { nativeHarnessJobForRole, resolveNativeHarnessRoute } from "./nativeHarnessRoutingPolicy";

const host = "00000000-0000-4000-8000-0000000000aa";
const now = decodeUtcTimestamp("2026-09-05T12:00:00.000Z");
const later = decodeUtcTimestamp("2026-09-05T12:05:00.000Z");
const big = decodeNativeHarnessSlotCandidate({
  hostId: host,
  providerInstanceId: "00000000-0000-4000-8000-000000000001",
  modelId: "big",
});
const small = decodeNativeHarnessSlotCandidate({
  hostId: host,
  providerInstanceId: "00000000-0000-4000-8000-000000000002",
  modelId: "small",
});
const spare = decodeNativeHarnessSlotCandidate({
  hostId: host,
  providerInstanceId: "00000000-0000-4000-8000-000000000003",
  modelId: "spare",
});

const configured: NativeHarnessRoutingConfiguration = {
  slots: [
    { id: "default" as never, candidates: [big, spare] },
    { id: "task" as never, candidates: [small] },
  ],
  jobSlots: [],
};
const allReady = () => ({ ready: true });

describe("native harness route resolution", () => {
  it("maps a child's role onto the job the harness routes", () => {
    expect(nativeHarnessJobForRole("research")).toBe("researcher");
    expect(nativeHarnessJobForRole("implementation")).toBe("implementer");
    expect(nativeHarnessJobForRole("review")).toBe("reviewer");
  });

  it("sends a researcher to the task slot's primary and the lead to default", () => {
    const researcher = resolveNativeHarnessRoute({
      job: "researcher",
      host: configured,
      facts: allReady,
      now,
    });
    expect(researcher).toMatchObject({ kind: "primary", slotId: "task", candidate: small });
    const lead = resolveNativeHarnessRoute({ job: "lead", host: configured, facts: allReady, now });
    expect(lead).toMatchObject({ kind: "primary", slotId: "default", candidate: big });
  });

  it("warns and routes to default when a job's slot is not configured", () => {
    const decision = resolveNativeHarnessRoute({
      job: "reviewer",
      host: configured,
      facts: allReady,
      now,
    });
    expect(decision).toMatchObject({
      kind: "unconfigured-slot",
      requestedSlotId: "slow",
      slotId: "default",
      candidate: big,
    });
  });

  it("steps to the next ready candidate while the primary cools down, and says why", () => {
    const decision = resolveNativeHarnessRoute({
      job: "lead",
      host: configured,
      facts: (candidate) =>
        candidate.modelId === "big"
          ? { ready: true, coolingDown: { reason: "rate-limited", until: later } }
          : { ready: true },
      now,
    });
    expect(decision).toMatchObject({
      kind: "failure-fallback",
      candidate: spare,
      from: big,
      reason: "rate-limited",
      cooldownUntil: later,
    });
    expect(decision.rejected).toEqual([{ candidate: big, reasons: ["provider-not-ready"] }]);
  });

  it("prefers a Project's own slot over the host's", () => {
    const decision = resolveNativeHarnessRoute({
      job: "lead",
      host: configured,
      project: { slots: [{ id: "default" as never, candidates: [small] }], jobSlots: [] },
      facts: allReady,
      now,
    });
    expect(decision).toMatchObject({ kind: "primary", candidate: small });
  });

  it("refuses with every rejection listed when no candidate is ready", () => {
    const decision = resolveNativeHarnessRoute({
      job: "lead",
      host: configured,
      facts: () => ({ ready: false }),
      now,
    });
    expect(decision.kind).toBe("unroutable");
    expect(decision.rejected).toHaveLength(2);
  });

  it("refuses the whole slot while its circuit breaker is open", () => {
    const decision = resolveNativeHarnessRoute({
      job: "lead",
      host: configured,
      facts: allReady,
      circuitOpen: () => true,
      now,
    });
    expect(decision).toMatchObject({ kind: "unroutable", reason: "circuit-open" });
  });

  it("reports an empty configuration as unroutable rather than inventing a vendor", () => {
    const decision = resolveNativeHarnessRoute({
      job: "lead",
      host: { slots: [], jobSlots: [] },
      facts: allReady,
      now,
    });
    expect(decision).toMatchObject({ kind: "unroutable", reason: "slot-empty" });
  });
});
