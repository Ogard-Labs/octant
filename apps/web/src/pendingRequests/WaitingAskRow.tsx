import type { WaitingAsk } from "@octant/contracts/pending-requests";
import { CirclePause } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAgentThreadName } from "../agentAccess/agentThreadAttribution";
import { elapsedLabel } from "../lib/relativeTime";
import { modeIcons } from "../shell/ModeSwitcher";
import { OctantButton } from "../ui/base/OctantButton";
import type { PendingRequestAnswerResult, WaitingAskAnswer } from "./pendingRequests";
import "./pendingRequestRow.css";

export interface WaitingAskRowProps {
  readonly ask: WaitingAsk;
  /** The clock the wait is read against; the shell advances it once a minute. */
  readonly now: number;
  readonly projectName?: string | undefined;
  /**
   * Delivers the answer through the ask's own route. Absent when this surface
   * holds no client for the ask's kind: the row then only opens the thread.
   */
  readonly onAnswer?:
    | ((ask: WaitingAsk, answer: WaitingAskAnswer) => Promise<PendingRequestAnswerResult>)
    | undefined;
  /** Opens the ask's thread, where its own card shows and answers all of it. */
  readonly onOpenThread: (ask: WaitingAsk) => void;
}

/** The words of the two plain answers, as each ask's own card names them. */
const ANSWER_LABELS: Readonly<
  Partial<Record<WaitingAsk["kind"], { readonly approve: string; readonly decline: string }>>
> = {
  "tool-approval": { approve: "Approve", decline: "Deny" },
  "memory-proposal": { approve: "Confirm", decline: "Decline" },
};

/**
 * One ask a thread's agent raised outside its provider's approvals: an MCP
 * tool call, a Project memory or routine proposal, an image offer, a Browser
 * approval or sign-in. The row names the thread and how long it has waited and
 * says what is asked. It offers the two plain answers only when the host says
 * the row carries the whole ask (`inPlace`) and this surface holds the ask's
 * own client; otherwise it opens the thread, whose card decides it. The row
 * carries no authority: the ask's own route checks who may answer.
 */
export function WaitingAskRow(props: WaitingAskRowProps) {
  const { ask } = props;
  const agentName = useAgentThreadName(ask.threadId);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const labels = ask.inPlace === true ? ANSWER_LABELS[ask.kind] : undefined;
  const onAnswer = props.onAnswer;
  const answerable = labels !== undefined && onAnswer !== undefined;

  async function answer(choice: WaitingAskAnswer) {
    if (busy || onAnswer === undefined) return;
    setBusy(true);
    setNotice(undefined);
    const result = await onAnswer(ask, choice);
    if (!mounted.current) return;
    // An answered row stays disabled until the next read takes it away, so a
    // second click cannot answer it twice.
    if (result.status === "answered") return;
    setBusy(false);
    setNotice(result.message);
  }

  const threadLabel =
    agentName === undefined ? ask.threadTitle : `${agentName} · ${ask.threadTitle}`;
  const ModeIcon = modeIcons[ask.mode];
  return (
    <div
      aria-label={
        ask.kind === "tool-approval" || ask.kind === "browser-approval"
          ? `${threadLabel} needs your approval`
          : `${threadLabel} is waiting for you`
      }
      className="pending-request"
      data-embedded="false"
      data-kind={ask.kind}
      role="group"
    >
      <div className="pending-request__head">
        <ModeIcon aria-hidden="true" className="pending-request__mark" size={16} />
        <OctantButton
          className="oct-row-label pending-request__title window-no-drag"
          onClick={() => props.onOpenThread(ask)}
          title={threadLabel}
          type="button"
          variant="bare"
        >
          {threadLabel}
        </OctantButton>
        <span className="oct-meta pending-request__wait">
          <CirclePause aria-hidden="true" size={12} />
          {`Waiting ${elapsedLabel(ask.requestedAt, props.now)}`}
        </span>
      </div>
      {props.projectName === undefined ? null : (
        <span className="oct-meta pending-request__project">{props.projectName}</span>
      )}
      <p className="oct-row-detail pending-request__text" title={ask.text}>
        {ask.text}
      </p>
      {ask.detail === undefined ? null : (
        <p className="oct-meta pending-request__ask-detail">{ask.detail}</p>
      )}
      <div className="pending-request__actions">
        {answerable ? (
          <>
            <OctantButton
              disabled={busy}
              onClick={() => void answer("approve")}
              size="sm"
              type="button"
            >
              {labels.approve}
            </OctantButton>
            <OctantButton
              disabled={busy}
              onClick={() => void answer("decline")}
              size="sm"
              type="button"
              variant="outline"
            >
              {labels.decline}
            </OctantButton>
          </>
        ) : null}
        <OctantButton
          onClick={() => props.onOpenThread(ask)}
          size="sm"
          type="button"
          variant={answerable ? "ghost" : "outline"}
        >
          Open thread
        </OctantButton>
      </div>
      {notice === undefined ? null : (
        <p className="oct-meta pending-request__notice" role="status">
          {notice}
        </p>
      )}
    </div>
  );
}
