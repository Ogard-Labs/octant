import { MAX_THREAD_MENTIONS_PER_TURN } from "@octant/contracts";
import { formatThreadMentionChip } from "./threadMentionChipText";

/** One place a mentioned thread's chip stands in a text. */
export interface ThreadMentionTag<T> {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly chip: T;
}

export interface ThreadMentionSpan {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * Every `#[…]` in a text, in text order. A chip's title holds no bracket and no
 * line break, so one pass over the text finds them whatever the text holds.
 */
export function bracketSpans(text: string): ReadonlyArray<ThreadMentionSpan> {
  const spans: ThreadMentionSpan[] = [];
  let open: number | undefined;
  for (let at = 0; at < text.length; at += 1) {
    const character = text[at];
    if (character === "[") open = text[at - 1] === "#" ? at - 1 : undefined;
    else if (character === "\n") open = undefined;
    else if (character === "]" && open !== undefined) {
      spans.push({ start: open, end: at + 1, text: text.slice(open, at + 1) });
      open = undefined;
    }
  }
  return spans;
}

/** Every place one of these chip texts stands, in text order. */
function chipTextSpans(
  text: string,
  chipTexts: ReadonlySet<string>,
): ReadonlyArray<ThreadMentionSpan> {
  return bracketSpans(text).filter((span) => chipTexts.has(span.text));
}

/**
 * Where each chip stands in a text. Two mentioned threads can share a title,
 * and then read alike in the text, so the chips' own order decides which place
 * is whose. Text that repeats a mentioned thread's chip stands for that thread
 * again; text no chip claims stays ordinary text.
 */
export function findThreadMentionTags<T extends { readonly title: string }>(
  text: string,
  chips: ReadonlyArray<T>,
): ReadonlyArray<ThreadMentionTag<T>> {
  if (chips.length === 0) return [];
  const claims = new Map<string, T[]>();
  for (const chip of chips) {
    const chipText = formatThreadMentionChip(chip.title);
    claims.set(chipText, [...(claims.get(chipText) ?? []), chip]);
  }
  const seen = new Map<string, number>();
  return chipTextSpans(text, new Set(claims.keys())).flatMap((span) => {
    const claimants = claims.get(span.text) ?? [];
    const count = seen.get(span.text) ?? 0;
    seen.set(span.text, count + 1);
    const chip = claimants[count] ?? claimants.at(-1);
    return chip === undefined ? [] : [{ ...span, chip }];
  });
}

/**
 * Drop chips whose text the user has since edited out of the draft, and cap the
 * survivors at the per-turn bound. Chips are structured selections, so a chip
 * that no longer appears in the draft must not keep contributing context the
 * user believes they deleted. The survivors come back in draft order.
 *
 * Given the draft before the edit, a chip outside the edited part keeps its
 * own place, so deleting the first of two chips that share a title removes
 * that thread and not the other. Two such chips side by side read alike
 * whichever of them went, so the caret the edit left says where it was made.
 * Given the chips this draft dropped earlier, text that brings one back (an
 * undo, a cut and paste) brings its thread back.
 */
export function reconcileThreadMentionChips<T extends { readonly title: string }>(
  draft: string,
  chips: ReadonlyArray<T>,
  earlier: {
    readonly draft?: string;
    readonly caret?: number;
    readonly dropped?: ReadonlyArray<T>;
  } = {},
): ReadonlyArray<T> {
  const dropped = earlier.dropped ?? [];
  const spans = chipTextSpans(
    draft,
    new Set([...chips, ...dropped].map((chip) => formatThreadMentionChip(chip.title))),
  );
  const placed = new Map<number, T>();
  const used = new Set<T>();
  if (earlier.draft !== undefined && earlier.draft !== draft) {
    const before = earlier.draft;
    const unchanged = unchangedEnds(before, draft, earlier.caret ?? draft.length);
    const placedBefore = new Set<T>();
    for (const tag of findThreadMentionTags(before, chips)) {
      if (placedBefore.has(tag.chip)) continue;
      placedBefore.add(tag.chip);
      const start =
        tag.end <= unchanged.start
          ? tag.start
          : tag.start >= before.length - unchanged.end
            ? tag.start + draft.length - before.length
            : undefined;
      if (start === undefined) continue;
      const span = spans.find((candidate) => candidate.start === start);
      if (span?.text !== tag.text) continue;
      placed.set(start, tag.chip);
      used.add(tag.chip);
    }
  }
  for (const span of spans) {
    if (placed.has(span.start)) continue;
    const chip = [...chips, ...dropped.toReversed()].find(
      (candidate) => !used.has(candidate) && formatThreadMentionChip(candidate.title) === span.text,
    );
    if (chip === undefined) continue;
    placed.set(span.start, chip);
    used.add(chip);
  }
  return spans
    .flatMap((span) => {
      const chip = placed.get(span.start);
      return chip === undefined ? [] : [chip];
    })
    .slice(0, MAX_THREAD_MENTIONS_PER_TURN);
}

/**
 * How many characters an edit left unchanged at the start and at the end of a
 * text. Where the two overlap, what stands after the caret counts as the end.
 */
function unchangedEnds(
  before: string,
  after: string,
  caret: number,
): { readonly start: number; readonly end: number } {
  const limit = Math.min(before.length, after.length);
  const sharedEnd = (from: number, most: number): number => {
    let end = from;
    while (end < most && before[before.length - 1 - end] === after[after.length - 1 - end]) {
      end += 1;
    }
    return end;
  };
  const afterCaret = sharedEnd(0, Math.min(limit, Math.max(0, after.length - caret)));
  let start = 0;
  while (start < limit - afterCaret && before[start] === after[start]) start += 1;
  return { start, end: sharedEnd(afterCaret, limit - start) };
}
