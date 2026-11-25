import { cleanedUpWorktreeSentence, type CleanedUpWorktreeStanding } from "@octant/domain";
import { OctantButton } from "../ui/base/OctantButton";
import type { ComposerNoticeItem } from "./ComposerNotice";

/**
 * Above a Code thread's composer while the host has removed the thread's
 * worktree folder: it says so, says the branch and thread are kept, and offers
 * **Restore worktree**. Sending is held meanwhile, since the thread takes no
 * turn without its folder. A device that may not restore gets the sentence and
 * no button.
 */
export function cleanedUpWorktreeNotice(input: {
  readonly standing: CleanedUpWorktreeStanding | undefined;
  readonly busy?: boolean;
  /** Absent where this window or device may not restore the worktree. */
  readonly onRestore: (() => void) | undefined;
}): ComposerNoticeItem | undefined {
  if (input.standing === undefined) return undefined;
  return {
    key: "worktree-cleaned-up",
    tone: "neutral",
    text: cleanedUpWorktreeSentence(input.standing),
    ...(input.onRestore === undefined
      ? {}
      : {
          action: (
            <OctantButton
              disabled={input.busy === true}
              onClick={input.onRestore}
              size="sm"
              type="button"
            >
              {input.busy === true ? "Restoring…" : "Restore worktree"}
            </OctantButton>
          ),
        }),
  };
}
