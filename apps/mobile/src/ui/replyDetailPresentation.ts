import type { ReplyDetailLevel } from "@octant/contracts";
import { replyDetailOpening, thinkingPreviewLine } from "@octant/domain/reply-detail-policy";

/**
 * How the phone draws one reply at a Reply detail level, the same rules the
 * desktop transcript follows: a settled run of tool calls folds behind
 * "N tool calls", and each finished call's detail folds inside it.
 */
export interface MobileReplyDetailPresentation {
  /** Whether a reasoning panel starts open. */
  readonly reasoningExpanded: boolean;
  /** The first line beside a closed reasoning panel's title, or "" for none. */
  readonly reasoningPreview: string;
  /** Whether a settled run of tool calls starts open rather than behind "N tool calls". */
  readonly toolCallsOpen: boolean;
  /** Whether a finished tool call starts with its summary showing. */
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
    toolCallsOpen: opening.toolCalls,
    toolDetailOpen: opening.toolDetail,
  };
}
