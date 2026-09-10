import type { ChatEventFrame, ChatThreadView } from "@octant/contracts/chat";

/**
 * Grow the thread view in place from a streamed `attempt-updated` frame.
 *
 * Returns `undefined` when the frame cannot be applied without the host, and
 * the caller re-reads the thread instead: the attempt has settled, so its
 * turn may carry facts the frame does not; its turn is not in the view; or a
 * response body is missing, which happens when a frame was dropped or the
 * host did not put the body on the frame. Re-reading was the cost of every
 * frame before frames carried the body their delta appended.
 */
export function applyChatAttemptFrame(
  view: ChatThreadView | undefined,
  frame: ChatEventFrame,
): ChatThreadView | undefined {
  if (view === undefined || frame.event.kind !== "attempt-updated") return undefined;
  if (String(view.thread.id) !== String(frame.threadId)) return undefined;
  const attempt = frame.event.attempt;
  if (attempt.outcome !== "queued" && attempt.outcome !== "streaming") return undefined;
  const turnIndex = view.turns.findIndex((turn) => String(turn.id) === String(attempt.turnId));
  const turn = view.turns[turnIndex];
  if (turn === undefined) return undefined;

  const known = new Set(view.contents.map((content) => String(content.contentId)));
  const added = (frame.contents ?? []).filter((content) => !known.has(String(content.contentId)));
  for (const content of added) known.add(String(content.contentId));
  const references =
    attempt.researchRef === undefined
      ? attempt.responseRefs
      : [...attempt.responseRefs, attempt.researchRef];
  if (references.some((reference) => !known.has(String(reference.contentId)))) return undefined;

  const attemptIndex = turn.attempts.findIndex(
    (candidate) => String(candidate.id) === String(attempt.id),
  );
  const attempts = turn.attempts.slice();
  if (attemptIndex === -1) attempts.push(attempt);
  else attempts[attemptIndex] = attempt;
  const turns = view.turns.slice();
  turns[turnIndex] = { ...turn, attempts };
  return {
    ...view,
    turns,
    contents: added.length === 0 ? view.contents : [...view.contents, ...added],
    lastSequence: frame.sequence,
  };
}
