import type { CodeBoardCard, CodeBoardStatus } from "@octant/contracts";
import type { ProjectId } from "@octant/contracts/projects";
import {
  CODE_BOARD_STATUS_COLUMN_ORDER,
  compareCodeBoardActivityDescending,
  compareCodeBoardProjectOrder,
} from "@octant/domain/code-policy";

export type CodeBoardGrouping = "status" | "project";

export interface CodeBoardColumn {
  readonly key: string;
  readonly label: string;
  readonly kind: "status" | "project" | "recovery";
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

export function codeBoardStatusLabel(status: CodeBoardStatus): string {
  return STATUS_LABELS[status];
}

/**
 * Project a single ordered board result into columns for the chosen grouping.
 * Grouping is a pure projection: it performs no command and never reclassifies,
 * duplicates, or drops a card. A card whose metadata is recovering (e.g. a
 * temporarily missing Project projection) is surfaced in a dedicated Recovery
 * column — with its actionable reason — rather than a Status or Project column,
 * so it stays visible even when its bound Project cannot be resolved.
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
  const recovering = cards.filter((card) => card.recovery.kind === "recovering");
  const placeable = cards.filter((card) => card.recovery.kind !== "recovering");

  const columns =
    grouping === "status" ? groupByStatus(placeable) : groupByProject(placeable, options.projects);

  if (recovering.length === 0) return columns;
  return [
    ...columns,
    {
      key: "recovery",
      label: "Recovery",
      kind: "recovery",
      cards: [...recovering].sort(sortByActivity),
    },
  ];
}

function groupByStatus(cards: readonly CodeBoardCard[]): readonly CodeBoardColumn[] {
  return CODE_BOARD_STATUS_COLUMN_ORDER.map((status) => ({
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
  return compareCodeBoardActivityDescending(
    { lastMeaningfulActivityAtMs: activityMs(a) },
    { lastMeaningfulActivityAtMs: activityMs(b) },
  );
}

function sortByProjectOrder(a: CodeBoardCard, b: CodeBoardCard): number {
  return compareCodeBoardProjectOrder(
    { status: a.status, lastMeaningfulActivityAtMs: activityMs(a) },
    { status: b.status, lastMeaningfulActivityAtMs: activityMs(b) },
  );
}

function activityMs(card: CodeBoardCard): number | null {
  if (card.lastMeaningfulActivityAt === null) return null;
  const parsed = Date.parse(card.lastMeaningfulActivityAt);
  return Number.isFinite(parsed) ? parsed : null;
}
