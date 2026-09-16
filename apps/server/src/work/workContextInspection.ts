import { Effect } from "effect";
import {
  normalizeModelLimitEvidence,
  unavailableProviderServiceLimits,
} from "@octant/provider-sdk/context-facts";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import { decodeModelContextLimits, UtcTimestamp } from "@octant/contracts";
import { Schema } from "effect";
import { resolveEffectiveModelLimits } from "@octant/domain/context-policy";
import { deriveCatalogEpoch } from "../context/capabilityCatalog";
import type {
  ContextInspectorSnapshot,
  ModelContextLimits,
  ProviderContextBlock,
  ProviderServiceLimits,
} from "@octant/contracts";
import type { ContextHarnessService } from "../context/contextHarnessService";
import { WORK_TURN_SAFE_INPUT_TOKENS, type WorkTurnContextPlan } from "./workTurnContext";

export function publishWorkContext(input: {
  readonly service: ContextHarnessService;
  readonly plan: Extract<WorkTurnContextPlan, { readonly kind: "ok" }>;
  readonly displayLabel: string;
  readonly modelLimitObservations: ReadonlyArray<ModelContextLimits>;
  readonly serviceLimits: ProviderServiceLimits;
}):
  | {
      readonly snapshot: ContextInspectorSnapshot;
      readonly context: ReadonlyArray<ProviderContextBlock>;
    }
  | undefined {
  const manifest = input.plan.manifest;
  const modelLimitObservations = input.modelLimitObservations.filter(
    (limits) =>
      String(limits.providerInstanceId) === String(manifest.providerInstanceId) &&
      String(limits.modelId) === String(manifest.modelId),
  );
  if (modelLimitObservations.length === 0) return undefined;
  const modelLimits = resolveEffectiveModelLimits(modelLimitObservations);
  const activeScope = {
    mode: { referenceId: "mode:work", revision: 1 },
    project: { referenceId: `work-thread:${manifest.subject.aggregateId}`, revision: 1 },
    host: { referenceId: "host:local", revision: 1 },
    model: { referenceId: `model:${manifest.modelId}`, revision: 1 },
  };
  const snapshot = input.service.planTurn({
    subject: manifest.subject,
    displayLabel: input.displayLabel,
    requestShape: "work-turn",
    modelLimitObservations,
    serviceLimits: input.serviceLimits,
    entries: manifest.entries,
    reserves: {
      response:
        modelLimits.maxOutput ??
        Math.min(4_096, Math.max(1, Math.floor(modelLimits.contextWindow / 4))),
      reasoning: 0,
      framing: 0,
      variance: 0,
      safety: 0,
    },
    watchHeadroomTokens: 100,
    capabilityCatalog: {
      entries: [],
      epoch: deriveCatalogEpoch({
        entries: [],
        activeFacts: { providerInstanceId: manifest.providerInstanceId, activeScope },
        invalidationFacts: [],
      }),
    },
    capabilityRequest: {
      providerInstanceId: manifest.providerInstanceId,
      activeScope,
      nativeToolSearch: "unsupported",
      taskKeywords: [],
      explicitSelections: [],
    },
  });
  const included = new Set(
    snapshot.next.plan.entries
      .filter(
        (entry) =>
          entry.state !== "omitted" && entry.state !== "reserved" && entry.state !== "summarized",
      )
      .map((entry) => String(entry.entryId)),
  );
  let index = 0;
  const context = manifest.entries.flatMap((entry) => {
    if (
      entry.state === "omitted" ||
      entry.category === "current-request" ||
      entry.category === "octant-tools"
    )
      return [];
    const block = input.plan.context[index++];
    return block !== undefined && included.has(String(entry.id)) ? [block] : [];
  });
  return { snapshot, context };
}

export async function observeWorkContext(input: {
  readonly service: ContextHarnessService;
  readonly plan: Extract<WorkTurnContextPlan, { readonly kind: "ok" }>;
  readonly driver: ProviderDriver;
  readonly displayLabel: string;
  readonly signal: AbortSignal;
}) {
  const facts = input.driver.contextFacts;
  if (input.signal.aborted) return undefined;
  const evidence =
    facts === undefined
      ? []
      : await Effect.runPromise(
          Effect.scoped(
            facts.observeModelLimits({ instanceId: input.plan.manifest.providerInstanceId }),
          ).pipe(
            Effect.timeout("2 seconds"),
            Effect.catchAllCause(() => Effect.succeed([])),
          ),
          { signal: input.signal },
        ).catch(() => []);
  if (input.signal.aborted) return undefined;
  const modelLimitObservations = evidence.flatMap((item) => {
    try {
      const observed = normalizeModelLimitEvidence(item);
      return observed.status === "available" ? [observed.limits] : [];
    } catch {
      return [];
    }
  });
  if (modelLimitObservations.length === 0) {
    modelLimitObservations.push(
      decodeModelContextLimits({
        providerInstanceId: input.plan.manifest.providerInstanceId,
        modelId: input.plan.manifest.modelId,
        contextWindow: WORK_TURN_SAFE_INPUT_TOKENS + 4_096,
        extendedContext: { kind: "unavailable" },
        reasoning: "unknown",
        compaction: "unknown",
        tokenizer: { kind: "unavailable" },
        source: "conservative-fallback",
        confidence: "low",
        conflicts: [],
        verifiedAt: input.plan.manifest.createdAt,
      }),
    );
  }
  return publishWorkContext({
    service: input.service,
    plan: input.plan,
    displayLabel: input.displayLabel,
    modelLimitObservations,
    serviceLimits: unavailableProviderServiceLimits(
      input.plan.manifest.providerInstanceId,
      Schema.decodeUnknownSync(UtcTimestamp)(input.plan.manifest.createdAt),
      "runtime-reported",
    ),
  });
}
