import type {
  CodeCommandResult,
  CodePlannerProposalCommand,
  CodePlannerProposalOutcome,
  CodePlannerThreadCreation,
  CodePlannerView,
  CodeThread,
  CodeThreadId,
} from "@octant/contracts";
import {
  finishPlannerAttempt,
  plannerAttemptStorage,
  reservePlannerAttempt,
  type PlannerAttemptStorage,
} from "./plannerProposalAttempt";

export type PlannerProposalReview = CodePlannerView["proposals"][number];

/** A timed-out mutation is uncertain; timing out never cancels or retries it. */
export async function plannerReply<A>(reply: Promise<A>): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reply,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error("Planner reply timed out. Refresh before making another decision.")),
          30_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
type Created = Extract<CodeCommandResult, { kind: "thread-created" | "managed-thread-created" }>;

/** Only a confirmed creation may proceed to the ordinary first-turn path. */
export async function createPlannerProposalTask(
  client: {
    readonly executePlannerProposal?: (
      command: CodePlannerProposalCommand,
    ) => Promise<CodePlannerProposalOutcome>;
    readonly thread: (threadId: CodeThreadId) => Promise<{ readonly thread: CodeThread }>;
  },
  review: PlannerProposalReview,
  creation: CodePlannerThreadCreation,
  storage: PlannerAttemptStorage | undefined = plannerAttemptStorage(),
): Promise<
  | { readonly status: "confirmed"; readonly creation: Created }
  | {
      readonly status: "unconfirmed";
      readonly message: string;
      readonly existingThread?: CodeThread;
    }
> {
  const projectId =
    creation.kind === "create-code-thread" ? creation.thread.projectId : creation.projectId;
  const threadId = creation.kind === "create-code-thread" ? creation.thread.id : creation.threadId;
  if (
    review.proposal.status !== "pending" ||
    String(projectId) !== String(review.proposal.projectId)
  )
    return {
      status: "unconfirmed",
      message:
        "This proposal is no longer pending in this Project. Refresh proposals before continuing.",
    };
  if (client.executePlannerProposal === undefined)
    return { status: "unconfirmed", message: "This host cannot approve planner proposals." };
  const reservation = reservePlannerAttempt(review, threadId, storage);
  if (reservation.status === "unavailable")
    return {
      status: "unconfirmed",
      message:
        "This window cannot retain the submitted approval identity. Enable session storage before approving; no request was sent.",
    };
  const submittedId = reservation.status === "blocked" ? reservation.threadId : threadId;
  let message: string;
  if (reservation.status === "blocked")
    message = "An earlier approval is unresolved. No replacement request was sent.";
  else
    try {
      const result = await plannerReply(
        client.executePlannerProposal({
          kind: "confirm-planner-work-proposal",
          proposalId: review.proposal.id,
          expectedVersion: review.proposalVersion,
          creation,
        }),
      );
      if (
        result.status === "confirmed" &&
        result.proposal.status === "confirmed" &&
        String(result.proposal.id) === String(review.proposal.id) &&
        String(result.proposal.createdThreadId) === String(threadId) &&
        (result.creation.kind === "thread-created" ||
          result.creation.kind === "managed-thread-created") &&
        String(result.creation.thread.id) === String(threadId) &&
        String(result.creation.thread.projectId) === String(projectId)
      ) {
        finishPlannerAttempt(review, storage);
        return { status: "confirmed", creation: result.creation };
      }
      if (result.status === "refused" && result.reason === "creation-not-started")
        return {
          status: "unconfirmed",
          message: `${result.message} Creation did not start. Refresh the proposal's current version before explicitly approving again. No first message was sent.`,
        };
      message =
        result.status === "refused" ? result.message : "The host did not confirm task creation.";
    } catch {
      message = "The approval reply was lost. The task may already have been created.";
    }
  // Creation can precede a concurrent-decline refusal. This read never creates
  // or starts work, and a missing reply never submits another creation.
  try {
    const existing = await plannerReply(client.thread(submittedId));
    if (
      String(existing.thread.id) === String(submittedId) &&
      String(existing.thread.projectId) === String(projectId)
    )
      return {
        status: "unconfirmed",
        message: `${message} The submitted task exists; inspect it before continuing. No first message was sent from this approval.`,
        existingThread: existing.thread,
      };
  } catch {
    // A missing task or unavailable read is uncertainty, not permission to retry.
  }
  return {
    status: "unconfirmed",
    message: `${message} Check the Project for submitted task ${String(submittedId)}. Approval stays blocked until the host proves the prior attempt settled. No first message was sent from this approval.`,
  };
}
