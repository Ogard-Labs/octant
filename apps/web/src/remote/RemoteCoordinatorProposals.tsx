import type { CodePlannerView, CodeThread } from "@octant/contracts";
import type { CodeClient } from "@octant/client-runtime/code-client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
    <section
      aria-label="Proposed workers"
      className="follow-up-cards thread-column remote-workspace__proposals"
    >
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
          <ProposalIntent intent={entry.proposal.intent} />
          {entry.proposal.workerOptions === undefined ? null : (
            <p className="oct-row-detail">{requestedWorkerOptions(entry.proposal.workerOptions)}</p>
          )}
          <p className="oct-row-detail">Approve at a window on this computer.</p>
        </article>
      ))}
    </section>
  );
}

/**
 * The proposal's request, two lines at first. The desktop card's Review opens
 * the whole request; a paired browser has no review, so a cut-off request
 * would otherwise be unreadable there. The toggle appears only when the two
 * lines actually cut text off.
 */
function ProposalIntent(props: { readonly intent: string }) {
  const prompt = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  useLayoutEffect(() => {
    const node = prompt.current;
    if (node === null || expanded) return;
    const measure = () => setClamped(node.scrollHeight > node.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [expanded, props.intent]);
  return (
    <>
      <p
        className={
          expanded
            ? "follow-up-card__prompt remote-workspace__proposal-intent--expanded"
            : "follow-up-card__prompt"
        }
        ref={prompt}
      >
        {props.intent}
      </p>
      {clamped || expanded ? (
        <button
          aria-expanded={expanded}
          className="remote-workspace__proposal-toggle"
          onClick={() => setExpanded((open) => !open)}
          type="button"
        >
          {expanded ? "Show less" : "Show the full request"}
        </button>
      ) : null}
    </>
  );
}
