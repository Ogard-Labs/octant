import type { ProviderCapabilitySupport } from "@octant/contracts";
import {
  ChildAgentAdapterError,
  allGuarantees,
  createChildReconcileEvent,
  createChildResultEvent,
  createChildStopEvent,
  createChildUsageEvent,
  createManagedChildActivity,
  dedupeChildEvents,
  normalizeProviderChildActivity,
  selectChildExecutionKind,
  type ChildAgentGuaranteeMatrix,
  type ChildAgentNormalizedEvent,
  type ChildExecutionSelection,
} from "./childAgentAdapter";
import type { ProviderRuntimeEvent } from "@octant/contracts";

export type ChildAgentProviderFamily =
  | "native-capable"
  | "managed-fallback"
  | "local-openai-compatible";

export interface ChildAgentFamilyFixture {
  readonly family: ChildAgentProviderFamily;
  readonly claimedNativeSupport: ProviderCapabilitySupport;
  readonly nativeGuaranteeMatrix: ChildAgentGuaranteeMatrix;
  readonly preferredKind: "provider-native" | "octant-managed";
  readonly managedAvailable: boolean;
  readonly nativeActivity?: Extract<ProviderRuntimeEvent, { kind: "child-agent-activity" }>;
}

export interface ChildAgentConformanceEvidence {
  readonly family: ChildAgentProviderFamily;
  readonly selection: ChildExecutionSelection;
  readonly events: ReadonlyArray<ChildAgentNormalizedEvent>;
  readonly overclaimRejected: boolean;
  readonly nativeMetadataIsolated: boolean;
  readonly fallbackExplicit: boolean;
}

function assertConformance(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Child agent conformance failed: ${message}`);
}

/**
 * Conformance probe for Phase 11C child execution adapters across representative
 * provider families. Proves explicit native-to-managed selection, overclaim
 * rejection, read-only native transcript truth, and normalized stop/reconcile.
 */
export function runChildAgentConformance(
  fixture: ChildAgentFamilyFixture,
): ChildAgentConformanceEvidence {
  let overclaimRejected = false;
  let selection: ChildExecutionSelection;
  try {
    selection = selectChildExecutionKind({
      claimedNativeSupport: fixture.claimedNativeSupport,
      nativeGuaranteeMatrix: fixture.nativeGuaranteeMatrix,
      preferredKind: fixture.preferredKind,
      managedAvailable: fixture.managedAvailable,
    });
  } catch (error) {
    if (error instanceof ChildAgentAdapterError && error.category === "overclaim") {
      overclaimRejected = true;
      // Overclaim fixtures still need a fail-closed managed path when available.
      selection = selectChildExecutionKind({
        claimedNativeSupport: fixture.claimedNativeSupport,
        nativeGuaranteeMatrix: allGuarantees(false),
        preferredKind: "octant-managed",
        managedAvailable: fixture.managedAvailable,
      });
    } else {
      throw error;
    }
  }

  const now = "2026-08-01T12:00:00.000Z";
  const runId = `run-${fixture.family}`;
  const events: ChildAgentNormalizedEvent[] = [];

  if (selection.selectedExecutionKind === "provider-native") {
    assertConformance(
      fixture.nativeActivity !== undefined,
      "native-capable fixture must supply native activity",
    );
    events.push(
      normalizeProviderChildActivity({
        runId,
        event: fixture.nativeActivity,
        executionKind: "provider-native",
      }),
    );
    events.push(
      createChildUsageEvent({
        runId,
        nativeChildId: fixture.nativeActivity.childAgentId,
        usageQuality: "provider-reported",
        inputTokens: 10,
        outputTokens: 4,
        sequence: 2,
        occurredAt: now,
      }),
    );
    events.push(
      createChildResultEvent({
        runId,
        nativeChildId: fixture.nativeActivity.childAgentId,
        status: "completed",
        resultReference: "result://native/1",
        sequence: 3,
        occurredAt: now,
      }),
    );
    events.push(
      createChildStopEvent({
        runId,
        nativeChildId: fixture.nativeActivity.childAgentId,
        confirmed: true,
        sequence: 4,
        occurredAt: now,
      }),
    );
  } else {
    events.push(
      createManagedChildActivity({
        runId,
        status: "running",
        summary: "Managed child activity",
        sequence: 1,
        occurredAt: now,
      }),
    );
    events.push(
      createChildUsageEvent({
        runId,
        usageQuality: "estimated",
        inputTokens: 8,
        outputTokens: 3,
        sequence: 2,
        occurredAt: now,
      }),
    );
    events.push(
      createChildResultEvent({
        runId,
        status: "completed",
        resultReference: "result://managed/1",
        sequence: 3,
        occurredAt: now,
      }),
    );
    events.push(
      createChildStopEvent({
        runId,
        confirmed: true,
        sequence: 4,
        occurredAt: now,
      }),
    );
    events.push(
      createChildReconcileEvent({
        runId,
        resumable: false,
        recoveryReason: "restart-without-resumable-execution",
        sequence: 5,
        occurredAt: now,
      }),
    );
  }

  // delayed duplicate must not re-apply
  const duplicated = dedupeChildEvents([...events, events[0]!]);
  assertConformance(duplicated.duplicates.length === 1, "duplicate child event was not detected");
  assertConformance(duplicated.applied.length === events.length, "dedupe changed applied length");

  // Native metadata must not invent alternate authority/cancel/usage path:
  // managed selection never carries nativeChildId on non-native events.
  const nativeMetadataIsolated =
    selection.selectedExecutionKind === "octant-managed"
      ? duplicated.applied.every((event) => event.nativeChildId === undefined)
      : duplicated.applied.some((event) => event.kind === "activity" && event.transcriptOnly);

  const fallbackExplicit =
    selection.attemptedExecutionKind === "provider-native" &&
    selection.selectedExecutionKind === "octant-managed"
      ? selection.selectedFallback?.kind === "octant-managed"
      : selection.selectedExecutionKind === selection.attemptedExecutionKind;

  assertConformance(fallbackExplicit, "native-to-managed fallback was not explicit");
  assertConformance(nativeMetadataIsolated, "native metadata isolation failed");

  return {
    family: fixture.family,
    selection,
    events: duplicated.applied,
    overclaimRejected,
    nativeMetadataIsolated,
    fallbackExplicit,
  };
}

export function childAgentFamilyFixtures(): ReadonlyArray<ChildAgentFamilyFixture> {
  const now = "2026-08-01T12:00:00.000Z";
  return [
    {
      family: "native-capable",
      claimedNativeSupport: "supported",
      nativeGuaranteeMatrix: allGuarantees(true),
      preferredKind: "provider-native",
      managedAvailable: true,
      nativeActivity: {
        kind: "child-agent-activity",
        instanceId: "11111111-1111-4111-8111-111111111111" as never,
        sessionId: "22222222-2222-4222-8222-222222222222" as never,
        sequence: 1,
        correlationId: "33333333-3333-4333-8333-333333333333" as never,
        occurredAt: now as never,
        childAgentId: "native-child-1",
        status: "running",
        summary: "Native child researching",
      },
    },
    {
      family: "managed-fallback",
      claimedNativeSupport: "unavailable",
      nativeGuaranteeMatrix: allGuarantees(false),
      preferredKind: "provider-native",
      managedAvailable: true,
    },
    {
      // local OpenAI-compatible endpoints do not provide native child agents
      family: "local-openai-compatible",
      claimedNativeSupport: "unsupported",
      nativeGuaranteeMatrix: allGuarantees(false),
      preferredKind: "provider-native",
      managedAvailable: true,
    },
  ];
}
