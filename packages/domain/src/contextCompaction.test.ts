import type { ContextEntryId, ProviderInstanceId, ProviderModelId } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  ContextCompactionRejected,
  decideContextLengthRecovery,
  decideSessionCompaction,
  evaluateSemanticSummary,
  orderContextMaintenance,
  reconcileContextVariance,
  selectSessionCompaction,
  type SessionCompactionFacts,
  type SessionCompactionItem,
} from "./contextCompaction";

const entryId = (value: string) => value as ContextEntryId;
const providerId = (value: string) => value as ProviderInstanceId;
const modelId = (value: string) => value as ProviderModelId;

describe("context compaction policy", () => {
  it("orders deterministic maintenance before semantic summarization", () => {
    const actions = orderContextMaintenance([
      { entryId: entryId("summary"), kind: "semantic-summary", priority: 0 },
      { entryId: entryId("narrow"), kind: "narrow-retrieval", priority: 0 },
      { entryId: entryId("artifact"), kind: "artifact-reference", priority: 0 },
      { entryId: entryId("reuse"), kind: "reuse-summary", priority: 0 },
      { entryId: entryId("stale"), kind: "stale", priority: 0 },
      { entryId: entryId("superseded"), kind: "superseded", priority: 0 },
      { entryId: entryId("duplicate"), kind: "duplicate", priority: 0 },
    ]);

    expect(actions.map((action) => action.entryId)).toEqual([
      entryId("duplicate"),
      entryId("superseded"),
      entryId("stale"),
      entryId("reuse"),
      entryId("artifact"),
      entryId("narrow"),
      entryId("summary"),
    ]);
  });

  it("uses priority and original position as deterministic tie breakers", () => {
    const actions = orderContextMaintenance([
      { entryId: entryId("third"), kind: "stale", priority: 2 },
      { entryId: entryId("first"), kind: "stale", priority: 1 },
      { entryId: entryId("second"), kind: "stale", priority: 1 },
    ]);

    expect(actions.map((action) => action.entryId)).toEqual([
      entryId("first"),
      entryId("second"),
      entryId("third"),
    ]);
  });

  it("allows a net-positive eligible summary on the active provider by default", () => {
    const activeProviderInstanceId = providerId("active-provider");
    const decision = evaluateSemanticSummary({
      activeProviderInstanceId,
      activeModelId: modelId("active-model"),
      maintenanceProviderInstanceId: activeProviderInstanceId,
      maintenanceModelId: modelId("maintenance-model"),
      crossVendorOptIn: false,
      expectedReuseCount: 3,
      expectedSavingsPerReuseTokens: 400,
      maintenanceCostTokens: 500,
      materials: [
        {
          entryId: entryId("eligible"),
          sizeTokens: 800,
          eligible: true,
          providerInstanceId: activeProviderInstanceId,
          modelId: modelId("maintenance-model"),
        },
        {
          entryId: entryId("denied"),
          sizeTokens: 100,
          eligible: false,
          providerInstanceId: activeProviderInstanceId,
          modelId: modelId("maintenance-model"),
        },
      ],
      maxMaterialTokens: 1_000,
    });

    expect(decision).toEqual({
      kind: "summarize",
      providerInstanceId: activeProviderInstanceId,
      modelId: modelId("maintenance-model"),
      sourceEntryIds: [entryId("eligible")],
      boundedMaterialTokens: 800,
      expectedGrossSavingsTokens: 1_200,
      expectedNetSavingsTokens: 700,
    });
  });

  it("defaults maintenance to the active provider and model when no target is configured", () => {
    const decision = evaluateSemanticSummary({
      activeProviderInstanceId: providerId("active-provider"),
      activeModelId: modelId("active-model"),
      crossVendorOptIn: false,
      expectedReuseCount: 2,
      expectedSavingsPerReuseTokens: 300,
      maintenanceCostTokens: 200,
      materials: [
        {
          entryId: entryId("eligible"),
          sizeTokens: 400,
          eligible: true,
          providerInstanceId: providerId("active-provider"),
          modelId: modelId("active-model"),
        },
      ],
      maxMaterialTokens: 500,
    });

    expect(decision).toMatchObject({
      kind: "summarize",
      providerInstanceId: providerId("active-provider"),
      modelId: modelId("active-model"),
    });
  });

  it("requires explicit opt-in for cross-vendor maintenance", () => {
    const input = {
      activeProviderInstanceId: providerId("active-provider"),
      activeModelId: modelId("active-model"),
      maintenanceProviderInstanceId: providerId("other-provider"),
      maintenanceModelId: modelId("other-model"),
      expectedReuseCount: 3,
      expectedSavingsPerReuseTokens: 400,
      maintenanceCostTokens: 500,
      materials: [
        {
          entryId: entryId("eligible"),
          sizeTokens: 800,
          eligible: true,
          providerInstanceId: providerId("other-provider"),
          modelId: modelId("other-model"),
        },
      ],
      maxMaterialTokens: 1_000,
    } as const;

    expect(evaluateSemanticSummary({ ...input, crossVendorOptIn: false })).toEqual({
      kind: "skip",
      reason: "cross-vendor-opt-in-required",
    });
    expect(evaluateSemanticSummary({ ...input, crossVendorOptIn: true }).kind).toBe("summarize");
  });

  it("skips summaries that are ineligible, unbounded, or not net-positive", () => {
    const base = {
      activeProviderInstanceId: providerId("active-provider"),
      activeModelId: modelId("active-model"),
      maintenanceProviderInstanceId: providerId("active-provider"),
      maintenanceModelId: modelId("active-model"),
      crossVendorOptIn: false,
      expectedReuseCount: 1,
      expectedSavingsPerReuseTokens: 500,
      maintenanceCostTokens: 500,
      maxMaterialTokens: 1_000,
    } as const;

    expect(
      evaluateSemanticSummary({
        ...base,
        materials: [
          {
            entryId: entryId("denied"),
            sizeTokens: 100,
            eligible: false,
            providerInstanceId: providerId("active-provider"),
            modelId: modelId("active-model"),
          },
        ],
      }),
    ).toEqual({ kind: "skip", reason: "no-eligible-material" });
    expect(
      evaluateSemanticSummary({
        ...base,
        materials: [
          {
            entryId: entryId("large"),
            sizeTokens: 1_001,
            eligible: true,
            providerInstanceId: providerId("active-provider"),
            modelId: modelId("active-model"),
          },
        ],
      }),
    ).toEqual({ kind: "skip", reason: "material-limit-exceeded" });
    expect(
      evaluateSemanticSummary({
        ...base,
        materials: [
          {
            entryId: entryId("eligible"),
            sizeTokens: 500,
            eligible: true,
            providerInstanceId: providerId("active-provider"),
            modelId: modelId("active-model"),
          },
        ],
      }),
    ).toEqual({ kind: "skip", reason: "not-net-positive" });
  });

  it("scopes material eligibility to the selected maintenance provider and model", () => {
    const decision = evaluateSemanticSummary({
      activeProviderInstanceId: providerId("active-provider"),
      activeModelId: modelId("active-model"),
      maintenanceProviderInstanceId: providerId("other-provider"),
      maintenanceModelId: modelId("other-model"),
      crossVendorOptIn: true,
      expectedReuseCount: 2,
      expectedSavingsPerReuseTokens: 300,
      maintenanceCostTokens: 100,
      materials: [
        {
          entryId: entryId("wrong-provider"),
          sizeTokens: 300,
          eligible: true,
          providerInstanceId: providerId("active-provider"),
          modelId: modelId("active-model"),
        },
        {
          entryId: entryId("wrong-model"),
          sizeTokens: 300,
          eligible: true,
          providerInstanceId: providerId("other-provider"),
          modelId: modelId("different-model"),
        },
      ],
      maxMaterialTokens: 1_000,
    });

    expect(decision).toEqual({ kind: "skip", reason: "no-eligible-material" });
  });

  it("caps savings per reuse at the bounded eligible source size", () => {
    expect(
      evaluateSemanticSummary({
        activeProviderInstanceId: providerId("active-provider"),
        activeModelId: modelId("active-model"),
        crossVendorOptIn: false,
        expectedReuseCount: 2,
        expectedSavingsPerReuseTokens: 10_000,
        maintenanceCostTokens: 250,
        materials: [
          {
            entryId: entryId("small"),
            sizeTokens: 100,
            eligible: true,
            providerInstanceId: providerId("active-provider"),
            modelId: modelId("active-model"),
          },
        ],
        maxMaterialTokens: 500,
      }),
    ).toEqual({ kind: "skip", reason: "not-net-positive" });
  });

  it("reconciles positive and negative variance with bounded conservative reserve changes", () => {
    expect(
      reconcileContextVariance({
        requestShape: "code-tools",
        expectedRequestShape: "code-tools",
        plannedInputTokens: 1_000,
        actualInputTokens: 1_500,
        currentVarianceReserve: 200,
        maxAdjustmentTokens: 250,
      }),
    ).toEqual({
      requestShape: "code-tools",
      varianceTokens: 500,
      reserveAdjustmentTokens: 250,
      nextVarianceReserve: 450,
    });

    expect(
      reconcileContextVariance({
        requestShape: "code-tools",
        expectedRequestShape: "code-tools",
        plannedInputTokens: 1_500,
        actualInputTokens: 1_000,
        currentVarianceReserve: 400,
        maxAdjustmentTokens: 300,
      }),
    ).toEqual({
      requestShape: "code-tools",
      varianceTokens: -500,
      reserveAdjustmentTokens: -250,
      nextVarianceReserve: 150,
    });
  });

  it("converges on stable provider overhead instead of accumulating it each turn", () => {
    let reserve = 0;
    for (let turn = 0; turn < 4; turn++) {
      reserve = reconcileContextVariance({
        requestShape: "work-turn",
        expectedRequestShape: "work-turn",
        plannedInputTokens: 1_000,
        actualInputTokens: 1_500,
        currentVarianceReserve: reserve,
        maxAdjustmentTokens: 250,
      }).nextVarianceReserve;
    }
    expect(reserve).toBe(500);
  });

  it("rejects unsafe arithmetic and cross-shape variance learning", () => {
    expect(() =>
      reconcileContextVariance({
        requestShape: "chat-basic",
        expectedRequestShape: "code-tools",
        plannedInputTokens: 1,
        actualInputTokens: 2,
        currentVarianceReserve: 0,
        maxAdjustmentTokens: 10,
      }),
    ).toThrow(ContextCompactionRejected);
    expect(() =>
      evaluateSemanticSummary({
        activeProviderInstanceId: providerId("provider"),
        activeModelId: modelId("model"),
        maintenanceProviderInstanceId: providerId("provider"),
        maintenanceModelId: modelId("model"),
        crossVendorOptIn: false,
        expectedReuseCount: Number.MAX_SAFE_INTEGER,
        expectedSavingsPerReuseTokens: 2,
        maintenanceCostTokens: 0,
        materials: [
          {
            entryId: entryId("entry"),
            sizeTokens: 2,
            eligible: true,
            providerInstanceId: providerId("provider"),
            modelId: modelId("model"),
          },
        ],
        maxMaterialTokens: 2,
      }),
    ).toThrow(ContextCompactionRejected);
  });

  it("permits exactly one larger-margin context-length rebuild", () => {
    expect(
      decideContextLengthRecovery({
        currentMarginTokens: 200,
        marginIncreaseTokens: 150,
        rebuilds: 0,
      }),
    ).toEqual({ kind: "rebuild-once", nextMarginTokens: 350 });
    expect(
      decideContextLengthRecovery({
        currentMarginTokens: 350,
        marginIncreaseTokens: 150,
        rebuilds: 1,
      }),
    ).toEqual({ kind: "blocked", reason: "context-length-repeated" });
    expect(() =>
      decideContextLengthRecovery({
        currentMarginTokens: 200,
        marginIncreaseTokens: 0,
        rebuilds: 0,
      }),
    ).toThrow(ContextCompactionRejected);
  });
});

