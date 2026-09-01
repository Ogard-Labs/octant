import type { ThreadBoardReason, ThreadBoardStatus } from "@octant/contracts/thread-board";
import type { ProjectId } from "@octant/contracts/projects";
import {
  THREAD_BOARD_STATUS_COLUMN_ORDER,
  compareThreadBoardActivityDescending,
  compareThreadBoardProjectOrder,
} from "@octant/domain/thread-board-policy";

export type ThreadBoardGrouping = "status" | "project";

export interface ThreadBoardGroupableCard {
  readonly threadId: unknown;
  readonly projectId: ProjectId;
  readonly status: ThreadBoardStatus;
  readonly lastMeaningfulActivityAt: string | null;
}

export interface ThreadBoardColumn<TCard extends ThreadBoardGroupableCard> {
  readonly key: string;
  readonly label: string;
  readonly kind: "status" | "project";
  readonly status?: ThreadBoardStatus;
  readonly projectId?: ProjectId;
  readonly cards: readonly TCard[];
}

export interface ThreadBoardProjectRef {
  readonly id: ProjectId;
  readonly name: string;
}

export interface GroupThreadBoardCardsOptions {
  readonly projects: readonly ThreadBoardProjectRef[];
}

const STATUS_LABELS: Record<ThreadBoardStatus, string> = {
  ready: "Ready",
  "in-progress": "In progress",
  waiting: "Waiting",
  done: "Done",
};

const STATUS_REASON_LABELS: Record<ThreadBoardReason, string> = {
  "delivery-satisfied": "The confirmed delivery target is satisfied",
  executing: "A provider turn, tool, or child run is executing",
  "awaiting-input": "Waiting for a decision or input",
  interrupted: "The last agent turn was interrupted",
  recovering: "Recovering Project or operation history",
  "delivery-waiting": "Delivery evidence is stale or ambiguous",
  "idle-unmet-delivery": "Idle; the delivery target is not yet met",
};

export function threadBoardStatusLabel(status: ThreadBoardStatus): string {
  return STATUS_LABELS[status];
}

export function threadBoardStatusReasonLabel(reason: ThreadBoardReason): string {
  return STATUS_REASON_LABELS[reason];
}

/**
 * Project a single ordered board result into columns for the chosen grouping.
 * Grouping is a pure projection: it performs no command and never reclassifies,
 * duplicates, or drops a card. Recovering threads stay in Waiting with their
 * specific reason visible rather than a fifth column.
 */
export function groupThreadBoardCards<TCard extends ThreadBoardGroupableCard>(
  cards: readonly TCard[],
  grouping: ThreadBoardGrouping,
  options: GroupThreadBoardCardsOptions,
): readonly ThreadBoardColumn<TCard>[] {
  return grouping === "status" ? groupByStatus(cards) : groupByProject(cards, options.projects);
}

function groupByStatus<TCard extends ThreadBoardGroupableCard>(
  cards: readonly TCard[],
): readonly ThreadBoardColumn<TCard>[] {
  return THREAD_BOARD_STATUS_COLUMN_ORDER.map((status) => ({
    key: `status:${status}`,
    label: threadBoardStatusLabel(status),
    kind: "status" as const,
    status,
    cards: cards.filter((card) => card.status === status).sort(sortByActivity),
  }));
}

function groupByProject<TCard extends ThreadBoardGroupableCard>(
  cards: readonly TCard[],
  projects: readonly ThreadBoardProjectRef[],
): readonly ThreadBoardColumn<TCard>[] {
  const present = new Set(cards.map((card) => String(card.projectId)));
  const ordered: ThreadBoardProjectRef[] = projects.filter((project) =>
    present.has(String(project.id)),
  );
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

function sortByActivity<TCard extends ThreadBoardGroupableCard>(a: TCard, b: TCard): number {
  return compareThreadBoardActivityDescending(
    { lastMeaningfulActivityAtMs: activityMs(a) },
    { lastMeaningfulActivityAtMs: activityMs(b) },
  );
}

function sortByProjectOrder<TCard extends ThreadBoardGroupableCard>(a: TCard, b: TCard): number {
  return compareThreadBoardProjectOrder(
    { status: a.status, lastMeaningfulActivityAtMs: activityMs(a) },
    { status: b.status, lastMeaningfulActivityAtMs: activityMs(b) },
  );
}

function activityMs(card: ThreadBoardGroupableCard): number | null {
  if (card.lastMeaningfulActivityAt === null) return null;
  const parsed = Date.parse(card.lastMeaningfulActivityAt);
  return Number.isFinite(parsed) ? parsed : null;
}
