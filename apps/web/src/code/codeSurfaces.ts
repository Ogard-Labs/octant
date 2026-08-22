import type { CodeOverviewSurfaceKind } from "./CodeOverview";

const TITLES: Readonly<Record<CodeOverviewSurfaceKind, string>> = {
  "code-terminal": "Terminal",
  "code-test": "Tests",
  "code-git": "Git",
  "code-pr": "Pull request",
};

export function codeSurfaceTitle(kind: CodeOverviewSurfaceKind): string {
  return TITLES[kind];
}

/**
 * The surfaces a reader can open beside a Code thread from the tab launcher.
 *
 * Git and pull-request surfaces are absent on purpose: they are reached from
 * the work they belong to, not from a list of things to open. Each surface here
 * opens against one thread, so the launcher offers them only while that thread
 * is its group's active tab.
 */
export const LAUNCHABLE_CODE_SURFACES = [
  "code-terminal",
  "code-test",
] as const satisfies ReadonlyArray<CodeOverviewSurfaceKind>;
