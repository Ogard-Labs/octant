import type { AutomationClient } from "@octant/client-runtime";
import type { RoutineProposal } from "@octant/contracts/automation";
import { useCallback, useEffect, useState } from "react";
import {
  THREAD_ACTIVITY_RECOVERY_MS,
  useThreadActivityRevision,
} from "../polling/ThreadActivityRevisions";
import { samePollingData } from "../polling/samePollingData";
import { useVisibleRefresh } from "../polling/useVisibleRefresh";
import { X } from "lucide-react";
import "../followUps/follow-up-suggestions.css";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton, OctantIconButton } from "../ui/base/OctantButton";
import {
  automationMissedRunPolicyLabel,
  automationModeLabel,
  formatAutomationInstant,
} from "./automationCenterModel";
import { routineScheduleLabel } from "./routinePresentation";

const ACTIVE_PROPOSAL_POLL_MS = 500;
const IDLE_PROPOSAL_POLL_MS = 5_000;

/**
 * A routine this thread's agent proposed, waiting on the host for the person,
 * as a suggestion chip at the foot of the thread like the reply's suggested
 * tasks. It says exactly what would run and when; nothing exists until its one
 * click, which the host performs as this window. Dismissing it declines, so
 * the agent hears no and nothing is created. The host lists only this
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

  const followUp = pending.targetPolicy === "same-thread";
  const schedule =
    pending.trigger.kind === "weekly-local"
      ? `${routineScheduleLabel(pending.trigger)} (${pending.trigger.timeZone})`
      : routineScheduleLabel(pending.trigger);
  const label = followUp ? "Follow-up proposal" : "Routine proposal";
  return (
    <section aria-label="Suggested by the agent" className={`follow-up-cards ${props.className}`}>
      <article aria-label={label} className="follow-up-card">
        <div className="follow-up-card__head">
          <span className="follow-up-card__kind">
            {followUp ? "Follow-up here · suggested" : "Routine · suggested"}
          </span>
          <OctantIconButton
            disabled={busy}
            label={`Dismiss ${pending.displayName}`}
            onClick={() => void decide("decline")}
            size="icon-xs"
            type="button"
          >
            <X aria-hidden="true" size={12} />
          </OctantIconButton>
        </div>
        <p className="follow-up-card__title">{pending.displayName}</p>
        <p className="follow-up-card__summary">
          {followUp
            ? `Once, ${formatAutomationInstant(pending.firstRunAt)}. It sends this prompt as a new turn in this thread, asks before it changes anything, and is skipped if the thread is busy, done, or archived by then.`
            : `${schedule} · First run ${formatAutomationInstant(pending.firstRunAt)} · ${automationMissedRunPolicyLabel(pending.missedRunPolicy)}. Each run starts a new ${automationModeLabel(pending.mode)} thread in this Project with this prompt, and asks before it changes anything.`}
        </p>
        <p className="follow-up-card__prompt">{pending.taskPrompt}</p>
        <div className="follow-up-card__actions">
          <OctantButton
            disabled={busy}
            onClick={() => void decide("confirm")}
            size="xs"
            type="button"
          >
            {followUp ? "Schedule follow-up" : "Create routine"}
          </OctantButton>
        </div>
      </article>
      {message === undefined ? null : (
        <OctantAlert className="follow-up-cards__error" tone="danger">
          {message}
        </OctantAlert>
      )}
    </section>
  );
}
