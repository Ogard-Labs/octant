import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { NightlyHostFeature, NightlyWindowBootstrap } from "@octant/contracts/nightly-browser";
import { decodePreviewHandoffRequest } from "@octant/contracts/previews";
import { openCodeExternalEditorFromServer } from "./codeExternalEditor";
import {
  DESKTOP_IPC_CHANNELS,
  decodeCodeCheckoutOpenRequest,
  decodeCodeExternalEditorRequest,
} from "./ipcChannels";
import { createLocalPluginFolderPicker } from "./localPluginFolderPicker";
import { NEEDS_NEWER_OCTANT } from "./nightlyClientChannels";
import type { NativeMainAuthority } from "./nightlyNativeMainAuthority";
import {
  launchOpenInApplication,
  openCodeCheckoutInApplicationFromServer,
} from "./openInApplications";
import { createNativePreviewHandoffExecutor, openPreviewHandoffFromServer } from "./previewHandoff";
import { createProjectRootPicker } from "./projectRootPicker";
import { createRuntimeBinaryPicker } from "./runtimeBinaryPicker";
import { createSupportBundleSaver } from "./supportBundleSaver";

interface BrokeredWindow {
  readonly isDestroyed: () => boolean;
}

interface BrokeredEvent {
  readonly sender: { readonly id: number };
}

type OpenDialogProperty = "openDirectory" | "openFile" | "dontAddToRecent";

type SpawnChild = (executable: string, arguments_: string[], options: SpawnOptions) => ChildProcess;

export interface NightlyBrokeredFlowOptions<TWindow extends BrokeredWindow> {
  readonly register: (
    channel: string,
    handler: (event: Electron.IpcMainInvokeEvent, ...values: unknown[]) => unknown,
  ) => void;
  /** The window this event's sender owns; throws for any other sender. */
  readonly owns: (event: Electron.IpcMainInvokeEvent) => TWindow;
  readonly bootstrap: (webContentsId: number) => NightlyWindowBootstrap | undefined;
  readonly nativeMain: NativeMainAuthority;
  readonly dialog: {
    readonly showOpenDialog: (
      window: TWindow,
      options: { readonly properties: OpenDialogProperty[] },
    ) => Promise<{ readonly canceled: boolean; readonly filePaths: readonly string[] }>;
    readonly showSaveDialog: (
      window: TWindow,
      options: {
        readonly title: string;
        readonly defaultPath: string;
        readonly buttonLabel: string;
        readonly filters: { name: string; extensions: string[] }[];
        readonly properties: ("createDirectory" | "showOverwriteConfirmation")[];
      },
    ) => Promise<{ readonly canceled: boolean; readonly filePath?: string | undefined }>;
  };
  readonly downloadsDirectory: () => string;
  /**
   * Nightly main's own Node transport. Electron's session fetch decorates
   * request headers and strips the native-main token, so it is never used here.
   */
  readonly fetch: typeof globalThis.fetch;
  readonly shell: {
    readonly showItemInFolder: (path: string) => void;
    readonly openPath: (path: string) => Promise<string>;
  };
  readonly spawn: SpawnChild;
  readonly spawnQuickLook: Parameters<typeof createNativePreviewHandoffExecutor>[0]["spawn"];
  readonly exists: (path: string) => boolean;
  readonly homeDirectory: string;
  readonly platform: NodeJS.Platform;
  readonly pathEnv?: string;
}

/**
 * Nightly's pickers and file handoffs. Each asks Octant's host through the
 * window's native-main admission, so the host sees the same receipt, target and
 * save requests Octant's own main sends. A host that does not broker a flow
 * refuses it before any dialog opens.
 */
