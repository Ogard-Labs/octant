// Turns a routine the hub offered into a routine on this host, through the same
// Automation command service a window's editor uses. The offer names no
// Project, profile, or authority, so each is chosen here on this host and only
// from what carries the least authority: an approval-gated profile, the Work
// authority every Work turn holds (the shell and Git, asking first), and a
// routine that is paused until the person resumes it.

import { createHash } from "node:crypto";
import {
  decodeAutomationCommand,
  decodeAutomationDefinitionDraft,
  decodeAutomationId,
  decodeBindingReceiptId,
  type AgentRunAuthority,
  type AutomationCommand,
  type AutomationCommandResult,
  type RoutineOffer,
} from "@octant/contracts";
import type { AgentProfile } from "@octant/contracts/agent-profile";
import type { ApplyOutcome } from "./spokeProvisionService";

/** What this host knows of a Work Project the person bound a routine to. */
export interface RoutineWorkProject {
  readonly projectId: string;
  readonly name: string;
  readonly projectVersion: number;
  readonly bindingRevisionId: string;
}

export interface RoutineOfferDependencies {
  readonly hostId: string;
  /** The person on this host, who confirms the routine's delivery target by applying it. */
  readonly actorId: string;
  /** The scope the routine's author is recorded under; it carries no window authority. */
  readonly authorScopeId: string;
  /** An active Work Project, or undefined for any other Project, an archived one, or one this host lacks. */
  readonly workProject: (projectId: string) => RoutineWorkProject | undefined;
  readonly profiles: () => Promise<ReadonlyArray<AgentProfile>>;
  /** The provider and model Work starts new threads with, when the person chose one. */
  readonly workModel: () => { readonly instanceId: string; readonly modelId: string } | undefined;
  readonly automations: {
    readonly execute: (command: AutomationCommand) => AutomationCommandResult;
  };
  readonly uuid: () => string;
  readonly clock: () => string;
}

const failed: ApplyOutcome = { status: "failed", kind: "apply-failed" };

export function createRoutineOfferAuthor(deps: RoutineOfferDependencies) {
  return async (offer: RoutineOffer, projectId: string): Promise<ApplyOutcome> => {
    // A Code routine binds a checkout that only a window has prepared.
    if (offer.mode !== "work") return { status: "failed", kind: "kind-unsupported" };
    try {
      const project = deps.workProject(projectId);
      const model = deps.workModel();
      if (project === undefined || model === undefined) return failed;
      const profile = (await deps.profiles()).find(
        (candidate) =>
          candidate.defaultExecutionPolicy === "approval-gated" &&
          candidate.compatibleModes.includes("work") &&
          (candidate.modelConstraints.length === 0 ||
            candidate.modelConstraints.map(String).includes(model.modelId)),
      );
      if (profile === undefined) return failed;

      const authority: AgentRunAuthority = {
        filesystem: true,
        shell: true,
        git: true,
        network: false,
        tools: true,
        subagents: false,
        executionPolicy: "approval-gated",
        permissionPersistence: profile.defaultPermissionPersistence,
      };
      const now = deps.clock();
      const draft = decodeAutomationDefinitionDraft({
        displayName: offer.displayName,
        taskPrompt: offer.taskPrompt,
        hostId: deps.hostId,
        mode: "work",
        projectId: project.projectId,
        projectVersion: project.projectVersion,
        binding: {
          kind: "work",
          hostId: deps.hostId,
          projectId: project.projectId,
          projectVersion: project.projectVersion,
          bindingRevisionId: project.bindingRevisionId,
          bindingReceiptId: workBindingReceiptId(project.projectId, project.bindingRevisionId),
        },
        executionProfile: {
          profileId: profile.id,
          profileVersion: profile.version,
          hostId: deps.hostId,
          mode: "work",
          projectId: project.projectId,
          providerInstanceId: model.instanceId,
          modelId: model.modelId,
          executionPolicy: profile.defaultExecutionPolicy,
          permissionPersistence: profile.defaultPermissionPersistence,
        },
        authorityProfile: {
          profileId: profile.id,
          profileVersion: profile.version,
          requested: authority,
          effective: authority,
          effectiveAuthorityDigest: createHash("sha256")
            .update(JSON.stringify(authority))
            .digest("hex"),
        },
        deliveryTarget: {
          revisionId: deps.uuid(),
          revision: 1,
          mode: "work",
          summary: `A new Work thread in ${project.name} for each run, from a routine offered by the hub.`,
          confirmed: true,
          confirmedBy: deps.actorId,
          confirmedAt: now,
        },
        trigger: offer.trigger,
        missedRunPolicy: "skip",
        targetPolicy: "new-thread",
      });

      const automationId = decodeAutomationId(deps.uuid());
      const principal = {
        kind: "local-window",
        windowId: deps.authorScopeId,
        capabilityGeneration: 0,
      } as const;
      const created = deps.automations.execute(
        decodeAutomationCommand({
          kind: "create-automation",
          automationId,
          expectedVersion: 0,
          principal,
          origin: { kind: "interactive" },
          definition: draft,
          // Paused in its first journaled event, so a host that stops right after
          // creating it cannot restore a routine that runs before the person resumes it.
          initialLifecycle: "paused",
        }),
      );
      return created.kind === "automation-created" ? { status: "applied" } : failed;
    } catch {
      return failed;
    }
  };
}

/**
 * The opaque receipt a window's editor derives for a Work Project binding, so a
 * routine made here names its binding exactly as one made there does.
 */
function workBindingReceiptId(projectId: string, bindingRevisionId: string) {
  const bytes = createHash("sha256")
    .update(`octant.automation-work-binding-receipt.v1\0${projectId}\0${bindingRevisionId}`)
    .digest("base64url");
  return decodeBindingReceiptId(bytes);
}
