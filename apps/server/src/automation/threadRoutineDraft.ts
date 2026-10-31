// Builds the routine a person confirmed from a thread's proposal. The agent
// named only the name, prompt, schedule, and missed-run policy; everything
// that carries authority is read here from the host's own records at the
// moment of confirmation: the thread's Project, its binding, its checkout, its
// provider and model, and an approval-gated profile. Nothing is ever wider
// than the thread: Work gets no shell or Git, Code runs ask first, network and
// subagents stay off, and a session-only permission stays session-only.

import { createHash } from "node:crypto";
import {
  decodeAutomationDefinitionDraft,
  decodeBindingReceiptId,
  type AgentRunAuthority,
  type AutomationDefinitionDraft,
  type PermissionPersistence,
  type ProviderExecutionPolicy,
  type RoutineProposal,
} from "@octant/contracts";
import type { AgentProfile } from "@octant/contracts/agent-profile";

/** What the host knows of the proposing thread right now. */
export interface RoutineSourceThread {
  readonly projectId: string;
  readonly active: boolean;
  readonly providerInstanceId: string;
  readonly modelId: string;
  /** Code only. */
  readonly executionPolicy?: ProviderExecutionPolicy;
  readonly permissionPersistence?: PermissionPersistence;
  readonly profileId?: string;
  readonly checkout?: { readonly repositoryId: string; readonly checkoutId: string };
}

export interface RoutineSourceProject {
  readonly name: string;
  readonly mode: "work" | "code";
  readonly active: boolean;
  readonly version: number;
  readonly bindingRevisionId: string | undefined;
}

export interface ThreadRoutineDraftDependencies {
  readonly hostId: string;
  /** The person on this host, who confirms the delivery target by confirming the proposal. */
  readonly actorId: string;
  readonly readThread: (mode: "work" | "code", threadId: string) => RoutineSourceThread | undefined;
  readonly readProject: (projectId: string) => RoutineSourceProject | undefined;
  readonly checkoutAvailable: (checkoutId: string, repositoryId: string) => boolean;
  readonly profiles: () => ReadonlyArray<AgentProfile>;
  readonly uuid: () => string;
  readonly clock: () => string;
}

export type ThreadRoutineDraftResult =
  | { readonly status: "ready"; readonly draft: AutomationDefinitionDraft }
  | { readonly status: "refused"; readonly message: string };

