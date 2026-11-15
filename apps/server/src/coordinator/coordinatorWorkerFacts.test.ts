import { describe, expect, it } from "vitest";
import { usageLimitFromReading } from "@octant/domain";
import {
  coordinatorCandidateFacts,
  type CoordinatorWorkerFactSources,
} from "./coordinatorWorkerFacts";

const PROVIDER = "60000000-0000-4000-8000-000000000001";
const now = Date.parse("2026-11-15T12:00:00.000Z");
const project = { id: "p", type: "code", lifecycle: "active" } as never;
const model = { providerInstanceId: PROVIDER, modelId: "sonnet" } as never;

function sources(
  windows: ReadonlyArray<Record<string, unknown>> | undefined,
  overrides: Partial<CoordinatorWorkerFactSources> = {},
): CoordinatorWorkerFactSources {
  return {
    readProviderInstance: () =>
      ({
        id: PROVIDER,
        enabled: true,
        driverKind: "claude-code",
        displayName: "Anthropic",
      }) as never,
    observedState: () =>
      ({
        readiness: "ready",
        models: [{ id: "sonnet", displayName: "Sonnet 5.5", inputModalities: ["text", "image"] }],
        capabilities: {},
      }) as never,
    catalogModel: () => undefined,
    isTargetAllowed: () => true,
    availability: () => undefined,
    usageReading: () =>
      windows === undefined
        ? undefined
        : usageLimitFromReading(
            {
              status: "available",
              providerInstanceId: PROVIDER,
              limits: { rateLimitWindows: windows },
            } as never,
            now,
          ),
    ...overrides,
  };
}

describe("a role model's facts for a worker", () => {
  it("counts a model at its limit while the plan-usage reading says the limit is reached", () => {
    const fact = coordinatorCandidateFacts(
      sources([{ window: "five-hour", status: "exhausted", resetsAt: "2026-11-15T14:00:00.000Z" }]),
      project,
      model,
    );
    expect(fact.usageLimit).toEqual({ until: "2026-11-15T14:00:00.000Z" });
    expect(fact.notReady).toBeUndefined();
  });

  it("never filters on a reading below the limit", () => {
    const fact = coordinatorCandidateFacts(
      sources([{ window: "five-hour", status: "warning", utilization: 0.97 }]),
      project,
      model,
    );
    expect(fact.usageLimit).toBeUndefined();
  });

  it("prefers a failed request's own limit signal over the reading", () => {
    const fact = coordinatorCandidateFacts(
      sources([{ window: "w", status: "exhausted", resetsAt: "2026-11-15T14:00:00.000Z" }], {
        availability: () => ({ usageLimit: { until: "2026-11-15T13:00:00.000Z" } }),
      }),
      project,
      model,
    );
    expect(fact.usageLimit).toEqual({ until: "2026-11-15T13:00:00.000Z" });
  });
});
