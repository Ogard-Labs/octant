import type {
  NativeHarnessSlotCandidate,
  Project,
  ProviderInstance,
  ProviderInstanceId,
  ProviderModel,
  ProviderModelId,
  ProviderObservedState,
} from "@octant/contracts";
import {
  isNativeHarnessDriverKind,
  providerCanServeModel,
  type WorkerCandidateFacts,
} from "@octant/domain";
import type { ProviderAvailabilityMark } from "../providers/providerAvailabilityMarks";

/** One role model as the host sees it, for the choice and for the role card. */
export interface CoordinatorCandidateFacts extends WorkerCandidateFacts {
  readonly providerName: string;
  /** The model's context window in tokens, when known. */
  readonly contextTokens?: number;
}

/** A model as a role lists it, or as a worker runs on it. */
export type WorkerModelRef = Pick<NativeHarnessSlotCandidate, "providerInstanceId" | "modelId">;

export interface CoordinatorWorkerFactSources {
  readonly readProviderInstance: (id: ProviderInstanceId) => ProviderInstance | undefined;
  readonly observedState: (id: ProviderInstanceId) => ProviderObservedState | undefined;
  /** The catalog's entry for the model, which carries its data tags and context override. */
  readonly catalogModel: (
    providerInstanceId: ProviderInstanceId,
    modelId: ProviderModelId,
  ) => ProviderModel | undefined;
  readonly isTargetAllowed: (
    project: Exclude<Project, { readonly type: "chat" }>,
    providerInstanceId: ProviderInstanceId,
    modelId: ProviderModelId,
  ) => boolean;
  readonly availability: (providerInstanceId: string) => ProviderAvailabilityMark | undefined;
  /**
   * The account's limit as the host's last plan-usage reading says it, while
   * that reading says the limit is reached ({@link usageLimitFromReading}).
   */
  readonly usageReading: (providerInstanceId: string) => { readonly until?: string } | undefined;
}

/**
 * What the host knows about one role model for a worker in this Project,
 * read from what already exists: the provider's enabled and sign-in state,
 * its last check, the model list it reports (image input, context), tool
 * evidence, the Project's policy and data rules, the availability marks
 * its own requests left, and the plan-usage readings the host keeps.
 */
export function coordinatorCandidateFacts(
  sources: CoordinatorWorkerFactSources,
  project: Project | undefined,
  candidate: WorkerModelRef,
): CoordinatorCandidateFacts {
  const providerInstanceId = String(candidate.providerInstanceId);
  const modelId = String(candidate.modelId);
  const instance = sources.readProviderInstance(candidate.providerInstanceId);
  const observed = sources.observedState(candidate.providerInstanceId);
  const reported = observed?.models.find((model) => String(model.id) === modelId);
  const catalog = sources.catalogModel(candidate.providerInstanceId, candidate.modelId);
  const harness = instance !== undefined && isNativeHarnessDriverKind(instance.driverKind);
  const mark = sources.availability(providerInstanceId);
  // A failed request's own limit signal first, then the plan-usage reading.
  const usageLimit = mark?.usageLimit ?? sources.usageReading(providerInstanceId);
  const contextTokens =
    catalog?.contextWindowOverride ?? reported?.contextLimit ?? catalog?.contextLimit;
  const notReady: WorkerCandidateFacts["notReady"] =
    instance === undefined || !instance.enabled
      ? "provider-off"
      : observed === undefined || observed.readiness === "unauthenticated"
        ? "not-signed-in"
        : mark?.downUntil !== undefined
          ? "provider-down"
          : reported === undefined
            ? observed.readiness === "ready"
              ? "model-not-offered"
              : "provider-down"
            : // An endpoint the harness runs may serve while degraded; an
              // agent runtime must be ready.
              (
                  harness
                    ? providerCanServeModel(observed, reported.id)
                    : observed.readiness === "ready"
                )
              ? undefined
              : "provider-down";
  return {
    label: reported?.displayName ?? catalog?.displayName ?? modelId,
    providerKind: instance === undefined ? providerInstanceId : String(instance.driverKind),
    providerName: instance?.displayName ?? providerInstanceId,
    ...(notReady === undefined ? {} : { notReady }),
    ...(usageLimit === undefined ? {} : { usageLimit }),
    allowed:
      project !== undefined &&
      project.type !== "chat" &&
      sources.isTargetAllowed(project, candidate.providerInstanceId, candidate.modelId),
    // An agent runtime brings its own tools; an endpoint the harness runs
    // needs Octant's tools proven on it.
    toolsVerified:
      !harness ||
      observed?.capabilities.appManagedTools === "supported" ||
      (observed?.verifiedToolModelIds?.some((id) => String(id) === modelId) ?? false),
    readsImages: (reported ?? catalog)?.inputModalities.includes("image") ?? false,
    ...(contextTokens === undefined ? {} : { contextTokens }),
  };
}
