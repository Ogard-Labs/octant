// Which threads a move holds on this host: frozen while they leave it, or
// arriving and not yet committed. Every mode's service checks this before it
// lets a held thread change, so at most one copy can change at a time.

import type { MovedThreadReference } from "@octant/contracts";

/** Why a command on a thread held by a move is refused. */
export const THREAD_MOVING_REFUSAL =
  "This thread is moving between your computers and cannot change until the move finishes.";

/** Which threads a move holds on this host, frozen or arriving. */
export interface ThreadMoveHolds {
  readonly hold: (thread: MovedThreadReference) => void;
  readonly release: (thread: MovedThreadReference) => void;
  readonly isHeld: (thread: MovedThreadReference) => boolean;
}

export function createThreadMoveHolds(
  initial: ReadonlyArray<MovedThreadReference> = [],
): ThreadMoveHolds {
  const key = (thread: MovedThreadReference) => `${thread.mode}:${thread.threadId}`;
  const held = new Set(initial.map(key));
  return {
    hold: (thread) => {
      held.add(key(thread));
    },
    release: (thread) => {
      held.delete(key(thread));
    },
    isHeld: (thread) => held.has(key(thread)),
  };
}
