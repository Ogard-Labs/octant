import { Copy, GitBranch, RotateCcw, Square, Volume2 } from "../ui/icons";

import { OctantIconButton } from "../ui/base/OctantButton";
import { useReadAloud } from "../voice/useReadAloud";
import { copyText } from "./TurnActionMenu";
import { turnTimeLabel, turnTimeTitle, type TurnHeaderOutcome } from "./TurnHeader";

const FINISHED_OUTCOMES = new Set<TurnHeaderOutcome>([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
]);

export interface TurnActionsProps {
  readonly outcome: TurnHeaderOutcome;
  /** Whether this is the thread's last reply: its row stays visible at rest. */
  readonly latest: boolean;
  /** When the turn last changed, ISO 8601. */
  readonly at?: string | undefined;
  readonly copyValue?: string | undefined;
  /** Runs the attempt again; offered only when the host exposes the command. */
  readonly onRegenerate?: (() => void) | undefined;
  readonly onFork?: (() => void) | undefined;
  readonly forkDisabled?: boolean | undefined;
}

/**
 * The one action row at the end of a finished agent reply, the same in Chat,
 * Work and Code: copy, fork from here, read aloud where voice is available,
 * run again where the host supports it, and the time. The row always occupies
 * its 28px, so showing it on hover moves nothing; the thread's last reply
 * keeps it visible at rest. A reply still working has no row.
 */
export function TurnActions(props: TurnActionsProps) {
  const readAloud = useReadAloud();
  if (!FINISHED_OUTCOMES.has(props.outcome)) return null;
  const label = turnTimeLabel(props.at);
  const text = props.copyValue ?? "";
  return (
    <div className="turn-actions" data-latest={props.latest ? "true" : "false"}>
      {text.length === 0 ? null : (
        <OctantIconButton
          label="Copy message"
          onClick={() => void copyText(text)}
          size="icon-sm"
          variant="ghost"
        >
          <Copy aria-hidden="true" size={14} />
        </OctantIconButton>
      )}
      {props.onFork === undefined ? null : (
        <OctantIconButton
          disabled={props.forkDisabled}
          label="Fork from here"
          onClick={props.onFork}
          size="icon-sm"
          variant="ghost"
        >
          <GitBranch aria-hidden="true" size={14} />
        </OctantIconButton>
      )}
      {text.length === 0 || readAloud.voice === "none" ? null : readAloud.speaking ? (
        <OctantIconButton
          label="Stop reading"
          onClick={readAloud.stop}
          size="icon-sm"
          variant="ghost"
        >
          <Square aria-hidden="true" fill="currentColor" size={12} />
        </OctantIconButton>
      ) : (
        <OctantIconButton
          label="Read aloud"
          onClick={() => void readAloud.speak(text)}
          size="icon-sm"
          variant="ghost"
        >
          <Volume2 aria-hidden="true" size={14} />
        </OctantIconButton>
      )}
      {props.onRegenerate === undefined ? null : (
        <OctantIconButton
          label="Regenerate response"
          onClick={props.onRegenerate}
          size="icon-sm"
          variant="ghost"
        >
          <RotateCcw aria-hidden="true" size={14} />
        </OctantIconButton>
      )}
      {label === undefined ? null : (
        <time
          className="oct-activity-line turn-time"
          dateTime={props.at}
          title={turnTimeTitle(props.at)}
        >
          {label}
        </time>
      )}
    </div>
  );
}
