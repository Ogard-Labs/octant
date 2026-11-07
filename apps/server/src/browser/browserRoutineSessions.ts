import {
  decodeToolActionAuthority,
  LOCAL_HOST_ID,
  sameToolActionAuthority,
  type AutomationDefinition,
  type AutomationRun,
  type BrowserThreadId,
  type Project,
  type ToolActionAuthority,
  type ToolHostId,
} from "@octant/contracts";
import type { CurrentBrowserSessionTarget } from "./browserSessionGrants";

/** The reviewed recipient is a definition, never whichever thread last ran it. */
export function currentRoutineBrowserTarget(input: {
  readonly definition: AutomationDefinition;
  readonly project:
    | (Pick<Project, "id" | "type" | "lifecycle" | "version"> & {
        readonly bindingHistory?: ReadonlyArray<{ readonly revisionId: string }>;
      })
    | undefined;
  readonly toolHostId: ToolHostId;
  readonly providerEligible: boolean;
  readonly executionProfileCurrent: boolean;
}): CurrentBrowserSessionTarget | undefined {
  const { definition, project } = input;
  const binding = definition.binding;
  if (
    String(definition.hostId) !== String(LOCAL_HOST_ID) ||
    definition.mode === "chat" ||
    definition.lifecycle !== "enabled" ||
    !input.providerEligible ||
    !input.executionProfileCurrent ||
    !definition.authorityProfile.effective.tools ||
    !definition.authorityProfile.requested.tools ||
    definition.executionProfile.executionPolicy === "full-access" ||
    definition.authorityProfile.effective.executionPolicy === "full-access" ||
    definition.authorityProfile.requested.executionPolicy === "full-access" ||
    project === undefined ||
    project.lifecycle !== "active" ||
    project.type !== definition.mode ||
    project.version !== definition.projectVersion ||
    binding.kind === "chat" ||
    String(project.id) !== String(definition.projectId) ||
    String(project.bindingHistory?.at(-1)?.revisionId) !== String(binding.bindingRevisionId)
  )
    return undefined;
  const authority = decodeToolActionAuthority({
    hostId: input.toolHostId,
    mode: definition.mode,
    projectId: definition.projectId,
    providerInstanceId: definition.executionProfile.providerInstanceId,
    extension: { kind: "core" },
    rootId: binding.bindingRevisionId,
    ...(binding.kind === "code" ? { worktreeId: binding.checkoutId } : {}),
  });
  return {
    target: {
      grantee: { kind: "routine", routineId: definition.id },
      label: definition.displayName,
      modelId: definition.executionProfile.modelId,
      authority,
    },
    // Observation/version counters do not change the reviewed definition.
    revision: JSON.stringify({
      definitionRevision: definition.definitionRevision,
      binding,
      authorityProfile: definition.authorityProfile,
      executionProfile: definition.executionProfile,
    }),
  };
}

/** A dispatcher-only run reference still needs its current host-owned receipt. */
export function routineBrowserExecutionIsCurrent(input: {
  readonly run: AutomationRun | undefined;
  readonly definition: AutomationDefinition | undefined;
  readonly threadId: BrowserThreadId;
  readonly authority: ToolActionAuthority | undefined;
  readonly target: CurrentBrowserSessionTarget | undefined;
}): boolean {
  const { run, definition, target, authority } = input;
  return (
    run !== undefined &&
    definition !== undefined &&
    target !== undefined &&
    authority !== undefined &&
    run.cancellationTombstone === undefined &&
    ["dispatching", "running", "waiting"].includes(run.lifecycle) &&
    String(run.automationId) === String(definition.id) &&
    String(run.threadId) === String(input.threadId) &&
    run.definitionSnapshot.definitionRevision === definition.definitionRevision &&
    JSON.stringify(run.definitionSnapshot.executionProfile) ===
      JSON.stringify(definition.executionProfile) &&
    JSON.stringify(run.definitionSnapshot.authorityProfile) ===
      JSON.stringify(definition.authorityProfile) &&
    run.authoritySnapshot.effectiveAuthorityDigest ===
      definition.authorityProfile.effectiveAuthorityDigest &&
    JSON.stringify(run.authoritySnapshot.requested) ===
      JSON.stringify(definition.authorityProfile.requested) &&
    JSON.stringify(run.authoritySnapshot.effective) ===
      JSON.stringify(definition.authorityProfile.effective) &&
    sameToolActionAuthority(authority, target.target.authority)
  );
}
