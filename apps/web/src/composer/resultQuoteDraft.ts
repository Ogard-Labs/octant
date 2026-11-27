import type { ResultQuoteTarget } from "../transcript/ResultQuoteScope";
import { QUOTE_HEADER_TAIL } from "./composerQuoteMark";

export interface ResultQuoteSource extends ResultQuoteTarget {
  readonly label: string;
  readonly threadId: string;
}

export interface ResultQuotePlace {
  readonly start: number;
  readonly end: number;
  readonly source: ResultQuoteSource;
}

// Drafts, copies and sends stay plain text. In this window each occurrence
// can still address its own delivery, even when two excerpts are identical.
const drafts = new Map<string, ReadonlyArray<ResultQuotePlace>>();
const LIMIT = 128;

export function resultQuotePlaces(threadId: string | undefined, draft: string) {
  return threadId === undefined || drafts.size === 0 || !draft.includes(QUOTE_HEADER_TAIL)
    ? []
    : (drafts.get(JSON.stringify([threadId, draft])) ?? []);
}

export function rememberResultQuotePlaces(
  threadId: string | undefined,
  draft: string,
  places: ReadonlyArray<ResultQuotePlace>,
): void {
  if (threadId === undefined || !draft.includes(QUOTE_HEADER_TAIL)) return;
  const key = JSON.stringify([threadId, draft]);
  drafts.delete(key);
  if (places.length === 0) return;
  drafts.set(key, places);
  if (drafts.size > LIMIT) {
    const oldest = drafts.keys().next();
    if (!oldest.done) drafts.delete(oldest.value);
  }
}

// The same words can occupy two independently saved drafts. Use the stash
// identity while a draft is out of the composer.
const stashed = new Map<string, ReadonlyArray<ResultQuotePlace>>();

export function stashResultQuotePlaces(id: string, places: ReadonlyArray<ResultQuotePlace>): void {
  if (places.length === 0) return;
  stashed.set(id, places);
  if (stashed.size > LIMIT) {
    const oldest = stashed.keys().next();
    if (!oldest.done) stashed.delete(oldest.value);
  }
}

export function takeStashedResultQuotePlaces(id: string): ReadonlyArray<ResultQuotePlace> {
  const places = stashed.get(id) ?? [];
  stashed.delete(id);
  return places;
}

export function replaceResultQuoteRange(
  places: ReadonlyArray<ResultQuotePlace>,
  start: number,
  end: number,
  insertedLength: number,
): ReadonlyArray<ResultQuotePlace> {
  const shift = insertedLength - (end - start);
  return places.flatMap((place) =>
    place.end <= start
      ? [place]
      : place.start >= end
        ? [{ ...place, start: place.start + shift, end: place.end + shift }]
        : [],
  );
}
