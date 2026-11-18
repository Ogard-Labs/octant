import type { ReactNode } from "react";

/**
 * The start screen's one calm list. Contributors (pending requests, pull
 * requests, running work, threads) each hand over rows tagged with the section
 * they belong to; this module is the only place that orders, dedupes and caps
 * them, so the same pull request or thread is never said twice.
 */

export type HomeListSectionId =
  | "needs-you"
  | "in-progress"
  | "your-pull-requests"
  | "continue"
  | "open-issues";

/** Sections in the order they read: what waits on the person first. */
export const HOME_LIST_SECTIONS: ReadonlyArray<{
  readonly id: HomeListSectionId;
  readonly title: string;
}> = [
  { id: "needs-you", title: "Needs you" },
  { id: "in-progress", title: "In progress" },
  { id: "your-pull-requests", title: "Your pull requests" },
  { id: "continue", title: "Continue" },
  { id: "open-issues", title: "Open issues" },
];

/** More than a glance holds; the rest are a "See all" away. */
export const HOME_LIST_ROW_LIMIT = 5;

export type HomeListGlyph =
  | "pull-request"
  | "pull-request-draft"
  | "issue"
  | "thread"
  | "running"
  | "service"
  | "ask";

/** The glyph's colour: the semantic ink, never the only carrier of the state. */
export type HomeListTone = "neutral" | "positive" | "warning" | "negative" | "running";

export interface HomeListRow {
  /** Stable across sections and reads: what a second contributor dedupes on. */
  readonly id: string;
  /** Other ids this row stands for, such as the thread a pending request waits on. */
  readonly aliases?: ReadonlyArray<string>;
  readonly section: HomeListSectionId;
  readonly glyph: HomeListGlyph;
  readonly tone: HomeListTone;
  /** The glyph's name for a screen reader, such as "Failing" or "Draft". */
  readonly label: string;
  readonly title: string;
  /** Facts for the one quiet line under the title, in order. */
  readonly meta: ReadonlyArray<string>;
  /** One word at the title's edge: where the row stands, such as "Failing" or "Waiting". */
  readonly trailing?: string;
  /** The row's moment, kept for the line's tooltip; the age is already in `meta`. */
  readonly at?: string;
  /** Absent for a row the host cannot open from here. */
  readonly onOpen?: () => void;
  /**
   * A row that answers where it stands (an approval with its buttons) draws
   * itself; the list only places it.
   */
  readonly custom?: ReactNode;
}

export interface HomeListSeeAll {
  readonly label: string;
  readonly onSelect: () => void;
}

export interface HomeListSection {
  readonly id: HomeListSectionId;
  readonly title: string;
  /** At most {@link HOME_LIST_ROW_LIMIT}. */
  readonly rows: ReadonlyArray<HomeListRow>;
  /** Every row the section has after dedupe, shown or not. */
  readonly total: number;
  /** Present only when rows were left out and the section has a full page. */
  readonly seeAll?: HomeListSeeAll;
}

/**
 * The sections that have rows, in reading order. Dedupe runs before the cap, in
 * section order, so Needs you claims an item before In progress or Your pull
 * requests can; a row the cap hides still claims its ids, which keeps a later
 * section from showing what an earlier one only counted.
 */
export function buildHomeList(input: {
  readonly rows: ReadonlyArray<HomeListRow>;
  readonly seeAll: Readonly<Partial<Record<HomeListSectionId, HomeListSeeAll>>>;
}): ReadonlyArray<HomeListSection> {
  const claimed = new Set<string>();
  const sections: HomeListSection[] = [];
  for (const definition of HOME_LIST_SECTIONS) {
    const kept: HomeListRow[] = [];
    for (const row of input.rows) {
      if (row.section !== definition.id) continue;
      const keys = [row.id, ...(row.aliases ?? [])];
      if (keys.some((key) => claimed.has(key))) continue;
      for (const key of keys) claimed.add(key);
      kept.push(row);
    }
    if (kept.length === 0) continue;
    const seeAll = input.seeAll[definition.id];
    const shown = kept.slice(0, HOME_LIST_ROW_LIMIT);
    sections.push({
      id: definition.id,
      title: definition.title,
      rows: shown,
      total: kept.length,
      ...(seeAll === undefined || kept.length <= shown.length ? {} : { seeAll }),
    });
  }
  return sections;
}

/** The id one pull request has wherever a contributor meets it. */
export function pullRequestListId(owner: string, name: string, number: number): string {
  return `pull-request:${owner.toLowerCase()}/${name.toLowerCase()}#${String(number)}`;
}

/** The id one thread has, whichever mode or contributor names it. */
export function threadListId(threadId: string): string {
  return `thread:${threadId}`;
}

/** The facts line: present facts joined by a middle dot. */
export function homeListMetaLine(meta: ReadonlyArray<string>): string {
  return meta.filter((fact) => fact !== "").join(" · ");
}
