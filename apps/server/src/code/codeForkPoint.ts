import type { CodeCheckpoint, CodeConversationTurn } from "@octant/contracts";

/**
 * Which recorded state a fork at `throughOperationId` starts from.
 *
 * The turn after the named one captured the checkout before it touched
 * anything, which is exactly the state the named turn left behind. A Plan turn
 * captures nothing and writes nothing, so the turn after it still holds that
 * state. Any other turn without a capture may have written files nobody
 * recorded, and a fork from a guessed state would be wrong in ways no one can
 * see, so it refuses. When the named turn is the newest, its result is the
 * checkout as it stands now, which the caller captures.
 */
export type CodeForkPointChoice =
  | { readonly kind: "checkpoint"; readonly checkpoint: CodeCheckpoint }
  | { readonly kind: "capture-now" }
  | { readonly kind: "refused"; readonly reason: "not-found" | "not-settled" | "unrecorded" };

export function chooseCodeForkPoint(
  turns: ReadonlyArray<CodeConversationTurn>,
  throughOperationId: string,
): CodeForkPointChoice {
  const named = turns.findIndex((turn) => String(turn.operationId) === throughOperationId);
  if (named === -1) return { kind: "refused", reason: "not-found" };
  if (turns[named]?.status !== "completed") return { kind: "refused", reason: "not-settled" };
  for (const turn of turns.slice(named + 1)) {
    if (turn.checkpoint !== undefined) return { kind: "checkpoint", checkpoint: turn.checkpoint };
    if (turn.executionPolicy !== "plan") return { kind: "refused", reason: "unrecorded" };
  }
  return { kind: "capture-now" };
}
