/**
 * Pure policy for the host-wide artifact library.
 *
 * Reading what an artifact is, and deciding which artifacts a query asks for,
 * are both decisions the host makes before answering. They live here so the
 * renderer's filter and the server's listing cannot disagree about what
 * "diagrams in this Project" means.
 */

import type { CanvasBlock } from "@octant/contracts/canvas";
import {
  CLAUDE_PLAIN_PAGE_TYPE,
  type ArtifactKind,
  type ArtifactLibraryClaudeEntry,
  type ArtifactLibraryEntry,
  type ArtifactLibraryQuery,
  type ArtifactLibrarySyncedEntry,
} from "@octant/contracts/artifact-library";

/**
 * Blocks that give an artifact its character.
 *
 * Headings, dividers, and references appear in almost everything, so counting
 * them would make every artifact a document. Only the blocks a person would
 * describe the artifact by are counted.
 */
const DEFINING_KIND: Partial<Record<CanvasBlock["kind"], ArtifactKind>> = {
  diagram: "diagram",
  chart: "chart",
  timeline: "chart",
  table: "table",
  "key-value": "table",
  "code-excerpt": "code",
  pseudocode: "code",
  diff: "code",
  "rich-text": "document",
  callout: "document",
  summary: "document",
};

/**
 * What this artifact mostly is.
 *
 * A single defining character wins outright. Two or more that are genuinely
 * different make it `mixed` rather than picking the larger — a document with
 * one diagram in it is a document, but a page that is half chart and half table
 * is neither, and saying so is more useful than rounding it off. An artifact
 * with nothing defining at all is a `document`, because that is what a page of
 * headings and links is.
 */
export function artifactKindForBlocks(
  blocks: ReadonlyArray<Pick<CanvasBlock, "kind">>,
): ArtifactKind {
  const counts = new Map<ArtifactKind, number>();
  for (const block of blocks) {
    const kind = DEFINING_KIND[block.kind];
    if (kind === undefined) continue;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  if (counts.size === 0) return "document";
  const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1]);
  const leader = ranked[0];
  if (leader === undefined) return "document";
  const runnerUp = ranked[1];
  // A clear majority is the artifact's character; a near-tie is not.
  if (runnerUp !== undefined && leader[1] < runnerUp[1] * 2) return "mixed";
  return leader[0];
}

/**
 * The artifacts one query asks for, newest first.
 *
 * Search matches the title and the Project's name, because that is how a person
 * looks for something they made three weeks ago: they remember one or the
 * other. The `shared` tab is a filter rather than a separate list — an artifact
 * with a live share is in both `all` and `shared`, and no artifact is hidden
 * from `all` for being shared.
 */
export function selectArtifactLibraryEntries(
  entries: ReadonlyArray<ArtifactLibraryEntry>,
  query: ArtifactLibraryQuery,
): ReadonlyArray<ArtifactLibraryEntry> {
  const needle = query.query?.toLocaleLowerCase("en-US");
  return entries
    .filter((entry) => {
      if (query.tab === "shared" && !entry.shared) return false;
      if (query.projectId !== undefined) {
        // A Project filter is a Project question: an entry that names no
        // Project is not in any Project, so it matches no Project filter.
        if (entry.projectId === undefined) return false;
        if (String(entry.projectId) !== String(query.projectId)) {
          return false;
        }
      }
      if (query.mode !== undefined && entry.mode !== query.mode) return false;
      if (query.kind !== undefined && entry.kind !== query.kind) return false;
      if (query.tag !== undefined && !(entry.tags ?? []).includes(query.tag)) return false;
      if (needle === undefined) return true;
      return (
        entry.title.toLocaleLowerCase("en-US").includes(needle) ||
        (entry.projectName?.toLocaleLowerCase("en-US").includes(needle) ?? false)
      );
    })
    .toSorted(compareArtifactLibraryEntries);
}

/**
 * The tag roster the listing offers its filter: every tag the caller's
 * artifacts carry, with how many carry it, alphabetical. An exact label is
 * counted once per artifact, so the count never exceeds the artifacts a
 * caller may see.
 */