export function installNightlyBrokeredFlows<TWindow extends BrokeredWindow>(
  options: NightlyBrokeredFlowOptions<TWindow>,
): void {
  const { register } = options;
  /** The window, host and headers for one call, or the honest refusal. */
  const brokered = (event: Electron.IpcMainInvokeEvent, feature: NightlyHostFeature) => {
    const window = options.owns(event);
    const id = event.sender.id;
    const bootstrap = options.bootstrap(id);
    if (bootstrap === undefined || !options.nativeMain.supports(id, feature))
      throw new Error(NEEDS_NEWER_OCTANT);
    return {
      window,
      serverUrl: bootstrap.hostOrigin,
      windowId: String(bootstrap.windowId),
      brokerHeaders: () => {
        const headers = options.nativeMain.headers(id);
        if (headers === undefined) throw new Error(NEEDS_NEWER_OCTANT);
        return headers;
      },
      // The dialog may outlive the window or its lease; a picked path is only
      // sent for the window that is still the sender's own.
      resolveOwnedWindow: (sender: unknown) => {
        if (sender !== event.sender) return undefined;
        try {
          return options.owns(event) === window ? window : undefined;
        } catch {
          return undefined;
        }
      },
    };
  };
  const openDialog = {
    showOpenDialog: (
      owner: TWindow,
      dialogOptions: { readonly properties: ReadonlyArray<OpenDialogProperty> },
    ) => options.dialog.showOpenDialog(owner, { properties: [...dialogOptions.properties] }),
  };
  register(DESKTOP_IPC_CHANNELS.selectProjectRoot, async (event, projectType) => {
    const call = brokered(event, "project-root-receipts");
    return await createProjectRootPicker<TWindow>({
      ...call,
      dialog: openDialog,
      fetch: options.fetch,
    })(event as BrokeredEvent, projectType);
  });
  for (const [channel, purpose] of [
    [DESKTOP_IPC_CHANNELS.selectLocalPluginFolder, "plugin-import"],
    [DESKTOP_IPC_CHANNELS.selectSkillFolder, "skill-folder"],
  ] as const)
    register(channel, async (event) => {
      const call = brokered(event, "local-folder-receipts");
      return await createLocalPluginFolderPicker<TWindow>({
        ...call,
        dialog: openDialog,
        fetch: options.fetch,
      })(event as BrokeredEvent, purpose);
    });
  register(DESKTOP_IPC_CHANNELS.selectRuntimeBinary, async (event) => {
    const call = brokered(event, "runtime-binary-receipts");
    return await createRuntimeBinaryPicker<TWindow>({
      ...call,
      dialog: openDialog,
      fetch: options.fetch,
    })(event as BrokeredEvent);
  });
  register(DESKTOP_IPC_CHANNELS.saveSupportBundle, async (event) => {
    const call = brokered(event, "support-bundle-save");
    return await createSupportBundleSaver<TWindow>({
      brokerHeaders: call.brokerHeaders,
      resolveOwnedWindow: call.resolveOwnedWindow,
      serverUrl: call.serverUrl,
      defaultDirectory: options.downloadsDirectory(),
      fetch: options.fetch,
      dialog: {
        showSaveDialog: async (owner, saveOptions) => {
          const chosen = await options.dialog.showSaveDialog(owner, {
            title: saveOptions.title,
            defaultPath: saveOptions.defaultPath,
            buttonLabel: saveOptions.buttonLabel,
            filters: saveOptions.filters.map((filter) => ({
              name: filter.name,
              extensions: [...filter.extensions],
            })),
            properties: [...saveOptions.properties],
          });
          return { canceled: chosen.canceled, filePath: chosen.filePath ?? "" };
        },
      },
    })(event as BrokeredEvent);
  });
  register(DESKTOP_IPC_CHANNELS.openCodeExternalEditor, async (event, request) => {
    const call = brokered(event, "code-external-editor-target");
    let decoded: ReturnType<typeof decodeCodeExternalEditorRequest>;
    try {
      decoded = decodeCodeExternalEditorRequest(request);
    } catch {
      throw new Error("Octant rejected an invalid external editor request.");
    }
    await openCodeExternalEditorFromServer({
      serverUrl: call.serverUrl,
      brokerHeaders: call.brokerHeaders,
      windowId: call.windowId,
      request: decoded,
      fetch: options.fetch,
      spawn: (executable, arguments_, spawnOptions) =>
        options.spawn(executable, [...arguments_], spawnOptions),
    });
  });
  register(DESKTOP_IPC_CHANNELS.openCodeCheckoutInApplication, async (event, request) => {
    const call = brokered(event, "code-checkout-open-target");
    let decoded: ReturnType<typeof decodeCodeCheckoutOpenRequest>;
    try {
      decoded = decodeCodeCheckoutOpenRequest(request);
    } catch {
      throw new Error("Octant rejected an invalid Open in request.");
    }
    await openCodeCheckoutInApplicationFromServer({
      serverUrl: call.serverUrl,
      brokerHeaders: call.brokerHeaders,
      windowId: call.windowId,
      request: decoded,
      fetch: options.fetch,
      launch: ({ applicationId, checkoutRoot }) =>
        launchOpenInApplication({
          applicationId,
          checkoutRoot,
          exists: options.exists,
          homeDirectory: options.homeDirectory,
          platform: options.platform,
          ...(options.pathEnv === undefined ? {} : { pathEnv: options.pathEnv }),
          shell: options.shell,
          spawn: (executable, arguments_, spawnOptions) =>
            options.spawn(executable, [...arguments_], spawnOptions),
        }),
    });
  });
  const previewExecutor = createNativePreviewHandoffExecutor({
    shell: options.shell,
    platform: options.platform,
    ...(options.pathEnv === undefined ? {} : { pathEnv: options.pathEnv }),
    exists: options.exists,
    spawn: options.spawnQuickLook,
  });
  // As in Octant, a newer handoff for the same target supersedes the last.
  const previewHandoffs = new Map<string, AbortController>();
  register(DESKTOP_IPC_CHANNELS.previewHandoff, async (event, request) => {
    const call = brokered(event, "preview-handoff");
    let decoded: ReturnType<typeof decodePreviewHandoffRequest>;
    try {
      decoded = decodePreviewHandoffRequest(request);
    } catch {
      throw new Error("Octant rejected an invalid preview handoff request.");
    }
    const key = `${event.sender.id}:${String(decoded.target.targetId)}`;
    previewHandoffs.get(key)?.abort();
    const controller = new AbortController();
    previewHandoffs.set(key, controller);
    try {
      await openPreviewHandoffFromServer({
        serverUrl: call.serverUrl,
        brokerHeaders: call.brokerHeaders,
        windowId: call.windowId,
        request: {
          target: {
            targetId: String(decoded.target.targetId),
            projectId: String(decoded.target.projectId),
            hostId: String(decoded.target.hostId),
            kind: decoded.target.kind,
            opaqueRef: String(decoded.target.opaqueRef),
            displayName: decoded.target.displayName,
          },
          kind: decoded.kind,
        },
        fetch: options.fetch,
        execute: previewExecutor,
        signal: controller.signal,
      });
    } finally {
      if (previewHandoffs.get(key) === controller) previewHandoffs.delete(key);
    }
  });
}
