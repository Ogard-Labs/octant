import type {
  AutomationId,
  AutomationDefinitionSnapshot,
  AutomationDefinitionDraft,
  AutomationFileSourceCheckpoint,
  UtcTimestamp,
} from "@octant/contracts";
import type { WorkFilesystemPort } from "../work/workFilesystemPort";
import { revalidateAutomationAuthority } from "./automationAuthorityRevalidation";
import {
  resolveAutomationAuthorityLiveFacts,
  type ResolveAutomationAuthorityLiveFactsDeps,
} from "./resolveAutomationAuthorityLiveFacts";
import {
  prepareAutomationFileSource,
  AutomationFileSourceScanError,
} from "./automationFileSourceScan";
import { initialAutomationFileCheckpoint } from "./automationFileSourceState";
import type { AutomationFileSourceAuthority } from "./automationFileSources";

/** A transient protected-route proof; never accepted from or returned to the renderer. */
export interface AutomationFileSourcePreparation {
  readonly automationId: AutomationId;
  readonly expectedVersion: number;
  readonly definition: AutomationDefinitionDraft;
  readonly checkpoint: AutomationFileSourceCheckpoint;
  readonly current: () => boolean;
}

/** Reuses dispatch's existing authority facts; source discovery grants no authority. */
export function resolveAutomationFileSourceAuthority(
  deps: ResolveAutomationAuthorityLiveFactsDeps,
  snapshot: AutomationDefinitionSnapshot,
  at: UtcTimestamp,
): AutomationFileSourceAuthority | undefined {
  if (
    snapshot.mode !== "work" ||
    snapshot.binding.kind !== "work" ||
    snapshot.trigger.kind !== "file-arrival" ||
    snapshot.targetPolicy !== "new-thread"
  )
    return undefined;
  const owner = {
    definitionSnapshot: snapshot,
    authoritySnapshot: {
      profileId: snapshot.authorityProfile.profileId,
      profileVersion: snapshot.authorityProfile.profileVersion,
      requested: snapshot.authorityProfile.requested,
      effective: snapshot.authorityProfile.effective,
      effectiveAuthorityDigest: snapshot.authorityProfile.effectiveAuthorityDigest,
      capturedAt: at,
    },
  };
  const definition = { hostId: snapshot.hostId };
  const facts = () => resolveAutomationAuthorityLiveFacts(deps, { definition, run: owner });
  const initial = facts();
  const project = initial.project;
  if (
    project?.type !== "work" ||
    !project.binding.canonicalRoot.startsWith("/") ||
    revalidateAutomationAuthority({ definition, run: owner, facts: initial }).kind !== "ok"
  )
    return undefined;
  const root = project.binding.canonicalRoot;
  return {
    canonicalRoot: root,
    bindingIdentity: JSON.stringify([
      snapshot.hostId,
      snapshot.projectId,
      snapshot.projectVersion,
      snapshot.binding,
    ]),
    current: () => {
      const current = facts();
      return (
        current.project?.type === "work" &&
        current.project.binding.canonicalRoot === root &&
        revalidateAutomationAuthority({ definition, run: owner, facts: current }).kind === "ok"
      );
    },
  };
}

export async function prepareAutomationFileDefinition(input: {
  readonly automationId: AutomationId;
  readonly expectedVersion: number;
  readonly filesystem: WorkFilesystemPort;
  readonly authority: AutomationFileSourceAuthority;
  readonly definition: AutomationDefinitionDraft;
  readonly current: () => boolean;
  readonly signal: AbortSignal;
  readonly now: () => UtcTimestamp;
}): Promise<AutomationFileSourcePreparation> {
  if (input.definition.trigger.kind !== "file-arrival")
    throw new AutomationFileSourceScanError("authority-changed");
  const current = () => !input.signal.aborted && input.current() && input.authority.current();
  const root = await prepareAutomationFileSource({
    filesystem: input.filesystem,
    canonicalRoot: input.authority.canonicalRoot,
    bindingIdentity: input.authority.bindingIdentity,
    trigger: input.definition.trigger,
    current,
    signal: input.signal,
  });
  if (!current()) throw new AutomationFileSourceScanError("authority-changed");
  return {
    automationId: input.automationId,
    expectedVersion: input.expectedVersion,
    definition: input.definition,
    checkpoint: initialAutomationFileCheckpoint(root.sourceIdentity, input.now()),
    current,
  };
}
