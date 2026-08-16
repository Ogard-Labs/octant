import type { MultiModelPoolCandidate } from "@octant/contracts/multi-model-pool";
import { decodeMultiModelRouteDecisionReceipt } from "@octant/contracts/multi-model-pool";
import { describe, expect, it } from "vitest";
import {
  resolveMultiModelRoute,
  type MultiModelCandidateRuntimeFacts,
  type ResolveMultiModelRouteInput,
} from "./multiModelPoolPolicy";

const localHost = "00000000-0000-4000-8000-000000000001";
const candidateA = candidate("10000000-0000-4000-8000-000000000001", "model-a");
const candidateB = candidate("20000000-0000-4000-8000-000000000002", "model-b");
const candidateC = candidate("30000000-0000-4000-8000-000000000003", "model-c");

describe("resolveMultiModelRoute", () => {
  it("selects the explicitly requested eligible candidate", () => {
    const result = resolveMultiModelRoute(
      input({
        requestedCandidate: candidateB,
        runtimeFacts: [facts(candidateA), facts(candidateB)],
      }),
    );

    expect(result.kind).toBe("selected");
    if (result.kind === "selected") {
      expect(result.selectedCandidate).toEqual(candidateB);
      expect(result.selectionKind).toBe("requested");
    }
  });

  it("never selects a runtime candidate outside the selected pool", () => {
    const result = resolveMultiModelRoute(
      input({
        requestedCandidate: candidateA,
        runtimeFacts: [
          facts(candidateA, { readiness: "unavailable" }),
          facts(candidateB, { readiness: "unavailable" }),
          facts(candidateC),
        ],
      }),
    );

    expect(result.kind).toBe("waiting");
    expect(result.eligibility.map((entry) => entry.candidate)).not.toContainEqual(candidateC);
  });

  it.each([
    ["provider-unconfigured", { configured: false }],
    ["provider-not-ready", { readiness: "unavailable" }],
    ["model-unavailable", { modelAvailable: false }],
    ["mode-incompatible", { compatibleModes: ["chat"] }],
    ["project-incompatible", { projectAllowed: false }],
    ["profile-disallowed", { profileAllowed: false }],
    ["capability-incompatible", { supportedCapabilities: [] }],
    ["authority-incompatible", { authorityAllowed: false }],
  ] as const)("fails closed with %s", (reason, override) => {
    const primaryFacts = facts(candidateA, override);
    const result = resolveMultiModelRoute(
      input({
        requestedCandidate: primaryFacts.candidate,
        runtimeFacts: [primaryFacts, facts(candidateB, { readiness: "unavailable" })],
      }),
    );

    expect(result.kind).toBe("waiting");
    expect(result.eligibility[0]?.reasons).toContain(reason);
  });

  it("fails closed when selected candidates belong to another host", () => {
    const result = resolveMultiModelRoute(
      input({
        activeHostId:
          "90000000-0000-4000-8000-000000000009" as ResolveMultiModelRouteInput["activeHostId"],
      }),
    );

    expect(result.kind).toBe("waiting");
    expect(result.eligibility[0]?.reasons).toContain("host-mismatch");
  });

  it("rejects mixed-vendor candidates until mixed routing is enabled", () => {
    const blocked = resolveMultiModelRoute(
      input({
        requestedCandidate: candidateB,
        mixedVendorEnabled: false,
        runtimeFacts: [
          facts(candidateA),
          facts(candidateB, { routingVendorId: "anthropic" as never }),
        ],
      }),
    );
    expect(blocked.kind).toBe("selected");
    if (blocked.kind === "selected") expect(blocked.selectionKind).toBe("fallback");
    expect(blocked.eligibility[1]?.reasons).toContain("mixed-vendor-disabled");

    const allowed = resolveMultiModelRoute(
      input({
        requestedCandidate: candidateB,
        mixedVendorEnabled: true,
        runtimeFacts: [
          facts(candidateA),
          facts(candidateB, { routingVendorId: "anthropic" as never }),
        ],
      }),
    );
    expect(allowed.kind).toBe("selected");
  });

  it("inherits the exact parent route when mixed routing is disabled", () => {
    const result = resolveMultiModelRoute(
      input({
        requestedCandidate: candidateB,
        mixedVendorEnabled: false,
        runtimeFacts: [facts(candidateA), facts(candidateB)],
      }),
    );

    expect(result.kind).toBe("selected");
    if (result.kind === "selected") expect(result.selectedCandidate).toEqual(candidateA);
    expect(result.eligibility[1]?.reasons).toContain("mixed-vendor-disabled");
  });

  it("rejects a candidate whose pooled model is absent from the probe and selects an eligible fallback", () => {
    const result = resolveMultiModelRoute(
      input({
        requestedCandidate: candidateA,
        runtimeFacts: [facts(candidateA, { modelAvailable: false }), facts(candidateB)],
      }),
    );

    expect(result.kind).toBe("selected");
    if (result.kind === "selected") {
      expect(result.selectionKind).toBe("fallback");
      expect(result.selectedCandidate).toEqual(candidateB);
    }
    expect(result.eligibility[0]?.eligible).toBe(false);
    expect(result.eligibility[0]?.reasons).toContain("model-unavailable");
    expect(result.eligibility[1]?.eligible).toBe(true);
  });

  it("uses only an explicitly permitted fallback", () => {
    const denied = resolveMultiModelRoute(
      input({
        fallbackAllowed: false,
        requestedCandidate: candidateA,
        runtimeFacts: [facts(candidateA, { readiness: "unavailable" }), facts(candidateB)],
      }),
    );
    expect(denied.kind).toBe("waiting");
    expect(denied.eligibility[1]?.reasons).toContain("fallback-not-permitted");

    const allowed = resolveMultiModelRoute(
      input({
        fallbackAllowed: true,
        requestedCandidate: candidateA,
        runtimeFacts: [facts(candidateA, { readiness: "unavailable" }), facts(candidateB)],
      }),
    );
    expect(allowed.kind).toBe("selected");
    if (allowed.kind === "selected") expect(allowed.selectionKind).toBe("fallback");
  });

  it("blocks a more expensive fallback unless explicitly permitted", () => {
    const denied = resolveMultiModelRoute(
      input({
        requestedCandidate: candidateA,
        runtimeFacts: [
          facts(candidateA, { readiness: "unavailable", costRank: 1 }),
          facts(candidateB, { costRank: 2 }),
        ],
      }),
    );
    expect(denied.kind).toBe("waiting");
    expect(denied.eligibility[1]?.reasons).toContain("cost-increase-not-permitted");

    const allowed = resolveMultiModelRoute(
      input({
        higherCostFallbackAllowed: true,
        requestedCandidate: candidateA,
        runtimeFacts: [
          facts(candidateA, { readiness: "unavailable", costRank: 1 }),
          facts(candidateB, { costRank: 2 }),
        ],
      }),
    );
    expect(allowed.kind).toBe("selected");
  });

  it("fails closed when fallback cost cannot be compared", () => {
    const result = resolveMultiModelRoute(
      input({
        requestedCandidate: candidateA,
        runtimeFacts: [
          facts(candidateA, { readiness: "unavailable", costRank: Number.NaN }),
          facts(candidateB, { costRank: 1 }),
        ],
      }),
    );

    expect(result.kind).toBe("waiting");
    expect(result.eligibility[1]?.reasons).toContain("cost-not-comparable");
  });

  it("returns an actionable Waiting decision when no candidate qualifies", () => {
    const result = resolveMultiModelRoute(
      input({
        requestedCandidate: candidateA,
        runtimeFacts: [
          facts(candidateA, { readiness: "unavailable" }),
          facts(candidateB, { readiness: "unauthenticated" }),
        ],
      }),
    );

    expect(result).toMatchObject({
      kind: "waiting",
      reason: "no-eligible-candidate",
      message: "No selected model is currently eligible. Check provider readiness and pool policy.",
    });
  });

  it("is deterministic for the same ordered pool and runtime facts", () => {
    const request = input({
      requestedCandidate: candidateA,
      runtimeFacts: [facts(candidateA, { readiness: "unavailable" }), facts(candidateB)],
    });

    expect(resolveMultiModelRoute(request)).toEqual(resolveMultiModelRoute(request));
  });

  it("binds emitted receipts to the parent route and cost evidence", () => {
    const selected = resolveMultiModelRoute(input({ requestedCandidate: candidateA }));
    expect(selected.parentCandidate).toEqual(candidateA);
    expect(selected.eligibility.map((entry) => entry.costRank)).toEqual([1, 1]);
    expect(() => decodeMultiModelRouteDecisionReceipt(selected)).not.toThrow();

    const fallback = resolveMultiModelRoute(
      input({
        requestedCandidate: candidateA,
        runtimeFacts: [
          facts(candidateA, { readiness: "unavailable", costRank: 2 }),
          facts(candidateB, { costRank: 1 }),
        ],
      }),
    );
    expect(fallback.kind).toBe("selected");
    expect(() => decodeMultiModelRouteDecisionReceipt(fallback)).not.toThrow();

    const waiting = resolveMultiModelRoute(
      input({
        requestedCandidate: candidateA,
        runtimeFacts: [
          facts(candidateA, { readiness: "unavailable" }),
          facts(candidateB, { readiness: "unavailable" }),
        ],
      }),
    );
    expect(waiting.parentCandidate).toEqual(candidateA);
    expect(() => decodeMultiModelRouteDecisionReceipt(waiting)).not.toThrow();
  });

  it("omits cost evidence when the runtime cost rank is unusable", () => {
    const result = resolveMultiModelRoute(
      input({
        requestedCandidate: candidateA,
        runtimeFacts: [
          facts(candidateA, { readiness: "unavailable", costRank: Number.NaN }),
          facts(candidateB, { costRank: 1 }),
        ],
      }),
    );

    expect(result.eligibility[0]?.costRank).toBeUndefined();
    expect(result.eligibility[1]?.costRank).toBe(1);
  });
});

