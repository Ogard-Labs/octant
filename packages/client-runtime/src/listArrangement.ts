/**
 * How a gathered list is narrowed, grouped, and ordered.
 *
 * This sits beside the environment selection for the same reason: a list that
 * gathers from several environments needs one vocabulary for arranging what it
 * gathered, or the sidebar, the routines list, and the artifact library each
 * grow their own idea of what "needs attention" or "by environment" means.
 *
 * Like the environment selection, it is view state and nothing more. Narrowing
 * a list never changes what anything may do, and grouping by environment never
 * moves ownership: an item is still owned and executed only by its own host.
 */

export type ListStatusFilter = "any" | "active" | "needs-attention" | "finished";
export type ListGrouping = "none" | "environment" | "project";
export type ListSort = "recent" | "name";

export interface ListArrangement {
  readonly status: ListStatusFilter;
  readonly grouping: ListGrouping;
  readonly sort: ListSort;
}

export const DEFAULT_LIST_ARRANGEMENT: ListArrangement = {
  status: "any",
  grouping: "none",
  sort: "recent",
};

/**
 * One item as an arranging view sees it.
 *
 * Deliberately small: an arrangement decides order and membership, so it needs
 * the facts those decisions turn on and nothing else. Anything richer would
 * make this module know about threads, routines, and artifacts separately.
 */
export interface ArrangeableItem {
  readonly id: string;
  readonly hostId: string;
  readonly name: string;
  readonly status: Exclude<ListStatusFilter, "any">;
  /** The Project or other container this belongs to, already named. */
  readonly groupName?: string;
  readonly updatedAt: string;
}

export interface ArrangedGroup<TItem extends ArrangeableItem> {
  /** Empty when the arrangement groups by nothing, so a view can skip headings. */
  readonly heading: string;
  readonly items: ReadonlyArray<TItem>;
}

export const LIST_STATUS_LABELS: Record<ListStatusFilter, string> = {
  any: "Any status",
  active: "Active",
  "needs-attention": "Needs attention",
  finished: "Finished",
};

export const LIST_GROUPING_LABELS: Record<ListGrouping, string> = {
  none: "No grouping",
  environment: "By environment",
  project: "By Project",
};

export const LIST_SORT_LABELS: Record<ListSort, string> = {
  recent: "Most recent",
  name: "Name",
};

export function matchesListStatus(item: ArrangeableItem, status: ListStatusFilter): boolean {
  return status === "any" || item.status === status;
}

/**
 * Narrow, order, and group in that order.
 *
 * Grouping last is what keeps an empty group from appearing: a heading with
 * nothing under it reads as a thing that broke rather than a thing that was
 * filtered out.
 */
export function arrangeItems<TItem extends ArrangeableItem>(
  items: ReadonlyArray<TItem>,
  arrangement: ListArrangement,
  options: {
    /** What to call each environment; the local one is already "Local". */
    readonly environmentLabel: (hostId: string) => string;
  },
): ReadonlyArray<ArrangedGroup<TItem>> {
  const kept = items.filter((item) => matchesListStatus(item, arrangement.status));
  const ordered = [...kept].sort((left, right) =>
    arrangement.sort === "name"
      ? left.name.localeCompare(right.name, "en-US") || left.id.localeCompare(right.id)
      : // Newest first, and ties broken by id so two items stamped in the same
        // millisecond do not swap places between renders.
        right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
  );
  if (arrangement.grouping === "none") {
    return ordered.length === 0 ? [] : [{ heading: "", items: ordered }];
  }

  const groups = new Map<string, TItem[]>();
  for (const item of ordered) {
    const heading =
      arrangement.grouping === "environment"
        ? options.environmentLabel(item.hostId)
        : (item.groupName ?? "No Project");
    const bucket = groups.get(heading) ?? [];
    bucket.push(item);
    groups.set(heading, bucket);
  }
  return [...groups.entries()]
    .map(([heading, grouped]) => ({ heading, items: grouped }))
    .sort((left, right) => left.heading.localeCompare(right.heading, "en-US"));
}
