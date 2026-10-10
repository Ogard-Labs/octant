import type { PendingRequest } from "@octant/contracts/pending-requests";
import { CirclePause } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { elapsedLabel } from "../lib/relativeTime";
import { ProviderGlyph } from "../providers/ProviderGlyph";
import { modeIcons } from "../shell/ModeSwitcher";
import type { ThreadProviderIdentity } from "../shell/navigationModel";
import { OctantButton } from "../ui/base/OctantButton";
import {
  pendingRequestChoices,
  type PendingRequestAnswerResult,
  type PendingRequestResponse,
} from "./pendingRequests";
import "./pendingRequestRow.css";

export interface PendingRequestRowProps {
  readonly request: PendingRequest;
  /** The clock the wait is read against; the shell advances it once a minute. */
  readonly now: number;
  readonly projectName?: string | undefined;
  /** The thread's provider when the shell knows it; otherwise the row draws its mode's glyph. */
  readonly provider?: ThreadProviderIdentity | undefined;
  /**
   * The host no longer lists this request. The row keeps its last words and
   * its refusal line but offers no answer.
   */
  readonly settled?: boolean;
  /**
   * The row sits inside a card that already names the thread, its Project, and
   * its provider: it keeps the wait, the text, and the answers.
   */
  readonly embedded?: boolean;
  /** Deliver the answer through the mode's own command; the row never knows how. */
  readonly onAnswer: (
    request: PendingRequest,
    response: PendingRequestResponse,
  ) => Promise<PendingRequestAnswerResult>;
  /** Opens the thread, where a typed answer goes in its composer. */
  readonly onOpenThread: (request: PendingRequest) => void;
}

/**
 * One approval, question, or decision waiting on the person: who is waiting
 * and for how long, what it asked, and the answers that fit, in the order the
 * shell keeps threads. An approval is Approve or Deny; a question offers its
 * choices as numbered buttons (the matching number key picks one while the row
 * has focus) and Reply…, which opens the thread to type an answer. A decision
 * is the ask a finished turn closed with: its options are numbered the same
 * way, the recommended one first and marked, and picking one sends those
 * words as the thread's next turn. The row owns only its own busy state and
 * its refusal line; it carries no authority and knows nothing about the card
 * or board that lists it.
 */
export function PendingRequestRow(props: PendingRequestRowProps) {
  const { request } = props;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const choices = pendingRequestChoices(request);
  const open = props.settled !== true;

  async function answer(response: PendingRequestResponse) {
    if (busy || !open) return;
    setBusy(true);
    setNotice(undefined);
    const result = await props.onAnswer(request, response);
    if (!mounted.current) return;
    // An answered row stays disabled until the next read takes it away, so a
    // second click cannot answer it twice.
    if (result.status === "answered") return;
    setBusy(false);
    setNotice(result.message);
  }

  /** Number keys 1 to 9 pick a choice; a tenth choice is a click away. */
  function pickByNumber(event: KeyboardEvent<HTMLDivElement>) {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    if (!/^[1-9]$/.test(event.key)) return;
    const choice = choices[Number(event.key) - 1];
    if (choice === undefined) return;
    event.preventDefault();
    void answer({ kind: "choice", label: choice.label });
  }

  const embedded = props.embedded === true;
  const ModeIcon = modeIcons[request.mode];
  return (
    <div
      aria-label={
        request.kind === "decision"
          ? `${request.threadTitle} asks you to decide`
          : `${request.threadTitle} is waiting for you`
      }
      className="pending-request"
      data-embedded={embedded ? "true" : "false"}
      data-kind={request.kind}
      onKeyDown={pickByNumber}
      role="group"
    >
      <div className="pending-request__head">
        {embedded ? null : (
          <>
            {props.provider === undefined ? (
              <ModeIcon aria-hidden="true" className="pending-request__mark" size={16} />
            ) : (
              <ProviderGlyph
                className="pending-request__mark"
                displayName={props.provider.displayName}
                driverKind={props.provider.driverKind}
                size={16}
              />
            )}
            <OctantButton
              className="oct-row-label pending-request__title window-no-drag"
              onClick={() => props.onOpenThread(request)}
              title={request.threadTitle}
              type="button"
              variant="bare"
            >
              {request.threadTitle}
            </OctantButton>
          </>
        )}
        <span className="oct-meta pending-request__wait">
          <CirclePause aria-hidden="true" size={12} strokeWidth={1.8} />
          {`Waiting ${elapsedLabel(request.requestedAt, props.now)}`}
        </span>
      </div>
      {embedded || props.projectName === undefined ? null : (
        <span className="oct-meta pending-request__project">{props.projectName}</span>
      )}
      <p className="oct-row-detail pending-request__text" title={request.text}>
        {request.text}
      </p>
      {open ? (
        <div className="pending-request__actions">
          {request.kind === "approval" ? (
            <>
              <OctantButton
                disabled={busy}
                onClick={() => void answer({ kind: "approve" })}
                size="sm"
                type="button"
              >
                Approve
              </OctantButton>
              <OctantButton
                disabled={busy}
                onClick={() => void answer({ kind: "deny" })}
                size="sm"
                type="button"
                variant="ghost"
              >
                Deny
              </OctantButton>
            </>
          ) : (
            <>
              {choices.map((choice, index) => (
                <OctantButton
                  className="pending-request__choice"
                  disabled={busy}
                  key={choice.label}
                  onClick={() => void answer({ kind: "choice", label: choice.label })}
                  size="sm"
                  title={choice.description ?? choice.label}
                  type="button"
                  variant="outline"
                >
                  <span aria-hidden="true" className="pending-request__number">
                    {String(index + 1)}
                  </span>
                  <span className="pending-request__choice-label">{choice.label}</span>
                  {choice.recommended === true ? (
                    <span className="oct-meta pending-request__recommended">Recommended</span>
                  ) : null}
                </OctantButton>
              ))}
              <OctantButton
                disabled={busy}
                onClick={() => props.onOpenThread(request)}
                size="sm"
                type="button"
                variant="ghost"
              >
                Reply…
              </OctantButton>
            </>
          )}
        </div>
      ) : null}
      {notice === undefined ? null : (
        <p className="oct-meta pending-request__notice" role="status">
          {notice}
        </p>
      )}
    </div>
  );
}
