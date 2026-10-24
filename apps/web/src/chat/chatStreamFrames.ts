import type { ChatEventFrame, ChatThreadView } from "@octant/contracts/chat";

/**
 * Grow the thread view in place from a streamed `attempt-updated` or
 * `attempt-response-appended` frame.
 *
 * Returns `undefined` when the frame cannot be applied without the host, and
 * the caller re-reads the thread instead: the attempt has settled, so its
 * turn may carry facts the frame does not; its turn or attempt is not in the
 * view; or a response body is missing, which happens when a frame was dropped
 * or the host did not put the body on the frame. Re-reading was the cost of
 * every frame before frames carried the body their delta appended.
 */
export function applyChatAttemptFrame(
  view: ChatThreadView | undefined,
  frame: ChatEventFrame,
): ChatThreadView | undefined {
  if (view === undefined) return undefined;
  if (String(view.thread.id) !== String(frame.threadId)) return undefined;
  const event = frame.event;

  if (event.kind === "attempt-response-appended") {
    const turnIndex = view.turns.findIndex((turn) => String(turn.id) === String(event.turnId));
    const turn = view.turns[turnIndex];
    if (turn === undefined) return undefined;
    const attemptIndex = turn.attempts.findIndex(
      (candidate) => String(candidate.id) === String(event.attemptId),
    );
    const attempt = turn.attempts[attemptIndex];
    if (attempt === undefined) return undefined;
    if (
      !(frame.contents ?? []).some(
        (content) => String(content.contentId) === String(event.responseRef.contentId),
      )
    ) {
      return undefined;
    }
    // A frame the view already covers is a no-op, judged by sequence and by
    // reference: an attachment upload or discard mid-stream re-reads the thread
    // without moving the stream cursor, so a buffered frame for a reference the
    // refreshed snapshot already holds mid-list arrives afterwards. Checking only
    // the last reference appended it again ([a, b, c] + b -> [a, b, c, b]) and
    // moved lastSequence backwards.
    if (
      frame.sequence <= view.lastSequence ||
      attempt.responseRefs.some(
        (reference) => String(reference.contentId) === String(event.responseRef.contentId),
      )
    ) {
      return view;
    }
    const attempts = turn.attempts.slice();
    attempts[attemptIndex] = {
      ...attempt,
      responseRefs: [...attempt.responseRefs, event.responseRef],
      updatedAt: event.updatedAt,
    };
    const turns = view.turns.slice();
    turns[turnIndex] = { ...turn, attempts };
    const known = new Set(view.contents.map((content) => String(content.contentId)));
    const added = (frame.contents ?? []).filter((content) => !known.has(String(content.contentId)));
    return {
      ...view,
      turns,
      contents: added.length === 0 ? view.contents : [...view.contents, ...added],
      lastSequence: frame.sequence,
    };
  }

  if (event.kind !== "attempt-updated") return undefined;
  const attempt = event.attempt;
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
