import type { CodeClient } from "@octant/client-runtime";
import type { CodePlannerThreadCreation, CodePlannerView, CodeThread } from "@octant/contracts";

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
type Created = Extract<
  Awaited<ReturnType<CodeClient["execute"]>>,
  { kind: "thread-created" | "managed-thread-created" }
>;

/** Only a confirmed creation may proceed to the ordinary first-turn path. */
export async function createPlannerProposalTask(
  client: Pick<CodeClient, "executePlannerProposal" | "thread">,
  review: PlannerProposalReview,
  creation: CodePlannerThreadCreation,
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
  let message: string;
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
      (result.creation.kind === "thread-created" ||
        result.creation.kind === "managed-thread-created")
    )
      return { status: "confirmed", creation: result.creation };
    message =
      result.status === "refused" ? result.message : "The host did not confirm task creation.";
  } catch {
    message = "The approval reply was lost. The task may already have been created.";
  }
  // Creation can precede a concurrent-decline refusal. This read never creates
  // or starts work, and a missing reply never submits another creation.
  try {
    const existing = await plannerReply(client.thread(threadId));
    if (String(existing.thread.projectId) === String(projectId))
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
    message: `${message} Check the Project for submitted task ${String(threadId)} before approving again. No first message was sent from this approval.`,
  };
}