function candidate(
  providerInstanceId: string,
  modelId: string,
  hostId = localHost,
): MultiModelPoolCandidate {
  return { hostId, providerInstanceId, modelId } as MultiModelPoolCandidate;
}

function facts(
  selectedCandidate: MultiModelPoolCandidate,
  override: Partial<MultiModelCandidateRuntimeFacts> = {},
): MultiModelCandidateRuntimeFacts {
  return {
    candidate: selectedCandidate,
    routingVendorId: "openai" as never,
    configured: true,
    readiness: "ready",
    modelAvailable: true,
    compatibleModes: ["chat", "work", "code"],
    projectAllowed: true,
    profileAllowed: true,
    supportedCapabilities: ["tool-calling"],
    authorityAllowed: true,
    costRank: 1,
    ...override,
  };
}

type InputOverride = Partial<Omit<ResolveMultiModelRouteInput, "request">> & {
  readonly requestedCandidate?: MultiModelPoolCandidate;
  readonly mixedVendorEnabled?: boolean;
  readonly fallbackAllowed?: boolean;
  readonly higherCostFallbackAllowed?: boolean;
};

function input(override: InputOverride = {}): ResolveMultiModelRouteInput {
  return {
    request: {
      pool: {
        candidates: [candidateA, candidateB],
        mixedVendorEnabled: override.mixedVendorEnabled ?? true,
        fallbackAllowed: override.fallbackAllowed ?? true,
        higherCostFallbackAllowed: override.higherCostFallbackAllowed ?? false,
      },
      requestedCandidate: override.requestedCandidate ?? candidateA,
      requiredCapabilities: ["tool-calling"],
    },
    activeHostId:
      override.activeHostId ?? (localHost as ResolveMultiModelRouteInput["activeHostId"]),
    mode: "code",
    parentRoutingVendorId: "openai" as never,
    parentCandidate: candidateA,
    runtimeFacts: override.runtimeFacts ?? [facts(candidateA), facts(candidateB)],
  };
}
