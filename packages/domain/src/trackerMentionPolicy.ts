import {
  MAX_TRACKER_MENTIONS_PER_TURN,
  type TrackerMention,
} from "@octant/contracts/tracker-mention";
import type { TrackerMentionCandidate } from "@octant/contracts/tracker-mention-search";

/** One place a pull request or issue reference stands in a text. */
export interface TrackerMentionSpan {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  /** `#2901` or `ENG-12`. */
  readonly label: string;
  readonly title: string;
  readonly mention: TrackerMention;
}

const REFERENCE =
  /\[(#[1-9]\d{0,8}|[A-Z][A-Z0-9]{0,9}-\d{1,9}) ([^[\]\n]{1,200})\]\((https:\/\/[^\s()]{1,500})\)/g;
const GITHUB_ITEM =
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(pull|issues)\/([1-9]\d{0,8})$/;
const LINEAR_ITEM =
  /^https:\/\/linear\.app\/[A-Za-z0-9_.-]+\/issue\/([A-Z][A-Z0-9]{0,9}-\d{1,9})(?:\/[A-Za-z0-9_.\-%]*)?$/;
const MAX_TITLE = 120;

/**
 * A mentioned pull request or issue is written into the prompt as an ordinary
 * Markdown link, so the provider can follow it without anything being read for
 * it. A title cannot hold a bracket or a line break, so the reference stays one
 * decidable token.
 */
export function formatTrackerMentionReference(input: {
  readonly label: string;
  readonly title: string;
  readonly url: string;
}): string {
  const collapsed = input.title.replace(/[[\]]/g, "").replace(/\s+/g, " ").trim();
  const title = collapsed.length <= MAX_TITLE ? collapsed : `${collapsed.slice(0, MAX_TITLE - 1)}…`;
  return `[${input.label} ${title.length === 0 ? "Untitled" : title}](${input.url})`;
}

/** The item a reference's label and URL both name, or nothing when they disagree. */
function mentionOf(label: string, url: string): TrackerMention | undefined {
  const github = GITHUB_ITEM.exec(url);
  if (github !== null) {
    const id = github[2];
    if (id === undefined || label !== `#${id}`) return undefined;
    const kind = github[1] === "pull" ? "pull-request" : "github-issue";
    return { kind, source: "github", id, url };
  }
  const linear = LINEAR_ITEM.exec(url);
  if (linear === null || linear[1] !== label) return undefined;
  return { kind: "linear-issue", source: "linear", id: label, url };
}

/** Every pull request or issue reference in a text, in text order. */
export function findTrackerMentionSpans(text: string): ReadonlyArray<TrackerMentionSpan> {
  return [...text.matchAll(REFERENCE)].flatMap((match) => {
    const [whole, label, title, url] = match;
    if (label === undefined || title === undefined || url === undefined) return [];
    const mention = mentionOf(label, url);
    return mention === undefined
      ? []
      : [
          {
            start: match.index,
            end: match.index + whole.length,
            text: whole,
            label,
            title,
            mention,
          },
        ];
  });
}

/**
 * The text with its references blanked, every other character where it was, so
 * a ticket key in a mentioned item's title is not read as a reference of its
 * own. `recorded` limits that to the references a sent message holds as mentions.
 */
export function maskTrackerMentions(
  text: string,
  recorded?: ReadonlyArray<{ readonly url: string }>,
): string {
  let masked = text;
  for (const span of findTrackerMentionSpans(text)) {
    if (recorded !== undefined && !recorded.some((each) => each.url === span.mention.url)) continue;
    masked = `${masked.slice(0, span.start)}${" ".repeat(span.text.length)}${masked.slice(span.end)}`;
  }
  return masked;
}

/** What a sent message records: each referenced item once, in the order the text shows them. */
export function findTrackerMentions(text: string): ReadonlyArray<TrackerMention> {
  const byUrl = new Map<string, TrackerMention>();
  for (const span of findTrackerMentionSpans(text)) byUrl.set(span.mention.url, span.mention);
  return [...byUrl.values()].slice(0, MAX_TRACKER_MENTIONS_PER_TURN);
}

/** The field a turn's record carries for the references in its message, absent for none. */
export function recordedTrackerMentions(
  text: string | undefined,
): { readonly trackerMentions: ReadonlyArray<TrackerMention> } | Record<string, never> {
  const trackerMentions = text === undefined ? [] : findTrackerMentions(text);
  return trackerMentions.length === 0 ? {} : { trackerMentions };
}

/**
 * Replace the active `#` token with the item's reference, leaving a trailing
 * space so the person keeps typing prose.
 */
export function applyTrackerMention(
  draft: string,
  token: { readonly start: number; readonly end: number },
  item: Pick<TrackerMentionCandidate, "source" | "id" | "title" | "url">,
): { readonly draft: string; readonly caretIndex: number } {
  const reference = `${formatTrackerMentionReference({
    label: trackerMentionLabel(item),
    title: item.title,
    url: item.url,
  })} `;
  return {
    draft: `${draft.slice(0, token.start)}${reference}${draft.slice(token.end)}`,
    caretIndex: token.start + reference.length,
  };
}

/** How a GitHub number or a Linear key reads. */
export function trackerMentionLabel(item: {
  readonly source: TrackerMention["source"];
  readonly id: string;
}): string {
  return item.source === "github" ? `#${item.id}` : item.id;
}

export type TrackerMentionQuery =
  | { readonly kind: "number"; readonly number: number }
  | { readonly kind: "key"; readonly key: string }
  | { readonly kind: "title"; readonly text: string };

/**
 * What the text after `#` asks a tracker for. Under two characters of title asks
 * for nothing, so typing `#` alone never reaches a tracker.
 */
export function parseTrackerMentionQuery(query: string): TrackerMentionQuery | undefined {
  const trimmed = query.trim().replace(/^#/, "");
  if (/^[1-9]\d{0,8}$/.test(trimmed)) return { kind: "number", number: Number(trimmed) };
  if (/^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,9}$/.test(trimmed)) {
    return { kind: "key", key: trimmed.toUpperCase() };
  }
  return trimmed.length < 2 ? undefined : { kind: "title", text: trimmed };
}
