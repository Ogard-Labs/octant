import { describe, expect, it } from "vitest";
import {
  decodeMultiModelPool,
  decodeMultiModelRouteDecisionReceipt,
  decodeMultiModelRouteSelectionRequest,
  type MultiModelPoolCandidate,
} from "./multiModelPool";

const candidate = (
  providerInstanceId: string,
  modelId: string,
  hostId = "00000000-0000-4000-8000-000000000001",
): MultiModelPoolCandidate =>
  ({
    hostId,
    providerInstanceId,
    modelId,
  }) as MultiModelPoolCandidate;

describe("MultiModelPool contracts", () => {
  it("decodes a bounded pool with two unique candidates", () => {
    const pool = decodeMultiModelPool({
      candidates: [
        candidate("10000000-0000-4000-8000-000000000001", "model-a"),
        candidate("20000000-0000-4000-8000-000000000002", "model-b"),
      ],
      mixedVendorEnabled: true,
      fallbackAllowed: true,
      higherCostFallbackAllowed: false,
    });

    expect(pool.candidates).toHaveLength(2);
  });

  it("rejects pools with fewer than two candidates", () => {
    expect(() =>
      decodeMultiModelPool({
        candidates: [candidate("10000000-0000-4000-8000-000000000001", "model-a")],
        mixedVendorEnabled: false,
        fallbackAllowed: false,
        higherCostFallbackAllowed: false,
      }),
    ).toThrow();
  });

  it("rejects duplicate candidate identities", () => {
    const duplicate = candidate("10000000-0000-4000-8000-000000000001", "model-a");
    expect(() =>
      decodeMultiModelPool({
        candidates: [duplicate, duplicate],
        mixedVendorEnabled: false,
        fallbackAllowed: false,
        higherCostFallbackAllowed: false,
      }),
    ).toThrow();
  });

  it("rejects malformed identifiers and excess fields", () => {
    expect(() =>
      decodeMultiModelPool({
        candidates: [
          candidate("not-a-uuid", "model-a"),
          candidate("20000000-0000-4000-8000-000000000002", "model-b"),
        ],
        mixedVendorEnabled: false,
        fallbackAllowed: false,
        higherCostFallbackAllowed: false,
      }),
    ).toThrow();

    expect(() =>
      decodeMultiModelPool({
        candidates: [
          candidate("10000000-0000-4000-8000-000000000001", "model-a"),
          candidate("20000000-0000-4000-8000-000000000002", "model-b"),
        ],
        mixedVendorEnabled: false,
        fallbackAllowed: false,
        higherCostFallbackAllowed: false,
        hiddenAuthority: true,
      }),
    ).toThrow();
  });

  it("rejects a requested candidate outside the selected pool", () => {
    expect(() =>
      decodeMultiModelRouteSelectionRequest({
        pool: {
          candidates: [
            candidate("10000000-0000-4000-8000-000000000001", "model-a"),
            candidate("20000000-0000-4000-8000-000000000002", "model-b"),
          ],
          mixedVendorEnabled: true,
          fallbackAllowed: true,
          higherCostFallbackAllowed: false,
        },
        requestedCandidate: candidate("30000000-0000-4000-8000-000000000003", "model-outside-pool"),
        requiredCapabilities: [],
      }),
    ).toThrow();
  });

  it("rejects route receipts that do not cover the pool consistently", () => {
    const first = candidate("10000000-0000-4000-8000-000000000001", "model-a");
    const second = candidate("20000000-0000-4000-8000-000000000002", "model-b");
    const request = {
      pool: {
        candidates: [first, second],
        mixedVendorEnabled: true,
        fallbackAllowed: true,
        higherCostFallbackAllowed: false,
      },
      requestedCandidate: first,
      requiredCapabilities: [],
    };

    expect(() =>
      decodeMultiModelRouteDecisionReceipt({
        kind: "selected",
        request,
        mode: "chat",
        activeHostId: first.hostId,
        parentCandidate: first,
        eligibility: [
          { candidate: first, eligible: true, reasons: [] },
          { candidate: second, eligible: false, reasons: ["provider-not-ready"] },
        ],
        selectedCandidate: candidate("30000000-0000-4000-8000-000000000003", "outside-pool"),
        selectionKind: "requested",
        reason: "Invalid selection",
      }),
    ).toThrow();

    expect(() =>
      decodeMultiModelRouteDecisionReceipt({
        kind: "selected",
        request,
        mode: "chat",
        activeHostId: first.hostId,
        parentCandidate: first,
        eligibility: [
          { candidate: first, eligible: true, reasons: [] },
          { candidate: second, eligible: false, reasons: ["provider-not-ready"] },
        ],
        selectedCandidate: first,
        selectionKind: "fallback",
        reason: "Inconsistent selection kind",
      }),
    ).toThrow();

    expect(() =>
      decodeMultiModelRouteDecisionReceipt({
        kind: "waiting",
        request,
        mode: "chat",
        activeHostId: first.hostId,
        parentCandidate: first,
        eligibility: [
          { candidate: first, eligible: true, reasons: [] },
          { candidate: second, eligible: false, reasons: ["provider-not-ready"] },
        ],
        reason: "no-eligible-candidate",
        message: "Invalid waiting receipt",
      }),
    ).toThrow();
  });

  it("rejects fallback receipts when fallback was not allowed", () => {
    const first = candidate("10000000-0000-4000-8000-000000000001", "model-a");
    const second = candidate("20000000-0000-4000-8000-000000000002", "model-b");

    expect(() =>
      decodeMultiModelRouteDecisionReceipt({
        kind: "selected",
        request: {
          pool: {
            candidates: [first, second],
            mixedVendorEnabled: true,
            fallbackAllowed: false,
            higherCostFallbackAllowed: false,
          },
          requestedCandidate: first,
          requiredCapabilities: [],
        },
        mode: "chat",
        activeHostId: first.hostId,
        parentCandidate: first,
        eligibility: [
          { candidate: first, eligible: false, reasons: ["provider-not-ready"] },
          { candidate: second, eligible: true, reasons: [] },
        ],
        selectedCandidate: second,
        selectionKind: "fallback",
        reason: "Fallback selected despite the request policy",
      }),
    ).toThrow();
  });

  it("rejects non-parent selections when mixed routing is disabled", () => {
    const first = candidate("10000000-0000-4000-8000-000000000001", "model-a");
    const second = candidate("20000000-0000-4000-8000-000000000002", "model-b");
    const pool = {
      candidates: [first, second],
      mixedVendorEnabled: false,
      fallbackAllowed: true,
      higherCostFallbackAllowed: true,
    };

    // Forged: claims a fallback to a non-parent route while mixed routing is disabled.
    expect(() =>
      decodeMultiModelRouteDecisionReceipt({
        kind: "selected",
        request: { pool, requestedCandidate: first, requiredCapabilities: [] },
        mode: "chat",
        activeHostId: first.hostId,
        parentCandidate: first,
        eligibility: [
          { candidate: first, eligible: false, reasons: ["provider-not-ready"] },
          { candidate: second, eligible: true, reasons: [] },
        ],
        selectedCandidate: second,
        selectionKind: "fallback",
        reason: "Forged fallback to a non-parent route",
      }),
    ).toThrow();

    // Forged: claims the non-parent route as the requested selection.
    expect(() =>
      decodeMultiModelRouteDecisionReceipt({
        kind: "selected",
        request: { pool, requestedCandidate: second, requiredCapabilities: [] },
        mode: "chat",
        activeHostId: first.hostId,
        parentCandidate: first,
        eligibility: [
          { candidate: first, eligible: true, reasons: [] },
          { candidate: second, eligible: true, reasons: [] },
        ],
        selectedCandidate: second,
        selectionKind: "requested",
        reason: "Forged requested selection of a non-parent route",
      }),
    ).toThrow();

    // Valid: selecting the parent route while mixed routing is disabled still decodes.
    const receipt = decodeMultiModelRouteDecisionReceipt({
      kind: "selected",
      request: { pool, requestedCandidate: first, requiredCapabilities: [] },
      mode: "chat",
      activeHostId: first.hostId,
      parentCandidate: first,
      eligibility: [
        { candidate: first, eligible: true, reasons: [] },
        { candidate: second, eligible: false, reasons: ["mixed-vendor-disabled"] },
      ],
      selectedCandidate: first,
      selectionKind: "requested",
      reason: "Parent route selected",
    });
    expect(receipt.kind).toBe("selected");
  });

  it("rejects fallback receipts that raise cost without the higher-cost opt-in", () => {
    const first = candidate("10000000-0000-4000-8000-000000000001", "model-a");
    const second = candidate("20000000-0000-4000-8000-000000000002", "model-b");
    const pool = {
      candidates: [first, second],
      mixedVendorEnabled: true,
      fallbackAllowed: true,
      higherCostFallbackAllowed: false,
    };

    // Forged: silently selects a more expensive fallback with no cost evidence at all.
    expect(() =>
      decodeMultiModelRouteDecisionReceipt({
        kind: "selected",
        request: { pool, requestedCandidate: first, requiredCapabilities: [] },
        mode: "chat",
        activeHostId: first.hostId,
        parentCandidate: first,
        eligibility: [
          { candidate: first, eligible: false, reasons: ["provider-not-ready"] },
          { candidate: second, eligible: true, reasons: [] },
        ],
        selectedCandidate: second,
        selectionKind: "fallback",
        reason: "Forged higher-cost fallback",
      }),
    ).toThrow();

    // Forged: carries cost evidence that itself shows the prohibited increase.
    expect(() =>
      decodeMultiModelRouteDecisionReceipt({
        kind: "selected",
        request: { pool, requestedCandidate: first, requiredCapabilities: [] },
        mode: "chat",
        activeHostId: first.hostId,
        parentCandidate: first,
        eligibility: [
          { candidate: first, eligible: false, reasons: ["provider-not-ready"], costRank: 1 },
          { candidate: second, eligible: true, reasons: [], costRank: 2 },
        ],
        selectedCandidate: second,
        selectionKind: "fallback",
        reason: "Forged higher-cost fallback with cost evidence",
      }),
    ).toThrow();

    // Valid: an equal-cost fallback with cost evidence still decodes.
    const equalCost = decodeMultiModelRouteDecisionReceipt({
      kind: "selected",
      request: { pool, requestedCandidate: first, requiredCapabilities: [] },
      mode: "chat",
      activeHostId: first.hostId,
      parentCandidate: first,
      eligibility: [
        { candidate: first, eligible: false, reasons: ["provider-not-ready"], costRank: 1 },
        { candidate: second, eligible: true, reasons: [], costRank: 1 },
      ],
      selectedCandidate: second,
      selectionKind: "fallback",
      reason: "Equal-cost fallback selected",
    });
    expect(equalCost.kind).toBe("selected");

    // Valid: a higher-cost fallback decodes when the separate opt-in is enabled.
    const optedIn = decodeMultiModelRouteDecisionReceipt({
      kind: "selected",
      request: {
        pool: { ...pool, higherCostFallbackAllowed: true },
        requestedCandidate: first,
        requiredCapabilities: [],
      },
      mode: "chat",
      activeHostId: first.hostId,
      parentCandidate: first,
      eligibility: [
        { candidate: first, eligible: false, reasons: ["provider-not-ready"], costRank: 1 },
        { candidate: second, eligible: true, reasons: [], costRank: 2 },
      ],
      selectedCandidate: second,
      selectionKind: "fallback",
      reason: "Higher-cost fallback explicitly permitted",
    });
    expect(optedIn.kind).toBe("selected");
  });
});
