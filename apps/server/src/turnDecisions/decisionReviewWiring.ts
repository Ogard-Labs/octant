import { randomUUID } from "node:crypto";
import {
  DECISION_REVIEW_REQUEST_SHAPE,
  DECISION_REVIEW_USAGE_AGGREGATE_TYPE,
  decodeProviderSessionId,
  type ProviderInstanceId,
} from "@octant/contracts";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import { completeOnceOutcome } from "../harness/nativeHarnessSingleShot";
import type { PersistenceService } from "../persistence/persistenceService";
import type { PersonMemoryStore } from "../personMemory/personMemoryStore";
import { redactForPersonMemory } from "../personMemory/personMemorySweep";
import { recordOneShotUsage } from "../shield/shieldUsageLedger";
import type { DecisionReviewDependencies } from "./decisionReviews";

/**
 * The model side of a decision's second opinion, from the host's own pieces:
 * the person's choice, the configured driver for that account, and a
 * tool-less one-shot in a scratch folder outside every Project. The chosen
 * account is asked as it is; when it cannot answer, no other one is tried.
 */
export function createDecisionReviewModelPort(input: {
  readonly persistence: Pick<PersistenceService, "connection" | "journal" | "readProviderInstance">;
  readonly store: Pick<PersonMemoryStore, "settings" | "leavesNoTrace" | "projectExcluded">;
  readonly resolveDriver: (providerInstanceId: ProviderInstanceId) => ProviderDriver | undefined;
  readonly accountUnavailable: (providerInstanceId: ProviderInstanceId) => string | undefined;
  readonly scratchRoot: string;
}): Pick<
  DecisionReviewDependencies,
  | "chosenModel"
  | "accountUnavailable"
  | "keptOutOfMemory"
  | "providerIdentity"
  | "redact"
  | "complete"
  | "recordUsage"
> {
  const { persistence } = input;
  return {
    chosenModel: () => input.store.settings().decisionReviewModel,
    accountUnavailable: input.accountUnavailable,
    keptOutOfMemory: (decision) =>
      input.store.leavesNoTrace({ mode: decision.mode, threadId: String(decision.threadId) }) ||
      input.store.projectExcluded(String(decision.projectId)),
    providerIdentity: (id) => {
      const instance = persistence.readProviderInstance(id);
      return instance === undefined
        ? undefined
        : { displayName: instance.displayName, driverKind: String(instance.driverKind) };
    },
    redact: redactForPersonMemory,
    complete: async ({ model, instructions, prompt, timeoutMs }) => {
      const driver = input.resolveDriver(model.providerInstanceId);
      if (driver === undefined) return { status: "unavailable" };
      const outcome = await completeOnceOutcome({
        driver,
        providerInstanceId: model.providerInstanceId,
        modelId: model.modelId,
        sessionId: decodeProviderSessionId(randomUUID()),
        projectRoot: input.scratchRoot,
        instructions,
        prompt,
        timeoutMs,
      });
      if (outcome.status === "completed") {
        return { status: "answered", text: outcome.text, usage: outcome.usage };
      }
      return outcome.status === "withheld"
        ? { status: "withheld", usage: outcome.usage }
        : { status: "unavailable" };
    },
    recordUsage: ({ threadId, model, usage }) =>
      recordOneShotUsage(
        {
          connection: persistence.connection,
          journal: persistence.journal,
          clock: () => new Date().toISOString(),
          uuid: randomUUID,
        },
        {
          threadId,
          providerInstanceId: model.providerInstanceId,
          modelId: model.modelId,
          usage,
          aggregateType: DECISION_REVIEW_USAGE_AGGREGATE_TYPE,
          requestShape: DECISION_REVIEW_REQUEST_SHAPE,
        },
      ),
  };
}
