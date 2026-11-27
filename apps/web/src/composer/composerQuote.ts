import {
  rememberResultQuotePlaces,
  replaceResultQuoteRange,
  resultQuotePlaces,
  type ResultQuotePlace,
  type ResultQuoteSource,
} from "./resultQuoteDraft";
import {
  COMPOSER_QUOTE_CLIPBOARD_TYPE,
  composerQuoteToolsLoaded,
  QUOTE_HEADER_TAIL,
  REPLY_QUOTE_SOURCE,
  TERMINAL_QUOTE_SOURCE,
} from "./composerQuoteMark";

/**
 * A quote in the composer: words taken from a reply, a terminal, or a file,
 * with the person's optional note on them. A quote lives in the prompt as its
 * own text, so the draft stays plain text and the host never sees a quote
 * type; the text is what is sent.
 *
 * Only a quote Octant wrote shows as a chip: one added by Add to chat (or a
 * terminal or editor selection), a note saved from the chip, or one copied out
 * of a composer and pasted with Octant's clipboard mark. Text that merely has
 * a quote's shape (an agent's reply pasted in, say) stays plain, visible text,
 * so a note inside it can never hide behind a chip as the person's own words.
 *
 * The text frames the quoted words as reference, not instructions, and fences
 * them so nothing inside can pass for the person's own request. The note
 * follows the fence on a line that says it is the person's.
 */
export interface ComposerQuote {
  /** Where the words came from, as the model reads it ("the terminal"). */
  readonly source: string;
  readonly text: string;
  /** The person's own note on the quote; empty for none. */
  readonly comment: string;
}

export interface ComposerQuotePlace extends ComposerQuote {
  readonly start: number;
  readonly end: number;
  /** The quote's whole text as the prompt holds it. */
  readonly chipText: string;
}

const HEADER_TAIL = QUOTE_HEADER_TAIL;
const NOTE_LEAD = "My note on this quote: ";
const SOURCE_LIMIT = 200;

export { COMPOSER_QUOTE_CLIPBOARD_TYPE, REPLY_QUOTE_SOURCE, TERMINAL_QUOTE_SOURCE };

function escapeForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A closing fence ends its line, so words glued to one never read as the end
// of a quote. The header may follow other words on its line: the person can
// type right before a chip, and the prompt puts the quote back on lines of
// its own (`separateComposerQuotes`).
const QUOTE_PATTERN = new RegExp(
  `Quoted from ([^\\n]+?)${escapeForPattern(HEADER_TAIL)}\\n(\`{3,})\\n([\\s\\S]*?)\\n\\2(?:\\n${escapeForPattern(NOTE_LEAD)}("(?:[^"\\\\\\n]|\\\\.)*"))?(?=\\n|$)`,
  "g",
);

/**
 * Quote texts Octant wrote in this window. A text only counts as a quote when
 * it is exactly one of these, so the shape alone grants nothing. Kept in
 * memory: after a reload a quote reads as the plain text it is.
 */
const QUOTES_WRITTEN_LIMIT = 512;
const quotesWritten = new Set<string>();

function rememberQuoteText(text: string): void {
  quotesWritten.delete(text);
  quotesWritten.add(text);
  while (quotesWritten.size > QUOTES_WRITTEN_LIMIT) {
    const oldest = quotesWritten.values().next();
    if (oldest.done === true) break;
    quotesWritten.delete(oldest.value);
  }
}

/**
 * Marks quote texts a composer copied (carried by Octant's clipboard type) as
 * Octant's own again, and answers the ones that are whole quotes. Anything
 * else under that type (another app's data, an empty string) is not a quote.
 */
export function trustComposerQuotes(texts: ReadonlyArray<string>): ReadonlyArray<string> {
  const trusted = texts.filter((text) =>
    findQuoteShapes(text).some((place) => place.chipText === text),
  );
  for (const text of trusted) rememberQuoteText(text);
  return trusted;
}

