import { ComposerFollowUpSuggestions } from "../followUps/FollowUpSuggestionChips";
import { useComposerNotice } from "./ComposerNotice";
import { ComposerSubagents } from "./ComposerSubagents";
import { ComposerOutsideContentNotice } from "./OutsideContentNotice";
import { useId, type ReactNode } from "react";
import { ArrowUp, Square } from "lucide-react";
import { ComposerContextMeter } from "../context/ComposerContextMeter";
import { useComposerCompacting } from "../context/composerContextMeterScope";
import { ThreadStats } from "../threadStats/ThreadStats";
import { ComposerPlanUsage } from "../usage/ComposerPlanUsage";
import "./composer-plan-usage.css";
import { OctantButton } from "../ui/base/OctantButton";
import {
  focusComposerThreadDrop,
  useActiveComposerThreadDropKey,
} from "../chat/composerThreadDrop";

/**
 * The trailing send control. Sending is refused while `disabled` is true or a
 * `disabledReason` stands; the reason's words are the caller's to surface (the
 * status line under the row), so the control itself only refuses.
 */
export interface ThreadComposerSend {
  readonly ariaLabel: string;
  readonly disabled?: boolean | undefined;
  readonly disabledReason?: string | undefined;
  /**
   * Omitted when the enclosing `<form>` owns submission — the control then
   * renders as the form's submit button instead of calling back.
   */
  readonly onSend?: (() => void) | undefined;
}

export interface ThreadComposerStop {
  readonly ariaLabel: string;
  readonly disabledReason?: string | undefined;
  readonly onStop: () => void;
}

/**
 * What the row's trailing edge does. Most surfaces start or follow up with a
 * single send control pushed right by the flexible gap; Chat swaps the same
 * spot between send and stop while a response streams, in its own actions
 * cell (its bar lays cells out itself, so it carries no gap). Send stays
 * available throughout a running response so the surface can queue a follow-up.
 */
export type ThreadComposerActions =
  | {
      readonly kind: "send";
      readonly send: ThreadComposerSend;
    }
  | {
      readonly kind: "send-or-stop";
      readonly cellClassName: string;
      readonly sending: boolean;
      readonly send: ThreadComposerSend;
      readonly stop: ThreadComposerStop;
    };

/**
 * The visually hidden label naming the message field for assistive technology.
 * The composer renders it so the `<label>` is always a direct child of the
 * frame, which is what keeps `.composer > label { display: block }` applying.
 */
export interface ThreadComposerLabel {
  readonly className: string;
  readonly htmlFor?: string | undefined;
  readonly text: string;
  readonly textClassName: string;
}

export interface ThreadComposerRow {
  readonly ariaLabel?: string | undefined;
  /** Appended after `composer-row`; positions the row, never restyles it. */
  readonly className?: string | undefined;
  /** Chat announces its bar as a toolbar; other rows stay plain groups. */
  readonly toolbar?: boolean | undefined;
  /** Surface-specific controls: pickers, access policy, attachments, profile. */
  readonly leading?: ReactNode;
  /**
   * The model, then the microphone, right of the context ring and before
   * send. Access and approval choices lead the row instead, beside attach.
   */
  readonly trailing?: ReactNode;
  readonly actions: ThreadComposerActions;
}

/**
 * The one composer frame Chat, Work, and Code share. It owns the anatomy —
 * `.composer` frame, chips row, block message label, `.composer-row` with
 * leading controls and trailing send/stop — while every capability (chips,
 * typeaheads, pickers, status) is passed in by the surface and rendered only
 * when given. State, wiring, and the message control itself stay with the
 * surface: the component takes over markup, not behavior.
 */
