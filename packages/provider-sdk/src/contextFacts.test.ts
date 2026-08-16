import { describe, expect, it } from "vitest";
import {
  decodeProviderInstanceId,
  decodeProviderModelId,
  type UtcTimestamp,
} from "@octant/contracts";
import { normalizeModelLimitEvidence, unavailableProviderServiceLimits } from "./contextFacts";

const providerInstanceId = decodeProviderInstanceId("00000000-0000-4000-8000-000000000001");
const modelId = decodeProviderModelId("model-a");
const observedAt = "2026-07-18T18:30:00.000Z" as UtcTimestamp;

describe("provider context facts", () => {
  it("keeps context-only evidence incomplete instead of inventing maximum output", () => {
    const result = normalizeModelLimitEvidence({
      providerInstanceId,
      modelId,
      contextWindow: 200_000,
      source: "provider-discovery",
      confidence: "high",
      observedAt,
    });

    expect(result).toEqual({
      status: "unavailable",
      reason: "incomplete",
      missing: ["max-output"],
    });
  });

  it("emits strict complete limits only when both safe bounds are known", () => {
    const result = normalizeModelLimitEvidence({
      providerInstanceId,
      modelId,
      contextWindow: 200_000,
      maxOutput: 8_000,
      extendedContext: { kind: "unavailable" },
      reasoning: "unknown",
      compaction: "unknown",
      tokenizer: { kind: "unavailable" },
      source: "provider-discovery",
      confidence: "medium",
      observedAt,
    });

    expect(result).toMatchObject({
      status: "available",
      limits: {
        contextWindow: 200_000,
        maxOutput: 8_000,
        source: "provider-discovery",
        confidence: "medium",
      },
    });
    expect(() =>
      normalizeModelLimitEvidence({
        providerInstanceId,
        modelId,
        contextWindow: 4_000,
        maxOutput: 8_000,
        source: "provider-discovery",
        confidence: "high",
        observedAt,
      }),
    ).toThrow(/maximum output/i);
  });

  it("represents absent service-limit buckets as unavailable, never unlimited", () => {
    expect(
      unavailableProviderServiceLimits(providerInstanceId, observedAt, "provider-discovery"),
    ).toEqual({
      providerInstanceId,
      scope: "provider-instance",
      requests: { status: "unavailable" },
      tokens: { status: "unavailable" },
      concurrency: { status: "unavailable" },
      retry: { status: "inactive" },
      quota: "unavailable",
      source: "provider-discovery",
      confidence: "unknown",
      updatedAt: observedAt,
    });
  });
});
