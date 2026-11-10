import type { CodeThreadId } from "@octant/contracts";
import { useState } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import type { PlannerProposalReview } from "./plannerProposalCreation";
import { readPlannerAttempt } from "./plannerProposalAttempt";
import {
  PlannerProposalReviewDialog,
  usePlannerState,
  type PlannerReviewProps,
} from "./plannerProposalReview";

/**
 * The workers a coordinator proposed while its starts need approval
 * (docs/design/coordinator-threads.md), shown in the coordinator's own thread
 * above its composer. They are the same planner proposals the Project
 * overview lists: Review and approve opens the same creation review, and both
 * decisions go through the versioned planner proposal routes, so a proposal
 * decided in another window or in the overview reads as decided here.
 */
export function CoordinatorProposalCards(
  props: PlannerReviewProps & { readonly coordinatorThreadId: CodeThreadId },
) {
  const { client } = props.controller;
  const planner = usePlannerState({ controller: props.controller, projectId: props.projectId });
  const [review, setReview] = useState<PlannerProposalReview>();
  if (!planner.supported) return null;
  const proposals = (planner.view?.proposals ?? []).filter(
    (entry) =>
      entry.proposal.fromCoordinator === true &&
      entry.proposal.status === "pending" &&
      String(entry.proposal.plannerThreadId) === String(props.coordinatorThreadId),
  );
  // The review closes with its card: once the host records the proposal as
  // approved or declined, here or in another window, nothing is left to decide.
  const reviewing =
    review === undefined
      ? undefined
      : proposals.find((entry) => String(entry.proposal.id) === String(review.proposal.id));
  if (proposals.length === 0) return null;
  const disabled = !planner.current || planner.busy || props.creating === true;
  return (
    <section aria-label="Proposed workers" className="follow-up-cards thread-column">
      {!planner.ready || planner.failure !== undefined ? (
        <OctantAlert tone="warning">
          {!planner.ready
            ? "Proposal decisions need a connected host. Reconnect before deciding."
            : planner.failure}
        </OctantAlert>
      ) : null}
      {planner.notice === undefined ? null : (
        <p role="status" className="oct-row-detail">
          {planner.notice}
        </p>
      )}
      {proposals.map((entry) => {
        const attempt = readPlannerAttempt(entry);
        return (
          <article
            aria-label={`Proposed worker: ${entry.proposal.title}`}
            className="follow-up-card"
            key={String(entry.proposal.id)}
          >
            <div className="follow-up-card__head">
              <span className="follow-up-card__kind">Worker · waiting for your approval</span>
            </div>
            <p className="follow-up-card__title">{entry.proposal.title}</p>
            <p className="follow-up-card__prompt">{entry.proposal.intent}</p>
            {attempt.status === "none" ? null : (
              <p className="oct-row-detail" role="status">
                {attempt.status === "blocked"
                  ? "The submitted approval is unresolved. Inspect its task; another approval or decline stays blocked until the host records its outcome."
                  : "This window cannot retain approval identity. Session storage is required before approving."}
              </p>
            )}
            {entry.proposal.creationAttempt?.status === "failed" ? (
              <p className="oct-row-detail">
                Creation did not start:{" "}
                {entry.proposal.creationAttempt.message ?? "The host refused before creation."}{" "}
                Review the current settings before explicitly approving again.
              </p>
            ) : null}
            <div className="follow-up-card__actions">
              {attempt.status === "blocked" ? (
                <OctantButton
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => props.onOpenThread(attempt.threadId)}
                >
                  Inspect submitted task
                </OctantButton>
              ) : null}
              <OctantButton
                type="button"
                variant="secondary"
                size="xs"
                disabled={
                  disabled ||
                  attempt.status !== "none" ||
                  props.onCreateThread === undefined ||
                  client.executePlannerProposal === undefined
                }
                onClick={() => setReview(entry)}
              >
                Review and approve
              </OctantButton>
              <OctantButton
                type="button"
                variant="ghost"
                size="xs"
                disabled={
                  disabled ||
                  attempt.status === "blocked" ||
                  client.executePlannerProposal === undefined
                }
                onClick={() =>
                  void planner.mutate(async () =>
                    client.executePlannerProposal === undefined
                      ? { status: "refused", message: "Proposal decisions are unavailable." }
                      : client.executePlannerProposal({
                          kind: "decline-planner-work-proposal",
                          proposalId: entry.proposal.id,
                          expectedVersion: entry.proposalVersion,
                        }),
                  )
                }
              >
                Decline
              </OctantButton>
            </div>
          </article>
        );
      })}
      {review === undefined || reviewing === undefined ? null : (
        <PlannerProposalReviewDialog
          {...props}
          heading="Review the proposed worker"
          onClose={() => setReview(undefined)}
          planner={planner}
          review={review}
        />
      )}
    </section>
  );
}
