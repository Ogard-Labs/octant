import type { ContextCompactionExecutor } from "@octant/contracts/context";
import { useId, type RefObject } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import type { ComposerCompaction } from "./composerContextMeterScope";
import {
  compactionResultLine,
  executorDestination,
  executorName,
  refusalLine,
  type CompactionNames,
  type CompactionOffer,
} from "./sessionCompactionPresentation";

/**
 * The secondary Compact session button. A refusal the person can wait out
 * keeps it in place, disabled, with the host's reason; one they cannot is
 * left out (see `compactionOffer`).
 */
export function CompactSessionButton(props: {
  readonly className?: string;
  readonly offer: CompactionOffer;
  readonly onRequest: () => void;
  readonly starting: boolean;
}) {
  const reasonId = useId();
  if (props.offer.kind === "hidden") return null;
  const reason = props.offer.kind === "disabled" ? props.offer.reason : undefined;
  return (
    <>
      {/* Focusable while refused, so the reason reaches keyboard and screen
          reader users as well as the pointer's tooltip. */}
      <OctantButton
        aria-describedby={reason === undefined ? undefined : reasonId}
        className={
          props.className === undefined
            ? "compact-session-button aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            : `compact-session-button aria-disabled:cursor-not-allowed aria-disabled:opacity-50 ${props.className}`
        }
        disabled={reason !== undefined || props.starting}
        focusableWhenDisabled
        onClick={props.onRequest}
        size="sm"
        title={reason}
        type="button"
        variant="secondary"
      >
        Compact session
      </OctantButton>
      {reason === undefined ? null : (
        <span className="sr-only" id={reasonId}>
          {reason}
        </span>
      )}
    </>
  );
}

/**
 * What the latest compaction did, or that one is running. The person's own
 * request, refused or unanswered, reads first while it still applies.
 */
export function compactionStatusText(compaction: ComposerCompaction): string | undefined {
  const { controller, names } = compaction;
  const latest = controller.state?.latestCompaction;
  if (latest?.status === "running") return compactionResultLine(latest, names);
  if (controller.stateUnknown) return STATE_UNKNOWN;
  if (controller.errorMessage !== undefined) return controller.errorMessage;
  if (controller.refusal !== undefined) return refusalLine(controller.refusal);
  return latest === undefined ? undefined : compactionResultLine(latest, names);
}

/**
 * Said once through the meter's live region: a compaction starting, and the
 * outcome of one this window watched. A result that was already there when
 * the thread opened is shown, not announced.
 */
export function compactionAnnouncement(compaction: ComposerCompaction | undefined): string {
  if (compaction === undefined) return "";
  const { controller, names } = compaction;
  const latest = controller.state?.latestCompaction;
  if (latest?.status === "running") return " Compacting session.";
  if (controller.stateUnknown) return ` ${STATE_UNKNOWN}`;
  if (controller.errorMessage !== undefined) return ` ${controller.errorMessage}`;
  if (controller.refusal !== undefined) return ` ${refusalLine(controller.refusal)}`;
  if (latest === undefined || controller.settledId === undefined) return "";
  const id = latest.status === "completed" ? latest.receipt.compactionId : latest.compactionId;
  return String(id) === controller.settledId ? ` ${compactionResultLine(latest, names)}` : "";
}

/** Said once the window stops following a compaction the host no longer reports on. */
const STATE_UNKNOWN =
  "Compaction state unknown: the host stopped answering. It may still be compacting, and refuses a send until it ends.";

export function CompactionStatusLine(props: {
  readonly className: string;
  readonly compaction: ComposerCompaction;
}) {
  const text = compactionStatusText(props.compaction);
  if (text === undefined) return null;
  const running = props.compaction.controller.state?.latestCompaction?.status === "running";
  return (
    <p className={props.className} data-compaction={running ? "running" : "settled"}>
      {text}
    </p>
  );
}

export function CompactSessionConfirm(props: {
  readonly executor: ContextCompactionExecutor;
  readonly names: CompactionNames;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly pending: boolean;
  readonly restoreFocus?: RefObject<HTMLElement | null>;
}) {
  const destination = executorDestination(props.executor, props.names);
  return (
    <OctantConfirmDialog
      confirmLabel="Compact"
      onCancel={props.onCancel}
      onConfirm={props.onConfirm}
      pending={props.pending}
      {...(props.restoreFocus === undefined ? {} : { restoreFocus: props.restoreFocus })}
      title="Compact this session?"
    >
      The earlier conversation is replaced by a summary. From the next message the model sees the
      summary and the most recent messages. The full history stays in this thread. This sends the
      conversation to {destination} and uses tokens.
      {props.executor.kind === "runtime"
        ? ` ${executorName(props.executor, props.names)} writes the summary; Octant can't show it.`
        : null}
    </OctantConfirmDialog>
  );
}
