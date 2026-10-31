/**
 * In-thread find over the rows a transcript has mounted. The caller mounts
 * every row first (see `TranscriptWindow`), so a match is never off-window.
 */

/** Text ranges matching `query` (case-insensitive, non-overlapping) in document order. */
/** The DOM `Range`, named apart from the virtualizer's own `Range`. */
export type TextMatch = ReturnType<Document["createRange"]>;

export function findTranscriptMatches(root: HTMLElement, query: string): TextMatch[] {
  const needle = query.toLowerCase();
  if (needle === "") return [];
  const ranges: TextMatch[] = [];
  for (const row of root.querySelectorAll("[data-transcript-row]")) {
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (!(node instanceof Text) || isHidden(node)) continue;
      const text = node.data;
      const lowered = text.toLowerCase();
      // A few characters change length when lowercased; offsets would drift.
      if (lowered.length !== text.length) continue;
      for (
        let at = lowered.indexOf(needle);
        at !== -1;
        at = lowered.indexOf(needle, at + needle.length)
      ) {
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + needle.length);
        ranges.push(range);
      }
    }
  }
  return ranges;
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
