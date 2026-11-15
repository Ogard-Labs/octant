import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  decodeProviderInstanceId,
  decodeSpendCeilingReservationId,
  IMAGE_DESCRIPTION_REQUEST_SHAPE,
  IMAGE_DESCRIPTION_USAGE_AGGREGATE_TYPE,
  type ProjectId,
  type WindowId,
  type WindowWorkspace,
  type Project,
  type ProviderInstance,
  type ProviderModel,
} from "@octant/contracts";
import { usageLimitFromReading } from "@octant/domain";
import { windowAdmitsProject } from "@octant/domain/shell-policy";
import { coordinatorCandidateFacts } from "../coordinator/coordinatorWorkerFacts";
import { ImageDescriber } from "../harness/imageDescription";
import type { NativeHarnessRoutingStore } from "../harness/nativeHarnessRoutingStore";
import type { PersistenceService } from "../persistence/persistenceService";
import type { ProviderAvailabilityMarks } from "../providers/providerAvailabilityMarks";
import type { ProviderRuntimeRegistry } from "../providers/providerRuntimeRegistry";
import type { ProviderUsageLimitsService } from "../providers/providerUsageLimitsService";
import { supportsConversationInput } from "./conversationInputs";
import { recordOneShotUsage } from "../shield/shieldUsageLedger";
import type { SpendCeilingService } from "../spendCeilingService";
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
  /** The ceilings a describe is admitted under; absent, none applies. */
  readonly spendCeiling?: Pick<SpendCeilingService, "admit" | "settle" | "abandon">;
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
    spend: {
      admit: ({ scope, projectId, candidate }) => {
        const reservationId = decodeSpendCeilingReservationId(randomUUID());
        const admission = deps.spendCeiling?.admit({
          reservationId,
          threadId: scope.threadId,
          threadType: scope.threadType,
          ...(projectId === undefined ? {} : { projectId: String(projectId) }),
          turnUpperBoundTokens: IMAGE_DESCRIPTION_TOKEN_BOUND,
          // A describe is spend, not a turn of the thread's own.
          countsAsTurn: false,
        });
        if (admission?.status === "refused") {
          return { status: "refused", reason: admission.refusal.message };
        }
        return {
          status: "admitted",
          // Recorded under the thread before the reservation goes, so the next
          // admission sees it as committed spend.
          settle: (usage) => {
            try {
              recordOneShotUsage(
                {
                  connection: persistence.connection,
                  journal: persistence.journal,
                  clock: () => new Date().toISOString(),
                  uuid: randomUUID,
                },
                {
                  threadId: scope.threadId,
                  providerInstanceId: candidate.providerInstanceId,
                  modelId: candidate.modelId,
                  usage,
                  aggregateType: IMAGE_DESCRIPTION_USAGE_AGGREGATE_TYPE,
                  requestShape: IMAGE_DESCRIPTION_REQUEST_SHAPE,
                },
              );
            } catch {
              // A ledger that refuses the record still releases the reservation.
            }
            deps.spendCeiling?.settle({
              reservationId,
              ...(usage === undefined
                ? {}
                : { observedTokens: usage.inputTokens + usage.outputTokens }),
            });
          },
          abandon: () => deps.spendCeiling?.abandon({ reservationId }),
        };
      },
    },
  });
}

/** What one describe may spend: a picture and a bounded answer. */
const IMAGE_DESCRIPTION_TOKEN_BOUND = 16_000;

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

/**
 * Whether a window may see a Project, of any kind, by its own persisted
 * workspace: the Project is the window's context for that Project's mode, or
 * a pane it shows. A Chat Project held as the window's Chat context counts.
 */
export function windowSeesProject(
  sources: {
    readonly readProject: (projectId: ProjectId) => Project | undefined;
    readonly readWorkspace: (windowId: WindowId) => WindowWorkspace | undefined;
  },
  windowId: WindowId,
  projectId: ProjectId,
): boolean {
  const project = sources.readProject(projectId);
  const workspace = sources.readWorkspace(windowId);
  return (
    project !== undefined &&
    project.lifecycle === "active" &&
    workspace !== undefined &&
    windowAdmitsProject(workspace, project.type, projectId)
  );
}
