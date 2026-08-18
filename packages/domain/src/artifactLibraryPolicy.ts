/**
 * Pure policy for the host-wide artifact library.
 *
 * Reading what an artifact is, and deciding which artifacts a query asks for,
 * are both decisions the host makes before answering. They live here so the
 * renderer's filter and the server's listing cannot disagree about what
 * "diagrams in this Project" means.
 */

import type { CanvasBlock } from "@octant/contracts/canvas";
import type {
  ArtifactKind,
  ArtifactLibraryEntry,
  ArtifactLibraryQuery,
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
      if (query.projectId !== undefined && String(entry.projectId) !== String(query.projectId)) {
        return false;
      }
      if (query.mode !== undefined && entry.mode !== query.mode) return false;
      if (query.kind !== undefined && entry.kind !== query.kind) return false;
      if (needle === undefined) return true;
      return (
        entry.title.toLocaleLowerCase("en-US").includes(needle) ||
        entry.projectName.toLocaleLowerCase("en-US").includes(needle)
      );
    })
    .toSorted(compareArtifactLibraryEntries);
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