export function buildThreadRoutineDraft(
  deps: ThreadRoutineDraftDependencies,
  proposal: RoutineProposal,
): ThreadRoutineDraftResult {
  const mode = proposal.mode;
  const thread = deps.readThread(mode, String(proposal.threadId));
  if (
    thread === undefined ||
    !thread.active ||
    String(thread.projectId) !== String(proposal.projectId)
  ) {
    return refused("The thread is no longer active in this Project.");
  }
  const project = deps.readProject(String(proposal.projectId));
  if (
    project === undefined ||
    !project.active ||
    project.mode !== mode ||
    project.bindingRevisionId === undefined
  ) {
    return refused("The Project is no longer active.");
  }
  if (mode === "code") {
    if (thread.executionPolicy === "plan") {
      return refused("The thread is in Plan mode, which is read-only.");
    }
    if (
      thread.checkout === undefined ||
      !deps.checkoutAvailable(thread.checkout.checkoutId, thread.checkout.repositoryId)
    ) {
      return refused("The thread's checkout is not available.");
    }
  }
  const profile = chooseProfile(deps.profiles(), mode, thread);
  if (profile === undefined) {
    return refused(
      "No profile that asks before effects fits this thread's model. Create the routine in Automation Center instead.",
    );
  }
  const sessionOnly =
    profile.defaultPermissionPersistence === "current-session" ||
    thread.permissionPersistence === "current-session";
  const authority: AgentRunAuthority = {
    filesystem: true,
    shell: mode === "code",
    git: mode === "code",
    network: false,
    tools: true,
    subagents: false,
    executionPolicy: "approval-gated",
    permissionPersistence: sessionOnly ? "current-session" : "project-default",
  };
  const now = deps.clock();
  const followUp = proposal.targetPolicy === "same-thread";
  const bindingRevisionId = project.bindingRevisionId;
  const projectId = String(proposal.projectId);
  const binding =
    mode === "work" || thread.checkout === undefined
      ? {
          kind: "work",
          hostId: deps.hostId,
          projectId,
          projectVersion: project.version,
          bindingRevisionId,
          bindingReceiptId: workBindingReceiptId(projectId, bindingRevisionId),
        }
      : {
          kind: "code",
          hostId: deps.hostId,
          projectId,
          projectVersion: project.version,
          bindingRevisionId,
          repositoryId: thread.checkout.repositoryId,
          checkoutId: thread.checkout.checkoutId,
          worktreeReceiptId: codeWorktreeReceiptId({
            projectId,
            bindingRevisionId,
            ...thread.checkout,
          }),
        };
  try {
    return {
      status: "ready",
      draft: decodeAutomationDefinitionDraft({
        displayName: proposal.displayName,
        taskPrompt: proposal.taskPrompt,
        hostId: deps.hostId,
        mode,
        projectId,
        projectVersion: project.version,
        binding,
        executionProfile: {
          profileId: profile.id,
          profileVersion: profile.version,
          hostId: deps.hostId,
          mode,
          projectId,
          providerInstanceId: thread.providerInstanceId,
          modelId: thread.modelId,
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
          mode,
          summary: followUp
            ? `One follow-up turn in the ${mode === "work" ? "Work" : "Code"} thread it was set up from, in ${project.name}.`
            : `A new ${mode === "work" ? "Work" : "Code"} thread in ${project.name} for each run, from a routine proposed in one of its threads.`,
          confirmed: true,
          confirmedBy: deps.actorId,
          confirmedAt: now,
        },
        trigger: proposal.trigger,
        missedRunPolicy: proposal.missedRunPolicy,
        targetPolicy: followUp ? "same-thread" : "new-thread",
      }),
    };
  } catch {
    return refused("The routine did not pass the host's routine rules.");
  }
}

/**
 * The thread's own profile when it qualifies, else the first approval-gated
 * profile for this mode that allows the thread's model: the same rule a
 * window's routine editor applies to the profiles it offers.
 */
function chooseProfile(
  profiles: ReadonlyArray<AgentProfile>,
  mode: "work" | "code",
  thread: RoutineSourceThread,
): AgentProfile | undefined {
  const fits = (profile: AgentProfile) =>
    profile.defaultExecutionPolicy === "approval-gated" &&
    profile.compatibleModes.includes(mode) &&
    (profile.modelConstraints.length === 0 ||
      profile.modelConstraints.map(String).includes(thread.modelId));
  const own = profiles.find((profile) => String(profile.id) === thread.profileId);
  return own !== undefined && fits(own) ? own : profiles.find(fits);
}

function refused(message: string): ThreadRoutineDraftResult {
  return { status: "refused", message };
}

/** The receipt a window's routine editor derives for the same Work binding. */
function workBindingReceiptId(projectId: string, bindingRevisionId: string) {
  return decodeBindingReceiptId(
    createHash("sha256")
      .update(`octant.automation-work-binding-receipt.v1\0${projectId}\0${bindingRevisionId}`)
      .digest("base64url"),
  );
}

/** The receipt a window's routine editor derives for the same Code checkout. */
function codeWorktreeReceiptId(input: {
  readonly projectId: string;
  readonly bindingRevisionId: string;
  readonly repositoryId: string;
  readonly checkoutId: string;
}): string {
  const digest = createHash("sha256")
    .update(
      `octant.automation-code-worktree-receipt.v1\0${input.projectId}\0${input.bindingRevisionId}\0${input.repositoryId}\0${input.checkoutId}`,
    )
    .digest("hex")
    .slice(0, 32);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20)}`;
}
