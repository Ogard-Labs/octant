/**
 * Context passed to a plugin-provided sidebar destination action. It exposes
 * only the panel-opening operations a destination is allowed to perform; the
 * plugin module does not receive the full App state.
 */
export interface SidebarDestinationActionContext {
  readonly closeOverlays: () => void;
  readonly openThreadBoard: () => void;
  readonly openPullRequests: () => void;
  readonly openGithubIssues: () => void;
  readonly openLinearIssues: () => void;
}

export type SidebarDestinationAction = (ctx: SidebarDestinationActionContext) => void;

export type PluginSidebarDestinationActionResult =
  | { readonly kind: "ready"; readonly action: SidebarDestinationAction }
  | { readonly kind: "unknown"; readonly entryPoint: string };

const builtInSidebarDestinationActions: ReadonlyMap<string, SidebarDestinationAction> = new Map([
  [
    "builtin:board/destination",
    (ctx) => {
      ctx.closeOverlays();
      ctx.openThreadBoard();
    },
  ],
  [
    "builtin:github/sidebar-destination",
    (ctx) => {
      ctx.closeOverlays();
      ctx.openPullRequests();
    },
  ],
  [
    "builtin:github/issues-destination",
    (ctx) => {
      ctx.closeOverlays();
      ctx.openGithubIssues();
    },
  ],
  [
    "builtin:linear/sidebar-destination",
    (ctx) => {
      ctx.closeOverlays();
      ctx.openLinearIssues();
    },
  ],
]);

/**
 * Returns a plugin sidebar-destination action by its entry point. Unknown
 * entry points are reported as a discriminated result.
 */
export function loadPluginSidebarDestinationAction(
  entryPoint: string,
): PluginSidebarDestinationActionResult {
  const action = builtInSidebarDestinationActions.get(entryPoint);
  if (action === undefined) {
    return { kind: "unknown", entryPoint };
  }
  return { kind: "ready", action };
}

/**
 * Returns whether the given string is a registered plugin sidebar-destination
 * entry point. Only own keys of the registry are considered.
 */
export function isPluginSidebarDestinationEntryPoint(entryPoint: string): boolean {
  return builtInSidebarDestinationActions.has(entryPoint);
}
