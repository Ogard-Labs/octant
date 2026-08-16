import { describe, expect, it } from "vitest";
import type { ProviderRuntimeEvent } from "@octant/contracts";
import {
  ChildAgentAdapterError,
  allGuarantees,
  createChildReconcileEvent,
  createChildResultEvent,
  createChildStopEvent,
  createChildUsageEvent,
  createManagedChildActivity,
  dedupeChildEvents,
  evaluateNativeChildEligibility,
  normalizeProviderChildActivity,
  selectChildExecutionKind,
} from "./childAgentAdapter";

const now = "2026-08-01T12:00:00.000Z";

const nativeActivity = {
  kind: "child-agent-activity",
  instanceId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  sequence: 3,
  correlationId: "33333333-3333-4333-8333-333333333333",
  occurredAt: now,
  childAgentId: "native-child-1",
  status: "running",
  summary: "Native child researching",
} as Extract<ProviderRuntimeEvent, { kind: "child-agent-activity" }>;

describe("childAgentAdapter", () => {
  it("accepts native only when capability and full guarantee matrix are proven", () => {
    const eligible = evaluateNativeChildEligibility({
      claimedNativeSupport: "supported",
      nativeGuaranteeMatrix: allGuarantees(true),
    });
    expect(eligible.eligible).toBe(true);

    const missing = evaluateNativeChildEligibility({
      claimedNativeSupport: "supported",
      nativeGuaranteeMatrix: { ...allGuarantees(true), cancellation: false },
    });
    expect(missing.eligible).toBe(false);
    expect(missing.rejectedReasons).toContain("missing-guarantee:cancellation");
  });

  it("selects native when preferred and eligible", () => {
    const selection = selectChildExecutionKind({
      claimedNativeSupport: "supported",
      nativeGuaranteeMatrix: allGuarantees(true),
      preferredKind: "provider-native",
      managedAvailable: true,
    });
    expect(selection.selectedExecutionKind).toBe("provider-native");
    expect(selection.attemptedExecutionKind).toBe("provider-native");
    expect(selection.selectedFallback).toBeUndefined();
  });

  it("falls back explicitly to managed when native is unavailable", () => {
    const selection = selectChildExecutionKind({
      claimedNativeSupport: "unavailable",
      nativeGuaranteeMatrix: allGuarantees(false),
      preferredKind: "provider-native",
      managedAvailable: true,
    });
    expect(selection.selectedExecutionKind).toBe("octant-managed");
    expect(selection.attemptedExecutionKind).toBe("provider-native");
    expect(selection.selectedFallback?.kind).toBe("octant-managed");
    expect(selection.capabilityDegradations).toContain("native-child-agents-unavailable");
  });

  it("fails closed on native overclaim of full guarantees without support", () => {
    expect(() =>
      selectChildExecutionKind({
        claimedNativeSupport: "unsupported",
        nativeGuaranteeMatrix: allGuarantees(true),
        preferredKind: "provider-native",
        managedAvailable: true,
      }),
    ).toThrow(ChildAgentAdapterError);
  });

  it("fails closed when native preferred but managed fallback is unavailable", () => {
    expect(() =>
      selectChildExecutionKind({
        claimedNativeSupport: "unsupported",
        nativeGuaranteeMatrix: allGuarantees(false),
        preferredKind: "provider-native",
        managedAvailable: false,
      }),
    ).toThrow(/managed fallback is unavailable/i);
  });

  it("normalizes native child activity as transcript-only truth", () => {
    const event = normalizeProviderChildActivity({
      runId: "run-1",
      event: nativeActivity,
      executionKind: "provider-native",
    });
    expect(event.kind).toBe("activity");
    expect(event.nativeChildId).toBe("native-child-1");
    expect(event.transcriptOnly).toBe(true);
    expect(event.orderingKey).toContain("native-child-1");
  });

  it("creates managed activity that is not transcript-only", () => {
    const event = createManagedChildActivity({
      runId: "run-1",
      status: "running",
      summary: "Managed child researching",
      sequence: 1,
      occurredAt: now,
    });
    expect(event.transcriptOnly).toBe(false);
    expect(event.nativeChildId).toBeUndefined();
  });

  it("requires completed result references and stop confirmation semantics", () => {
    expect(() =>
      createChildResultEvent({
        runId: "run-1",
        status: "completed",
        sequence: 2,
        occurredAt: now,
      }),
    ).toThrow(/result reference/i);

    const completed = createChildResultEvent({
      runId: "run-1",
      status: "completed",
      resultReference: "result://child/1",
      sequence: 2,
      occurredAt: now,
    });
    expect(completed.resultReference).toBe("result://child/1");

    const stop = createChildStopEvent({
      runId: "run-1",
      confirmed: false,
      sequence: 3,
      occurredAt: now,
    });
    expect(stop.confirmed).toBe(false);

    const reconcile = createChildReconcileEvent({
      runId: "run-1",
      resumable: false,
      recoveryReason: "restart-without-resumable-execution",
      sequence: 4,
      occurredAt: now,
    });
    expect(reconcile.resumable).toBe(false);
  });

  it("keeps usage quality honest and dedupes by ordering key", () => {
    expect(() =>
      createChildUsageEvent({
        runId: "run-1",
        usageQuality: "unavailable",
        inputTokens: 12,
        sequence: 1,
        occurredAt: now,
      }),
    ).toThrow(/token counts/i);

    const first = createManagedChildActivity({
      runId: "run-1",
      status: "running",
      summary: "A",
      sequence: 1,
      occurredAt: now,
    });
    const duplicate = createManagedChildActivity({
      runId: "run-1",
      status: "running",
      summary: "A-dup",
      sequence: 1,
      occurredAt: now,
    });
    const { applied, duplicates } = dedupeChildEvents([first, duplicate]);
    expect(applied).toHaveLength(1);
    expect(duplicates).toHaveLength(1);
    expect(applied[0]?.kind === "activity" ? applied[0].summary : undefined).toBe("A");
  });
});
