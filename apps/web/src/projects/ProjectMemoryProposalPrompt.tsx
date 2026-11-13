import type { ProjectClient } from "@octant/client-runtime/project-client";
import type { ProjectMemoryProposal } from "@octant/contracts";
import { useCallback, useEffect, useState } from "react";
import { ApprovalOutsideContentNote } from "../composer/ApprovalOutsideContentNote";
import {
  THREAD_ACTIVITY_RECOVERY_MS,
  useThreadActivityRevision,
} from "../polling/ThreadActivityRevisions";
import { samePollingData } from "../polling/samePollingData";
import { useVisibleRefresh } from "../polling/useVisibleRefresh";
import { OctantApprovalCard } from "../ui/base/OctantApprovalCard";
import { OctantButton } from "../ui/base/OctantButton";

const ACTIVE_PROPOSAL_POLL_MS = 500;
const IDLE_PROPOSAL_POLL_MS = 5_000;

export type ProjectMemoryProposalClient = Pick<
  ProjectClient,
  "listMemoryProposals" | "decideMemoryProposal"
>;

/**
 * A change to Project memory this thread's agent asked for, waiting on the
 * host until the person answers. It shows exactly what would be written, and
 * nothing changes until Save; no answer here covers a later write. A write at
 * Full access, or in a Project that lets agents write its memory, never
 * reaches this card. The host lists only this window's proposals; the open thread's
 * are shown, oldest first.
 */
export function ProjectMemoryProposalPrompt(props: {
  readonly client: ProjectMemoryProposalClient | undefined;
  readonly threadId: string | undefined;
  /** A running turn is polled often, because its call is waiting on the answer. */
  readonly turnActive: boolean;
  readonly className: string;
}) {
  const { client, threadId, turnActive } = props;
  const [proposals, setProposals] = useState<ReadonlyArray<ProjectMemoryProposal>>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const revision = useThreadActivityRevision("toolApprovals");

  useEffect(() => {
    setProposals([]);
  }, [client, threadId]);

  const refresh = useCallback(
    async (signal: AbortSignal) => {
      if (client === undefined || threadId === undefined) return;
      try {
        const listed = await client.listMemoryProposals(signal);
        if (signal.aborted) return;
        const next = listed.filter((proposal) => String(proposal.threadId) === threadId);
        setProposals((current) => (samePollingData(current, next) ? current : next));
      } catch {
        if (!signal.aborted) setProposals((current) => (current.length === 0 ? current : []));
      }
    },
    [client, threadId],
  );
  useVisibleRefresh(
    refresh,
    revision,
    turnActive
      ? ACTIVE_PROPOSAL_POLL_MS
      : revision === undefined
        ? IDLE_PROPOSAL_POLL_MS
        : THREAD_ACTIVITY_RECOVERY_MS,
  );

  const pending = proposals[0];
  if (pending === undefined || client === undefined) return null;

  async function decide(decision: "confirm" | "decline") {
    if (pending === undefined || client === undefined || busy) return;
    setBusy(true);
    setMessage(undefined);
    try {
      // Every answer takes the proposal off the host's list, whatever came of
      // it; the agent's tool result says what happened, including a confirmed
      // change the memory command refused.
      await client.decideMemoryProposal({ proposalId: pending.proposalId, decision });
      setProposals((current) =>
        current.filter((proposal) => proposal.proposalId !== pending.proposalId),
      );
    } catch {
      setMessage("Your answer could not be sent. The change is still waiting; try again.");
    } finally {
      setBusy(false);
    }
  }

  const { change } = pending;
  return (
    <OctantApprovalCard
      actions={
        <>
          <OctantButton
            disabled={busy}
            onClick={() => void decide("confirm")}
            size="sm"
            type="button"
          >
            {change.kind === "retract" ? "Retract" : "Save to memory"}
          </OctantButton>
          <OctantButton
            disabled={busy}
            onClick={() => void decide("decline")}
            size="sm"
            type="button"
            variant="ghost"
          >
            Decline
          </OctantButton>
        </>
      }
      className={props.className}
      context={
        pending.outsideContent === undefined ? undefined : (
          <ApprovalOutsideContentNote outsideContent={pending.outsideContent} />
        )
      }
      detail="Every later thread in this Project starts with its memory. The entry will be marked as written by an agent in this thread."
      error={message}
      label="Project memory change"
      summary={proposalSummary(change)}
    >
      {change.kind === "supersede" ? (
        <p className="approval-row__code">Replaces: {change.previousContent}</p>
      ) : null}
      {change.kind === "retract" ? (
        <p className="approval-row__code">Reason: {change.reason}</p>
      ) : null}
      <p className="approval-row__code">{change.content}</p>
    </OctantApprovalCard>
  );
}

function proposalSummary(change: ProjectMemoryProposal["change"]): string {
  switch (change.kind) {
    case "create":
      return `Save a ${change.memoryKind} to Project memory?`;
    case "supersede":
      return "Replace a Project memory entry?";
    case "retract":
      return "Retract a Project memory entry?";
  }
}