function readNote(written: string | undefined): string {
  if (written === undefined) return "";
  try {
    const note: unknown = JSON.parse(written);
    return typeof note === "string" ? note : "";
  } catch {
    return "";
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** A file selection's source: its path and the lines it spans. */
export function fileQuoteSource(path: string, startLine: number, endLine: number): string {
  const lines =
    startLine === endLine
      ? `line ${String(startLine)}`
      : `lines ${String(startLine)}–${String(endLine)}`;
  return `${path}, ${lines}`;
}

/**
 * The quote as the prompt holds it. The fence outruns the longest backtick run
 * in the words, because a fixed one closes on any output that prints a fence of
 * its own, and everything after it would read as the person's request. The
 * words keep their trailing whitespace: an editor's replacement replaces the
 * whole selection, line break included, so the model must see all of it.
 */
export function composerQuoteText(quote: ComposerQuote): string {
  const body = quote.text.replace(/\r\n?/g, "\n");
  const longestRun = [...body.matchAll(/`+/g)].reduce(
    (longest, match) => Math.max(longest, match[0].length),
    0,
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  const source = oneLine(quote.source).slice(0, SOURCE_LIMIT) || "the person's selection";
  const comment = oneLine(quote.comment);
  const text = [
    `Quoted from ${source}${HEADER_TAIL}`,
    fence,
    body,
    fence,
    ...(comment === "" ? [] : [`${NOTE_LEAD}${JSON.stringify(comment)}`]),
  ].join("\n");
  rememberQuoteText(text);
  return text;
}

// Drafts made by the first result-quote build contain a reference suffix in
// the attribution. The old window's lookup is gone, so recover only its text.
const LEGACY_RESULT_REFERENCE =
  /^(a subagent result|the .+ subagent \(generation [0-9]+\)) · result reference [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function restoreLegacyResultQuoteText(value: string): string {
  let next = value;
  for (const quote of findQuoteShapes(value).toReversed()) {
    if (!LEGACY_RESULT_REFERENCE.test(quote.source)) continue;
    const sourceStart = quote.start + "Quoted from ".length;
    next =
      next.slice(0, sourceStart) +
      quote.source.replace(LEGACY_RESULT_REFERENCE, "$1") +
      next.slice(sourceStart + quote.source.length);
  }
  return next;
}

/** Every quote Octant wrote in the prompt's text, in order. */
export function findComposerQuotes(value: string): ReadonlyArray<ComposerQuotePlace> {
  return findQuoteShapes(value).filter((place) => quotesWritten.has(place.chipText));
}

/** The quote texts in `value`, for a copy to carry under Octant's clipboard type. */
export function composerQuoteTextsIn(value: string): ReadonlyArray<string> {
  return findComposerQuotes(value).map((place) => place.chipText);
}

function findQuoteShapes(value: string): ReadonlyArray<ComposerQuotePlace> {
  if (!value.includes(HEADER_TAIL)) return [];
  const places: Array<ComposerQuotePlace> = [];
  for (const match of value.matchAll(QUOTE_PATTERN)) {
    places.push({
      start: match.index,
      end: match.index + match[0].length,
      chipText: match[0],
      source: match[1] ?? "",
      text: match[3] ?? "",
      comment: readNote(match[4]),
    });
  }
  return places;
}

/**
 * The prompt with each of the quotes it held before an edit (`held`, their
 * exact texts) on lines of its own, and where the caret lands. Text typed
 * right against a chip would otherwise run into its header or its closing
 * fence, and a fence with words after it no longer closes. The quotes are
 * found by their exact text, since glued words stop the pattern matching.
 */
export function separateComposerQuotes(
  value: string,
  caret: number,
  held: ReadonlyArray<string>,
  places: ReadonlyArray<ResultQuotePlace> = [],
) {
  let next = value;
  let resultQuotes = places;
  let at = caret;
  for (const text of new Set(held)) {
    // An empty text is found everywhere and would never move past itself.
    if (text === "") continue;
    let from = 0;
    for (;;) {
      const start = next.indexOf(text, from);
      if (start < 0) break;
      let end = start + text.length;
      if (end < next.length && next[end] !== "\n") {
        next = `${next.slice(0, end)}\n${next.slice(end)}`;
        resultQuotes = replaceResultQuoteRange(resultQuotes, end, end, 1);
        if (at > end) at += 1;
      }
      if (start > 0 && next[start - 1] !== "\n") {
        next = `${next.slice(0, start)}\n${next.slice(start)}`;
        resultQuotes = replaceResultQuoteRange(resultQuotes, start, start, 1);
        if (at > start) at += 1;
        end += 1;
      }
      from = end;
    }
  }
  return { value: next, caret: at, resultQuotes };
}

const PREVIEW_LIMIT = 40;

/** A quote's first words, on one line, short enough for a chip. */
export function quotePreview(text: string): string {
  const flat = oneLine(text);
  return flat.length <= PREVIEW_LIMIT ? flat : `${flat.slice(0, PREVIEW_LIMIT - 1)}…`;
}

/**
 * The draft with a quote added at its end on a line of its own, and a fresh
 * line after it for the person to continue on.
 */
export function appendComposerQuote(
  draft: string,
  quote: ComposerQuote,
  scope?: { readonly threadId: string; readonly result?: ResultQuoteSource | undefined },
): string {
  const existing = draft.replace(/\s+$/, "");
  const text = composerQuoteText(quote);
  const lead = existing === "" ? "" : `${existing}\n\n`;
  const next = `${lead}${text}\n`;
  if (scope !== undefined) {
    rememberResultQuotePlaces(scope.threadId, next, [
      ...resultQuotePlaces(scope.threadId, draft),
      ...(scope.result === undefined
        ? []
        : [{ start: lead.length, end: lead.length + text.length, source: scope.result }]),
    ]);
  }
  return next;
}

composerQuoteToolsLoaded({
  composerQuoteText,
  appendComposerQuote,
  findComposerQuotes,
  restoreLegacyResultQuoteText,
  composerQuoteTextsIn,
  trustComposerQuotes,
  separateComposerQuotes,
});
