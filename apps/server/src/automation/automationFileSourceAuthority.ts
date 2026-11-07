import { currentProtectedFilesChoice } from "../process/secretGuard";
import type {
  AutomationId,
  AutomationRun,
  AutomationDefinitionSnapshot,
  AutomationDefinitionDraft,
  AutomationFileSourceCheckpoint,
  AutomationFileSourceReview,
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
  automationFileSourceCurrent,
  AutomationFileSourceScanError,
} from "./automationFileSourceScan";
import { initialAutomationFileCheckpoint } from "./automationFileSourceState";
import type { AutomationFileSourceAuthority } from "./automationFileSources";
import { automationRunFileSource } from "./automationFileContext";

/** A transient protected-route proof; never accepted from or returned to the renderer. */
export interface AutomationFileSourcePreparation {
  readonly kind: "definition";
  readonly automationId: AutomationId;
  readonly expectedVersion: number;
  readonly definition: AutomationDefinitionDraft;
  readonly checkpoint: AutomationFileSourceCheckpoint;
  readonly current: () => boolean;
}

export interface AutomationFileSourceRearmPreparation {
  readonly kind: "rearm";
  readonly automationId: AutomationId;
  readonly expectedVersion: number;
  readonly checkpoint: AutomationFileSourceCheckpoint;
  readonly review: AutomationFileSourceReview;
  readonly files: ReadonlyArray<string>;
  readonly current: () => boolean;
}

/** Reuses dispatch's existing authority facts; source discovery grants no authority. */
export function resolveAutomationFileSourceAuthority(
  deps: ResolveAutomationAuthorityLiveFactsDeps,
  snapshot: AutomationDefinitionSnapshot,
  at: UtcTimestamp,
): AutomationFileSourceAuthority | undefined {
  if (
    (snapshot.mode !== "work" && snapshot.mode !== "code") ||
    (snapshot.binding.kind !== "work" && snapshot.binding.kind !== "code") ||
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
    (project?.type !== "work" && project?.type !== "code") ||
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
        (current.project?.type === "work" || current.project?.type === "code") &&
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
  const protectedChoice = currentProtectedFilesChoice();
  const current = () =>
    !input.signal.aborted &&
    input.current() &&
    input.authority.current() &&
    currentProtectedFilesChoice() === protectedChoice;
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
    kind: "definition",
    automationId: input.automationId,
    expectedVersion: input.expectedVersion,
    definition: input.definition,
    checkpoint: initialAutomationFileCheckpoint(root.sourceIdentity, input.now()),
    current: () => current() && automationFileSourceCurrent(input.filesystem, root) && current(),
  };
}

/** Capture one host-owned run's exact source; the proof never adopts replacement paths. */
export async function prepareAutomationFileRunAdmission(input: {
  readonly run: AutomationRun;
  readonly filesystem: WorkFilesystemPort;
  readonly authority: AutomationFileSourceAuthority;
  readonly current: () => boolean;
  readonly signal: AbortSignal;
}): Promise<(() => boolean) | undefined> {
  const { run } = input;
  const receipt = automationRunFileSource(run);
  if (receipt === undefined || run.definitionSnapshot.trigger.kind !== "file-arrival")
    return undefined;
  const protectedChoice = currentProtectedFilesChoice();
  const current = () =>
    !input.signal.aborted &&
    input.current() &&
    input.authority.current() &&
    currentProtectedFilesChoice() === protectedChoice;
  const root = await prepareAutomationFileSource({
    filesystem: input.filesystem,
    canonicalRoot: input.authority.canonicalRoot,
    bindingIdentity: input.authority.bindingIdentity,
    trigger: run.definitionSnapshot.trigger,
    current,
    signal: input.signal,
  });
  if (root.sourceIdentity !== receipt.checkpoint.sourceIdentity || !current()) return undefined;
  const retained = () =>
    current() && automationFileSourceCurrent(input.filesystem, root) && current();
  return retained() ? retained : undefined;
}
