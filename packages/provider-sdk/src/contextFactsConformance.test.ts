import {
  decodeProviderInstanceId,
  decodeProviderModelId,
  decodeProviderServiceLimits,
  type ProviderFailure,
  type UtcTimestamp,
} from "@octant/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { ProviderContextFactsSource } from "./contextFacts";
import { runProviderContextFactsConformance } from "./contextFactsConformance";

const instanceId = decodeProviderInstanceId("00000000-0000-4000-8000-000000000001");
const otherId = decodeProviderInstanceId("00000000-0000-4000-8000-000000000002");
const modelId = decodeProviderModelId("model-a");
const observedAt = "2026-07-18T18:30:00.000Z" as UtcTimestamp;

function source(providerInstanceId = instanceId): ProviderContextFactsSource {
  return {
    observeModelLimits: () =>
      Effect.succeed([
        {
          providerInstanceId,
          modelId,
          contextWindow: 200_000,
          source: "provider-discovery",
          confidence: "high",
          observedAt,
        },
      ]),
    observeServiceLimits: () =>
      Effect.succeed(
        decodeProviderServiceLimits({
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
        }),
      ),
  };
}

describe("provider context facts conformance", () => {
  it("accepts honest incomplete model evidence and unavailable service buckets", async () => {
    await expect(
      Effect.runPromise(
        Effect.scoped(runProviderContextFactsConformance(source(), { instanceId })),
      ),
    ).resolves.toEqual({ modelFactsHonest: true, serviceFactsHonest: true });
  });

  it("fails closed when a source returns facts for a different provider instance", async () => {
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.exit(runProviderContextFactsConformance(source(otherId), { instanceId })),
      ),
    );
    expect(String(exit)).toContain("provider-failed" satisfies ProviderFailure["category"]);
  });

  it("fails closed when complete model evidence contains contradictory bounds", async () => {
    const invalidSource: ProviderContextFactsSource = {
      ...source(),
      observeModelLimits: () =>
        Effect.succeed([
          {
            providerInstanceId: instanceId,
            modelId,
            contextWindow: 4_000,
            maxOutput: 8_000,
            source: "provider-discovery",
            confidence: "high",
            observedAt,
          },
        ]),
    };

    const exit = await Effect.runPromise(
      Effect.scoped(Effect.exit(runProviderContextFactsConformance(invalidSource, { instanceId }))),
    );

    expect(String(exit)).toContain("provider-failed" satisfies ProviderFailure["category"]);
  });
});
