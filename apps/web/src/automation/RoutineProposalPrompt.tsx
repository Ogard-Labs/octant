import type { AutomationClient } from "@octant/client-runtime";
import type { RoutineProposal } from "@octant/contracts/automation";
import { useCallback, useEffect, useState } from "react";
import {
  THREAD_ACTIVITY_RECOVERY_MS,
  useThreadActivityRevision,
} from "../polling/ThreadActivityRevisions";
import { samePollingData } from "../polling/samePollingData";
import { useVisibleRefresh } from "../polling/useVisibleRefresh";
import { OctantApprovalCard } from "../ui/base/OctantApprovalCard";
import { OctantButton } from "../ui/base/OctantButton";
import {
  automationMissedRunPolicyLabel,
  automationModeLabel,
  formatAutomationInstant,
} from "./automationCenterModel";
import { routineScheduleLabel } from "./routinePresentation";

const ACTIVE_PROPOSAL_POLL_MS = 500;
const IDLE_PROPOSAL_POLL_MS = 5_000;

/**
 * A routine this thread's agent proposed, waiting on the host for the person.
 * The card says exactly what would run and when; nothing exists until Create
 * routine, which the host performs as this window. The host lists only this
 * window's proposals; the open thread's are shown, oldest first.
 */
export function RoutineProposalPrompt(props: {
  readonly client: AutomationClient | undefined;
  readonly threadId: string | undefined;
  /** A running turn is polled often, because its call is waiting on the answer. */
  readonly turnActive: boolean;
  readonly className: string;
}) {
  const { client, threadId, turnActive } = props;
  const [proposals, setProposals] = useState<ReadonlyArray<RoutineProposal>>([]);
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
        const listed = await client.listProposals(signal);
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
      // Every answer takes the proposal off the host's list, whatever came
      // of it; the agent's tool result says what happened, and a created
      // routine appears in this thread's Environment.
      await client.decideProposal({ proposalId: pending.proposalId, decision });
      setProposals((current) =>
        current.filter((proposal) => proposal.proposalId !== pending.proposalId),
      );
    } catch {
      setMessage("Your answer could not be sent. The proposal is still waiting; try again.");
    } finally {
      setBusy(false);
    }
  }

  const schedule =
    pending.trigger.kind === "weekly-local"
      ? `${routineScheduleLabel(pending.trigger)} (${pending.trigger.timeZone})`
      : routineScheduleLabel(pending.trigger);
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
            Create routine
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
      detail={`${schedule} · First run ${formatAutomationInstant(pending.firstRunAt)} · ${automationMissedRunPolicyLabel(pending.missedRunPolicy)}. Each run starts a new ${automationModeLabel(pending.mode)} thread in this Project with this prompt, and asks before it changes anything.`}
      error={message}
      label="Routine proposal"
      summary={`Create the routine “${pending.displayName}”?`}
    >
      <code className="approval-row__code">{pending.taskPrompt}</code>
    </OctantApprovalCard>
  );
}
