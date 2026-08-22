import type { CodeBoardCard, CodeBoardStatus, CodeBoardStatusReason } from "@octant/contracts";
import type { ProjectId } from "@octant/contracts/projects";
import {
  THREAD_BOARD_STATUS_COLUMN_ORDER,
  compareThreadBoardActivityDescending,
  compareThreadBoardProjectOrder,
} from "@octant/domain/thread-board-policy";

export type CodeBoardGrouping = "status" | "project";

export interface CodeBoardColumn {
  readonly key: string;
  readonly label: string;
  readonly kind: "status" | "project";
  readonly status?: CodeBoardStatus;
  readonly projectId?: ProjectId;
  readonly cards: readonly CodeBoardCard[];
}

export interface CodeBoardProjectRef {
  readonly id: ProjectId;
  readonly name: string;
}

export interface GroupCodeBoardCardsOptions {
  /** Projects in the user's configured order, used to order Project columns. */
  readonly projects: readonly CodeBoardProjectRef[];
}

const STATUS_LABELS: Record<CodeBoardStatus, string> = {
  ready: "Ready",
  "in-progress": "In Progress",
  waiting: "Waiting",
  done: "Done",
};

const STATUS_REASON_LABELS: Record<CodeBoardStatusReason, string> = {
  "delivery-satisfied": "The confirmed delivery target is satisfied",
  executing: "A provider turn, tool, or child run is executing",
  "awaiting-input": "Waiting for a decision or input",
  interrupted: "The last agent turn was interrupted",
  recovering: "Recovering Project or operation history",
  "delivery-waiting": "Delivery evidence is stale or ambiguous",
  "idle-unmet-delivery": "Idle; the delivery target is not yet met",
};

export function codeBoardStatusLabel(status: CodeBoardStatus): string {
  return STATUS_LABELS[status];
}

export function codeBoardStatusReasonLabel(reason: CodeBoardStatusReason): string {
  return STATUS_REASON_LABELS[reason];
}

/**
 * Project a single ordered board result into columns for the chosen grouping.
 * Grouping is a pure projection: it performs no command and never reclassifies,
 * duplicates, or drops a card. Recovering threads stay in Waiting with their
 * specific reason visible rather than a fifth column.
 *
 * Every matching card appears in exactly one column. `Done` is a first-class
 * column and is never suppressed. Column counts therefore reflect the full
 * filtered result.
 */
export function groupCodeBoardCards(
  cards: readonly CodeBoardCard[],
  grouping: CodeBoardGrouping,
  options: GroupCodeBoardCardsOptions,
): readonly CodeBoardColumn[] {
  return grouping === "status" ? groupByStatus(cards) : groupByProject(cards, options.projects);
}

function groupByStatus(cards: readonly CodeBoardCard[]): readonly CodeBoardColumn[] {
  return THREAD_BOARD_STATUS_COLUMN_ORDER.map((status) => ({
    key: `status:${status}`,
    label: codeBoardStatusLabel(status),
    kind: "status" as const,
    status,
    cards: cards.filter((card) => card.status === status).sort(sortByActivity),
  }));
}

function groupByProject(
  cards: readonly CodeBoardCard[],
  projects: readonly CodeBoardProjectRef[],
): readonly CodeBoardColumn[] {
  const present = new Set(cards.map((card) => String(card.projectId)));
  const ordered: CodeBoardProjectRef[] = projects.filter((project) =>
    present.has(String(project.id)),
  );
  // Any Project represented in the result but missing from the configured order
  // still gets a column so no card silently disappears.
  const known = new Set(ordered.map((project) => String(project.id)));
  for (const card of cards) {
    if (known.has(String(card.projectId))) continue;
    known.add(String(card.projectId));
    ordered.push({ id: card.projectId, name: String(card.projectId) });
  }
  return ordered.map((project) => ({
    key: `project:${String(project.id)}`,
    label: project.name,
    kind: "project" as const,
    projectId: project.id,
    cards: cards
      .filter((card) => String(card.projectId) === String(project.id))
      .sort(sortByProjectOrder),
  }));
}

function sortByActivity(a: CodeBoardCard, b: CodeBoardCard): number {
  return compareThreadBoardActivityDescending(
    { lastMeaningfulActivityAtMs: activityMs(a) },
    { lastMeaningfulActivityAtMs: activityMs(b) },
  );
}

function sortByProjectOrder(a: CodeBoardCard, b: CodeBoardCard): number {
  return compareThreadBoardProjectOrder(
    { status: a.status, lastMeaningfulActivityAtMs: activityMs(a) },
    { status: b.status, lastMeaningfulActivityAtMs: activityMs(b) },
  );
}

function activityMs(card: CodeBoardCard): number | null {
  if (card.lastMeaningfulActivityAt === null) return null;
  const parsed = Date.parse(card.lastMeaningfulActivityAt);
  return Number.isFinite(parsed) ? parsed : null;
}
