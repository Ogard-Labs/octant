import type { OctantMode } from "@octant/contracts/modes";
import type { ReplyDetailThread } from "@octant/domain/reply-detail-policy";

/**
 * The thread the Reply detail shortcut and the palette's thread commands act
 * on: the active pane's thread of the active mode, and only while it is on
 * screen. Settings, Usage, Review, Zen, and the other pages that cover the
 * workspace keep its active thread ids, so without `covered` the chord would
 * change a thread the person cannot see.
 */
export function replyDetailThreadInFront(input: {
  readonly activeMode: OctantMode;
  readonly chatThreadId: string | undefined;
  readonly workThreadId: string | undefined;
  readonly codeThreadId: string | undefined;
  readonly covered: boolean;
}): ReplyDetailThread | undefined {
  if (input.covered) return undefined;
  const threadId =
    input.activeMode === "chat"
      ? input.chatThreadId
      : input.activeMode === "work"
        ? input.workThreadId
        : input.codeThreadId;
  return threadId === undefined ? undefined : { mode: input.activeMode, threadId };
}
