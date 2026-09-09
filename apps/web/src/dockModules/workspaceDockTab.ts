import { decodeWorkspaceTabId } from "@octant/contracts";
export const dockTabIds = {
  browser: decodeWorkspaceTabId("90000000-0000-4000-8000-000000000001"),
  "side-chat": decodeWorkspaceTabId("90000000-0000-4000-8000-000000000002"),
  terminal: decodeWorkspaceTabId("90000000-0000-4000-8000-000000000004"),
  tests: decodeWorkspaceTabId("90000000-0000-4000-8000-000000000005"),
  "ios-simulator": decodeWorkspaceTabId("90000000-0000-4000-8000-000000000006"),
} as const;

export function workspaceDockTabId(
  utilityTabId: string | undefined,
  surface: "browser" | "terminal",
): ReturnType<typeof decodeWorkspaceTabId> {
  if (utilityTabId !== undefined && utilityTabId !== surface) {
    return decodeWorkspaceTabId(utilityTabId);
  }
  return dockTabIds[surface];
}
