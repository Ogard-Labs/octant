import type { CodeThreadView } from "@octant/contracts/code";
import type { CodeOperationApprovalAnchor, OctantHostBridge } from "../shell/hostBridge";
import type { CodeWorkspaceApprovals } from "./CodeWorkspace";

export function observeComposerPlacement(composer: HTMLElement, observer: ResizeObserver): void {
  // Opening a dock pane shrinks an ancestor column without resizing the composer, so the panel kept its old x until the next unrelated update.
  let current: HTMLElement | null = composer;
  while (current !== null) {
    observer.observe(current);
    current = current.parentElement;
  }
}

export function nativeCodeWorkspaceApprovals(
  hostBridge: OctantHostBridge | undefined,
  view: CodeThreadView | undefined,
): CodeWorkspaceApprovals | undefined {
  const request = hostBridge?.requestCodeOperationApproval;
  if (hostBridge === undefined || request === undefined || view === undefined) return undefined;
  const approve = async (command: Parameters<NonNullable<CodeWorkspaceApprovals["git"]>>[0]) =>
    await request({ effect: { kind: "operation", command } as never });
  const request0 = async (
    appleRequest: Parameters<NonNullable<CodeWorkspaceApprovals["apple"]>>[0],
  ) => await request({ effect: { kind: "apple-action", request: appleRequest } as never });
  const requestAndroid = async (
    androidRequest: Parameters<NonNullable<CodeWorkspaceApprovals["android"]>>[0],
  ) => await request({ effect: { kind: "android-action", request: androidRequest } as never });
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
    // Android Allow input is the same native confirmation, named by the
    // emulator action it authorizes.
    android: async (request) => await requestAndroid(request),
    ...(hostBridge.updateCodeOperationApprovalAnchor === undefined
      ? {}
      : {
          updateAnchor: async (bounds: CodeOperationApprovalAnchor["bounds"]) =>
            await hostBridge.updateCodeOperationApprovalAnchor?.({
              kind: "thread",
              projectId: String(view.thread.projectId),
              threadId: String(view.thread.id),
              bounds,
            }),
        }),
    ...(hostBridge.cancelCodeOperationApproval === undefined
      ? {}
      : { cancel: hostBridge.cancelCodeOperationApproval }),
  };
}
