import type { CodePlannerView, CodeThread } from "@octant/contracts";
import type { CodeClient } from "@octant/client-runtime/code-client";
import {
  approveCoordinatorProposal,
  declineCoordinatorProposal,
  type CoordinatorProposalEntry,
} from "@octant/client-runtime/coordinator-proposal-approval";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { requestedWorkerOptions } from "../code/plannerProposalReview";
import { OctantButton } from "../ui/base/OctantButton";

/**
 * A coordinator's pending proposed workers on a paired browser
 * (docs/design/coordinator-threads.md#the-start-setting). A browser the
 * host's own person paired approves a worker as it was asked for, or
 * declines it, and the host journals the browser as the actor; choosing
 * another provider, checkout or level stays with the review at a window on
 * the host. Every other session sees what waits and where to approve it,
 * since the host refuses its decision.
 */
export function RemoteCoordinatorProposals(props: {
  readonly client: Pick<CodeClient, "readPlanner" | "execute" | "executePlannerProposal">;
  readonly thread: CodeThread;
  /** What the host said of this session; absent or false shows no decision. */
  readonly actsAsHostPerson?: boolean;
  /** False while the session is stale: the host would not hear a decision. */
  readonly connected?: boolean;
  /** Sends the approved worker's first message; true once the host took it. */
  readonly startFirstTurn?: (thread: CodeThread, prompt: string) => Promise<boolean>;
}) {
  const { client, thread } = props;
  const [view, setView] = useState<{ readonly threadId: string; readonly view: CodePlannerView }>();
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const threadId = String(thread.id);
  const projectId = thread.projectId;
  const executePlannerProposal = client.executePlannerProposal;
  const decide = async (run: () => Promise<string | undefined>) => {
    setBusy(true);
    setMessage(undefined);
    try {
      setMessage(await run());
    } catch {
      setMessage("The decision reply was lost. Refresh before deciding again.");
    } finally {
      setBusy(false);
      setRevision((value) => value + 1);
    }
  };
  const approve = (entry: CoordinatorProposalEntry) =>
    decide(async () => {
      if (executePlannerProposal === undefined) return "This host cannot approve workers.";
      const approved = await approveCoordinatorProposal({
        port: { execute: (command) => client.execute(command), executePlannerProposal },
        entry,
        coordinator: thread,
      });
      if (approved.status === "refused") return approved.message;
      // The worker is durable whether or not its first turn starts.
      const started =
        (await props.startFirstTurn?.(approved.thread, entry.proposal.intent)) ?? false;
      return started
        ? "Worker approved and started."
        : "The worker was created, but its first message could not be sent. Open it to retry.";
    });
  const decline = (entry: CoordinatorProposalEntry) =>
    decide(async () => {
      if (executePlannerProposal === undefined) return "This host cannot decline workers.";
      const declined = await declineCoordinatorProposal({
        port: { executePlannerProposal },
        entry,
      });
      return declined.status === "declined" ? "Worker declined." : declined.message;
    });
  const decides = props.actsAsHostPerson === true && executePlannerProposal !== undefined;
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
  }, [client, projectId, threadId, revision]);
  const proposals =
    view?.threadId === threadId
      ? view.view.proposals.filter(
          (entry) =>
            entry.proposal.fromCoordinator === true &&
            entry.proposal.status === "pending" &&
            String(entry.proposal.plannerThreadId) === threadId,
        )
      : [];
  if (proposals.length === 0 && message === undefined) return null;
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
          {decides ? (
            <div className="follow-up-card__actions">
              <OctantButton
                disabled={busy || props.connected === false}
                onClick={() => void approve(entry)}
                size="sm"
                type="button"
                variant="secondary"
              >
                Approve and start
              </OctantButton>
              <OctantButton
                disabled={busy || props.connected === false}
                onClick={() => void decline(entry)}
                size="sm"
                type="button"
                variant="ghost"
              >
                Decline
              </OctantButton>
            </div>
          ) : (
            <p className="oct-row-detail">Approve at a window on this computer.</p>
          )}
        </article>
      ))}
      {message === undefined ? null : (
        <p className="oct-row-detail" role="status">
          {message}
        </p>
      )}
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
        <OctantButton
          aria-expanded={expanded}
          className="remote-workspace__proposal-toggle"
          onClick={() => setExpanded((open) => !open)}
          size="sm"
          type="button"
          variant="link"
        >
          {expanded ? "Show less" : "Show the full request"}
        </OctantButton>
      ) : null}
    </>
  );
}
