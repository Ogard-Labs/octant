import type { ThreadMentionCandidate } from "@octant/contracts";

/** Words for where the host says a mentionable thread is filed. */
export function threadPlacementLabel(placement: ThreadMentionCandidate["placement"]): string {
  if (placement.kind === "project") return placement.label;
  return placement.kind === "recents" ? "Recents" : "Unfiled";
}
