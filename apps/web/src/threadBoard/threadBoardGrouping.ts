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
  "delivery-satisfied": "Done: what you asked for is finished",
  executing: "An agent is working on it",
  "awaiting-input": "Waiting for a decision or answer",
  interrupted: "The agent stopped partway through",
  recovering: "Catching up after a restart",
  "delivery-waiting": "Not confirmed finished yet",
  "idle-unmet-delivery": "Paused before it was finished",
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

/**
 * The Waiting column leads with the threads that have waited on the person the
 * longest, so a column of waiting cards is cleared from the top. A card with no
 * listed request keeps its place after them, in the order grouping gave it.
 * Without a reader the columns come back untouched.
 */
export function waitingColumnOldestFirst<TCard extends ThreadBoardGroupableCard>(
  columns: readonly ThreadBoardColumn<TCard>[],
  oldestRequestedAt: ReadonlyMap<string, string> | undefined,
): readonly ThreadBoardColumn<TCard>[] {
  if (oldestRequestedAt === undefined || oldestRequestedAt.size === 0) return columns;
  return columns.map((column) =>
    column.kind === "status" && column.status === "waiting"
      ? {
          ...column,
          cards: column.cards.toSorted((a, b) => {
            const first = oldestRequestedAt.get(String(a.threadId));
            const second = oldestRequestedAt.get(String(b.threadId));
            if (first === undefined) return second === undefined ? 0 : 1;
            if (second === undefined) return -1;
            return first.localeCompare(second);
          }),
        }
      : column,
  );
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
