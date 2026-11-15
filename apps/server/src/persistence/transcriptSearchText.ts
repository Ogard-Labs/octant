import { MAX_CHAT_TRANSCRIPT_SEARCH_SNIPPET_LENGTH } from "@octant/contracts";

/**
 * Text rules every mode's message search shares, so a needle matches, is
 * escaped, and is clipped the same way in Chat, Work, and Code.
 */
export function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase();
}

/** Escape LIKE metacharacters so a user needle cannot widen into every row. */
export function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Clip a body around the first case-insensitive hit so the overlay can show
 * context without shipping the whole message.
 */
export function clipTranscriptSearchSnippet(
  body: string,
  needle: string,
  maxLength: number = MAX_CHAT_TRANSCRIPT_SEARCH_SNIPPET_LENGTH,
): {
  readonly snippet: string;
  readonly matchRanges: ReadonlyArray<{ readonly start: number; readonly end: number }>;
} {
  if (maxLength <= 0) return { snippet: "", matchRanges: [] };
  const haystack = body.toLocaleLowerCase();
  const normalizedNeedle = needle.trim().toLocaleLowerCase();
  if (normalizedNeedle.length === 0) {
    return { snippet: body.slice(0, maxLength), matchRanges: [] };
  }
  const index = haystack.indexOf(normalizedNeedle);
  if (index < 0) {
    return { snippet: body.slice(0, maxLength), matchRanges: [] };
  }
  const matchLength = Math.min(normalizedNeedle.length, maxLength);
  const pad = Math.max(0, Math.floor((maxLength - matchLength) / 2));
  let start = Math.max(0, index - pad);
  let end = Math.min(body.length, start + maxLength);
  if (end - start < maxLength) {
    start = Math.max(0, end - maxLength);
  }
  const snippet = body.slice(start, end);
  const matchStart = index - start;
  if (matchStart < 0 || matchStart >= snippet.length) {
    return { snippet, matchRanges: [] };
  }
  const matchEnd = Math.min(snippet.length, matchStart + matchLength);
  if (matchEnd <= matchStart) return { snippet, matchRanges: [] };
  return { snippet, matchRanges: [{ start: matchStart, end: matchEnd }] };
}

/** A search names at most this many words or quoted phrases; later ones are ignored. */
export const MAX_SEARCH_TERMS = 8;

/**
 * The words a search must all find, in any order. Text in double quotes is one
 * phrase that must appear as written; an unclosed quote runs to the end.
 * Matching ignores case, and repeated terms count once.
 */
export function parseSearchTerms(query: string): ReadonlyArray<string> {
  const terms: string[] = [];
  const pattern = /"([^"]*)"?|(\S+)/g;
  for (const match of query.matchAll(pattern)) {
    const raw = match[1] ?? match[2] ?? "";
    const term = raw.replace(/\s+/g, " ").trim().toLowerCase();
    if (term.length === 0 || terms.includes(term)) continue;
    terms.push(term);
    if (terms.length === MAX_SEARCH_TERMS) break;
  }
  return terms;
}

/**
 * Clip a body around the first place any term appears, and mark every place a
 * term appears inside the clip, so a several-word search shows each word lit.
 */
export function clipSearchSnippet(
  body: string,
  terms: ReadonlyArray<string>,
  maxLength: number = MAX_CHAT_TRANSCRIPT_SEARCH_SNIPPET_LENGTH,
  maxRanges = 8,
): {
  readonly snippet: string;
  readonly matchRanges: ReadonlyArray<{ readonly start: number; readonly end: number }>;
} {
  const haystack = body.toLocaleLowerCase();
  let first = -1;
  let firstTerm = "";
  for (const term of terms) {
    const index = haystack.indexOf(term);
    if (index >= 0 && (first < 0 || index < first)) {
      first = index;
      firstTerm = term;
    }
  }
  if (first < 0) return clipTranscriptSearchSnippet(body, "", maxLength);
  if (maxLength <= 0) return { snippet: "", matchRanges: [] };
  // The same window clipTranscriptSearchSnippet takes, centred on the first hit.
  const pad = Math.max(0, Math.floor((maxLength - Math.min(firstTerm.length, maxLength)) / 2));
  let start = Math.max(0, first - pad);
  const end = Math.min(body.length, start + maxLength);
  if (end - start < maxLength) start = Math.max(0, end - maxLength);
  const snippet = body.slice(start, end);
  const window = haystack.slice(start, end);
  const ranges: Array<{ start: number; end: number }> = [];
  for (const term of terms) {
    let at = window.indexOf(term);
    while (at >= 0) {
      ranges.push({ start: at, end: Math.min(window.length, at + term.length) });
      at = window.indexOf(term, at + Math.max(1, term.length));
    }
  }
  ranges.sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last !== undefined && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return { snippet, matchRanges: merged.slice(0, maxRanges) };
}
