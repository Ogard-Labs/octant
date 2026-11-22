import { createHash } from "node:crypto";
import type {
  AutomationBlockReason,
  AutomationDefinition,
  AutomationDigest,
  AutomationRun,
  Project,
  ProviderInstance,
} from "@octant/contracts";

/**
 * Live host facts the dispatcher revalidates against the immutable definition
 * and authority snapshots before creating a thread. Every check fails closed
 * with a typed {@link AutomationBlockReason}.
 */
export interface AutomationAuthorityLiveFacts {
  readonly hostId: string;
  readonly project: Project | undefined;
  /**
   * The routine's Project when it is one on a registered server, which the
   * local catalog never names. Absent for a local Project.
   */
  readonly serverProject?: AutomationServerProjectFacts;
  readonly providerInstance: ProviderInstance | undefined;
  readonly providerSupportsModel: boolean;
  readonly executionProfileMatches: boolean;
  readonly authorityDigestMatches: boolean;
  readonly extensionTrustMatches: boolean;
  /** Code checkout/worktree still available at the bound revision. */
  readonly codeBindingMatches: boolean;
  /** Work binding receipt still matches the Project root revision. */
  readonly workBindingMatches: boolean;
}

export type AutomationServerProjectFacts =
  | { readonly kind: "bound"; readonly mode: "code" | "work"; readonly serverRegistered: boolean }
  | { readonly kind: "removed" };

export type AutomationAuthorityRevalidationResult =
  | { readonly kind: "ok" }
  | { readonly kind: "blocked"; readonly reason: AutomationBlockReason; readonly message: string };

/**
 * Revalidate every due-occurrence authority fact server-side before thread
 * creation (design §4.2). A stale definition never silently adopts replacement
 * authority; Full access remains ineligible.
 */
export function revalidateAutomationAuthority(input: {
  readonly definition: Pick<AutomationDefinition, "hostId">;
  readonly run: Pick<AutomationRun, "definitionSnapshot" | "authoritySnapshot">;
  readonly facts: AutomationAuthorityLiveFacts;
}): AutomationAuthorityRevalidationResult {
  const snapshot = input.run.definitionSnapshot;
  if (String(snapshot.hostId) !== input.facts.hostId) {
    return blocked("host-mismatch", "Automation host identity no longer matches this host.");
  }
  if (String(input.definition.hostId) !== input.facts.hostId) {
    return blocked("host-mismatch", "Automation definition host identity no longer matches.");
  }
  if (
    snapshot.executionProfile.executionPolicy === "full-access" ||
    snapshot.authorityProfile.requested.executionPolicy === "full-access" ||
    snapshot.authorityProfile.effective.executionPolicy === "full-access" ||
    input.run.authoritySnapshot.effective.executionPolicy === "full-access" ||
    input.run.authoritySnapshot.requested.executionPolicy === "full-access"
  ) {
    return blocked(
      "full-access-ineligible",
      "Full access profiles are ineligible for Automation dispatch.",
    );
  }
  const server = input.facts.serverProject;
  if (server !== undefined) {
    const refusal = serverProjectRefusal(server, snapshot);
    if (refusal !== undefined) return refusal;
  } else if (
    input.facts.project === undefined ||
    input.facts.project.lifecycle !== "active" ||
    input.facts.project.type !== snapshot.mode ||
    String(input.facts.project.id) !== String(snapshot.projectId) ||
    input.facts.project.version !== snapshot.projectVersion
  ) {
    return blocked(
      "project-mismatch",
      "Automation Project is missing, inactive, or no longer matches the definition.",
    );
  }
  if (snapshot.mode === "code" && !input.facts.codeBindingMatches) {
    return blocked(
      "binding-mismatch",
      "Code Project binding, checkout, or worktree no longer matches the definition.",
    );
  }
  // Every Work turn holds the shell and Git at its level, and no turn can
  // withhold them. A Work routine captured without them, as every Work
  // routine was before Work shared Code's capability set, would run with
  // authority it was never given, so it does not run until a person saves it
  // again under a profile that grants them, which journals that choice.
  if (
    snapshot.mode === "work" &&
    !(
      snapshot.authorityProfile.effective.shell &&
      snapshot.authorityProfile.effective.git &&
      input.run.authoritySnapshot.effective.shell &&
      input.run.authoritySnapshot.effective.git
    )
  ) {
    return blocked(
      "authority-mismatch",
      "This Work routine was saved without the shell and Git every Work turn now holds. Edit it and choose a profile that grants them to run it again.",
    );
  }
  if (snapshot.mode === "work" && !input.facts.workBindingMatches) {
    return blocked("binding-mismatch", "Work Project binding no longer matches the definition.");
  }
  if (!input.facts.executionProfileMatches) {
    return blocked(
      "execution-profile-mismatch",
      "Execution profile revision no longer matches the definition.",
    );
  }
  if (
    input.facts.providerInstance === undefined ||
    !input.facts.providerInstance.enabled ||
    String(input.facts.providerInstance.id) !==
      String(snapshot.executionProfile.providerInstanceId) ||
    !input.facts.providerSupportsModel
  ) {
    return blocked(
      "provider-capability-mismatch",
      "Provider or model capability no longer matches the definition.",
    );
  }
  if (!input.facts.authorityDigestMatches) {
    return blocked(
      "authority-mismatch",
      "Authority profile digest no longer matches the captured Automation snapshot.",
    );
  }
  if (
    input.run.authoritySnapshot.effectiveAuthorityDigest !==
    snapshot.authorityProfile.effectiveAuthorityDigest
  ) {
    return blocked(
      "authority-mismatch",
      "Run authority snapshot digests do not match the definition revision.",
    );
  }
  if (!input.facts.extensionTrustMatches) {
    return blocked(
      "authority-mismatch",
      "Extension trust state no longer matches Automation authority.",
    );
  }
  if (
    snapshot.deliveryTarget.confirmed !== true ||
    snapshot.deliveryTarget.mode !== snapshot.mode
  ) {
    return blocked(
      "delivery-target-invalid",
      "Automation delivery-target template is missing, stale, or unconfirmed.",
    );
  }
  return { kind: "ok" };
}

