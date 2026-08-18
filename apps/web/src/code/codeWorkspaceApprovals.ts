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
  const request0 = async (
    appleRequest: Parameters<NonNullable<CodeWorkspaceApprovals["apple"]>>[0],
  ) => await request({ effect: { kind: "apple-action", request: appleRequest } as never });
  return {
    // Raising a thread to Full access is the same native confirmation the host
    // demands for a full-access thread at creation, named by the effect it
    // authorizes rather than by the surface that asked for it.
    access: async (effect) => (await request({ effect: { ...effect } as never })) as never,
    git: async (command) => (await approve(command)) as never,
    pullRequest: async (command) => (await approve(command)) as never,
    review: async ({ command }) => (await approve(command)) !== undefined,
    test: async ({ command }) => (await approve(command)) !== undefined,
    // An Apple action is confirmed by the action it would run, not by the pane
    // that asked, so the host prompt names the same effect it will authorize.
    apple: async (request) => await request0(request),
  };
}
