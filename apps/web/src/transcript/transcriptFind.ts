/**
 * In-thread find over the rows a transcript has mounted. The caller mounts
 * every row first (see `TranscriptWindow`), so a match is never off-window.
 */

/** The DOM `Range`, named apart from the virtualizer's own `Range`. */
export type TextMatch = ReturnType<Document["createRange"]>;

/** Phrasing elements: text on either side of one reads as a single run. */
const INLINE_TAGS = new Set([
  "a",
  "abbr",
  "b",
  "bdi",
  "bdo",
  "cite",
  "code",
  "data",
  "del",
  "dfn",
  "em",
  "i",
  "ins",
  "kbd",
  "mark",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "time",
  "u",
  "var",
]);

interface Piece {
  readonly node: Text;
  readonly start: number;
}

/**
 * Text ranges matching `query` (case-insensitive, non-overlapping) in document
 * order. A match may cross inline formatting (`The **plan** is`), because the
 * text nodes of one block are searched as a single run; it never crosses a
 * block boundary.
 */
export function findTranscriptMatches(root: HTMLElement, query: string): TextMatch[] {
  const needle = query.toLowerCase();
  if (needle === "") return [];
  const ranges: TextMatch[] = [];
  for (const row of root.querySelectorAll("[data-transcript-row]")) {
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let block: Element | null = null;
    let pieces: Piece[] = [];
    let lowered = "";
    const flush = () => {
      if (pieces.length > 0) matchRun(pieces, lowered, needle, ranges);
      pieces = [];
      lowered = "";
    };
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (!(node instanceof Text) || node.data === "" || isHidden(node)) continue;
      const owner = blockOf(node);
      if (owner !== block) {
        flush();
        block = owner;
      }
      pieces.push({ node, start: lowered.length });
      const folded = node.data.toLowerCase();
      // A few characters change length when lowercased; keep offsets aligned.
      lowered += folded.length === node.data.length ? folded : node.data;
    }
    flush();
  }
  return ranges;
}

function blockOf(node: Text): Element | null {
  let element = node.parentElement;
  while (element !== null && INLINE_TAGS.has(element.localName)) element = element.parentElement;
  return element;
}

function matchRun(
  pieces: ReadonlyArray<Piece>,
  lowered: string,
  needle: string,
  ranges: TextMatch[],
): void {
  for (
    let at = lowered.indexOf(needle);
    at !== -1;
    at = lowered.indexOf(needle, at + needle.length)
  ) {
    const first = pieceAt(pieces, at, false);
    const last = pieceAt(pieces, at + needle.length, true);
    if (first === undefined || last === undefined) continue;
    const range = document.createRange();
    range.setStart(first.node, at - first.start);
    range.setEnd(last.node, at + needle.length - last.start);
    ranges.push(range);
  }
}

/** The piece holding `offset`; an end offset belongs to the piece it closes. */
function pieceAt(pieces: ReadonlyArray<Piece>, offset: number, isEnd: boolean): Piece | undefined {
  for (let index = pieces.length - 1; index >= 0; index -= 1) {
    const piece = pieces[index];
    if (piece === undefined) continue;
    if (isEnd ? offset > piece.start : offset >= piece.start) return piece;
  }
  return undefined;
}

/** Text inside a closed disclosure (other than its summary) is not on screen. */
function isHidden(node: Text): boolean {
  const parent = node.parentElement;
  if (parent === null) return true;
  if (parent.closest("[hidden], .sr-only") !== null) return true;
  const details = parent.closest("details");
  if (details === null || details.open) return false;
  const summary = parent.closest("summary");
  return summary === null || summary.parentElement !== details;
}

const ALL = "transcript-find";
const CURRENT = "transcript-find-current";

/** Paints matches with the CSS Custom Highlight API; a host without it shows none. */
export function paintTranscriptMatches(ranges: ReadonlyArray<TextMatch>, current: number): void {
  if (
    typeof CSS === "undefined" ||
    CSS.highlights === undefined ||
    typeof Highlight === "undefined"
  ) {
    return;
  }
  CSS.highlights.set(ALL, new Highlight(...ranges.filter((_, index) => index !== current)));
  const active = ranges[current];
  if (active === undefined) CSS.highlights.delete(CURRENT);
  else CSS.highlights.set(CURRENT, new Highlight(active));
}

export function clearTranscriptMatches(): void {
  if (typeof CSS === "undefined" || CSS.highlights === undefined) return;
  CSS.highlights.delete(ALL);
  CSS.highlights.delete(CURRENT);
}

export function revealTranscriptMatch(range: TextMatch | undefined): void {
  const target = range?.startContainer.parentElement;
  target?.scrollIntoView?.({ block: "center" });
}
