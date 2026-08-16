import type {
  ContextEntryId,
  ContextPlanId,
  ContextSummaryId,
  ProviderInstanceId,
  ProviderModelId,
  UsageReconciliationId,
  UtcTimestamp,
} from "@octant/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ContextDispatchPlan,
  ContextMaintenancePort,
  StoredContextSummary,
} from "./contextMaintenancePort";
import {
  ContextLengthRejected,
  ContextMaintenanceService,
  type ContextMaintenancePolicy,
} from "./contextMaintenanceService";

const entryIds = {
  eligible: "00000000-0000-4000-8000-000000000011",
  denied: "00000000-0000-4000-8000-000000000012",
} as const;
const providerIds = {
  "active-provider": "00000000-0000-4000-8000-000000000001",
  "other-provider": "00000000-0000-4000-8000-000000000002",
} as const;
const entryId = (value: keyof typeof entryIds) => entryIds[value] as ContextEntryId;
const providerId = (value: keyof typeof providerIds) => providerIds[value] as ProviderInstanceId;
const modelId = (value: string) => value as ProviderModelId;
const planId = (value: string) => value as ContextPlanId;
const timestamp = "2026-07-18T19:00:00.000Z" as UtcTimestamp;

describe("ContextMaintenanceService", () => {
  let summaries: Array<StoredContextSummary>;
  let usageWrites: Array<Parameters<ContextMaintenancePort["writeUsage"]>[0]>;
  let port: ContextMaintenancePort;
  let policy: ContextMaintenancePolicy;

  beforeEach(() => {
    summaries = [];
    usageWrites = [];
    port = {
      loadMaterials: (requestedEntryIds) =>
        requestedEntryIds.map((id) => ({
          entryId: id,
          content: id === entryId("eligible") ? "canonical:eligible" : "canonical:denied",
          sizeTokens: 400,
        })),
      generateSummary: vi.fn(async () => ({
        content: "bounded summary",
        summaryTokens: { kind: "known", tokens: 120, accuracy: "exact-tokenizer" } as const,
      })),
      writeSummary: (summary) => summaries.push(summary),
      writeUsage: (usage) => usageWrites.push(usage),
      rebuildContextPlan: (plan, marginTokens) => ({ ...plan, marginTokens }),
      dispatch: vi.fn(async () => undefined),
    };
    policy = {
      evaluateSummary: vi.fn(
        () =>
          ({
            kind: "summarize",
            providerInstanceId: providerId("active-provider"),
            modelId: modelId("active-model"),
            sourceEntryIds: [entryId("eligible")],
            boundedMaterialTokens: 400,
            expectedGrossSavingsTokens: 900,
            expectedNetSavingsTokens: 500,
          }) as const,
      ),
      reconcileVariance: vi.fn((input) => ({
        requestShape: input.requestShape,
        varianceTokens: input.actualInputTokens - input.plannedInputTokens,
        reserveAdjustmentTokens: 50,
        nextVarianceReserve: input.currentVarianceReserve + 50,
      })),
      decideContextLengthRecovery: vi.fn(
        ({
          currentMarginTokens,
          rebuilds,
        }: Parameters<ContextMaintenancePolicy["decideContextLengthRecovery"]>[0]) =>
          rebuilds === 0
            ? ({ kind: "rebuild-once", nextMarginTokens: currentMarginTokens + 100 } as const)
            : ({ kind: "blocked", reason: "context-length-repeated" } as const),
      ),
    };
  });

  function service(): ContextMaintenanceService {
    return new ContextMaintenanceService({
      port,
      policy,
      identity: {
        summaryId: () => "00000000-0000-4000-8000-000000000021" as ContextSummaryId,
        usageId: () => "00000000-0000-4000-8000-000000000022" as UsageReconciliationId,
        timestamp: () => timestamp,
      },
    });
  }

  const maintenanceInput = {
    activeProviderInstanceId: providerId("active-provider"),
    activeModelId: modelId("active-model"),
    maintenanceProviderInstanceId: providerId("active-provider"),
    maintenanceModelId: modelId("active-model"),
    crossVendorOptIn: false,
    expectedReuseCount: 3,
    expectedSavingsPerReuseTokens: 300,
    maintenanceCostTokens: 400,
    materials: [
      {
        entryId: entryId("eligible"),
        sizeTokens: 400,
        eligible: true,
        providerInstanceId: providerId("active-provider"),
        modelId: modelId("active-model"),
      },
      {
        entryId: entryId("denied"),
        sizeTokens: 400,
        eligible: false,
        providerInstanceId: providerId("active-provider"),
        modelId: modelId("active-model"),
      },
    ],
    maxMaterialTokens: 500,
    replacedSummaryIds: ["00000000-0000-4000-8000-000000000020" as ContextSummaryId],
    deterministicFallbackAvailable: true,
  } as const;

  it("routes only bounded eligible material and stores complete summary provenance", async () => {
    const signal = new AbortController().signal;
    const result = await service().maintain(maintenanceInput, signal);

    expect(port.loadMaterials).toBeDefined();
    expect(port.generateSummary).toHaveBeenCalledWith(
      {
        providerInstanceId: providerId("active-provider"),
        modelId: modelId("active-model"),
        materials: [
          { entryId: entryId("eligible"), content: "canonical:eligible", sizeTokens: 400 },
        ],
      },
      signal,
    );
    expect(result.kind).toBe("summary-created");
    expect(summaries).toEqual([
      {
        content: "bounded summary",
        summary: {
          id: "00000000-0000-4000-8000-000000000021",
          sourceEntryIds: [entryId("eligible")],
          providerInstanceId: providerId("active-provider"),
          modelId: modelId("active-model"),
          createdAt: timestamp,
          usageCount: 0,
          summaryTokens: { kind: "known", tokens: 120, accuracy: "exact-tokenizer" },
          originalTokens: { kind: "known", tokens: 400, accuracy: "conservative-heuristic" },
          estimatedSavingsTokens: 500,
          replacedSummaryIds: maintenanceInput.replacedSummaryIds,
        },
      },
    ]);
  });

  it("falls back deterministically when summary generation fails", async () => {
    port = { ...port, generateSummary: vi.fn(async () => Promise.reject(new Error("offline"))) };

    await expect(
      service().maintain(maintenanceInput, new AbortController().signal),
    ).resolves.toEqual({ kind: "deterministic-reduction", reason: "summary-generation-failed" });
    expect(summaries).toEqual([]);
  });

  it("propagates a summary-store failure instead of misreporting deterministic fallback", async () => {
    port = {
      ...port,
      writeSummary: () => {
        throw new Error("store unavailable");
      },
    };

    await expect(
      service().maintain(maintenanceInput, new AbortController().signal),
    ).rejects.toThrow("store unavailable");
  });

  it("requests a structured user decision when no deterministic fallback remains", async () => {
    port = { ...port, generateSummary: vi.fn(async () => Promise.reject(new Error("offline"))) };

    await expect(
      service().maintain(
        { ...maintenanceInput, deterministicFallbackAvailable: false },
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      kind: "user-decision",
      reason: "summary-generation-failed",
      remedies: ["compact-range", "exclude-context", "switch-model"],
    });
  });

  it("does not generate or write when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(service().maintain(maintenanceInput, controller.signal)).resolves.toEqual({
      kind: "cancelled",
    });
    expect(port.generateSummary).not.toHaveBeenCalled();
    expect(summaries).toEqual([]);
  });

  it("does not write when cancellation happens during summary generation", async () => {
    const controller = new AbortController();
    port = {
      ...port,
      generateSummary: vi.fn(async () => {
        controller.abort();
        return {
          content: "discard me",
          summaryTokens: {
            kind: "known",
            tokens: 10,
            accuracy: "conservative-heuristic",
          } as const,
        };
      }),
    };

    await expect(service().maintain(maintenanceInput, controller.signal)).resolves.toEqual({
      kind: "cancelled",
    });
    expect(summaries).toEqual([]);
  });

  it("falls back without writing when generated summary usage is unknown", async () => {
    port = {
      ...port,
      generateSummary: vi.fn(async () => ({
        content: "cannot account for this",
        summaryTokens: { kind: "unknown", accuracy: "unknown" } as const,
      })),
    };

    await expect(
      service().maintain(maintenanceInput, new AbortController().signal),
    ).resolves.toEqual({
      kind: "deterministic-reduction",
      reason: "summary-usage-unavailable",
    });
    expect(summaries).toEqual([]);
  });

  it("rejects a policy target mismatch before loading canonical material", async () => {
    const loadMaterials = vi.fn(port.loadMaterials);
    port = { ...port, loadMaterials };
    policy = {
      ...policy,
      evaluateSummary: () => ({
        kind: "summarize",
        providerInstanceId: providerId("other-provider"),
        modelId: modelId("other-model"),
        sourceEntryIds: [entryId("eligible")],
        boundedMaterialTokens: 400,
        expectedGrossSavingsTokens: 900,
        expectedNetSavingsTokens: 500,
      }),
    };

    await expect(
      service().maintain(maintenanceInput, new AbortController().signal),
    ).rejects.toThrow("maintenance target");
    expect(loadMaterials).not.toHaveBeenCalled();
  });

  it("rejects material not eligible for the selected provider and model before loading it", async () => {
    const loadMaterials = vi.fn(port.loadMaterials);
    port = { ...port, loadMaterials };
    const input = {
      ...maintenanceInput,
      maintenanceProviderInstanceId: providerId("other-provider"),
      maintenanceModelId: modelId("other-model"),
      crossVendorOptIn: true,
    } as const;
    policy = {
      ...policy,
      evaluateSummary: () => ({
        kind: "summarize",
        providerInstanceId: providerId("other-provider"),
        modelId: modelId("other-model"),
        sourceEntryIds: [entryId("eligible")],
        boundedMaterialTokens: 400,
        expectedGrossSavingsTokens: 900,
        expectedNetSavingsTokens: 500,
      }),
    };

    await expect(service().maintain(input, new AbortController().signal)).rejects.toThrow(
      "ineligible",
    );
    expect(loadMaterials).not.toHaveBeenCalled();
  });

  it("rejects loaded material that does not exactly match the bounded decision", async () => {
    port = {
      ...port,
      loadMaterials: () => [
        { entryId: entryId("eligible"), content: "canonical:eligible", sizeTokens: 500 },
      ],
    };

    await expect(
      service().maintain(maintenanceInput, new AbortController().signal),
    ).rejects.toThrow("Loaded context material does not match");
    expect(port.generateSummary).not.toHaveBeenCalled();
    expect(summaries).toEqual([]);
  });

  it("writes checked shape-scoped usage reconciliation unless cancelled", () => {
    const input = {
      planId: planId("00000000-0000-4000-8000-000000000030"),
      providerInstanceId: providerId("active-provider"),
      modelId: modelId("active-model"),
      requestShape: "code-tools",
      expectedRequestShape: "code-tools",
      plannedInputTokens: 1_000,
      actualInputTokens: 1_200,
      actualOutputTokens: 80,
      currentVarianceReserve: 100,
      maxAdjustmentTokens: 100,
    } as const;

    expect(service().reconcileUsage(input, new AbortController().signal)).toEqual({
      kind: "usage-reconciled",
      variance: {
        requestShape: "code-tools",
        varianceTokens: 200,
        reserveAdjustmentTokens: 50,
        nextVarianceReserve: 150,
      },
    });
    expect(usageWrites).toHaveLength(1);
    expect(usageWrites[0]).toMatchObject({
      requestShape: "code-tools",
      plannedInputTokens: 1_000,
      actualInputTokens: 1_200,
      actualOutputTokens: 80,
      varianceTokens: 200,
    });

    const controller = new AbortController();
    controller.abort();
    expect(service().reconcileUsage(input, controller.signal)).toEqual({ kind: "cancelled" });
    expect(usageWrites).toHaveLength(1);
  });

  it("rebuilds once with a larger margin and then succeeds", async () => {
    const dispatch = vi
      .fn<(plan: ContextDispatchPlan, signal: AbortSignal) => Promise<void>>()
      .mockRejectedValueOnce(new ContextLengthRejected())
      .mockResolvedValueOnce(undefined);
    port = { ...port, dispatch };

    await expect(
      service().dispatchWithContextRecovery(
        { planId: planId("00000000-0000-4000-8000-000000000040"), marginTokens: 200 },
        100,
        new AbortController().signal,
      ),
    ).resolves.toEqual({ kind: "dispatched", rebuilds: 1, marginTokens: 300 });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("blocks after a repeated context-length rejection without a retry loop", async () => {
    const dispatch = vi.fn(async () => Promise.reject(new ContextLengthRejected()));
    port = { ...port, dispatch };

    await expect(
      service().dispatchWithContextRecovery(
        { planId: planId("00000000-0000-4000-8000-000000000040"), marginTokens: 200 },
        100,
        new AbortController().signal,
      ),
    ).resolves.toEqual({ kind: "blocked", reason: "context-length-repeated", rebuilds: 1 });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("rejects a rebuilt plan with the wrong margin before a second dispatch", async () => {
    const dispatch = vi.fn(async () => Promise.reject(new ContextLengthRejected()));
    port = {
      ...port,
      dispatch,
      rebuildContextPlan: (plan) => ({ ...plan, marginTokens: 299 }),
    };

    await expect(
      service().dispatchWithContextRecovery(
        { planId: planId("00000000-0000-4000-8000-000000000040"), marginTokens: 200 },
        100,
        new AbortController().signal,
      ),
    ).rejects.toThrow("rebuilt context plan");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("rejects a rebuilt plan with a different identity before a second dispatch", async () => {
    const dispatch = vi.fn(async () => Promise.reject(new ContextLengthRejected()));
    port = {
      ...port,
      dispatch,
      rebuildContextPlan: (plan, marginTokens) => ({
        ...plan,
        planId: planId("00000000-0000-4000-8000-000000000041"),
        marginTokens,
      }),
    };

    await expect(
      service().dispatchWithContextRecovery(
        { planId: planId("00000000-0000-4000-8000-000000000040"), marginTokens: 200 },
        100,
        new AbortController().signal,
      ),
    ).rejects.toThrow("rebuilt context plan");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
