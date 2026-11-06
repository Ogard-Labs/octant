import type { NightlyWindowBootstrap } from "@octant/contracts/nightly-browser";
import { decodeCodeOperationApprovalRequest } from "@octant/contracts/code-operations";
import {
  cancelCodeOperationApprovalFromServer,
  confirmCodeOperationApprovalFromServer,
  prepareCodeOperationApprovalChallengeFromServer,
} from "./codeOperationApproval";
import {
  CODE_OPERATION_APPROVAL_VIEW_CHANNELS,
  codeApprovalBoundsForAnchor,
  codeApprovalFallbackBounds,
  createCodeOperationApprovalViewController,
  decodeCodeOperationApprovalAnchor,
  decodeCodeOperationApprovalPalette,
  decodeCodeOperationApprovalPresentation,
  decodeCodeOperationApprovalViewDecision,
  type ApprovalHostWindow,
  type CodeOperationApprovalPalette,
  type CodeOperationApprovalViewHost,
} from "./codeOperationApprovalView";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";
import { NEEDS_NEWER_OCTANT } from "./nightlyClientChannels";
import type { NativeMainAuthority } from "./nightlyNativeMainAuthority";

export interface NightlyCodeApprovalOptions<TWindow extends ApprovalHostWindow> {
  readonly register: (
    channel: string,
    handler: (event: Electron.IpcMainInvokeEvent, ...values: unknown[]) => unknown,
  ) => void;
  /**
   * Registers the approval view's own decision channel. Its sender is the
   * native view, never a Nightly window, so it is not a window channel.
   */
  readonly handleViewDecision: (
    channel: string,
    handler: (event: { readonly sender: { readonly id: number } }, value: unknown) => unknown,
  ) => void;
  readonly owns: (event: Electron.IpcMainInvokeEvent) => TWindow;
  readonly bootstrap: (webContentsId: number) => NightlyWindowBootstrap | undefined;
  readonly nativeMain: NativeMainAuthority;
  /** The native approval view that Octant's main also uses. */
  readonly views: Pick<CodeOperationApprovalViewHost<TWindow>, "createView" | "attach" | "detach">;
  /** Nightly main's own Node transport, which keeps the main-only token. */
  readonly fetch: typeof globalThis.fetch;
}

/**
 * Code operation approvals in a Nightly window, from the same owner-only
 * native view Octant shows. The renderer may only ask for an approval, move
 * its anchor or cancel it; the host's confirm route is called only from that
 * view's own decision, sent by the view's web contents with its one-time
 * token after the person's click. Prepare, confirm and cancel reach the host
 * with the window's main-only token.
 */
export function installNightlyCodeApprovals<TWindow extends ApprovalHostWindow>(
  options: NightlyCodeApprovalOptions<TWindow>,
) {
  const senderByWindow = new Map<string, number>();
  const palettes = new Map<string, CodeOperationApprovalPalette>();
  const host = (windowId: string) => {
    const id = senderByWindow.get(windowId);
    const bootstrap = id === undefined ? undefined : options.bootstrap(id);
    const headers = id === undefined ? undefined : options.nativeMain.headers(id);
    if (bootstrap === undefined || headers === undefined)
      throw new Error("Octant Code approval is unavailable.");
    return { serverUrl: bootstrap.hostOrigin, brokerHeaders: headers };
  };
  const controller = createCodeOperationApprovalViewController<TWindow>({
    host: {
      ...options.views,
      boundsForAnchor: codeApprovalBoundsForAnchor,
      fallbackBounds: codeApprovalFallbackBounds,
      approvalPalette: (windowId) => palettes.get(windowId),
      isWindowDestroyed: (window) => window.isDestroyed(),
    },
    prepare: ({ request, windowId }) =>
      prepareCodeOperationApprovalChallengeFromServer({
        ...host(windowId),
        request,
        fetch: options.fetch,
      }),
    confirm: ({ challengeId, windowId }) =>
      confirmCodeOperationApprovalFromServer({
        ...host(windowId),
        challengeId,
        fetch: options.fetch,
      }),
    cancel: async ({ challengeId, windowId }) => {
      if (!senderByWindow.has(windowId)) return;
      await cancelCodeOperationApprovalFromServer({
        ...host(windowId),
        challengeId,
        fetch: options.fetch,
      });
    },
  });
  const windowOf = (event: Electron.IpcMainInvokeEvent) => {
    const window = options.owns(event);
    const bootstrap = options.bootstrap(event.sender.id);
    if (bootstrap === undefined) throw new Error("Octant Code approval is unavailable.");
    return { window, bootstrap, windowId: String(bootstrap.windowId) };
  };
  options.register(
    DESKTOP_IPC_CHANNELS.requestCodeOperationApproval,
    async (event, request, requestPresentation) => {
      const { window, bootstrap, windowId } = windowOf(event);
      if (!options.nativeMain.supports(event.sender.id, "code-operation-approval"))
        throw new Error(NEEDS_NEWER_OCTANT);
      const decoded = decodeCodeOperationApprovalRequest(request);
      const presentation =
        requestPresentation === undefined
          ? undefined
          : decodeCodeOperationApprovalPresentation(requestPresentation);
      senderByWindow.set(windowId, event.sender.id);
      return await controller.request({
        window,
        windowId,
        windowCapability: bootstrap.capability,
        request: decoded,
        ...(presentation === undefined ? {} : { presentation }),
      });
    },
  );
  options.register(DESKTOP_IPC_CHANNELS.updateCodeOperationApprovalAnchor, (event, value) => {
    const { window, windowId } = windowOf(event);
    controller.updateAnchor({ window, windowId, anchor: decodeCodeOperationApprovalAnchor(value) });
  });
  options.register(DESKTOP_IPC_CHANNELS.cancelCodeOperationApproval, (event) => {
    controller.cancel(windowOf(event).windowId);
  });
  options.register(DESKTOP_IPC_CHANNELS.approvalSurfacePalette, (event, palette) => {
    const { windowId } = windowOf(event);
    const decoded = decodeCodeOperationApprovalPalette(palette);
    // An unreadable palette never blocks an approval; the view keeps the
    // system palette it falls back to.
    if (decoded !== undefined) palettes.set(windowId, decoded);
  });
  options.handleViewDecision(CODE_OPERATION_APPROVAL_VIEW_CHANNELS.decision, async (event, value) =>
    controller.decision({ senderId: event.sender.id, ...decodeCodeOperationApprovalViewDecision(value) }),
  );
  return Object.freeze({
    /** Ends the window's approvals, cancelling any challenge it still holds. */
    closeWindow: (windowId: string): void => {
      controller.closeWindow(windowId);
      palettes.delete(windowId);
      senderByWindow.delete(windowId);
    },
    viewDestroyed: (id: number): void => controller.viewDestroyed(id),
  });
}
