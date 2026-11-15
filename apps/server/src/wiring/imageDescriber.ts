import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  decodeProviderInstanceId,
  type Project,
  type ProviderInstance,
  type ProviderModel,
} from "@octant/contracts";
import { usageLimitFromReading } from "@octant/domain";
import { coordinatorCandidateFacts } from "../coordinator/coordinatorWorkerFacts";
import { ImageDescriber } from "../harness/imageDescription";
import type { NativeHarnessRoutingStore } from "../harness/nativeHarnessRoutingStore";
import type { PersistenceService } from "../persistence/persistenceService";
import type { ProviderAvailabilityMarks } from "../providers/providerAvailabilityMarks";
import type { ProviderRuntimeRegistry } from "../providers/providerRuntimeRegistry";
import type { ProviderUsageLimitsService } from "../providers/providerUsageLimitsService";
import { supportsConversationInput } from "./conversationInputs";
import { makeConfiguredProviderDriver, type ConfiguredProviderDriverOptions } from "./providers";

/**
 * The host's one Sees images describer, read by Code, Work, and Chat alike.
 * Its facts about each model are the ones a coordinator worker's choice
 * reads (sign-in, availability marks, plan-usage readings, the Project's
 * provider policy and data rules), so an image never goes to a model a
 * worker could not be started on for the same reason.
 */
export function createHostImageDescriber(deps: {
  readonly persistence: PersistenceService;
  readonly providerRuntimeRegistry: ProviderRuntimeRegistry;
  readonly nativeHarnessRoutingStore: Pick<NativeHarnessRoutingStore, "host" | "projectOverride">;
  readonly providerAvailabilityMarks: Pick<ProviderAvailabilityMarks, "read">;
  readonly providerUsageLimitsService: Pick<ProviderUsageLimitsService, "snapshot">;
  readonly isProjectPolicyTargetAllowed: (
    project: Exclude<Project, { readonly type: "chat" }>,
    providerInstanceId: ProviderInstance["id"],
    modelId: ProviderModel["id"],
  ) => boolean;
  readonly configuredDriverOptions: () => ConfiguredProviderDriverOptions;
  readonly providerDataDirectory: string;
}): ImageDescriber {
  const { persistence, providerRuntimeRegistry } = deps;
  return new ImageDescriber({
    roles: (projectId) => ({
      host: deps.nativeHarnessRoutingStore.host().configuration,
      project:
        projectId === undefined
          ? undefined
          : deps.nativeHarnessRoutingStore.projectOverride(projectId)?.configuration,
    }),
    readProject: (projectId) => persistence.readProject(projectId),
    candidateFacts: (project, candidate) =>
      coordinatorCandidateFacts(
        {
          readProviderInstance: (id) => persistence.readProviderInstance(id),
          observedState: (id) => providerRuntimeRegistry.observedState(id),
          catalogModel: (providerInstanceId, modelId) =>
            persistence
              .readProviderCatalog?.(providerInstanceId)
              ?.models.find((model) => String(model.id) === String(modelId)),
          isTargetAllowed: deps.isProjectPolicyTargetAllowed,
          availability: (providerInstanceId) =>
            deps.providerAvailabilityMarks.read(providerInstanceId),
          usageReading: (providerInstanceId) =>
            usageLimitFromReading(
              deps.providerUsageLimitsService
                .snapshot()
                .entries.find((entry) => String(entry.providerInstanceId) === providerInstanceId),
              Date.now(),
            ),
        },
        project,
        candidate,
      ),
    takesImage: (candidate, mediaType) =>
      supportsConversationInput(
        providerRuntimeRegistry.observedState(
          decodeProviderInstanceId(String(candidate.providerInstanceId)),
        ),
        String(candidate.modelId),
        mediaType,
      ),
    resolveDriver: (providerInstanceId) => {
      const instance = persistence.readProviderInstance(providerInstanceId);
      if (instance === undefined || !instance.enabled) return undefined;
      try {
        return makeConfiguredProviderDriver(instance, deps.configuredDriverOptions());
      } catch {
        return undefined;
      }
    },
    scratchRoot: join(deps.providerDataDirectory, "harness", "work"),
    uuid: randomUUID,
  });
}

/** A model's name as the person sees it, for a refusal that names it. */
export function modelLabelOf(
  deps: {
    readonly persistence: Pick<PersistenceService, "readProviderCatalog">;
    readonly providerRuntimeRegistry: Pick<ProviderRuntimeRegistry, "observedState">;
  },
  providerInstanceId: ProviderInstance["id"],
  modelId: ProviderModel["id"],
): string {
  const observed = deps.providerRuntimeRegistry
    .observedState(providerInstanceId)
    ?.models.find((model) => String(model.id) === String(modelId));
  const catalog = deps.persistence
    .readProviderCatalog?.(providerInstanceId)
    ?.models.find((model) => String(model.id) === String(modelId));
  return observed?.displayName ?? catalog?.displayName ?? String(modelId);
}