export interface ThreadComposerProps {
  readonly presentation?: "follow-up";
  /** Existing-thread checkout context, in the strip above the message surface. */
  readonly context?: ReactNode;
  /** Naming the frame promotes it to a `<section>` landmark (Chat). */
  readonly ariaLabel?: string | undefined;
  /** Appended after `composer`; positions the frame within the surface. */
  readonly className?: string | undefined;
  /**
   * Where a new thread will run (Project, branch, Environment), as the first
   * row inside a start screen's card, above the chips and the message. A
   * thread's own composer never takes it: its context is already fixed.
   */
  readonly startContext?: ReactNode;
  /**
   * The provider a new thread will send to. Its remaining plan usage stands
   * at the right of the start context's row. A thread's own composer never
   * takes it: its windows come with the thread's stats strip.
   */
  readonly planUsage?: { readonly providerInstanceId: string | undefined };
  readonly queue?: ReactNode;
  /**
   * A turn is running or messages are queued on the thread around this
   * composer. The outside-content review cannot clear the thread's mark
   * meanwhile, and re-reads it when this changes.
   */
  readonly threadBusy?: boolean;
  /** Attachment and mention chips shown above the input. */
  readonly chips?: ReactNode;
  readonly label?: ThreadComposerLabel | undefined;
  /** The surface's message control (`.composer-input` textarea and wiring). */
  readonly input: ReactNode;
  /** Mention/command typeahead popovers anchored between input and row. */
  readonly typeahead?: ReactNode;
  readonly row: ThreadComposerRow;
  /** Status line, context strip, or panels the surface shows under the row. */
  readonly footer?: ReactNode;
  /**
   * When set, a sidebar thread dropped on this frame attaches a mention
   * instead of opening a pane. The key matches the registered composer.
   */
  readonly threadDropKey?: string;
}

export function ThreadComposer(props: ThreadComposerProps) {
  const notice = useComposerNotice();
  // The host refuses a turn while the session compacts, so send waits too, and
  // says why under the row.
  const compacting = useComposerCompacting();
  const compactingNoteId = useId();
  const compactingNote = compacting ? (
    <p className="oct-meta thread-composer__compacting" data-compacting="" id={compactingNoteId}>
      Compacting session
    </p>
  ) : null;
  const activeDropKey = useActiveComposerThreadDropKey();
  const dropKey = props.threadDropKey;
  const dropActive = dropKey !== undefined && activeDropKey === dropKey;
  const baseClassName = props.className === undefined ? "composer" : `composer ${props.className}`;
  const followUp = props.presentation === "follow-up";
  const frameClassName = `${followUp ? `${baseClassName} composer--follow-up` : baseClassName}${notice == null ? "" : " composer--has-notice"}`;
  const message = (
    <>
      {props.startContext === undefined || props.planUsage === undefined ? (
        props.startContext
      ) : (
        <div className="composer-start">
          {props.startContext}
          <ComposerPlanUsage providerInstanceId={props.planUsage.providerInstanceId} />
        </div>
      )}
      {props.queue}
      {props.chips}
      {props.label === undefined ? (
        props.input
      ) : (
        <label
          className={props.label.className}
          {...(props.label.htmlFor === undefined ? {} : { htmlFor: props.label.htmlFor })}
        >
          <span className={props.label.textClassName}>{props.label.text}</span>
          {props.input}
        </label>
      )}
      {props.typeahead}
    </>
  );
  const controls = (
    <div
      {...(props.row.ariaLabel === undefined ? {} : { "aria-label": props.row.ariaLabel })}
      className={
        props.row.className === undefined ? "composer-row" : `composer-row ${props.row.className}`
      }
      {...(props.row.toolbar === true ? { role: "toolbar" } : {})}
    >
      {props.row.leading}
      <ThreadComposerTrailing
        actions={props.row.actions}
        compactingNoteId={compacting ? compactingNoteId : undefined}
        controls={props.row.trailing}
      />
    </div>
  );
  // Suggested tasks stand above the composer, as the last thing in the
  // thread; inside the surface they made the box read as one tall composer.
  // Where the thread runs and how much of the plan is left share one strip
  // above the box, so the box itself holds only the message and its controls.
  const body = followUp ? (
    <>
      <ComposerFollowUpSuggestions />
      <div className="thread-composer__strip">
        {props.context === undefined ? null : (
          <div className="thread-composer__context">{props.context}</div>
        )}
        <ThreadStats />
      </div>
      <div className="thread-composer__surface">
        <ComposerOutsideContentNotice busy={props.threadBusy === true} />
        {message}
        <div className="thread-composer__feedback">
          {compactingNote}
          {props.footer}
        </div>
        {controls}
      </div>
    </>
  ) : (
    <>
      <ComposerFollowUpSuggestions />
      {message}
      {controls}
      {compactingNote}
      {props.footer}
      <ThreadStats />
    </>
  );
  const frame =
    props.ariaLabel === undefined ? (
      <div
        className={frameClassName}
        {...(dropKey === undefined ? {} : { "data-composer-thread-drop": dropKey })}
        {...(dropActive ? { "data-drop-target": "true" } : {})}
        {...(dropKey === undefined
          ? {}
          : { onFocusCapture: () => focusComposerThreadDrop(dropKey) })}
      >
        {notice}
        {dropActive ? <ComposerThreadDropCue /> : null}
        <ComposerSubagents />
        {body}
      </div>
    ) : (
      <section
        aria-label={props.ariaLabel}
        className={frameClassName}
        {...(dropKey === undefined ? {} : { "data-composer-thread-drop": dropKey })}
        {...(dropActive ? { "data-drop-target": "true" } : {})}
        {...(dropKey === undefined
          ? {}
          : { onFocusCapture: () => focusComposerThreadDrop(dropKey) })}
      >
        {notice}
        {dropActive ? <ComposerThreadDropCue /> : null}
        <ComposerSubagents />
        {body}
      </section>
    );
  return frame;
}

