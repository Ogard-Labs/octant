import type { ReplyDetailLevel } from "@octant/contracts";
import { replyDetailOpening, thinkingPreviewLine } from "@octant/domain/reply-detail-policy";

/**
 * How the phone draws one reply at a Reply detail level, the same rules the
 * desktop transcript follows. The phone has no settled "N tool calls" fold:
 * each tool call is its own card, so only a finished card's detail folds.
 */
export interface MobileReplyDetailPresentation {
  /** Whether a reasoning panel starts open. */
  readonly reasoningExpanded: boolean;
  /** The first line beside a closed reasoning panel's title, or "" for none. */
  readonly reasoningPreview: string;
  /** Whether a finished tool card starts with its summary showing. */
  readonly toolDetailOpen: boolean;
}

export function mobileReplyDetailPresentation(
  level: ReplyDetailLevel,
  reasoning: string,
): MobileReplyDetailPresentation {
  const opening = replyDetailOpening(level);
  return {
    reasoningExpanded: opening.thinking,
    reasoningPreview: opening.thinkingPreview ? thinkingPreviewLine(reasoning) : "",
    toolDetailOpen: opening.toolDetail,
  };
}
