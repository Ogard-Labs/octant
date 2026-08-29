import type {
  FederatedHostReadFreshness,
  FederatedHostState,
  FederatedReadItem,
} from "./hostFederationMergedReads";

/**
 * Environments: the user-facing name for a connected host.
 *
 * It is a view concept and nothing more. Filtering by environment changes what
 * a list shows and never what anything may do — an item is still owned and
 * executed only by its own host, and reaching one still goes through that
 * host's transport under remote authority. Nothing here grants, widens, or
 * clamps anything.
 *
 * This is the one place the vocabulary lives, so the sidebar, the routines
 * list, and the artifact library filter the same way rather than each growing
 * their own idea of what "this environment" means.
 */

export const LOCAL_ENVIRONMENT_LABEL = "Local";

/**
 * Which environments a view is showing.
 *
 * `all` is not the same as "every id I currently know". A host that connects
 * later is included by `all` and would have been silently excluded by a frozen
 * set, which is the bug that makes a new machine's work invisible.
 */
export type EnvironmentSelection =
  | { readonly kind: "all" }
  | { readonly kind: "some"; readonly hostIds: ReadonlySet<string> };

export const ALL_ENVIRONMENTS: EnvironmentSelection = { kind: "all" };

/**
 * How reachable an environment is, in the terms a row shows.
 *
 * Derived from the host's own read freshness rather than tracked separately, so
 * a row cannot disagree with the items beneath it.
 */
export type EnvironmentReach = "ready" | "stale" | "connecting" | "unreachable";

export interface EnvironmentRow {
  readonly hostId: string;
  /** What to call it. The local host is "Local", whatever it is named. */
  readonly label: string;
  readonly isLocal: boolean;
  readonly reach: EnvironmentReach;
  readonly itemCount: number;
  readonly checked: boolean;
}

export function environmentReach(freshness: FederatedHostReadFreshness): EnvironmentReach {
  switch (freshness) {
    case "ready":
      return "ready";
    case "connecting":
      return "connecting";
    case "stale":
      return "stale";
    case "unavailable":
    case "unauthorized":
    case "incompatible":
      return "unreachable";
  }
}

/**
 * What an environment is called on a row.
 *
 * The local host is always "Local" — a person does not think of their own
 * machine by its name, and two people looking at the same federation should
 * each see their own as Local.
 */
export function environmentLabel(input: {
  readonly hostId: string;
  readonly hostDisplayName?: string;
  readonly localHostId?: string;
}): string {
  if (input.localHostId !== undefined && input.hostId === input.localHostId) {
    return LOCAL_ENVIRONMENT_LABEL;
  }
  const named = input.hostDisplayName?.trim();
  return named === undefined || named.length === 0 ? input.hostId : named;
}

/**
 * The environment rows a filter menu offers.
 *
 * Local first, then the rest by name: the machine you are sitting at is the one
 * you look for. An unreachable environment keeps its row rather than
 * disappearing — a host that dropped out is a thing to see, not a thing to
 * hide, and its items are still listed as stale beneath it.
 */
export function environmentRows(input: {
  readonly hostStates: ReadonlyArray<FederatedHostState>;
  readonly selection: EnvironmentSelection;
  readonly localHostId?: string;
}): ReadonlyArray<EnvironmentRow> {
  return input.hostStates
    .map((state): EnvironmentRow => {
      const hostId = String(state.hostId);
      const isLocal = input.localHostId !== undefined && hostId === input.localHostId;
      return {
        hostId,
        label: environmentLabel({
          hostId,
          hostDisplayName: state.hostDisplayName,
          ...(input.localHostId === undefined ? {} : { localHostId: input.localHostId }),
        }),
        isLocal,
        reach: environmentReach(state.freshness),
        itemCount: state.itemCount,
        checked: isEnvironmentSelected(input.selection, hostId),
      };
    })
    .sort((left, right) => {
      if (left.isLocal !== right.isLocal) return left.isLocal ? -1 : 1;
      return left.label.localeCompare(right.label, "en-US");
    });
}

