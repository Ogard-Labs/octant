import type {
  DockTileColumn,
  DockTileLayout,
  ThreadUtilityDockState,
} from "./rightUtilityDockSelection";

/**
 * How the dock divides between the Environment strip and the tool columns.
 * Environment is a thin, static strip of its own; every other shown tool is in
 * the tile layout beside it. Pure, so the width model, the surface and the
 * resize handle read one answer.
 */
export interface DockEnvironmentSplit {
  /** The open Environment tab, absent when Environment is not open. */
  readonly environmentTabId?: string;
  /** The tool tabs drawn in the tool columns, in layout order. */
  readonly toolTabIds: ReadonlyArray<string>;
  /** The tool columns, absent while no tool is shown. */
  readonly toolLayout?: DockTileLayout;
  /** The column of the stored layout each tool column came from. */
  readonly columnOrigins: ReadonlyArray<number>;
}

export function splitEnvironmentStrip(state: ThreadUtilityDockState): DockEnvironmentSplit {
  const environmentTabId = state.tabs.find((tab) => tab.surface === "environment")?.id;
  if (environmentTabId === undefined) return layoutOf(state, undefined);
  return { environmentTabId, ...layoutOf(state, environmentTabId) };
}

function layoutOf(
  state: ThreadUtilityDockState,
  environmentTabId: string | undefined,
): Omit<DockEnvironmentSplit, "environmentTabId"> {
  if (state.layout !== undefined) {
    const columns: DockTileColumn[] = [];
    const columnOrigins: number[] = [];
    state.layout.columns.forEach((column, index) => {
      const tiles = column.tiles.filter((tile) => tile.tabId !== environmentTabId);
      if (tiles.length === 0) return;
      const total = tiles.reduce((sum, tile) => sum + tile.share, 0);
      columns.push({
        share: column.share,
        tiles: tiles.map((tile) => ({ ...tile, share: tile.share / total })),
      });
      columnOrigins.push(index);
    });
    const total = columns.reduce((sum, column) => sum + column.share, 0);
    if (columns.length === 0) return { toolTabIds: [], columnOrigins: [] };
    return {
      toolTabIds: columns.flatMap((column) => column.tiles.map((tile) => tile.tabId)),
      toolLayout: {
        columns: columns.map((column) => ({ ...column, share: column.share / total })),
      },
      columnOrigins,
    };
  }
  const minimised = new Set(state.minimised ?? []);
  const isTool = (id: string) =>
    id !== environmentTabId && !minimised.has(id) && state.tabs.some((tab) => tab.id === id);
  // Environment in front with a tool open behind it: the tool stays on screen,
  // because the strip never takes the tool's place.
  const shown =
    state.active !== undefined && isTool(state.active)
      ? state.active
      : state.active !== undefined && state.active === environmentTabId
        ? [...state.tabs].reverse().find((tab) => isTool(tab.id))?.id
        : undefined;
  if (shown === undefined) return { toolTabIds: [], columnOrigins: [] };
  return {
    toolTabIds: [shown],
    toolLayout: { columns: [{ share: 1, tiles: [{ tabId: shown, share: 1 }] }] },
    columnOrigins: [0],
  };
}

/**
 * The dock state with Environment kept apart from the tiles: it is never a tile
 * in the layout and never the tool in front while another tool is shown. As a
 * tile it counted toward the caps, made a second column out of one tool
 * (Environment | Browser), and was the tile a press replaced, which took the
 * section off screen while its tab stayed open. Tile changes are made on this
 * state, so no placement, cap or replacement can reach the section.
 */
export function environmentApart(state: ThreadUtilityDockState): ThreadUtilityDockState {
  const environmentId = state.tabs.find((tab) => tab.surface === "environment")?.id;
  if (environmentId === undefined) return state;
  const tools = layoutOf(state, environmentId);
  const active =
    tools.toolTabIds.length === 0
      ? environmentId
      : state.active !== undefined && tools.toolTabIds.includes(state.active)
        ? state.active
        : tools.toolTabIds[0];
  const inLayout =
    state.layout?.columns.some((column) =>
      column.tiles.some((tile) => tile.tabId === environmentId),
    ) === true;
  if (!inLayout && active === state.active) return state;
  const { layout: stored, active: _front, ...rest } = state;
  const layout = stored === undefined ? undefined : tools.toolLayout;
  return {
    ...rest,
    ...(active === undefined ? {} : { active }),
    ...(layout === undefined ? {} : { layout }),
  };
}

/**
 * Opens the Environment section and changes nothing else: the tools shown, the
 * tool in front and every tile stay as they are.
 */
export function withEnvironmentOpen(state: ThreadUtilityDockState): ThreadUtilityDockState {
  if (state.tabs.some((tab) => tab.surface === "environment")) return state;
  return {
    ...state,
    tabs: [...state.tabs, { id: "environment", surface: "environment" }],
    ...(state.active === undefined && state.layout === undefined ? { active: "environment" } : {}),
  };
}

/**
 * A column resize measured on the tool columns, put back onto the stored
 * layout: the Environment tile (when it is in the layout) keeps its share.
 */
export function storedColumnShares(
  state: ThreadUtilityDockState,
  split: DockEnvironmentSplit,
  toolShares: ReadonlyArray<number>,
): ReadonlyArray<number> | undefined {
  const stored = state.layout?.columns;
  if (stored === undefined) return undefined;
  const kept = stored.reduce(
    (sum, column, index) => (split.columnOrigins.includes(index) ? sum + column.share : sum),
    0,
  );
  return stored.map((column, index) => {
    const at = split.columnOrigins.indexOf(index);
    return at === -1 ? column.share : (toolShares[at] ?? 0) * kept;
  });
}

/** The same for the heights inside one tool column. */
export function storedTileShares(
  state: ThreadUtilityDockState,
  split: DockEnvironmentSplit,
  toolColumn: number,
  toolShares: ReadonlyArray<number>,
): { readonly column: number; readonly shares: ReadonlyArray<number> } | undefined {
  const origin = split.columnOrigins[toolColumn];
  const stored = origin === undefined ? undefined : state.layout?.columns[origin];
  if (origin === undefined || stored === undefined) return undefined;
  const shownIds = split.toolLayout?.columns[toolColumn]?.tiles.map((tile) => tile.tabId) ?? [];
  const kept = stored.tiles.reduce(
    (sum, tile) => (shownIds.includes(tile.tabId) ? sum + tile.share : sum),
    0,
  );
  return {
    column: origin,
    shares: stored.tiles.map((tile) => {
      const at = shownIds.indexOf(tile.tabId);
      return at === -1 ? tile.share : (toolShares[at] ?? 0) * kept;
    }),
  };
}
