import type { TurnLoopNotice, TurnStallNotice } from "@octant/contracts";
import { turnLoopNoticeSentence, turnStallNoticeSentence } from "@octant/domain";
import { OctantButton } from "../ui/base/OctantButton";
import "./turn-loop-stall-notice.css";

export interface TurnLoopStallNoticeProps {
  readonly loopNotice?: TurnLoopNotice;
  readonly stallNotice?: TurnStallNotice;
  readonly running: boolean;
  readonly stopping?: boolean;
  readonly onStop?: () => void;
}

/**
 * Quiet thread lines for loop notices (or Strict loop stops) and silent-turn
 * stall notices outside Strict. Offers an inline Stop button while the turn
 * is still running and omits it once the turn settles.
 */
export function TurnLoopStallNotice(props: TurnLoopStallNoticeProps) {
  const { loopNotice, stallNotice, running, stopping, onStop } = props;
  if (loopNotice === undefined && stallNotice === undefined) return null;

  return (
    <>
      {loopNotice === undefined ? null : (
        <p className="turn-loop-stall-notice" role="note">
          <span>{turnLoopNoticeSentence(loopNotice)}</span>
          {running && loopNotice.kind === "turn-loop-noticed" && onStop !== undefined ? (
            <OctantButton
              className="turn-loop-stall-notice__stop"
              disabled={stopping === true}
              onClick={onStop}
              type="button"
              variant="bare"
            >
              Stop
            </OctantButton>
          ) : null}
        </p>
      )}
      {stallNotice === undefined ? null : (
        <p className="turn-loop-stall-notice" role="note">
          <span>{turnStallNoticeSentence(stallNotice)}</span>
          {running && onStop !== undefined ? (
            <OctantButton
              className="turn-loop-stall-notice__stop"
              disabled={stopping === true}
              onClick={onStop}
              type="button"
              variant="bare"
            >
              Stop
            </OctantButton>
          ) : null}
        </p>
      )}
    </>
  );
}
