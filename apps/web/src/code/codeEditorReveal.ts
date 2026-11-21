import type { MonacoEditorRange } from "./MonacoEditorAdapter";

/**
 * A place in a file a go-to-definition asked to show, handed to the editor
 * that opens that file. The jump opens the target through the ordinary
 * file-open path, which knows only a path, so the place waits here until an
 * editor for that thread, checkout, and path is ready to take it. A request
 * nobody takes soon is dropped, so a later, unrelated open of the same file
 * does not jump.
 */

const PENDING_REVEAL_MS = 30_000;
/**
 * How many reveals may wait at once. The queue is swept on every request and
 * take, and past the cap its oldest entry is dropped: a reveal is a
 * convenience jump, never work that must not be lost.
 */
const MAX_PENDING_REVEALS = 128;

const pending = new Map<string, { readonly range: MonacoEditorRange; readonly at: number }>();
const listeners = new Map<string, (range: MonacoEditorRange) => void>();

export function codeEditorRevealKey(threadId: string, checkoutId: string, path: string): string {
  return JSON.stringify([threadId, checkoutId, path]);
}

function sweepPending(now: number): void {
  for (const [key, waiting] of pending) {
    if (now - waiting.at > PENDING_REVEAL_MS) pending.delete(key);
  }
}

export function requestCodeEditorReveal(
  key: string,
  range: MonacoEditorRange,
  now = Date.now(),
): void {
  sweepPending(now);
  const listener = listeners.get(key);
  if (listener !== undefined) {
    listener(range);
    return;
  }
  // Reinsert under a known key so the newest request is also the newest
  // entry; at the cap the oldest waiting reveal is the one dropped.
  pending.delete(key);
  if (pending.size >= MAX_PENDING_REVEALS) {
    const oldest = pending.keys().next().value;
    if (oldest !== undefined) pending.delete(oldest);
  }
  pending.set(key, { range, at: now });
}

/** Takes a waiting reveal now and later ones as they come, until released. */
export function takeCodeEditorReveals(
  key: string,
  listener: (range: MonacoEditorRange) => void,
  now = Date.now(),
): () => void {
  sweepPending(now);
  listeners.set(key, listener);
  const waiting = pending.get(key);
  pending.delete(key);
  if (waiting !== undefined && now - waiting.at <= PENDING_REVEAL_MS) listener(waiting.range);
  return () => {
    if (listeners.get(key) === listener) listeners.delete(key);
  };
}
