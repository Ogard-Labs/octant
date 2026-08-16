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

export type AutomationAuthorityRevalidationResult =
  | { readonly kind: "ok" }
  | { readonly kind: "blocked"; readonly reason: AutomationBlockReason; readonly message: string };

/**
 * Revalidate every due-occurrence authority fact server-side before thread
 * creation (design §4.2). A stale definition never silently adopts replacement
 * authority; Full access remains ineligible.
 */
export function revalidateAutomationAuthority(input: {
  readonly definition: AutomationDefinition;
  readonly run: AutomationRun;
  readonly facts: AutomationAuthorityLiveFacts;
}): AutomationAuthorityRevalidationResult {
  const snapshot = input.run.definitionSnapshot;
  if (String(snapshot.hostId) !== input.facts.hostId) {
    return blocked("host-mismatch", "Automation host identity no longer matches this host.");
  }
  if (String(input.definition.hostId) !== input.facts.hostId) {
    return blocked("host-mismatch", "Automation definition host identity no longer matches.");
  }
  if (snapshot.mode !== "work" && snapshot.mode !== "code") {
    return blocked("unsupported-mode", "Automation mode is unsupported for dispatch.");
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
  const project = input.facts.project;
  if (
    project === undefined ||
    project.lifecycle !== "active" ||
    project.type !== snapshot.mode ||
    String(project.id) !== String(snapshot.projectId) ||
    project.version !== snapshot.projectVersion
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

export function automationPromptDigest(taskPrompt: string): AutomationDigest {
  return createHash("sha256")
    .update("octant.automation-prompt.v1\0")
    .update(taskPrompt)
    .digest("hex") as AutomationDigest;
}

export function buildAutomationAuthorityFactsFromHost(input: {
  readonly hostId: string;
  readonly project: Project | undefined;
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
