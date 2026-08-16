import type { CodeThreadView } from "@octant/contracts/code";
import type { OctantHostBridge } from "../shell/hostBridge";
import type { CodeWorkspaceApprovals } from "./CodeWorkspace";

export function nativeCodeWorkspaceApprovals(
  hostBridge: OctantHostBridge | undefined,
  view: CodeThreadView | undefined,
): CodeWorkspaceApprovals | undefined {
  const request = hostBridge?.requestCodeOperationApproval;
  if (request === undefined || view === undefined) return undefined;
  const approve = async (command: Parameters<NonNullable<CodeWorkspaceApprovals["git"]>>[0]) =>
    await request({ effect: { kind: "operation", command } as never });
  return {
    git: async (command) => (await approve(command)) as never,
    pullRequest: async (command) => (await approve(command)) as never,
    review: async ({ command }) => (await approve(command)) !== undefined,
    terminal: async ({ command }) => (await approve(command)) !== undefined,
    test: async ({ command }) => (await approve(command)) !== undefined,
  };
}
