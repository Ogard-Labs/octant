/**
 * Whether this window is showing the guided tour, and whether this
 * installation has been offered it.
 *
 * Like the What's new acknowledgement, the record lives in the window's
 * JavaScript realm so every entry point (the first-start offer and the menu
 * item) reads one answer, and it is persisted best-effort beside it. The
 * persisted value is renderer-local storage, the same kind the host notices
 * use for their dismissals: a store that cannot be read or written never
 * blocks the tour, it only means the offer can come back.
 *
 * `due` is written while first-run setup is still unanswered, so only an
 * installation that really started fresh is offered the tour; a person who
 * finished setup before the tour existed has no value and is never offered it.
 */
export const GUIDED_TOUR_STORAGE_KEY = "octant.guidedTour.v1";

export type GuidedTourRecord = "due" | "seen";

let open = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function readGuidedTourRecord(): GuidedTourRecord | undefined {
  try {
    const value = globalThis.localStorage?.getItem(GUIDED_TOUR_STORAGE_KEY);
    return value === "due" || value === "seen" ? value : undefined;
  } catch {
    return undefined;
  }
}

function writeGuidedTourRecord(record: GuidedTourRecord): void {
  try {
    globalThis.localStorage?.setItem(GUIDED_TOUR_STORAGE_KEY, record);
  } catch {
    // Without storage the offer can return on the next start, which is harmless.
  }
}

/** First-run setup is unanswered: the tour is owed once it is answered. */
export function markGuidedTourDue(): void {
  if (readGuidedTourRecord() === undefined) writeGuidedTourRecord("due");
}

export function isGuidedTourOpen(): boolean {
  return open;
}

/** Showing the tour, from the offer or the menu, is what makes it seen. */
export function openGuidedTour(): void {
  writeGuidedTourRecord("seen");
  if (open) return;
  open = true;
  emit();
}

export function closeGuidedTour(): void {
  if (!open) return;
  open = false;
  emit();
}

export function subscribeGuidedTour(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** For tests: a fresh window has no tour showing. */
export function resetGuidedTour(): void {
  open = false;
  emit();
}
