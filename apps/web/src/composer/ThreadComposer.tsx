import { ComposerFollowUpSuggestions } from "../followUps/FollowUpSuggestionChips";
import {
  ComposerNoticeSinkProvider,
  noticeRole,
  useComposerNotice,
  type ComposerNoticeItem,
  type ComposerProgress,
} from "./ComposerNotice";
import { ComposerNoticeCard, noticeCardId } from "./ComposerNoticeCard";
import { useFrozenBar } from "./frozenBarScope";
import { ComposerSubagents } from "./ComposerSubagents";
import { ComposerOutsideContentChip } from "./OutsideContentNotice";
import {
  Fragment,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ArrowUp, Square } from "lucide-react";
import { ComposerContextMeter } from "../context/ComposerContextMeter";
import { useComposerCompacting } from "../context/composerContextMeterScope";
import { ThreadPlanWindows } from "../threadStats/ThreadStats";
import type { ModelPickerSelection, PickerGroup } from "@octant/domain";
import { ComposerPlanUsage } from "../usage/ComposerPlanUsage";
import { ComposerUsageWarning } from "../usage/ComposerUsageWarning";
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
  /**
   * Offered beside Stop once a Stop did not end the turn. It kills the turn's
   * runtime process, which a normal Stop never does.
   */
  readonly forceStop?: { readonly onForceStop: () => void } | undefined;
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
  /**
   * The attach control, at the leading edge of the card beside the prompt. It
   * is the one control besides send that acts on the message being written.
   */
  readonly attach?: ReactNode;
  /** Surface-specific controls: pickers, access policy, profile. */
  readonly leading?: ReactNode;
  /**
   * The model, right of the context ring. Access and approval choices lead
   * the row instead.
   */
  readonly trailing?: ReactNode;
  /**
   * The microphone, in the pill just before send: it writes into the prompt,
   * so it stands with the two other controls that act on the message. In the
   * row under the pill it read as a fact about the thread.
   */
  readonly dictate?: ReactNode;
  readonly actions: ThreadComposerActions;
}

/**
 * The one composer frame Chat, Work, and Code share. It owns the anatomy —
 * the `.composer` frame, and inside it the notice cards, the pill (chips, then
 * attach, the block message label and send/stop on one line) and the
 * `.composer-row` of the surface's controls on the page under it — while every
 * capability (chips, typeaheads, pickers, notices) is passed in by the surface
 * and rendered only when given. State, wiring, and the message control itself stay with the
 * surface: the component takes over markup, not behavior.
 */
export interface ThreadComposerProps {
  readonly presentation?: "follow-up";
  /** Existing-thread checkout context, in the strip above the message surface. */
  readonly context?: ReactNode;
  /** The thread's info panel and its button, at the end of that strip. */
  readonly info?: ReactNode;
  /** Naming the frame promotes it to a `<section>` landmark (Chat). */
  readonly ariaLabel?: string | undefined;
  /** Appended after `composer`; positions the frame within the surface. */
  readonly className?: string | undefined;
  /**
   * Where a new thread will run (Project, branch, Environment), as one quiet
   * row on the page just above a start screen's card. A thread's own composer
   * never takes it: its context is already fixed.
   */
  readonly startContext?: ReactNode;
  /**
   * The provider a new thread will send to. Its remaining plan usage stands
   * at the right of the start context's row. A thread's own composer never
   * takes it: its windows stand in the thread's strip above the box.
   */
  readonly planUsage?: {
    readonly providerInstanceId: string | undefined;
    /**
     * The accounts a new thread could use instead. With them, a chosen
     * account at its limit shows a warning with a button for each account
     * that has room; without them, the meters stand alone.
     */
    readonly alternatives?: {
      readonly groups: ReadonlyArray<PickerGroup>;
      readonly selectedModelId?: string | undefined;
      readonly onSelect: (selection: ModelPickerSelection) => void | Promise<void>;
    };
  };
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
  /**
   * What the surface has to say about its thread or about sending: a refusal,
   * a failure, a status, a hint. They are drawn as cards directly above the
   * pill, most severe first, never inside it.
   */
  readonly notices?: ReadonlyArray<ComposerNoticeItem>;
  /**
   * The one passing message (sending, a response streaming, a provider
   * check): a quiet line above the notice group that takes no layout room,
   * never a card. The newest wins; the surface picks it.
   */
  readonly progress?: ComposerProgress | undefined;
  /**
   * Text for the persistent status region that is the prompt's description
   * (why Send is held). Visually hidden and never in the pill's height.
   */
  readonly description?: ReactNode;
  /** The region's element id, when the surface's prompt already names it. */
  readonly statusId?: string | undefined;
  /**
   * When set, a sidebar thread dropped on this frame attaches a mention
   * instead of opening a pane. The key matches the registered composer.
   */
  readonly threadDropKey?: string;
}