export function artifactTagRoster(
  entries: ReadonlyArray<ArtifactLibraryEntry>,
): ReadonlyArray<{ readonly name: string; readonly artifactCount: number }> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    for (const tag of entry.tags ?? []) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([name, artifactCount]) => ({ name, artifactCount }))
    .sort((left, right) => left.name.localeCompare(right.name, "en-US"));
}

/**
 * Which synced artifacts a query asks for. A synced artifact belongs to no
 * Project on this host, has no share here, and carries no tag here — the
 * person tags what this host holds — so a Project or tag filter matches none
 * of them; mode, kind, and text match as they do for this host's own
 * artifacts, and text also matches the computer's name.
 */
export function selectSyncedArtifactLibraryEntries(
  entries: ReadonlyArray<ArtifactLibrarySyncedEntry>,
  query: ArtifactLibraryQuery,
): ReadonlyArray<ArtifactLibrarySyncedEntry> {
  if (query.tab === "shared" || query.projectId !== undefined || query.tag !== undefined) {
    return [];
  }
  const needle = query.query?.toLocaleLowerCase("en-US");
  return entries.filter((entry) => {
    if (query.mode !== undefined && entry.mode !== query.mode) return false;
    if (query.kind !== undefined && entry.kind !== query.kind) return false;
    if (needle === undefined) return true;
    return [entry.title, entry.projectName, entry.computerName].some((text) =>
      text.toLocaleLowerCase("en-US").includes(needle),
    );
  });
}

/**
 * Newest edit first, and by title when two were edited in the same instant, so
 * a listing does not reshuffle between two reads that saw the same state.
 */
export function compareArtifactLibraryEntries(
  left: ArtifactLibraryEntry,
  right: ArtifactLibraryEntry,
): number {
  if (left.updatedAt !== right.updatedAt) return left.updatedAt < right.updatedAt ? 1 : -1;
  const byTitle = left.title.localeCompare(right.title, "en-US");
  return byTitle !== 0 ? byTitle : String(left.canvasId).localeCompare(String(right.canvasId));
}

/**
 * How long ago an artifact was edited, in the words a card uses.
 *
 * Deliberately coarse: a card says "3 days ago", and a person who needs the
 * exact instant opens the artifact. `observedAt` is passed in rather than read
 * from the clock so the same listing renders the same way in a test.
 */
