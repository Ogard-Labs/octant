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