function ComposerThreadDropCue() {
  return (
    <div aria-hidden="true" className="composer-thread-drop-cue">
      <span>Attach as context</span>
    </div>
  );
}

function sendRefused(send: ThreadComposerSend, compactingNoteId: string | undefined): boolean {
  return (
    compactingNoteId !== undefined || send.disabled === true || send.disabledReason !== undefined
  );
}

function ThreadComposerTrailing(props: {
  readonly actions: ThreadComposerActions;
  /** Set while the session compacts: send is held, and this note says why. */
  readonly compactingNoteId: string | undefined;
  readonly controls?: ReactNode;
}) {
  const meter = <ComposerContextMeter />;
  if (props.actions.kind === "send") {
    const { send } = props.actions;
    return (
      <div className="composer-actions">
        {meter}
        {props.controls}
        <OctantButton
          aria-describedby={props.compactingNoteId}
          aria-label={send.ariaLabel}
          disabled={sendRefused(send, props.compactingNoteId)}
          {...(send.onSend === undefined ? {} : { onClick: send.onSend })}
          size="icon"
          type={send.onSend === undefined ? "submit" : "button"}
          variant="default"
        >
          <ArrowUp aria-hidden="true" size={16} strokeWidth={2} />
        </OctantButton>
      </div>
    );
  }
  const { cellClassName, sending, send, stop } = props.actions;
  return (
    <div className={cellClassName}>
      {meter}
      {props.controls}
      {sending ? (
        <OctantButton
          aria-label={stop.ariaLabel}
          disabled={stop.disabledReason !== undefined}
          onClick={stop.onStop}
          size="icon"
          type="button"
          variant="secondary"
        >
          <Square aria-hidden="true" fill="currentColor" size={12} strokeWidth={1.5} />
        </OctantButton>
      ) : null}
      <OctantButton
        aria-describedby={props.compactingNoteId}
        aria-label={send.ariaLabel}
        disabled={sendRefused(send, props.compactingNoteId)}
        {...(send.onSend === undefined ? {} : { onClick: send.onSend })}
        size="icon"
        type="button"
        variant="default"
      >
        <ArrowUp aria-hidden="true" size={16} strokeWidth={2} />
      </OctantButton>
    </div>
  );
}
