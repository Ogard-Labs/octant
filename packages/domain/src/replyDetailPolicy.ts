import {
  MAX_THREAD_REPLY_DETAILS,
  type ReplyDetailLevel,
  type ThreadReplyDetail,
  type ThreadReplyDetails,
} from "@octant/contracts/shell";
import type { OctantMode } from "@octant/contracts/modes";

/**
 * Reply detail: how much of a turn's thinking and tool calls a transcript
 * shows open. Presentation only; nothing here reaches a model or a route.
 */

export const REPLY_DETAIL_LEVELS: ReadonlyArray<ReplyDetailLevel> = ["low", "medium", "high"];

export interface ReplyDetailThread {
  readonly mode: OctantMode;
  readonly threadId: string;
}

/** Which of a turn's disclosures a level shows open before anyone touches one. */
export interface ReplyDetailOpening {
  readonly thinking: boolean;
  /** Whether a closed thinking disclosure shows its first line beside its name. */
  readonly thinkingPreview: boolean;
  /** Whether a settled turn's "N tool calls" fold stays open. */
  readonly toolCalls: boolean;
  /** Whether each tool row shows the summary the transcript already holds. */
  readonly toolDetail: boolean;
}

const OPENING: Readonly<Record<ReplyDetailLevel, ReplyDetailOpening>> = {
  low: { thinking: false, thinkingPreview: false, toolCalls: false, toolDetail: false },
  medium: { thinking: false, thinkingPreview: true, toolCalls: true, toolDetail: false },
  high: { thinking: true, thinkingPreview: false, toolCalls: true, toolDetail: true },
};

export function replyDetailOpening(level: ReplyDetailLevel): ReplyDetailOpening {
  return OPENING[level];
}

/** Low, then Medium, then High, then Low again: what the shortcut steps through. */
export function nextReplyDetailLevel(level: ReplyDetailLevel): ReplyDetailLevel {
  return level === "low" ? "medium" : level === "medium" ? "high" : "low";
}

function sameThread(entry: ThreadReplyDetail, thread: ReplyDetailThread): boolean {
  return entry.mode === thread.mode && entry.threadId === thread.threadId;
}

/** The level a thread chose for itself, if it chose one. */
export function threadReplyDetailOverride(
  threads: ThreadReplyDetails,
  thread: ReplyDetailThread,
): ReplyDetailLevel | undefined {
  return threads.find((entry) => sameThread(entry, thread))?.level;
}

/** The level a thread is drawn at: its own choice, else the default. */
export function effectiveReplyDetail(
  reading: { readonly defaultLevel: ReplyDetailLevel; readonly threads: ThreadReplyDetails },
  thread: ReplyDetailThread,
): ReplyDetailLevel {
  return threadReplyDetailOverride(reading.threads, thread) ?? reading.defaultLevel;
}

/**
 * The list with one thread's choice set, or removed when `level` is undefined
 * (the thread follows the default again). The newest choice goes last; a full
 * list drops its first, longest-standing entry to make room.
 */
export function withThreadReplyDetail(
  threads: ThreadReplyDetails,
  thread: ReplyDetailThread,
  level: ReplyDetailLevel | undefined,
): ThreadReplyDetails {
  const others = threads.filter((entry) => !sameThread(entry, thread));
  if (level === undefined) return others;
  const kept =
    others.length >= MAX_THREAD_REPLY_DETAILS
      ? others.slice(others.length - MAX_THREAD_REPLY_DETAILS + 1)
      : others;
  return [...kept, { mode: thread.mode, threadId: thread.threadId, level }];
}

/** The list without any choice made by these threads, as when they are erased. */
export function withoutThreadReplyDetails(
  threads: ThreadReplyDetails,
  erased: ReadonlyArray<ReplyDetailThread>,
): ThreadReplyDetails {
  return threads.filter((entry) => !erased.some((thread) => sameThread(entry, thread)));
}

/** Longest preview kept; a row's own ellipsis clips it on screen. */
const THINKING_PREVIEW_LIMIT = 160;

/**
 * The first line of a turn's thinking, as plain words: block markers and
 * emphasis marks are dropped because the preview is not rendered as Markdown.
 */
export function thinkingPreviewLine(text: string): string {
  const line =
    text
      .split("\n")
      .map((candidate) => candidate.trim())
      .find((candidate) => candidate.length > 0) ?? "";
  const plain = line
    .replace(/^(?:#{1,6}|>|[-*+]|\d+[.)])\s+/, "")
    .replace(/\*\*|__|`/g, "")
    .trim();
  return plain.length <= THINKING_PREVIEW_LIMIT
    ? plain
    : `${plain.slice(0, THINKING_PREVIEW_LIMIT - 1)}…`;
}