export function isEnvironmentSelected(selection: EnvironmentSelection, hostId: string): boolean {
  return selection.kind === "all" || selection.hostIds.has(hostId);
}

/** Whether the "All environments" master checkbox reads as ticked. */
export function allEnvironmentsSelected(
  selection: EnvironmentSelection,
  knownHostIds: ReadonlyArray<string>,
): boolean {
  return selection.kind === "all" || knownHostIds.every((hostId) => selection.hostIds.has(hostId));
}

/**
 * Tick or untick one environment.
 *
 * Unticking one while "all" is on becomes "everything except this one", which
 * is what a person means by clicking it. Ticking the last missing one collapses
 * back to `all` rather than freezing today's set, so a host that connects
 * tomorrow is still included.
 */
export function toggleEnvironment(
  selection: EnvironmentSelection,
  hostId: string,
  knownHostIds: ReadonlyArray<string>,
): EnvironmentSelection {
  const current = selection.kind === "all" ? new Set(knownHostIds) : new Set(selection.hostIds);
  if (current.has(hostId)) {
    current.delete(hostId);
  } else {
    current.add(hostId);
  }
  const coversEverything =
    knownHostIds.length > 0 && knownHostIds.every((candidate) => current.has(candidate));
  return coversEverything ? ALL_ENVIRONMENTS : { kind: "some", hostIds: current };
}

/**
 * Tick or untick every environment at once.
 *
 * Unticking all of them selects none rather than silently meaning everything:
 * an empty list is a state a person can see and undo, and quietly showing all
 * of them would make the checkbox appear broken.
 */
export function toggleAllEnvironments(selection: EnvironmentSelection): EnvironmentSelection {
  return selection.kind === "all" ? { kind: "some", hostIds: new Set() } : ALL_ENVIRONMENTS;
}

/**
 * Drop host ids that are no longer registered. When nothing selected remains,
 * restore `all` so create destination preselect is not stuck on a removed host.
 */
export function pruneEnvironmentSelection(
  selection: EnvironmentSelection,
  knownHostIds: ReadonlyArray<string>,
): EnvironmentSelection {
  if (selection.kind === "all") return selection;
  const known = new Set(knownHostIds);
  const remaining = new Set([...selection.hostIds].filter((hostId) => known.has(hostId)));
  if (remaining.size === 0) return ALL_ENVIRONMENTS;
  if (
    knownHostIds.length > 0 &&
    knownHostIds.every((hostId) => remaining.has(hostId)) &&
    remaining.size === known.size
  ) {
    return ALL_ENVIRONMENTS;
  }
  if (remaining.size === selection.hostIds.size) return selection;
  return { kind: "some", hostIds: remaining };
}

/**
 * The items the chosen environments contribute.
 *
 * An item from an unreachable environment is kept when its environment is
 * selected — it is stale, not gone, and the reconnect-replay behaviour the rest
 * of the client already has depends on a list that does not flicker away when a
 * host drops.
 */
export function selectEnvironmentItems<TPayload>(
  items: ReadonlyArray<FederatedReadItem<TPayload>>,
  selection: EnvironmentSelection,
  hostIdOf: (item: FederatedReadItem<TPayload>) => string,
): ReadonlyArray<FederatedReadItem<TPayload>> {
  if (selection.kind === "all") return items;
  return items.filter((item) => selection.hostIds.has(hostIdOf(item)));
}

/**
 * A short line describing the current selection, for a collapsed filter button.
 *
 * It names environments rather than counting them until there are too many,
 * because "Local, Devbox" tells you what you are looking at and "2 selected"
 * does not.
 */
export function environmentSelectionSummary(
  rows: ReadonlyArray<EnvironmentRow>,
  selection: EnvironmentSelection,
): string {
  if (selection.kind === "all") return "All environments";
  const chosen = rows.filter((row) => row.checked);
  if (chosen.length === 0) return "No environments";
  if (chosen.length <= 2) return chosen.map((row) => row.label).join(", ");
  return `${String(chosen.length)} environments`;
}
