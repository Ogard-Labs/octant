import type { CodePlannerView, CodeThread } from "@octant/contracts";
import type { CodeClient } from "@octant/client-runtime/code-client";
import { useEffect, useState } from "react";
import { requestedWorkerOptions } from "../code/plannerProposalReview";

/**
 * A coordinator's pending proposed workers on a paired browser, read-only
 * (docs/design/coordinator-threads.md#the-start-setting). The planner read
 * is open to the remote session; approving and declining stay with a window
 * on the host, whose proposal routes refuse every other caller, so the card
 * offers no decision.
 */
export function RemoteCoordinatorProposals(props: {
  readonly client: Pick<CodeClient, "readPlanner">;
  readonly thread: CodeThread;
}) {
  const { client, thread } = props;
  const [view, setView] = useState<{ readonly threadId: string; readonly view: CodePlannerView }>();
  const threadId = String(thread.id);
  const projectId = thread.projectId;
  useEffect(() => {
    if (client.readPlanner === undefined) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const next = await client.readPlanner?.(projectId);
        if (!disposed && next !== undefined) setView({ threadId, view: next });
      } catch {
        // A failed read keeps the last one; the next poll tries again.
      }
      if (!disposed) timer = setTimeout(() => void read(), 5_000);
    };
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [client, projectId, threadId]);
  const proposals =
    view?.threadId === threadId
      ? view.view.proposals.filter(
          (entry) =>
            entry.proposal.fromCoordinator === true &&
            entry.proposal.status === "pending" &&
            String(entry.proposal.plannerThreadId) === threadId,
        )
      : [];
  if (proposals.length === 0) return null;
  return (
    <section aria-label="Proposed workers" className="follow-up-cards thread-column">
      {proposals.map((entry) => (
        <article
          aria-label={`Proposed worker: ${entry.proposal.title}`}
          className="follow-up-card"
          key={String(entry.proposal.id)}
        >
          <div className="follow-up-card__head">
            <span className="follow-up-card__kind">Worker · waiting for approval</span>
          </div>
          <p className="follow-up-card__title">{entry.proposal.title}</p>
          <p className="follow-up-card__prompt">{entry.proposal.intent}</p>
          {entry.proposal.workerOptions === undefined ? null : (
            <p className="oct-row-detail">{requestedWorkerOptions(entry.proposal.workerOptions)}</p>
          )}
          <p className="oct-row-detail">Approve at a window on this computer.</p>
        </article>
      ))}
    </section>
  );
}