/**
 * A thread's composer, or the frozen bar in its place while a move holds the
 * thread. The host refuses every command on a held thread anyway; the bar
 * says what holds it instead of offering a send that would be refused.
 */
export function ThreadComposer(props: ThreadComposerProps) {
  const frozenBar = useFrozenBar();
  const held = props.presentation === "follow-up" && frozenBar !== undefined;
  // A held thread takes no message, but its access level and a credential
  // command waiting for review are still the person's to read and answer. The
  // surface stays where it is and draws only the strip's info while held, so
  // a row of the info panel keeps what the person typed into it (a provider
  // cloud task under review) when a move starts and is then cancelled.
  return (
    <>
      <ComposerSurface {...props} held={held} />
      {held ? frozenBar : null}
    </>
  );
}

function ComposerSurface(props: ThreadComposerProps & { readonly held: boolean }) {
  const notice = useComposerNotice();
  // A control inside the pill (the microphone) says its failure in the card
  // too, where it wraps, instead of beside itself where it was cut to fit.
  const [published, setPublished] = useState<ReadonlyMap<string, ComposerNoticeItem>>(new Map());
  const publish = useCallback((item: ComposerNoticeItem | undefined, key: string) => {
    setPublished((current) => {
      if (item === undefined && !current.has(key)) return current;
      const next = new Map(current);
      if (item === undefined) next.delete(key);
      else next.set(key, item);
      return next;
    });
  }, []);
  // The host refuses a turn while the session compacts, so send waits too, and
  // says why under the row.
  const compacting = useComposerCompacting();
  const compactingNoteId = useId();
  const regionFallbackId = useId();
  const regionId = props.statusId ?? regionFallbackId;
  const noticeIdPrefix = useId();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const activeDropKey = useActiveComposerThreadDropKey();
  const dropKey = props.threadDropKey;
  const dropActive = dropKey !== undefined && activeDropKey === dropKey;
  const baseClassName = props.className === undefined ? "composer" : `composer ${props.className}`;
  const followUp = props.presentation === "follow-up";
  const frameClassName = `${baseClassName} composer--carded${followUp ? " composer--follow-up" : ""}`;
  // Where a new thread runs and how much of the plan is left stand in the
  // tray above the card, so the card holds only the prompt. Inside the card
  // the row sat between the person and the prompt, and a control with more
  // than a label (a folder form) grew the card instead of opening over the
  // page.
  const startRow =
    props.startContext === undefined ? null : (
      <div className="composer-start">
        {props.planUsage?.alternatives === undefined ? null : (
          <ComposerUsageWarning
            groups={props.planUsage.alternatives.groups}
            onSelect={props.planUsage.alternatives.onSelect}
            selectedModelId={props.planUsage.alternatives.selectedModelId}
            selectedProviderInstanceId={props.planUsage.providerInstanceId}
          />
        )}
        {props.startContext}
        {props.planUsage === undefined ? null : (
          <ComposerPlanUsage providerInstanceId={props.planUsage.providerInstanceId} />
        )}
      </div>
    );
  // One group of cards directly above the pill, under the start row: what the
  // thread did or what sending refused, then the Project offer and the
  // outside-content mark.
  const all = [...(props.notices ?? []), ...published.values()];
  // A card is for something the person must read or act on, or a fact that
  // stays until they do. Only a state a surface marks as passing by itself
  // (and with text it can draw on one line) is the quiet line.
  const isLine = (card: ComposerNoticeItem) =>
    card.transient === true && card.action === undefined && typeof card.text === "string";
  const cards = all.filter((card) => !isLine(card));
  const noted = all.filter(isLine);
  // A session that compacts holds Send; that is progress, and it outranks the
  // surface's own passing message.
  const lastNote = noted.at(-1);
  const progress: ComposerProgress | undefined = compacting
    ? { text: "Compacting session" }
    : (props.progress ??
      (lastNote === undefined || typeof lastNote.text !== "string"
        ? undefined
        : {
            text: lastNote.text,
            ...(lastNote.label === undefined ? {} : { label: lastNote.label }),
          }));
  // The region says every passing note even when only the newest is drawn.
  // A card that stays is read where it stands and is not repeated here.
  const spoken = noted.filter(
    (card) => card !== lastNote || props.progress !== undefined || compacting,
  );
  const alertIds = cards
    .filter((card) => noticeRole(card) === "alert")
    .map((card) => noticeCardId(noticeIdPrefix, card));
  // The prompt is described by the status region and by every refusal card
  // that is showing, so a pending refusal is heard again when it takes focus.
  // The prompt belongs to the surface, so the ids are merged into its own.
  useLayoutEffect(() => {
    const prompt = surfaceRef.current?.querySelector<HTMLElement>(".composer-input");
    if (prompt === null || prompt === undefined) return;
    const managed = new Set((prompt.dataset["composerDescribed"] ?? "").split(" "));
    const own = (prompt.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .filter((token) => token !== "" && !managed.has(token));
    const added = [regionId, ...alertIds].filter((id) => !own.includes(id));
    prompt.setAttribute("aria-describedby", [...own, ...added].join(" "));
    prompt.dataset["composerDescribed"] = added.join(" ");
  });
  const noticeCard = (
    <ComposerNoticeCard idPrefix={noticeIdPrefix} notices={cards}>
      {notice}
    </ComposerNoticeCard>
  );
  // The pill holds what acts on the message being written and nothing else:
  // attach, the prompt, the microphone and send. With the model, the access
  // level and the context ring in a toolbar inside it, it was a third taller
  // than its prompt and read as a form; those describe the thread, so they
  // stand on the page under the pill with the thread's other facts.
  const message = (
    <>
      {props.queue}
      {props.chips}
      <div className="composer-field">
        {props.row.attach === undefined ? null : (
          <div className="composer-field__attach">{props.row.attach}</div>
        )}
        <div className="composer-field__prompt">
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
        </div>
        <ComposerSendCell
          actions={props.row.actions}
          compactingNoteId={compacting ? compactingNoteId : undefined}
          dictate={props.row.dictate}
        />
      </div>
      {props.typeahead}
    </>
  );
  // Every child keeps its place whether or not the thread is held: only what
  // is drawn in each place changes, so the info panel is never remounted.
  const { held } = props;
  const trailingClassName =
    props.row.actions.kind === "send-or-stop"
      ? `composer-actions ${props.row.actions.cellClassName}`
      : "composer-actions";
  // One line under the pill, in reading order: where the thread runs, the
  // surface's own row (what the thread may do leading, the model and then the
  // context ring trailing), the plan's windows, and the thread's info. The
  // ring ends the run: it is the one figure there, and at the end it does not
  // shift when the model's name changes length. Only the
  // surface's controls are inside `.composer-row`: the row restyles every
  // control in it to one quiet treatment, which the info panel's fields and
  // the checkout's actions must not take.
  const under = (
    <div className="composer-under">
      {held || !followUp || props.context === undefined ? null : (
        <div className="thread-composer__context">{props.context}</div>
      )}
      {held ? null : (
        <div
          {...(props.row.ariaLabel === undefined ? {} : { "aria-label": props.row.ariaLabel })}
          className={
            props.row.className === undefined
              ? "composer-row"
              : `composer-row ${props.row.className}`
          }
          {...(props.row.toolbar === true ? { role: "toolbar" } : {})}
        >
          {props.row.leading}
          {followUp ? <ComposerOutsideContentChip busy={props.threadBusy === true} /> : null}
          <div className={trailingClassName}>
            {props.row.trailing}
            <ComposerContextMeter />
          </div>
        </div>
      )}
      {held || !followUp ? null : <ThreadPlanWindows />}
      {followUp ? props.info : null}
    </div>
  );
  // Suggested tasks stand above the composer, as the last thing in the
  // thread; inside the surface they made the box read as one tall composer.
  // The stats line stands under the composer, where a person reads the last
  // turn's figures after sending.
  //
  // The frame groups the start row, the pill and the line under it, and
  // draws nothing: the pill is the one raised thing and the rows are quiet
  // lines on the page. A held thread has no pill; the frame stays in the tree
  // so the info panel in the line is never remounted.
  const body = (
    <>
      {held ? null : <ComposerFollowUpSuggestions />}
      <div className={held ? "composer-frame composer-frame--held" : "composer-frame"}>
        {held ? null : startRow}
        {held ? null : (
          <div
            aria-live="polite"
            className="composer-progress"
            id={regionId}
            role="status"
            {...(progress?.label === undefined ? {} : { "aria-label": progress.label })}
          >
            {progress === undefined ? null : (
              <span
                className={progress.quiet === true ? "sr-only" : "composer-progress__line"}
                {...(compacting ? { id: compactingNoteId } : {})}
                title={progress.text}
              >
                {progress.text}
              </span>
            )}
            <span className="sr-only">
              {props.description}
              {spoken.map((card) => (
                <Fragment key={card.key}> {card.text}</Fragment>
              ))}
            </span>
          </div>
        )}
        {held ? null : noticeCard}
        {held ? null : (
          <div className="thread-composer__surface" ref={surfaceRef}>
            {dropActive ? <ComposerThreadDropCue /> : null}
            {message}
          </div>
        )}
        {under}
      </div>
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
        {held ? null : <ComposerSubagents />}
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
        {held ? null : <ComposerSubagents />}
        {body}
      </section>
    );
  return <ComposerNoticeSinkProvider set={publish}>{frame}</ComposerNoticeSinkProvider>;
}

function ComposerThreadDropCue() {
  return (
    <div aria-hidden="true" className="composer-thread-drop-cue">
      <span>Attach as context</span>
    </div>
  );
}

/**
 * Send is a quiet raised tile until there is something to send, then the
 * primary action: the accent as a gradient with a glow under it. Filled with
 * the accent at every moment, it was the loudest thing on the page under an
 * empty prompt.
 */
function sendVariant(refused: boolean): "secondary" | "default" {
  return refused ? "secondary" : "default";
}

/**
 * A refused send keeps its quiet fill at full strength and dims only the
 * arrow: the blanket disabled opacity left the circle at 1.07:1 on the page,
 * so the pill no longer showed where send is.
 */
const SEND_REFUSED_PAINT = "disabled:opacity-100 disabled:[&_svg]:opacity-50";

function sendRefused(send: ThreadComposerSend, compactingNoteId: string | undefined): boolean {
  return (
    compactingNoteId !== undefined || send.disabled === true || send.disabledReason !== undefined
  );
}

/**
 * The pill's trailing edge: the microphone, then Send, and Stop while a
 * response streams.
 */
function ComposerSendCell(props: {
  readonly actions: ThreadComposerActions;
  /** Set while the session compacts: send is held, and this note says why. */
  readonly compactingNoteId: string | undefined;
  readonly dictate: ReactNode;
}) {
  const refused = sendRefused(props.actions.send, props.compactingNoteId);
  if (props.actions.kind === "send") {
    const { send } = props.actions;
    return (
      <div className="composer-field__actions">
        {props.dictate}
        <OctantButton
          aria-describedby={props.compactingNoteId}
          aria-label={send.ariaLabel}
          className={SEND_REFUSED_PAINT}
          disabled={refused}
          {...(send.onSend === undefined ? {} : { onClick: send.onSend })}
          size="icon"
          type={send.onSend === undefined ? "submit" : "button"}
          variant={sendVariant(refused)}
        >
          <ArrowUp aria-hidden="true" size={16} strokeWidth={2} />
        </OctantButton>
      </div>
    );
  }
  const { sending, send, stop } = props.actions;
  return (
    <div className="composer-field__actions">
      {props.dictate}
      {sending && stop.forceStop !== undefined ? (
        <OctantButton
          onClick={stop.forceStop.onForceStop}
          size="sm"
          title="Kill this response's process. Use it when Stop did not end the response."
          type="button"
          variant="secondary"
        >
          Force stop
        </OctantButton>
      ) : null}
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
        className={SEND_REFUSED_PAINT}
        disabled={refused}
        {...(send.onSend === undefined ? {} : { onClick: send.onSend })}
        size="icon"
        type="button"
        variant={sendVariant(refused)}
      >
        <ArrowUp aria-hidden="true" size={16} strokeWidth={2} />
      </OctantButton>
    </div>
  );
}
