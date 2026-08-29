import type {
  CodePlannerDesignation,
  CodePlannerDesignationRefusalReason,
  CodePlannerWorkProposal,
  CodeThreadId,
  CodeThreadLifecycle,
  ProjectId,
  ProjectLifecycle,
  ProjectType,
} from "@octant/contracts";
import { MAX_PENDING_CODE_PLANNER_PROPOSALS } from "@octant/contracts";

/**
 * Pure planner policy for Code Projects.
 *
 * A Code Project may designate exactly one of its own Code threads as the
 * planner thread. Only that thread's agent may read the Project's board or
 * propose work, a proposal is advisory until the user confirms it, and every
 * refusal here is a value the server returns, never an exception. The server
 * gathers the facts and journals the outcome; nothing in this module reads
 * storage or performs I/O.
 */

export interface CodePlannerProjectFacts {
  readonly id: ProjectId;
  readonly type: ProjectType;
  readonly lifecycle: ProjectLifecycle;
}

export interface CodePlannerThreadFacts {
  readonly id: CodeThreadId;
  readonly projectId: ProjectId;
  readonly lifecycle: CodeThreadLifecycle;
}

export interface CodePlannerRefusal<Reason extends string> {
  readonly status: "refused";
  readonly reason: Reason;
  readonly message: string;
}

export type CodePlannerDesignationDecision =
  | { readonly status: "designate" }
  | CodePlannerRefusal<CodePlannerDesignationRefusalReason>;

function refusal<Reason extends string>(
  reason: Reason,
  message: string,
): CodePlannerRefusal<Reason> {
  return { status: "refused", reason, message };
}

function requireActiveCodeProject(
  project: CodePlannerProjectFacts | undefined,
):
  | { readonly status: "ok"; readonly project: CodePlannerProjectFacts }
  | CodePlannerRefusal<"project-unavailable"> {
  if (project === undefined) {
    return refusal("project-unavailable", "The Project was not found.");
  }
  if (project.type !== "code") {
    return refusal("project-unavailable", "Only a Code Project can designate a planner thread.");
  }
  if (project.lifecycle !== "active") {
    return refusal("project-unavailable", "An archived Project cannot change its planner.");
  }
  return { status: "ok", project };
}

export function decideCodePlannerDesignation(input: {
  readonly project: CodePlannerProjectFacts | undefined;
  readonly thread: CodePlannerThreadFacts | undefined;
  readonly currentDesignation: CodePlannerDesignation | undefined;
}): CodePlannerDesignationDecision {
  const project = requireActiveCodeProject(input.project);
  if (project.status === "refused") return project;
  if (input.thread === undefined) {
    return refusal("thread-not-found", "The thread to designate was not found.");
  }
  if (String(input.thread.projectId) !== String(project.project.id)) {
    return refusal(
      "thread-in-another-project",
      "A planner thread must belong to the Project it plans.",
    );
  }
  if (input.thread.lifecycle === "archived") {
    return refusal("thread-archived", "An archived thread cannot be the planner.");
  }
  if (input.currentDesignation?.kind === "designated") {
    // One planner per Project, full stop: re-designating even the same thread
    // refuses so a stale window learns the designation it holds is current.
    return refusal(
      "planner-already-designated",
      "This Project already has a planner thread. Undesignate it first.",
    );
  }
  return { status: "designate" };
}

export type CodePlannerUndesignationDecision =
  | { readonly status: "undesignate" }
  | CodePlannerRefusal<CodePlannerDesignationRefusalReason>;

export function decideCodePlannerUndesignation(input: {
  readonly project: CodePlannerProjectFacts | undefined;
  readonly currentDesignation: CodePlannerDesignation | undefined;
}): CodePlannerUndesignationDecision {
  const project = requireActiveCodeProject(input.project);
  if (project.status === "refused") return project;
  if (input.currentDesignation?.kind !== "designated") {
    return refusal("no-planner-designated", "This Project has no planner thread to remove.");
  }
  return { status: "undesignate" };
}

export type CodePlannerAccessRefusalReason =
  | "no-planner-designated"
  | "not-the-planner-thread"
  | "planner-thread-unavailable";

export type CodePlannerBoardAccessDecision =
  | { readonly status: "allowed"; readonly projectId: ProjectId }
  | CodePlannerRefusal<CodePlannerAccessRefusalReason>;

/**
 * Whether a thread's agent may read its Project's board. Checked on every
 * call, so an undesignation takes effect immediately even for a turn that is
 * already running.
 */
export function decideCodePlannerBoardAccess(input: {
  readonly thread: CodePlannerThreadFacts | undefined;
  readonly designation: CodePlannerDesignation | undefined;
}): CodePlannerBoardAccessDecision {
  if (input.thread === undefined || input.thread.lifecycle === "archived") {
    return refusal("planner-thread-unavailable", "The calling thread is not available.");
  }
  if (input.designation === undefined || input.designation.kind !== "designated") {
    return refusal("no-planner-designated", "This Project has no designated planner thread.");
  }
  if (String(input.designation.plannerThreadId) !== String(input.thread.id)) {
    return refusal(
      "not-the-planner-thread",
      "Only the Project's designated planner thread may read the board.",
    );
  }
  return { status: "allowed", projectId: input.thread.projectId };
}

export type CodePlannerProposalSubmissionDecision =
  | { readonly status: "allowed"; readonly projectId: ProjectId }
  | CodePlannerRefusal<CodePlannerAccessRefusalReason | "too-many-pending-proposals">;

export function decideCodePlannerProposalSubmission(input: {
  readonly thread: CodePlannerThreadFacts | undefined;
  readonly designation: CodePlannerDesignation | undefined;
  readonly pendingProposals: number;
}): CodePlannerProposalSubmissionDecision {
  const access = decideCodePlannerBoardAccess(input);
  if (access.status === "refused") return access;
  if (input.pendingProposals >= MAX_PENDING_CODE_PLANNER_PROPOSALS) {
    return refusal(
      "too-many-pending-proposals",
      "This Project already has the maximum number of unresolved proposals.",
    );
  }
  return access;
}

export type CodePlannerProposalResolutionDecision =
  | { readonly status: "allowed"; readonly proposal: CodePlannerWorkProposal }
  | CodePlannerRefusal<"proposal-not-found" | "proposal-not-pending" | "creation-project-mismatch">;

/**
 * Whether the user's confirm or decline may resolve a proposal. A confirm must
 * create inside the proposal's own Project: the proposal never becomes a way
 * to reach into another Project's checkout.
 */
export function decideCodePlannerProposalResolution(input: {
  readonly proposal: CodePlannerWorkProposal | undefined;
  readonly action: "confirm" | "decline";
  readonly creationProjectId?: ProjectId;
}): CodePlannerProposalResolutionDecision {
  if (input.proposal === undefined) {
    return refusal("proposal-not-found", "The proposal was not found.");
  }
  if (input.proposal.status !== "pending") {
    return refusal("proposal-not-pending", "The proposal was already resolved.");
  }
  if (
    input.action === "confirm" &&
    (input.creationProjectId === undefined ||
      String(input.creationProjectId) !== String(input.proposal.projectId))
  ) {
    return refusal(
      "creation-project-mismatch",
      "A confirmed proposal must create its thread in the proposal's own Project.",
    );
  }
  return { status: "allowed", proposal: input.proposal };
}
