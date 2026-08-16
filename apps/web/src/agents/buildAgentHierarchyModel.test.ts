import { describe, expect, it } from "vitest";
import { buildAgentHierarchyModel } from "./buildAgentHierarchyModel";

const entries = [
  {
    runId: "run-active",
    role: "research",
    task: "Active research",
    lifecycleStatus: "running",
    executionKind: "octant-managed",
    usageQuality: "provider-reported",
    resultAcknowledgement: { required: false, acknowledged: false },
    version: 2,
    updatedAt: "2026-08-01T15:01:00.000Z",
  },
  {
    runId: "run-done",
    parentRunId: "run-active",
    role: "review",
    task: "Completed review",
    lifecycleStatus: "completed",
    executionKind: "provider-native",
    usageQuality: "estimated",
    resultAcknowledgement: {
      required: true,
      acknowledged: false,
      followUpReason: "unacknowledged-child-result",
    },
    version: 4,
    updatedAt: "2026-08-01T15:02:00.000Z",
  },
] as const;

describe("buildAgentHierarchyModel", () => {
  it("splits active and history buckets and marks native read-only truth", () => {
    const model = buildAgentHierarchyModel({ entries, filter: "all" });
    expect(model.activeCount).toBe(1);
    expect(model.historyCount).toBe(1);
    const done = model.rows.find((row) => row.runId === "run-done");
    expect(done?.bucket).toBe("history");
    expect(done?.nativeReadOnly).toBe(true);
    expect(done?.needsAcknowledgement).toBe(true);
    expect(done?.depth).toBe(1);
  });

  it("filters by query without inventing authority", () => {
    const model = buildAgentHierarchyModel({ entries, filter: "all", query: "review" });
    expect(model.rows).toHaveLength(1);
    expect(model.rows[0]?.runId).toBe("run-done");
  });

  it("explains empty active state when posture is Off", () => {
    const model = buildAgentHierarchyModel({
      entries: [],
      filter: "active",
      creationPosture: "off",
    });
    expect(model.emptyReason).toMatch(/Off/i);
  });

  it("presents honest pool route receipt data without inventing routing", () => {
    const routeEntries = [
      {
        ...entries[0],
        runId: "run-pool-fallback",
        route: {
          requestedProviderInstanceId: "provider-a",
          requestedModelId: "gpt-4o",
          executionProviderInstanceId: "provider-b",
          executionModelId: "claude-x",
          poolDerived: true,
          selectionKind: "fallback" as const,
          routingReason: "The requested model is unavailable; a permitted fallback ran.",
        },
      },
      {
        ...entries[0],
        runId: "run-pool-waiting",
        lifecycleStatus: "waiting",
        route: {
          requestedProviderInstanceId: "provider-a",
          requestedModelId: "gpt-4o",
          executionProviderInstanceId: "provider-a",
          executionModelId: "gpt-4o",
          poolDerived: true,
          routingReason: "No selected model is currently eligible.",
        },
      },
      {
        ...entries[0],
        runId: "run-pool-requested",
        route: {
          requestedProviderInstanceId: "provider-a",
          requestedModelId: "gpt-4o",
          executionProviderInstanceId: "provider-a",
          executionModelId: "gpt-4o",
          poolDerived: true,
          selectionKind: "requested" as const,
          routingReason: "The requested model is selected and eligible.",
        },
      },
      {
        ...entries[0],
        runId: "run-plain",
        route: {
          requestedProviderInstanceId: "provider-a",
          requestedModelId: "gpt-4o",
          executionProviderInstanceId: "provider-a",
          executionModelId: "gpt-4o",
          poolDerived: false,
        },
      },
      { ...entries[0], runId: "run-no-route" },
    ];
    const model = buildAgentHierarchyModel({ entries: routeEntries, filter: "all" });
    const byId = new Map(model.rows.map((row) => [row.runId, row]));
    expect(byId.get("run-pool-fallback")?.routeLabel).toBe("gpt-4o → claude-x · pool fallback");
    expect(byId.get("run-pool-fallback")?.routeReason).toBe(
      "The requested model is unavailable; a permitted fallback ran.",
    );
    expect(byId.get("run-pool-waiting")?.routeLabel).toBe("gpt-4o · pool waiting");
    expect(byId.get("run-pool-waiting")?.routeReason).toBe(
      "No selected model is currently eligible.",
    );
    expect(byId.get("run-pool-requested")?.routeLabel).toBe("gpt-4o · pool");
    expect(byId.get("run-plain")?.routeLabel).toBe("gpt-4o");
    expect(byId.get("run-plain")?.routeReason).toBeUndefined();
    expect(byId.get("run-no-route")?.routeLabel).toBeUndefined();
  });
});