describe("session compaction on request", () => {
  const noFraming = { fixedTokens: 0, perItemTokens: 0 };
  const message = (
    id: string,
    exchangeKey: string,
    tokens: number,
    summarizable = true,
  ): SessionCompactionItem => ({
    entryId: entryId(id),
    kind: "message",
    exchangeKey,
    tokens,
    summarizable,
  });

  it("summarizes the conversation before a tail that fits a quarter of the safe budget", () => {
    const selection = selectSessionCompaction({
      summaryFraming: noFraming,
      safeInputBudget: 800,
      items: [
        message("u1", "turn-1", 100),
        message("a1", "turn-1", 100),
        message("u2", "turn-2", 100),
        message("a2", "turn-2", 100),
        message("u3", "turn-3", 100),
        message("a3", "turn-3", 90),
      ],
    });
    // A 200-token tail keeps turn 3 (190); turn 2 would push it to 390.
    expect(selection).toEqual({
      kind: "summarize",
      entryIds: ["u1", "a1", "u2", "a2"],
      materialTokens: 400,
      throughExchangeKey: "turn-2",
    });
  });

  it("always keeps the latest exchange, even one newer than the plan or larger than the tail", () => {
    expect(
      selectSessionCompaction({
        summaryFraming: noFraming,
        safeInputBudget: 400,
        items: [
          message("u1", "turn-1", 50),
          message("a1", "turn-1", 50),
          { kind: "message", exchangeKey: "turn-2", tokens: 900, summarizable: false },
        ],
      }),
    ).toEqual({
      kind: "summarize",
      entryIds: ["u1", "a1"],
      materialTokens: 100,
      throughExchangeKey: "turn-1",
    });
    expect(
      selectSessionCompaction({
        summaryFraming: noFraming,
        safeInputBudget: 400,
        items: [message("u1", "turn-1", 900), message("a1", "turn-1", 900)],
      }),
    ).toEqual({ kind: "nothing-to-compact" });
  });

  it("never summarizes pinned, excluded, or summarized entries, and leaves what does not fit", () => {
    expect(
      selectSessionCompaction({
        summaryFraming: noFraming,
        safeInputBudget: 400,
        items: [
          message("pinned", "turn-1", 50, false),
          message("a1", "turn-1", 300),
          message("u2", "turn-2", 300),
          message("a2", "turn-2", 50),
          message("u3", "turn-3", 20),
        ],
      }),
    ).toEqual({
      kind: "summarize",
      entryIds: ["a1"],
      materialTokens: 300,
      throughExchangeKey: "turn-1",
    });
  });

  it("leaves out material whose excerpt framing would overflow the summary request", () => {
    const items = [
      message("u1", "turn-1", 150),
      message("a1", "turn-1", 150),
      message("u2", "turn-2", 20),
    ];
    expect(
      selectSessionCompaction({ summaryFraming: noFraming, safeInputBudget: 300, items }),
    ).toMatchObject({ entryIds: ["u1", "a1"], materialTokens: 300 });
    // 40 for the instruction and 10 per excerpt: the second message no longer fits.
    expect(
      selectSessionCompaction({
        summaryFraming: { fixedTokens: 40, perItemTokens: 10 },
        safeInputBudget: 300,
        items,
      }),
    ).toEqual({
      kind: "summarize",
      entryIds: ["u1"],
      materialTokens: 150,
      throughExchangeKey: "turn-1",
    });
  });

  it("does not re-summarize an earlier summary on its own", () => {
    expect(
      selectSessionCompaction({
        summaryFraming: noFraming,
        safeInputBudget: 400,
        items: [
          {
            entryId: entryId("summary"),
            kind: "summary",
            exchangeKey: "summary",
            tokens: 40,
            summarizable: true,
          },
          message("u1", "turn-1", 20),
        ],
      }),
    ).toEqual({ kind: "nothing-to-compact" });
  });

  const available: SessionCompactionFacts = {
    principal: "local-window",
    modeEnabled: true,
    runsOnSshTarget: false,
    owner: "host",
    runtimeCompaction: "unsupported",
    turnAdmission: "admitted",
    hasSession: true,
    compactionRunning: false,
    turnRunning: false,
    providerAvailable: true,
    spendCeilingReached: false,
    somethingToCompact: true,
  };

  it("offers compaction only when every fact allows it, naming permanent refusals first", () => {
    expect(decideSessionCompaction(available)).toEqual({ status: "available" });
    const cases: ReadonlyArray<readonly [Partial<SessionCompactionFacts>, string]> = [
      [{ principal: "remote-device", modeEnabled: false }, "remote-client"],
      [{ modeEnabled: false, owner: "runtime" }, "mode-disabled"],
      [{ runsOnSshTarget: true, owner: "runtime" }, "runs-on-ssh-target"],
      [{ owner: "runtime", turnRunning: true }, "runtime-cannot-compact"],
      [{ owner: "runtime", runtimeCompaction: "unavailable" }, "runtime-version-unsupported"],
      [{ turnAdmission: "project-unavailable", hasSession: false }, "project-unavailable"],
      [
        { turnAdmission: "model-options-unsupported", turnRunning: true },
        "model-options-unsupported",
      ],
      [{ turnAdmission: "thread-paused", hasSession: false }, "thread-paused"],
      [{ hasSession: false, turnRunning: true }, "no-session"],
      [{ compactionRunning: true, turnRunning: true }, "compaction-running"],
      [{ turnRunning: true, providerAvailable: false }, "turn-running"],
      [{ providerAvailable: false, spendCeilingReached: true }, "provider-unavailable"],
      [{ spendCeilingReached: true, somethingToCompact: false }, "spend-ceiling-reached"],
      [{ somethingToCompact: false }, "nothing-to-compact"],
    ];
    for (const [facts, reason] of cases) {
      expect(decideSessionCompaction({ ...available, ...facts })).toEqual({
        status: "refused",
        reason,
      });
    }
    expect(
      decideSessionCompaction({ ...available, owner: "runtime", runtimeCompaction: "supported" }),
    ).toEqual({ status: "available" });
  });
});
