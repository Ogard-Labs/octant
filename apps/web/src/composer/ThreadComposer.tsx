import type { ReactNode } from "react";
import { ArrowUp, Square, X } from "lucide-react";
import { ComposerContextMeter } from "../context/ComposerContextMeter";
import { OctantButton } from "../ui/base/OctantButton";

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

export interface ThreadComposerDiscard {
  readonly ariaLabel: string;
  readonly onDiscard: () => void;
}

/**
 * What the row's trailing edge does. Most surfaces start or follow up with a
 * single send control pushed right by the flexible gap; Chat swaps the same
 * spot between send and stop while a response streams, in its own actions
 * cell (its bar lays cells out itself, so it carries no gap). A running turn
 * also lets a follow-up be queued: `discard` drops the parked follow-up, and
 * `sendHidden` hides send once that follow-up is already queued — Chat pairs
 * these with `stop` in "send-or-stop"; Code and Work's plain "send" follow-up
 * bar has no stop control, only queue/discard.
 */
export type ThreadComposerActions =
  | {
      readonly kind: "send";
      readonly send: ThreadComposerSend;
      readonly discard?: ThreadComposerDiscard | undefined;
      readonly sendHidden?: boolean | undefined;
    }
  | {
      readonly kind: "send-or-stop";
      readonly cellClassName: string;
      readonly sending: boolean;
      readonly send: ThreadComposerSend;
      readonly stop: ThreadComposerStop;
      readonly discard?: ThreadComposerDiscard | undefined;
      readonly sendHidden?: boolean | undefined;
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
  /** Naming the frame promotes it to a `<section>` landmark (Chat). */
  readonly ariaLabel?: string | undefined;
  /** Appended after `composer`; positions the frame within the surface. */
  readonly className?: string | undefined;
  /** Attachment, mention, and queued-turn chips shown above the input. */
  readonly chips?: ReactNode;
  readonly label?: ThreadComposerLabel | undefined;
  /** The surface's message control (`.composer-input` textarea and wiring). */
  readonly input: ReactNode;
  /** Mention/command typeahead popovers anchored between input and row. */
  readonly typeahead?: ReactNode;
  readonly row: ThreadComposerRow;
  /** Status line, context strip, or panels the surface shows under the row. */
  readonly footer?: ReactNode;
}

export function ThreadComposer(props: ThreadComposerProps) {
  const frameClassName = props.className === undefined ? "composer" : `composer ${props.className}`;
  const body = (
    <>
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
      <div
        {...(props.row.ariaLabel === undefined ? {} : { "aria-label": props.row.ariaLabel })}
        className={
          props.row.className === undefined ? "composer-row" : `composer-row ${props.row.className}`
        }
        {...(props.row.toolbar === true ? { role: "toolbar" } : {})}
      >
        {props.row.leading}
        <ThreadComposerTrailing actions={props.row.actions} />
      </div>
      {props.footer}
    </>
  );
  return props.ariaLabel === undefined ? (
    <div className={frameClassName}>{body}</div>
  ) : (
    <section aria-label={props.ariaLabel} className={frameClassName}>
      {body}
    </section>
  );
}

function sendRefused(send: ThreadComposerSend): boolean {
  return send.disabled === true || send.disabledReason !== undefined;
}

function ThreadComposerTrailing(props: { readonly actions: ThreadComposerActions }) {
  const meter = <ComposerContextMeter />;
  if (props.actions.kind === "send") {
    const { send, discard, sendHidden } = props.actions;
    return (
      <>
        <span className="composer-gap" />
        {meter}
        {discard === undefined ? null : (
          <OctantButton
            aria-label={discard.ariaLabel}
            onClick={discard.onDiscard}
            size="icon"
            type="button"
            variant="ghost"
          >
            <X aria-hidden="true" size={14} strokeWidth={1.8} />
          </OctantButton>
        )}
        {sendHidden === true ? null : (
          <OctantButton
            aria-label={send.ariaLabel}
            disabled={sendRefused(send)}
            {...(send.onSend === undefined ? {} : { onClick: send.onSend })}
            size="icon"
            type={send.onSend === undefined ? "submit" : "button"}
            variant="default"
          >
            <ArrowUp aria-hidden="true" size={16} strokeWidth={2} />
          </OctantButton>
        )}
      </>
    );
  }
  const { cellClassName, sending, send, stop, discard, sendHidden } = props.actions;
  return (
    <div className={cellClassName}>
      {meter}
      {discard === undefined ? null : (
        <OctantButton
          aria-label={discard.ariaLabel}
          onClick={discard.onDiscard}
          size="icon"
          type="button"
          variant="ghost"
        >
          <X aria-hidden="true" size={14} strokeWidth={1.8} />
        </OctantButton>
      )}
      {sending ? (
        <button
          aria-label={stop.ariaLabel}
          className="btn-send window-no-drag"
          disabled={stop.disabledReason !== undefined}
          onClick={stop.onStop}
          type="button"
        >
          <Square aria-hidden="true" fill="currentColor" size={10} strokeWidth={1.5} />
        </button>
      ) : null}
      {sendHidden === true ? null : (
        <button
          aria-label={send.ariaLabel}
          className="btn-send window-no-drag"
          disabled={sendRefused(send)}
          {...(send.onSend === undefined ? {} : { onClick: send.onSend })}
          type="button"
        >
          <ArrowUp aria-hidden="true" size={16} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}