/**
 * A routine in a Project on a server runs as a person-started turn there
 * would, so it is refused whenever such a turn would be: the person removed
 * the Project, or its server left the registry. Reaching the server is the
 * thread's own first step, which records a run that cannot reach it as failed.
 */
function serverProjectRefusal(
  server: AutomationServerProjectFacts,
  snapshot: AutomationRun["definitionSnapshot"],
): Extract<AutomationAuthorityRevalidationResult, { readonly kind: "blocked" }> | undefined {
  if (server.kind === "removed") {
    return blocked(
      "project-mismatch",
      "This routine's Project on a server was removed, so the routine cannot run. Bind the folder again and set the routine up there.",
    );
  }
  if (server.mode !== snapshot.mode) {
    return blocked(
      "project-mismatch",
      "This routine's Project on a server no longer matches the definition.",
    );
  }
  if (!server.serverRegistered) {
    return blocked(
      "binding-mismatch",
      "This routine's server is no longer registered in Settings › Permissions › Servers, so nothing can run there.",
    );
  }
  // A file routine watches a folder of this host; a server Project has none.
  if (snapshot.trigger.kind === "file-arrival") {
    return blocked(
      "binding-mismatch",
      "A file routine watches a folder on this computer, so it cannot run in a Project on a server.",
    );
  }
  return undefined;
}

export function automationPromptDigest(taskPrompt: string): AutomationDigest {
  return createHash("sha256")
    .update("octant.automation-prompt.v1\0")
    .update(taskPrompt)
    .digest("hex") as AutomationDigest;
}

export function buildAutomationAuthorityFactsFromHost(input: {
  readonly hostId: string;
  readonly project: Project | undefined;
  readonly serverProject?: AutomationServerProjectFacts;
  readonly providerInstance: ProviderInstance | undefined;
  readonly providerSupportsModel: boolean;
  readonly executionProfileMatches: boolean;
  readonly authorityDigestMatches: boolean;
  readonly extensionTrustMatches?: boolean;
  readonly codeBindingMatches?: boolean;
  readonly workBindingMatches?: boolean;
}): AutomationAuthorityLiveFacts {
  return {
    hostId: input.hostId,
    project: input.project,
    ...(input.serverProject === undefined ? {} : { serverProject: input.serverProject }),
    providerInstance: input.providerInstance,
    providerSupportsModel: input.providerSupportsModel,
    executionProfileMatches: input.executionProfileMatches,
    authorityDigestMatches: input.authorityDigestMatches,
    extensionTrustMatches: input.extensionTrustMatches ?? true,
    codeBindingMatches: input.codeBindingMatches ?? true,
    workBindingMatches: input.workBindingMatches ?? true,
  };
}

function blocked(
  reason: AutomationBlockReason,
  message: string,
): Extract<AutomationAuthorityRevalidationResult, { readonly kind: "blocked" }> {
  return { kind: "blocked", reason, message };
}
