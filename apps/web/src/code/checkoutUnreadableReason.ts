/**
 * The reason a pane gives when its thread's checkout cannot be read, in words
 * for the person. The host answers a folder it can no longer resolve (moved,
 * renamed, deleted, or no longer granted to this window) with a sentence about
 * its own authority: "Code file authority is unavailable." in Files and "Code
 * checkout authority is unavailable." in Review, two wordings of one cause
 * that named nothing a person could act on. Any other sentence is the host's
 * own account of what failed and is shown as it came.
 */
export function checkoutUnreadableReason(hostMessage: string): string {
  return /\bauthority is unavailable\b/i.test(hostMessage)
    ? "The thread's folder can't be opened. It may have been moved, renamed or deleted, or this window no longer has access to it."
    : hostMessage;
}
