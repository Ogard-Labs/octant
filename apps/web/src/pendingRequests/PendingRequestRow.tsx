import { resolveSnoozePresets } from "@octant/domain";
import { OctantSelectField } from "../ui/base/OctantSelect";
import type { PendingRequest } from "@octant/contracts/pending-requests";
import { CirclePause } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { elapsedLabel } from "../lib/relativeTime";
import { ProviderGlyph } from "../providers/ProviderGlyph";
import { modeIcons } from "../shell/ModeSwitcher";
import type { ThreadProviderIdentity } from "../shell/navigationModel";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import {
  childRequestHeadline,
  isChildPendingRequest,
  isFindOnlyPendingRequest,
  isLeadApprovalPendingRequest,
  isLeadQuestionPendingRequest,
  MAX_DECISION_NOTE_LENGTH,
  pendingRequestChoices,
  type PendingRequestAnswerResult,
  type PendingRequestResponse,
} from "./pendingRequests";
import "./pendingRequestRow.css";

export interface PendingRequestRowProps {
  readonly onDefer?: (request: PendingRequest, until: string | null) => Promise<boolean>;
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
  /**
   * Opens the thread, where a typed answer goes in its composer. For a
   * subagent's request it opens the thread's Agents tab on that subagent, the
   * only place the request is answered. For the agent's own approval or Work
   * question it opens the thread, whose approval or question card answers it.
   */
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
 * words as the thread's next turn. A waiting subagent's request, and the
 * agent's own approval or Work question, are only found here: each has one
 * action, Review request, and no answer; the thread's own cards decide them.
 * The row owns only its own busy state and its refusal line; it carries no
 * authority and knows nothing about the card or board that lists it.
 */
export function PendingRequestRow(props: PendingRequestRowProps) {
  const { request } = props;
  const deferred =
    props.onDefer !== undefined &&
    request.deferredUntil !== undefined &&
    Date.parse(request.deferredUntil) > props.now;
  const [presetId, setPresetId] = useState<string>();
  const presets = resolveSnoozePresets(new Date(props.now));
  const selectedPreset = presets.find((preset) => preset.id === presetId);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const noteToggle = useRef<HTMLButtonElement>(null);
  const noteField = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (noteOpen) noteField.current?.focus();
  }, [noteOpen]);
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
    if (busy || !open || deferred) return;
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
    // Digits typed into the note are text, not a pick.
    if (event.target instanceof HTMLTextAreaElement) return;
    const choice = choices[Number(event.key) - 1];
    if (choice === undefined) return;
    event.preventDefault();
    pick(choice.label);
  }

  function pick(label: string) {
    // A closed note is kept for when it reopens, but only text the person can
    // see goes with their choice.
    void answer(
      !noteOpen || note.trim().length === 0
        ? { kind: "choice", label }
        : { kind: "choice", label, note },
    );
  }

  async function defer(until: string | null) {
    if (busy || props.onDefer === undefined) return;
    setBusy(true);
    setNotice(undefined);
    try {
      if (await props.onDefer(request, until)) {
        if (mounted.current) setPresetId(undefined);
      } else
        setNotice(`This ${noun} changed or is no longer available. Refresh before trying again.`);
    } catch {
      setNotice("The attention change could not be confirmed. Refresh before trying again.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const embedded = props.embedded === true;
  const decision = request.kind === "decision" ? request : undefined;
  const noun = decision === undefined ? "question" : "decision";
  const ModeIcon = modeIcons[request.mode];
  const child = isChildPendingRequest(request) ? request : undefined;
  const lead = isLeadApprovalPendingRequest(request) ? request : undefined;
  return (
    <div
      aria-label={
        child !== undefined
          ? `${request.threadTitle} has a subagent waiting for you`
          : lead !== undefined
            ? `${request.threadTitle} needs your approval`
            : isLeadQuestionPendingRequest(request)
              ? `${request.threadTitle} is waiting for your answer`
              : request.kind === "decision"
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
        {decision?.urgent === true ? (
          <span className="oct-meta pending-request__urgent">Urgent</span>
        ) : null}
        <span className="oct-meta pending-request__wait">
          <CirclePause aria-hidden="true" size={12} strokeWidth={1.8} />
          {`Waiting ${elapsedLabel(request.requestedAt, props.now)}`}
        </span>
      </div>
      {embedded || props.projectName === undefined ? null : (
        <span className="oct-meta pending-request__project">{props.projectName}</span>
      )}
      {child === undefined ? null : (
        <p className="oct-meta pending-request__subagent" title={child.child.task}>
          <span className="pending-request__subagent-headline">{childRequestHeadline(child)}</span>
          {` · ${child.child.task}`}
        </p>
      )}
      {lead?.lostInRestart !== true ? null : (
        <p className="oct-meta pending-request__subagent">
          Octant restarted while this was waiting, so it did not run.
        </p>
      )}
      {deferred ? null : (
        <p className="oct-row-detail pending-request__text" title={request.text}>
          {request.text}
        </p>
      )}
      {deferred || decision?.why === undefined ? null : (
        <p className="oct-meta pending-request__why" title={decision.why}>
          {decision.why}
        </p>
      )}
      {deferred ? (
        <p className="oct-meta" role="status">
          Deferred until {new Date(request.deferredUntil ?? "").toLocaleString()}. The {noun}{" "}
          remains unanswered.
        </p>
      ) : null}
      {open &&
      (request.kind === "question" || request.kind === "decision") &&
      request.deferralKey !== undefined &&
      props.onDefer !== undefined ? (
        <div className="pending-request__actions">
          {deferred ? (
            <OctantButton size="sm" disabled={busy} onClick={() => void defer(null)}>
              Bring back now
            </OctantButton>
          ) : (
            <>
              <OctantSelectField
                aria-label={`Defer ${noun} until`}
                value={selectedPreset?.id ?? ""}
                disabled={busy}
                placeholder="Remind me…"
                onValueChange={setPresetId}
                options={presets.map((preset) => ({
                  id: preset.id,
                  label: preset.label,
                }))}
              />
              <OctantButton
                size="sm"
                disabled={busy || selectedPreset === undefined}
                onClick={() => {
                  // Relative times start at submission, not when the menu was opened.
                  const preset = resolveSnoozePresets(new Date(Date.now())).find(
                    (candidate) => candidate.id === presetId,
                  );
                  if (preset === undefined) setPresetId(undefined);
                  else void defer(preset.until);
                }}
              >
                {`Defer ${noun}`}
              </OctantButton>
            </>
          )}
        </div>
      ) : null}
      {open && !deferred ? (
        <div className="pending-request__actions">
          {isFindOnlyPendingRequest(request) ? (
            <OctantButton
              onClick={() => props.onOpenThread(request)}
              size="sm"
              type="button"
              variant="outline"
            >
              Review request
            </OctantButton>
          ) : request.kind === "approval" ? (
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
                  onClick={() => pick(choice.label)}
                  size="sm"
                  title={choice.description ?? choice.label}
                  type="button"
                  variant="outline"
                >
                  <span aria-hidden="true" className="pending-request__number">
                    {String(index + 1)}
                  </span>
                  <span className="pending-request__choice-body">
                    <span className="pending-request__choice-line">
                      <span className="pending-request__choice-label">{choice.label}</span>
                      {choice.recommended === true ? (
                        <span className="oct-meta pending-request__recommended">Recommended</span>
                      ) : null}
                    </span>
                    {choice.detail === undefined ? null : (
                      <span className="oct-meta pending-request__choice-detail">
                        {choice.detail}
                      </span>
                    )}
                  </span>
                </OctantButton>
              ))}
              {decision === undefined || embedded ? null : (
                <OctantButton
                  aria-expanded={noteOpen}
                  disabled={busy}
                  onClick={() => setNoteOpen((current) => !current)}
                  ref={noteToggle}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Add note
                </OctantButton>
              )}
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
      {open && !deferred && !embedded && decision !== undefined && noteOpen ? (
        <OctantTextarea
          aria-label="Note sent with your choice"
          className="pending-request__note"
          disabled={busy}
          maxLength={MAX_DECISION_NOTE_LENGTH}
          onChange={(event) => setNote(event.target.value)}
          ref={noteField}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            setNoteOpen(false);
            noteToggle.current?.focus();
          }}
          placeholder="Add a note for the agent"
          rows={2}
          value={note}
        />
      ) : null}
      {notice === undefined ? null : (
        <p className="oct-meta pending-request__notice" role="status">
          {notice}
        </p>
      )}
    </div>
  );
}