export function artifactEditedAgo(updatedAt: string, observedAt: string): string {
  const elapsedMs = Date.parse(observedAt) - Date.parse(updatedAt);
  if (!Number.isFinite(elapsedMs)) return "Edited recently";
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "Edited just now";
  if (minutes < 60) return `Edited ${String(minutes)} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Edited ${String(hours)} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `Edited ${String(days)} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `Edited ${String(months)} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(months / 12);
  return `Edited ${String(years)} year${years === 1 ? "" : "s"} ago`;
}

/**
 * One publish a thread's journal holds: a tool call's page, with the facts
 * the publish recorded. Several publishes to one address are one page.
 */
export interface ClaudePublishRecord {
  readonly url: string;
  readonly title?: string | undefined;
  readonly artifactType?: string | undefined;
  readonly account?: string | undefined;
  readonly projectId: ArtifactLibraryClaudeEntry["projectId"];
  readonly projectName: string;
  readonly mode: ArtifactLibraryClaudeEntry["mode"];
  readonly threadId: string;
  readonly threadTitle?: string | undefined;
  readonly toolCallId: string;
  readonly publishedAt: ArtifactLibraryClaudeEntry["publishedAt"];
  /**
   * Where the publish sits in its thread's journal: a Work turn's place and
   * its step's place in it, or a Code frame's cursor. Several publishes in one
   * Work turn share the turn's time, so within a thread this, not the time,
   * says which came last.
   */
  readonly sequence: number;
  readonly snapshot?: "html" | "markdown" | undefined;
}

/** Which of two publishes came first: by journal order within a thread, else by time. */
function comparePublishes(left: ClaudePublishRecord, right: ClaudePublishRecord): number {
  if (left.threadId === right.threadId && left.sequence !== right.sequence) {
    return left.sequence - right.sequence;
  }
  if (left.publishedAt !== right.publishedAt) return left.publishedAt < right.publishedAt ? -1 : 1;
  return left.sequence - right.sequence;
}

/**
 * The library's Claude pages from every publish the caller may see: one
 * entry per page address, showing its newest publish, with each publish to
 * that address counted as a version. A later update that names no type or
 * title keeps the ones an earlier publish gave the page.
 */
export function foldClaudePublishes(
  records: ReadonlyArray<ClaudePublishRecord>,
  accountName: (account: string) => string | undefined = () => undefined,
): ReadonlyArray<ArtifactLibraryClaudeEntry> {
  const byUrl = new Map<string, ClaudePublishRecord[]>();
  for (const record of records) {
    const versions = byUrl.get(record.url);
    if (versions === undefined) byUrl.set(record.url, [record]);
    else versions.push(record);
  }
  return [...byUrl.values()].flatMap((versions) => {
    const ordered = versions.toSorted(comparePublishes);
    const newest = ordered.at(-1);
    if (newest === undefined) return [];
    const title = ordered.findLast((version) => version.title !== undefined)?.title;
    const artifactType =
      ordered.findLast((version) => version.artifactType !== undefined)?.artifactType ??
      CLAUDE_PLAIN_PAGE_TYPE;
    const name = newest.account === undefined ? undefined : accountName(newest.account);
    return [
      {
        url: newest.url,
        title: title ?? "Published page",
        artifactType,
        ...(newest.account === undefined ? {} : { account: newest.account }),
        ...(name === undefined ? {} : { accountName: name }),
        projectId: newest.projectId,
        projectName: newest.projectName,
        mode: newest.mode,
        threadId: newest.threadId,
        ...(newest.threadTitle === undefined ? {} : { threadTitle: newest.threadTitle }),
        toolCallId: newest.toolCallId,
        versionCount: ordered.length,
        publishedAt: newest.publishedAt,
        ...(newest.snapshot === undefined ? {} : { snapshot: newest.snapshot }),
      },
    ];
  });
}

/**
 * The Claude pages one query asks for, newest first. They carry no tag and
 * no share, so the tag and shared views and a tag or Canvas kind filter
 * match none; a Claude type or account filter matches only Claude pages.
 */
export function selectClaudeLibraryEntries(
  entries: ReadonlyArray<ArtifactLibraryClaudeEntry>,
  query: ArtifactLibraryQuery,
): ReadonlyArray<ArtifactLibraryClaudeEntry> {
  if (
    query.source === "canvas" ||
    query.tab === "shared" ||
    query.tab === "by-tag" ||
    query.tag !== undefined ||
    query.kind !== undefined
  ) {
    return [];
  }
  const needle = query.query?.toLocaleLowerCase("en-US");
  return entries
    .filter((entry) => {
      if (query.projectId !== undefined && String(entry.projectId) !== String(query.projectId)) {
        return false;
      }
      if (query.mode !== undefined && entry.mode !== query.mode) return false;
      if (query.claudeType !== undefined && entry.artifactType !== query.claudeType) return false;
      if (query.account !== undefined && entry.account !== query.account) return false;
      if (needle === undefined) return true;
      return (
        entry.title.toLocaleLowerCase("en-US").includes(needle) ||
        entry.projectName.toLocaleLowerCase("en-US").includes(needle)
      );
    })
    .toSorted((left, right) =>
      left.publishedAt === right.publishedAt
        ? left.url.localeCompare(right.url)
        : left.publishedAt < right.publishedAt
          ? 1
          : -1,
    );
}

/** Whether a query asks for Canvas documents at all. */
export function artifactLibraryQueryListsCanvas(query: ArtifactLibraryQuery): boolean {
  return query.source !== "claude" && query.claudeType === undefined && query.account === undefined;
}
