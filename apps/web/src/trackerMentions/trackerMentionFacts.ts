import type { TrackerMentionCandidate } from "@octant/contracts/tracker-mention-search";

/**
 * What this window's `#` searches have said of an item, by its URL. A card
 * reads it, so drawing one asks no tracker anything; after a reload a chip has
 * only what its own reference says.
 */
const facts = new Map<string, TrackerMentionCandidate>();

export function rememberTrackerMentionFacts(
  candidates: ReadonlyArray<TrackerMentionCandidate>,
): void {
  for (const candidate of candidates) facts.set(candidate.url, candidate);
}

export function trackerMentionFacts(url: string): TrackerMentionCandidate | undefined {
  return facts.get(url);
}
