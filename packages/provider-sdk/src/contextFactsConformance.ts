import {
  decodeModelContextLimits,
  decodeProviderServiceLimits,
  type ProviderFailure,
} from "@octant/contracts";
import { Effect } from "effect";
import type {
  ModelLimitMissingField,
  ProviderContextFactsInput,
  ProviderContextFactsSource,
} from "./contextFacts";
import { normalizeModelLimitEvidence } from "./contextFacts";

export interface ProviderContextFactsConformanceEvidence {
  readonly modelFactsHonest: true;
  readonly serviceFactsHonest: true;
}

const missingFields = new Set<ModelLimitMissingField>(["context-window", "max-output"]);

function invalidFacts(): ProviderFailure {
  return {
    category: "provider-failed",
    message: "Provider context facts failed conformance validation.",
  };
}

export function runProviderContextFactsConformance(
  source: ProviderContextFactsSource,
  input: ProviderContextFactsInput,
) {
  return Effect.gen(function* () {
    const observations = yield* source.observeModelLimits(input);
    const serviceLimits = yield* source.observeServiceLimits(input);
    yield* Effect.try({
      try: () => {
        for (const evidence of observations) {
          if (evidence.providerInstanceId !== input.instanceId) throw invalidFacts();
          const observation = normalizeModelLimitEvidence(evidence);
          if (observation.status === "available") {
            const limits = decodeModelContextLimits(observation.limits);
            if (limits.providerInstanceId !== input.instanceId) throw invalidFacts();
          } else if (
            observation.missing.length === 0 ||
            new Set(observation.missing).size !== observation.missing.length ||
            observation.missing.some((field) => !missingFields.has(field))
          ) {
            throw invalidFacts();
          }
        }
        const service = decodeProviderServiceLimits(serviceLimits);
        if (service.providerInstanceId !== input.instanceId) throw invalidFacts();
      },
      catch: invalidFacts,
    });
    return { modelFactsHonest: true, serviceFactsHonest: true } as const;
  });
}
