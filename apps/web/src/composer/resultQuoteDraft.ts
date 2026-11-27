import type { ResultQuoteTarget } from "../transcript/ResultQuoteScope";

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
const drafts = new Map<
  string,
  { readonly text: string; readonly places: ReadonlyArray<ResultQuotePlace> }
>();
const LIMIT = 128;

function keep<Key, Value>(map: Map<Key, Value>, key: Key, value: Value): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > LIMIT) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
}

export function resultQuotePlaces(threadId: string | undefined, text: string) {
  const draft = threadId === undefined ? undefined : drafts.get(threadId);
  return draft?.text === text ? draft.places : [];
}

export function rememberResultQuotePlaces(
  threadId: string | undefined,
  text: string,
  places: ReadonlyArray<ResultQuotePlace>,
): void {
  if (threadId === undefined) return;
  if (places.length === 0) drafts.delete(threadId);
  else keep(drafts, threadId, { text, places });
}

/** Note and editor inserts preserve the draft through its last nonblank character. */
export function appendToResultQuoteDraft(threadId: string, before: string, after: string): string {
  rememberResultQuotePlaces(threadId, after, resultQuotePlaces(threadId, before));
  return after;
}

const sent = new Map<
  string,
  { readonly text: string; readonly places: ReadonlyArray<ResultQuotePlace> }
>();

export function rememberSentResultQuotes(
  threadId: string,
  id: string,
  draft: string,
  places: ReadonlyArray<ResultQuotePlace>,
): void {
  if (places.length === 0) return;
  const start = draft.length - draft.trimStart().length;
  keep(sent, `${threadId}:${id}`, {
    text: draft.trim(),
    places: shiftResultQuotePlaces(places, -start),
  });
}

export function sentResultQuotes(threadId: string, id: string | undefined, text: string) {
  const message = id === undefined ? undefined : sent.get(`${threadId}:${id}`);
  return message?.text === text ? message.places : [];
}

/**
 * The workspace owns quote positions. Its controller reports the accepted
 * identity or that it restored the trimmed draft after a failed submission.
 */
export function observeResultQuoteSend(threadId: string, draft: string) {
  const places = resultQuotePlaces(threadId, draft);
  if (places.length === 0) return undefined;
  return (messageId: string | null, submitted: string) => {
    if (draft.trim() !== submitted) return;
    if (messageId !== null) {
      rememberSentResultQuotes(threadId, messageId, draft, places);
      return;
    }
    const lead = draft.length - draft.trimStart().length;
    rememberResultQuotePlaces(threadId, submitted, shiftResultQuotePlaces(places, -lead));
  };
}

export function shiftResultQuotePlaces(places: ReadonlyArray<ResultQuotePlace>, offset: number) {
  return places.map((place) => ({
    ...place,
    start: place.start + offset,
    end: place.end + offset,
  }));
}

// The same words can occupy two independently saved drafts. Use the stash
// identity while a draft is out of the composer.
const stashed = new Map<string, ReadonlyArray<ResultQuotePlace>>();

export function stashResultQuotePlaces(id: string, places: ReadonlyArray<ResultQuotePlace>): void {
  if (places.length === 0) return;
  keep(stashed, id, places);
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
