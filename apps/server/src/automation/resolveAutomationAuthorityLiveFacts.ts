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

/**
 * A Project on a registered server as a routine's revalidation reads it: the
 * binding its threads are created against (derived from the Project, server,
 * and folder alone), whether its server is still in the registry, or that the
 * person removed it.
 */
export type AutomationServerProjectBinding =
  | {
      readonly kind: "bound";
      readonly mode: "code";
      readonly serverRegistered: boolean;
      readonly bindingRevisionId: string;
      readonly repositoryId: string;
      readonly checkoutId: string;
    }
  | {
      readonly kind: "bound";
      readonly mode: "work";
      readonly serverRegistered: boolean;
      readonly bindingRevisionId: string;
    }
  | { readonly kind: "removed" };

export interface ResolveAutomationAuthorityLiveFactsDeps {
  readonly hostId: string;
  readonly readProject: (projectId: string) => Project | undefined;
  /**
   * The server Project with this id, when the local catalog has none. Server
   * Projects are a catalog of their own, so `readProject` never names one.
   */
  readonly readServerProject?: (projectId: string) => AutomationServerProjectBinding | undefined;
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
  input: {
    readonly definition: Pick<AutomationDefinition, "hostId">;
    readonly run: Pick<AutomationRun, "definitionSnapshot">;
  },
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
    binding.kind !== "chat" &&
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
  const server =
    project === undefined ? deps.readServerProject?.(String(snapshot.projectId)) : undefined;
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
    ...(server === undefined
      ? { codeBindingMatches, workBindingMatches }
      : {
          serverProject:
            server.kind === "removed"
              ? server
              : { kind: "bound", mode: server.mode, serverRegistered: server.serverRegistered },
          ...serverBindingMatches(server, binding),
        }),
    extensionTrustMatches: true,
  });
}

/**
 * A server Project's binding is the one its Project derives now: a Code
 * routine's checkout is the Project's own folder, and a Work routine's is its
 * Project's binding, so a rebound folder or another server never matches.
 */
function serverBindingMatches(
  server: AutomationServerProjectBinding,
  binding: AutomationRun["definitionSnapshot"]["binding"],
): { readonly codeBindingMatches: boolean; readonly workBindingMatches: boolean } {
  if (server.kind === "removed") return { codeBindingMatches: false, workBindingMatches: false };
  if (binding.kind === "chat") return { codeBindingMatches: false, workBindingMatches: false };
  const revisionMatches = String(binding.bindingRevisionId) === server.bindingRevisionId;
  if (binding.kind === "work") {
    return {
      codeBindingMatches: true,
      workBindingMatches: server.mode === "work" && revisionMatches,
    };
  }
  return {
    codeBindingMatches:
      server.mode === "code" &&
      revisionMatches &&
      String(binding.repositoryId) === server.repositoryId &&
      String(binding.checkoutId) === server.checkoutId,
    workBindingMatches: true,
  };
}
