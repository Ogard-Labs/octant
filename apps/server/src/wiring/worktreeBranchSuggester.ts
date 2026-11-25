import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  decodeSpendCeilingReservationId,
  type Project,
  type ProviderInstance,
  type ProviderModel,
} from "@octant/contracts";
import type { CodeWorktreeBranchSuggestionPort } from "../code/codeService";
import { suggestWorktreeBranchWords } from "../code/worktreeBranchSuggestion";
import type { PersistenceService } from "../persistence/persistenceService";
import type { ProviderRuntimeRegistry } from "../providers/providerRuntimeRegistry";
import type { SpendCeilingService } from "../spendCeilingService";
import { makeConfiguredProviderDriver, type ConfiguredProviderDriverOptions } from "./providers";

/**
 * What one suggestion may spend: a short draft in and a handful of words out.
 * The bound is a reservation against token ceilings, not a limit on the model.
 */
const SUGGESTION_TOKEN_BOUND = 4_000;

/**
 * The host's one branch-name suggester. It runs on the model the Code composer
 * has selected, on the same Project rules and spend ceilings a turn there
 * would meet, and only when a person asks for it.
 */
export function createHostWorktreeBranchSuggester(deps: {
  readonly persistence: PersistenceService;
  readonly providerRuntimeRegistry: Pick<ProviderRuntimeRegistry, "observedState">;
  readonly isProjectPolicyTargetAllowed: (
    project: Exclude<Project, { readonly type: "chat" }>,
    providerInstanceId: ProviderInstance["id"],
    modelId: ProviderModel["id"],
  ) => boolean;
  readonly configuredDriverOptions: () => ConfiguredProviderDriverOptions;
  readonly providerDataDirectory: string;
  readonly spendCeiling?: Pick<SpendCeilingService, "admit" | "settle" | "abandon">;
}): CodeWorktreeBranchSuggestionPort {
  const { persistence } = deps;
  const ports = {
    scratchRoot: join(deps.providerDataDirectory, "harness", "work"),
    uuid: randomUUID,
    open: (input: {
      readonly projectId: string;
      readonly providerInstanceId: ProviderInstance["id"];
      readonly modelId: ProviderModel["id"];
    }) => {
      const instance = persistence.readProviderInstance(input.providerInstanceId);
      const model = persistence
        .readProviderCatalog?.(input.providerInstanceId)
        ?.models.find((candidate) => String(candidate.id) === String(input.modelId));
      if (
        instance === undefined ||
        !instance.enabled ||
        model === undefined ||
        deps.providerRuntimeRegistry.observedState(input.providerInstanceId)?.readiness !== "ready"
      ) {
        return { status: "refused" as const, reason: "provider-unavailable" as const };
      }
      const project = persistence.readProject(input.projectId as never);
      if (
        project?.type !== "code" ||
        project.lifecycle !== "active" ||
        !deps.isProjectPolicyTargetAllowed(project, instance.id, model.id)
      ) {
        return { status: "refused" as const, reason: "not-allowed" as const };
      }
      try {
        return {
          status: "ready" as const,
          driver: makeConfiguredProviderDriver(instance, deps.configuredDriverOptions()),
        };
      } catch {
        return { status: "refused" as const, reason: "provider-unavailable" as const };
      }
    },
    admit: (input: { readonly projectId: string }) => {
      const reservationId = decodeSpendCeilingReservationId(randomUUID());
      const admission = deps.spendCeiling?.admit({
        reservationId,
        // A draft has no thread yet, so only the Project's ceilings can apply.
        threadId: reservationId,
        threadType: "code-thread",
        projectId: input.projectId,
        turnUpperBoundTokens: SUGGESTION_TOKEN_BOUND,
        // The selected gateway can set its own prices for any model ID.
        estimatedCostUsdMicros: "unknown",
        countsAsTurn: false,
        skipTurnAndRunTimeCeiling: true,
      });
      if (admission?.status === "refused") return { status: "refused" as const };
      return {
        status: "admitted" as const,
        settle: (usage: { readonly inputTokens: number; readonly outputTokens: number } | undefined) =>
          deps.spendCeiling?.settle({
            reservationId,
            ...(usage === undefined
              ? {}
              : { observedTokens: usage.inputTokens + usage.outputTokens }),
          }),
        abandon: () => deps.spendCeiling?.abandon({ reservationId }),
      };
    },
  };
  return {
    suggest: (input) =>
      suggestWorktreeBranchWords(ports, {
        projectId: String(input.projectId),
        providerInstanceId: input.providerInstanceId,
        modelId: input.modelId,
        draft: input.draft,
      }),
  };
}
