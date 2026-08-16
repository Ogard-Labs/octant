import type {
  AutomationDefinition,
  AutomationRun,
  Project,
  ProviderInstance,
  ProviderModelId,
} from "@octant/contracts";
import {
  buildAutomationAuthorityFactsFromHost,
  type AutomationAuthorityLiveFacts,
} from "./automationAuthorityRevalidation";

export interface ResolveAutomationAuthorityLiveFactsDeps {
  readonly hostId: string;
  readonly readProject: (projectId: string) => Project | undefined;
  readonly readProviderInstance: (providerInstanceId: string) => ProviderInstance | undefined;
  readonly providerSupportsModel: (providerInstanceId: string, modelId: ProviderModelId) => boolean;
  readonly readExecutionProfileVersion: (
    profileId: string,
  ) => { readonly version: number; readonly executionPolicy: string } | undefined;
  readonly readCodeCheckoutAvailable: (input: {
    readonly projectId: string;
    readonly bindingRevisionId: string;
    readonly repositoryId: string;
    readonly checkoutId: string;
  }) => boolean;
}

/**
 * Build live revalidation facts for one Automation dispatch attempt from the
 * host's authoritative Project/provider/profile projections.
 */
export function resolveAutomationAuthorityLiveFacts(
  deps: ResolveAutomationAuthorityLiveFactsDeps,
  input: { readonly definition: AutomationDefinition; readonly run: AutomationRun },
): AutomationAuthorityLiveFacts {
  const snapshot = input.run.definitionSnapshot;
  const project = deps.readProject(String(snapshot.projectId));
  const providerInstance = deps.readProviderInstance(
    String(snapshot.executionProfile.providerInstanceId),
  );
  const liveProfile = deps.readExecutionProfileVersion(String(snapshot.executionProfile.profileId));
  const binding = snapshot.binding;
  const latestBindingRevisionId =
    project !== undefined && "bindingHistory" in project
      ? project.bindingHistory.at(-1)?.revisionId
      : undefined;
  const bindingRevisionMatches =
    latestBindingRevisionId !== undefined &&
    String(latestBindingRevisionId) === String(binding.bindingRevisionId);
  const codeBindingMatches =
    binding.kind !== "code" ||
    (bindingRevisionMatches &&
      deps.readCodeCheckoutAvailable({
        projectId: String(binding.projectId),
        bindingRevisionId: String(binding.bindingRevisionId),
        repositoryId: String(binding.repositoryId),
        checkoutId: String(binding.checkoutId),
      }));
  const workBindingMatches = binding.kind !== "work" || bindingRevisionMatches;
  const executionProfileMatches =
    liveProfile !== undefined &&
    liveProfile.version === snapshot.executionProfile.profileVersion &&
    liveProfile.executionPolicy === snapshot.executionProfile.executionPolicy &&
    liveProfile.executionPolicy !== "full-access";
  // Authority profiles are receipt-bound on the definition revision. Without a
  // separate live authority-profile store, refuse closed when the captured
  // digest is empty or Full access appears on the effective snapshot.
  const authorityDigestMatches =
    snapshot.authorityProfile.effectiveAuthorityDigest.length > 0 &&
    snapshot.authorityProfile.effective.executionPolicy !== "full-access" &&
    snapshot.authorityProfile.requested.executionPolicy !== "full-access";

  return buildAutomationAuthorityFactsFromHost({
    hostId: deps.hostId,
    project,
    providerInstance,
    providerSupportsModel: deps.providerSupportsModel(
      String(snapshot.executionProfile.providerInstanceId),
      snapshot.executionProfile.modelId,
    ),
    executionProfileMatches,
    authorityDigestMatches,
    codeBindingMatches,
    workBindingMatches,
    extensionTrustMatches: true,
  });
}
