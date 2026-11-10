import type { CodePlannerCommand, ProjectId } from "@octant/contracts";
import { useState } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantSelectField } from "../ui/base/OctantSelect";
import type { CodeOverviewProps } from "./CodeOverview";
import type { PlannerProposalReview } from "./plannerProposalCreation";
import { readPlannerAttempt } from "./plannerProposalAttempt";
import { PlannerProposalReviewDialog, usePlannerState } from "./plannerProposalReview";

/** The person reviews one Project's planner; every write retains its server version. */
export function CodeProjectPlanner(
  props: Extract<CodeOverviewProps, { readonly projectId: ProjectId }>,
) {
  const { client } = props.controller;
  const plannerState = usePlannerState({
    controller: props.controller,
    projectId: props.projectId,
  });
  const { ready, view, current, busy, notice, refresh, mutate } = plannerState;
  const failure = plannerState.failure;
  const [chosen, choose] = useState<string>();
  const [review, setReview] = useState<PlannerProposalReview>();
  const threads = (props.controller.bootstrap?.threads ?? []).filter(
    (thread) =>
      String(thread.projectId) === String(props.projectId) && thread.lifecycle !== "archived",
  );
  const selected = threads.find((thread) => String(thread.id) === chosen) ?? threads[0];
  const designation = (command: CodePlannerCommand) =>
    mutate(async () => {
      if (client.executePlanner === undefined)
        return { status: "refused", message: "Planner designation is unavailable on this host." };
      return client.executePlanner(command);
    });
  if (!plannerState.supported) return null;
  const disabled = !current || busy || props.creating === true;
  const activePlanner =
    view?.designation.kind === "designated" ? view.designation.plannerThreadId : undefined;
  const planner = threads.find((thread) => String(thread.id) === String(activePlanner));
  const proposals = [...(view?.proposals ?? [])]
    .sort(
      (a, b) =>
        Number(b.proposal.status === "pending") - Number(a.proposal.status === "pending") ||
        b.proposal.proposedAt.localeCompare(a.proposal.proposedAt),
    )
    .slice(0, 50);
  return (
    <section aria-label="Project planner" className="code-project-planner">
      <header className="code-project-overview__section-header">
        <h2>Project planner</h2>
        <OctantButton type="button" variant="ghost" size="sm" onClick={refresh}>
          Refresh planner
        </OctantButton>
      </header>
      <p className="oct-row-detail">
        One Code thread may survey this Project and propose tasks. Each proposal waits for your
        decision; designation grants no right to start work.
      </p>
      {!ready || failure !== undefined ? (
        <OctantAlert tone="warning">
          {!ready
            ? "Planner decisions need a connected host. Reconnect and refresh before continuing."
            : failure}
        </OctantAlert>
      ) : null}
      {notice === undefined ? null : (
        <p role="status" className="oct-row-detail">
          {notice}
        </p>
      )}
      {view === undefined ? (
        <p role="status">Loading planner state…</p>
      ) : activePlanner === undefined ? (
        <div className="code-project-planner__controls">
          <OctantSelectField
            aria-label="Planner thread"
            value={selected === undefined ? "" : String(selected.id)}
            options={threads.map((thread) => ({ id: String(thread.id), label: thread.title }))}
            placeholder={threads.length === 0 ? "No Code threads yet" : "Choose a thread"}
            onValueChange={choose}
            disabled={disabled}
          />
          <OctantButton
            type="button"
            variant="secondary"
            disabled={disabled || selected === undefined || client.executePlanner === undefined}
            onClick={() => {
              if (selected !== undefined)
                void designation({
                  kind: "designate-code-planner-thread",
                  projectId: props.projectId,
                  threadId: selected.id,
                  expectedVersion: view.designationVersion,
                });
            }}
          >
            Designate planner
          </OctantButton>
          {threads.length === 0 ? (
            <p className="oct-meta">Create a Code thread in this Project first.</p>
          ) : null}
        </div>
      ) : (
        <div className="code-project-planner__controls">
          <span>{planner?.title ?? "Designated planner thread"}</span>
          <OctantButton
            type="button"
            variant="ghost"
            onClick={() => props.onOpenThread(activePlanner)}
          >
            Open planner
          </OctantButton>
          <OctantButton
            type="button"
            variant="ghost"
            disabled={disabled || client.executePlanner === undefined}
            onClick={() =>
              void designation({
                kind: "undesignate-code-planner-thread",
                projectId: props.projectId,
                expectedVersion: view.designationVersion,
              })
            }
          >
            Remove designation
          </OctantButton>
        </div>
      )}
      <ul className="code-project-planner__proposals">
        {proposals.map((entry) => {
          const attempt = readPlannerAttempt(entry);
          return (
            <li key={String(entry.proposal.id)}>
              <h3>{entry.proposal.title}</h3>
              <p className="oct-meta">
                {entry.proposal.status === "confirmed"
                  ? "Approved"
                  : entry.proposal.status === "declined"
                    ? "Declined"
                    : "Awaiting your decision"}{" "}
                ·{" "}
                <time dateTime={entry.proposal.proposedAt}>
                  {new Date(entry.proposal.proposedAt).toLocaleString()}
                </time>
              </p>
              <p className="code-project-planner__intent">{entry.proposal.intent}</p>
              {entry.proposal.rationale === undefined ? null : (
                <p className="oct-row-detail">{entry.proposal.rationale}</p>
              )}
              {entry.proposal.status === "pending" && attempt.status !== "none" ? (
                <p className="oct-row-detail" role="status">
                  {attempt.status === "blocked"
                    ? "The submitted approval is unresolved. Inspect its task; another approval or decline stays blocked until the host records its outcome."
                    : "This window cannot retain approval identity. Session storage is required before approving."}
                </p>
              ) : null}
              {entry.proposal.status === "pending" &&
              entry.proposal.creationAttempt?.status === "failed" ? (
                <p className="oct-row-detail">
                  Creation did not start:{" "}
                  {entry.proposal.creationAttempt.message ?? "The host refused before creation."}{" "}
                  Review the current settings before explicitly approving again.
                </p>
              ) : null}
              {entry.proposal.status === "pending" && attempt.status === "blocked" ? (
                <OctantButton
                  type="button"
                  variant="ghost"
                  onClick={() => props.onOpenThread(attempt.threadId)}
                >
                  Inspect submitted task
                </OctantButton>
              ) : null}
              {entry.proposal.status === "confirmed" ? (
                <OctantButton
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    if (entry.proposal.status === "confirmed")
                      props.onOpenThread(entry.proposal.createdThreadId);
                  }}
                >
                  Open created task
                </OctantButton>
              ) : entry.proposal.status !== "pending" ? null : (
                <div className="code-project-planner__controls">
                  <OctantButton
                    type="button"
                    variant="secondary"
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
                    disabled={
                      disabled ||
                      attempt.status === "blocked" ||
                      client.executePlannerProposal === undefined
                    }
                    onClick={() =>
                      void mutate(async () =>
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
                    Decline proposal
                  </OctantButton>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {view !== undefined && proposals.length === 0 ? (
        <p className="oct-row-detail">
          No proposals yet. Open the designated planner to ask it to survey this Project.
        </p>
      ) : null}
      {(view?.proposals.length ?? 0) > 50 ? (
        <p className="oct-meta">Showing the first fifty proposals, with pending decisions first.</p>
      ) : null}
      {review === undefined ? null : (
        <PlannerProposalReviewDialog
          {...props}
          heading="Review the planner's proposal"
          onClose={() => setReview(undefined)}
          planner={plannerState}
          review={review}
        />
      )}
    </section>
  );
}
