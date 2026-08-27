/**
 * Context passed to a plugin-provided sidebar destination action. It exposes
 * only the panel-opening operations a destination is allowed to perform; the
 * plugin module does not receive the full App state.
 */
export interface SidebarDestinationActionContext {
  readonly closeOverlays: () => void;
  readonly openThreadBoard: () => void;
  readonly openPullRequests: () => void;
}

export type SidebarDestinationAction = (ctx: SidebarDestinationActionContext) => void;

const builtInSidebarDestinationModules: Readonly<Record<string, SidebarDestinationAction>> = {
  "builtin:board/destination": (ctx) => {
    ctx.closeOverlays();
    ctx.openThreadBoard();
  },
  "builtin:github/sidebar-destination": (ctx) => {
    ctx.closeOverlays();
    ctx.openPullRequests();
  },
};

export function loadPluginSidebarDestinationAction(
  entryPoint: string,
): SidebarDestinationAction | undefined {
  return builtInSidebarDestinationModules[entryPoint];
}

export function isPluginSidebarDestinationEntryPoint(entryPoint: string): boolean {
  return entryPoint in builtInSidebarDestinationModules;
}
