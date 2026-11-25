import type { ProjectId, PullRequestStackPlace } from "@octant/contracts";

interface StackLayerIdentity {
  readonly projectId: ProjectId;
  readonly repositoryOwner: string;
  readonly repositoryName: string;
  readonly number: number;
}

export interface StackListItem {
  readonly identity: StackLayerIdentity;
  readonly stack?: PullRequestStackPlace | undefined;
}

/** "2 of 4": the same words on every list that shows a stack. */
export function stackPlaceWords(place: PullRequestStackPlace): string {
  return `${String(place.position)} of ${String(place.size)}`;
}

/** The place as a sentence part, for a tooltip or an accessible name. */
export function stackPlaceSentence(place: PullRequestStackPlace): string {
  const layer = `Layer ${stackPlaceWords(place)} of a stack`;
  return place.parent === undefined ? `${layer}, the bottom` : `${layer}, on #${place.parent}`;
}

function isBasedOn(upper: StackListItem, lower: StackListItem): boolean {
  return (
    upper.stack?.parent === lower.identity.number &&
    String(upper.identity.projectId) === String(lower.identity.projectId) &&
    upper.identity.repositoryOwner.toLowerCase() === lower.identity.repositoryOwner.toLowerCase() &&
    upper.identity.repositoryName.toLowerCase() === lower.identity.repositoryName.toLowerCase()
  );
}

export type StackJoin = "previous" | "next" | "both";

/**
 * Which neighbours in the shown list this row's connector reaches. Only a layer
 * and the one it is really based on are joined, so a list that leaves a layer
 * out (a filter, or a thread that never touched it) draws no line across it.
 */
export function stackJoin(
  items: ReadonlyArray<StackListItem>,
  index: number,
): StackJoin | undefined {
  const item = items[index];
  if (item === undefined) return undefined;
  const before = items[index - 1];
  const after = items[index + 1];
  const previous = before !== undefined && isBasedOn(item, before);
  const next = after !== undefined && isBasedOn(after, item);
  if (previous && next) return "both";
  if (previous) return "previous";
  return next ? "next" : undefined;
}
