import { contextBridge, ipcRenderer } from "electron";
import type { CodeApprovalId, CodeOperationApprovalRequest } from "@octant/contracts";
import type { OpenInApplicationId } from "@octant/contracts/shell";

export const HOST_BRIDGE_KEY = "octantHost";

export const IPC_CHANNELS = {
  attentionBadge: "octant:attention:badge",
  attentionNotify: "octant:attention:notify",
  browserSurfaceAttach: "octant:browser-surface:attach",
  browserSurfaceBounds: "octant:browser-surface:bounds",
  browserSurfaceCommand: "octant:browser-surface:command",
  browserSurfaceDetach: "octant:browser-surface:detach",
  browserSurfaceOpenExternal: "octant:browser-surface:open-external",
  browserSurfaceState: "octant:browser-surface:state",
  browserSurfaceTab: "octant:browser-surface:tab",
  appUpdateState: "octant:app-update:state",
  appUpdateCheck: "octant:app-update:check",
  appUpdateDownload: "octant:app-update:download",
  appUpdateInstall: "octant:app-update:install",
  appUpdateAutomatic: "octant:app-update:automatic",
  appUpdateRing: "octant:app-update:ring",
  clearProviderCredential: "octant:provider-credential:clear",
  codeDeepLink: "octant:code:deep-link",
  close: "octant:window:close",
  maximizeOrRestore: "octant:window:maximize-or-restore",
  minimize: "octant:window:minimize",
  openCodeExternalEditor: "octant:code:open-external-editor",
  listOpenInApplications: "octant:code:list-open-in-applications",
  openCodeCheckoutInApplication: "octant:code:open-checkout-in-application",
  openInNewWindow: "octant:window:open-project",
  openSettings: "octant:menu:open-settings",
  previewHandoff: "octant:preview:handoff",
  requestCodeOperationApproval: "octant:code:request-operation-approval",
  startNewAgent: "octant:menu:start-new-agent",
  providerCredentialStatus: "octant:provider-credential:status",
  resetBounds: "octant:window:reset-bounds",
  selectProjectRoot: "octant:project:select-root",
  selectLocalPluginFolder: "octant:extensions:select-local-plugin-folder",
  setProviderCredential: "octant:provider-credential:set",
  hostCapabilities: "octant:window:host-capabilities",
  resolvedMaterial: "octant:window:resolved-material",
  resolvedSidebarVibrancy: "octant:window:resolved-sidebar-vibrancy",
  sidebarMaterialPreference: "octant:window:sidebar-material-preference",
  sidebarVibrancyMode: "octant:window:sidebar-vibrancy-mode",
  privateListenerStatus: "octant:private-listener:status",
  privateListenerEnable: "octant:private-listener:enable",
  privateListenerDisable: "octant:private-listener:disable",
  privateListenerRestart: "octant:private-listener:restart",
  remotePairingRequests: "octant:remote-device:pairing-requests",
  remotePairingApprove: "octant:remote-device:pairing-approve",
  remotePairingDeny: "octant:remote-device:pairing-deny",
  remoteDeviceInventory: "octant:remote-device:inventory",
  remoteDeviceRename: "octant:remote-device:rename",
  remoteDeviceRevoke: "octant:remote-device:revoke",
  remoteDeviceRevokeAll: "octant:remote-device:revoke-all",
  remoteDeviceReconcileExpired: "octant:remote-device:reconcile-expired",
  remoteHostIdentityStatus: "octant:remote-host-identity:status",
  remoteHostIdentityRotate: "octant:remote-host-identity:rotate",
  remoteHostIdentityRecover: "octant:remote-host-identity:recover",
} as const;

type ResolvedSidebarMaterial = "opaque" | "translucent";
type SidebarMaterialPreference = "opaque" | "system";
type SidebarVibrancyMode = "off" | "subtle" | "strong";
export interface HostCapabilities {
  readonly sidebarVibrancySupported: boolean;
  readonly liveBrowserSupported: boolean;
  readonly liveSimulatorFrameSupported: boolean;
}

export interface AppUpdateRelease {
  readonly version: string;
  readonly platform: string;
  readonly arch: string;
  readonly url: string;
  readonly sha256: string;
  readonly releasedAt: string;
  readonly notes?: string;
}

export interface AppUpdateState {
  readonly status: string;
  readonly currentVersion: string;
  readonly available?: AppUpdateRelease;
  readonly refusal?: string;
  readonly message?: string;
  readonly checkedAt?: string;
  readonly automaticChecks: boolean;
}

export type AppUpdateInstallOutcome =
  | { readonly kind: "installing" }
  | {
      readonly kind: "wait";
      readonly activeAgentCount: number;
      readonly attentionRequired: boolean;
    }
  | { readonly kind: "not-ready" };

export interface BrowserSurfaceTabState {
  readonly tabId: string;
  readonly url: string;
  readonly title: string;
}

export interface BrowserSurfaceState {
  readonly contextId: string;
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly control: "idle" | "user" | "agent";
  readonly tabs: ReadonlyArray<BrowserSurfaceTabState>;
  readonly activeTabId: string;
}

export type BrowserSurfaceTabCommand =
  | { readonly kind: "open" }
  | { readonly kind: "select"; readonly tabId: string }
  | { readonly kind: "close"; readonly tabId: string };

export interface BrowserSurfaceRequest {
  readonly contextId: string;
  readonly threadId: string;
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

export type PrivateListenerExposureClass = "lan-private" | "tailscale";
export type PrivateListenerControlFailureCode =
  | "local-confirmation-required"
  | "invalid-bind"
  | "invalid-origin"
  | "invalid-tls"
  | "occupied-port"
  | "interface-unavailable"
  | "bind-failed"
  | "shutdown-failed"
  | "unavailable";

export interface PrivateListenerPublicStatus {
  readonly enabled: boolean;
  readonly state: "disabled" | "ready" | "failed";
  readonly hostname: string | null;
  readonly port: number | null;
  readonly origin: string | null;
  readonly exposureClass: PrivateListenerExposureClass | null;
  readonly certificateFingerprint: string | null;
  readonly certificateReady: boolean;
  readonly errorCode?: PrivateListenerControlFailureCode;
}

export interface PrivateListenerEnableBridgeRequest {
  readonly hostname: string;
  readonly port: number;
  readonly origin: string;
  readonly certificatePem: string;
  readonly privateKeyPem: string;
  readonly localConfirmation: true;
}

export type RemoteDeviceSourceClass = "loopback" | "lan-private" | "tailscale" | "unknown";
export type RemoteDeviceState = "active" | "revoked" | "expired";

export interface RemotePendingPairingRequest {
  readonly kind: "pending";
  readonly ticketId: string;
  readonly hostId: string;
  readonly deviceLabel: string;
  readonly deviceKeyFingerprint: string;
  readonly origin: string;
  readonly sourceClass: RemoteDeviceSourceClass;
  readonly comparisonCode: string;
  readonly claimedAt: string;
  readonly expiresAt: string;
}

export interface RemoteDeviceInventoryEntry {
  readonly hostId: string;
  readonly deviceId: string;
  readonly deviceKeyFingerprint: string;
  readonly deviceLabel: string;
  readonly origin: string;
  readonly protocolFloor: number;
  readonly credentialGeneration: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastSeenAt: string;
  readonly state: RemoteDeviceState;
  readonly revokedAt?: string;
  readonly revokedReason?: string;
}

export interface RemotePairingApprovalResult {
  readonly decision: "approved";
  readonly device: RemoteDeviceInventoryEntry;
}

export interface RemotePairingDenialResult {
  readonly decision: "denied";
}

export interface RemoteCredentialOperationReceipt {
  readonly commandId: string;
  readonly result: "applied" | "already-applied";
  readonly occurredAt: string;
}

export type RemoteHostIdentityRecoveryState =
  | {
      readonly status: "ready";
      readonly reason: null;
      readonly remoteIdentityUsable: true;
      readonly localDesktopUsable: true;
      readonly fingerprint: string;
    }
  | {
      readonly status: "recovery-required";
      readonly reason: "failed" | "invalid" | "missing" | "unavailable";
      readonly remoteIdentityUsable: false;
      readonly localDesktopUsable: true;
    };

export interface RemoteHostIdentityRotationResult {
  readonly status: "rotated";
  readonly fingerprint: string;
}
type MaterialListener = (event: unknown, material: unknown) => void;
type DeepLinkListener = (event: unknown, target: unknown) => void;
type AgentStartListener = (event: unknown) => void;
type SettingsOpenListener = (event: unknown) => void;
type BoundProjectType = "work" | "code";
type ProviderCredentialStatus = "stored" | "missing" | "unavailable";
const MAX_PROVIDER_CREDENTIAL_BYTES = 12 * 1_024;
const PROVIDER_INSTANCE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type ProjectRootPickerResult =
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "selected"; receiptId: string; displayName: string }>;
type LocalPluginFolderPickerResult =
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "selected"; receiptId: string; displayName: string }>;
export interface CodeExternalEditorRequest {
  readonly threadId: string;
  readonly checkoutId: string;
  readonly fileId: string;
  readonly line: number;
  readonly column: number;
}

export interface OpenInApplicationDescriptor {
  readonly id: OpenInApplicationId;
  readonly label: string;
  readonly available: boolean;
}

export interface CodeCheckoutOpenRequest {
  readonly threadId: string;
  readonly applicationId: OpenInApplicationId;
}

export interface PreviewHandoffRequest {
  readonly target: {
    readonly targetId: string;
    readonly projectId: string;
    readonly hostId: string;
    readonly kind: string;
    readonly opaqueRef: string;
    readonly displayName: string;
  };
  readonly kind: "reveal-in-finder" | "quick-look" | "open-external";
}

export type ProjectWindowTarget =
  | Readonly<{ kind: "project"; projectId: string }>
  | Readonly<{
      kind: "project-thread";
      projectId: string;
      mode: "code" | "work";
      threadId: string;
    }>;

export interface IpcRendererPort {
  readonly invoke: (channel: string, ...args: readonly unknown[]) => Promise<unknown>;
  readonly on: (channel: string, listener: MaterialListener) => void;
  readonly removeListener: (channel: string, listener: MaterialListener) => void;
}

export interface ContextBridgePort {
  readonly exposeInMainWorld: (key: string, value: unknown) => void;
}

export type AttentionReason = "turn-finished" | "approval-required" | "question-asked";

export interface AttentionNotificationBridgeRequest {
  readonly reason: AttentionReason;
  readonly threadTitle: string;
  readonly detail?: string;
}

export interface OctantHostBridge {
  readonly notifyAttention: (request: AttentionNotificationBridgeRequest) => Promise<void>;
  readonly setAttentionBadge: (count: number) => Promise<void>;
  readonly attachBrowserSurface: (request: BrowserSurfaceRequest) => Promise<BrowserSurfaceState>;
  readonly updateBrowserSurfaceBounds: (request: BrowserSurfaceRequest) => Promise<void>;
  readonly detachBrowserSurface: (request: Omit<BrowserSurfaceRequest, "bounds">) => Promise<void>;
  readonly commandBrowserSurface: (
    request: Omit<BrowserSurfaceRequest, "bounds"> & {
      readonly command: "back" | "forward" | "reload" | "stop";
    },
  ) => Promise<void>;
  readonly tabBrowserSurface: (
    request: Omit<BrowserSurfaceRequest, "bounds"> & {
      readonly command: BrowserSurfaceTabCommand;
    },
  ) => Promise<BrowserSurfaceState>;
  readonly checkForAppUpdate: () => Promise<AppUpdateState>;
  readonly downloadAppUpdate: () => Promise<AppUpdateState>;
  readonly installAppUpdate: () => Promise<AppUpdateInstallOutcome>;
  readonly setAutomaticAppUpdateChecks: (enabled: boolean) => Promise<AppUpdateState>;
  readonly subscribeAppUpdateState: (listener: (state: AppUpdateState) => void) => () => void;
  readonly openBrowserExternal: (url: string) => Promise<void>;
  readonly subscribeBrowserSurfaceState: (
    listener: (state: BrowserSurfaceState) => void,
  ) => () => void;
  readonly clearProviderCredential: (providerInstanceId: string) => Promise<void>;
  readonly close: () => Promise<void>;
  readonly getHostCapabilities: () => Promise<HostCapabilities>;
  /**
   * Which window chrome this host gave the renderer, so it reserves the macOS
   * hiddenInset titlebar strip only where that strip exists.
   */
  readonly windowChrome: "hidden-inset" | "system-frame";
  readonly initialProjectTarget: ProjectWindowTarget | undefined;
  readonly maximizeOrRestore: () => Promise<void>;
  readonly minimize: () => Promise<void>;
  readonly openCodeExternalEditor: (request: CodeExternalEditorRequest) => Promise<void>;
  readonly listOpenInApplications: () => Promise<ReadonlyArray<OpenInApplicationDescriptor>>;
  readonly openCodeCheckoutInApplication: (request: CodeCheckoutOpenRequest) => Promise<void>;
  readonly openInNewWindow: (target: ProjectWindowTarget) => Promise<void>;
  readonly previewHandoff: (request: PreviewHandoffRequest) => Promise<void>;
  readonly requestCodeOperationApproval: (
    request: CodeOperationApprovalRequest,
  ) => Promise<CodeApprovalId | undefined>;
  readonly projectWindowCapability: string;
  readonly providerCredentialStatus: (
    providerInstanceId: string,
  ) => Promise<ProviderCredentialStatus>;
  readonly resetBounds: () => Promise<void>;
  readonly selectProjectRoot: (projectType: BoundProjectType) => Promise<ProjectRootPickerResult>;
  readonly selectLocalPluginFolder: () => Promise<LocalPluginFolderPickerResult>;
  readonly setProviderCredential: (providerInstanceId: string, credential: string) => Promise<void>;
  readonly setSidebarMaterialPreference: (preference: SidebarMaterialPreference) => Promise<void>;
  readonly setSidebarVibrancyMode: (mode: SidebarVibrancyMode) => Promise<void>;
  readonly subscribeResolvedMaterial: (
    listener: (material: ResolvedSidebarMaterial) => void,
  ) => () => void;
  readonly subscribeResolvedSidebarVibrancy: (
    listener: (vibrancy: "sidebar" | null) => void,
  ) => () => void;
  readonly subscribeCodeDeepLinks: (listener: (target: unknown) => void) => () => void;
  readonly subscribeOpenSettings: (listener: () => void) => () => void;
  readonly subscribeStartNewAgent: (listener: () => void) => () => void;
  readonly getPrivateListenerStatus: () => Promise<PrivateListenerPublicStatus>;
  readonly enablePrivateListener: (
    request: PrivateListenerEnableBridgeRequest,
  ) => Promise<PrivateListenerPublicStatus>;
  readonly restartPrivateListener: (
    request: PrivateListenerEnableBridgeRequest,
  ) => Promise<PrivateListenerPublicStatus>;
  readonly disablePrivateListener: () => Promise<PrivateListenerPublicStatus>;
  readonly listRemotePairingRequests: () => Promise<ReadonlyArray<RemotePendingPairingRequest>>;
  readonly approveRemotePairingRequest: (ticketId: string) => Promise<RemotePairingApprovalResult>;
  readonly denyRemotePairingRequest: (
    ticketId: string,
    reasonCode: string,
  ) => Promise<RemotePairingDenialResult>;
  readonly getRemoteDeviceInventory: () => Promise<ReadonlyArray<RemoteDeviceInventoryEntry>>;
  readonly renameRemoteDevice: (
    deviceId: string,
    deviceLabel: string,
  ) => Promise<RemoteDeviceInventoryEntry>;
  readonly revokeRemoteDevice: (deviceId: string) => Promise<RemoteCredentialOperationReceipt>;
  readonly revokeAllRemoteDevices: () => Promise<RemoteCredentialOperationReceipt>;
  readonly reconcileExpiredRemoteDevices: () => Promise<RemoteCredentialOperationReceipt>;
  readonly getRemoteHostIdentityRecovery: () => Promise<RemoteHostIdentityRecoveryState>;
  readonly rotateRemoteHostIdentity: () => Promise<RemoteHostIdentityRotationResult>;
  readonly recoverRemoteHostIdentity: () => Promise<RemoteHostIdentityRecoveryState>;
}

export function createHostBridge(
  ipc: IpcRendererPort,
  projectWindowCapability: string,
  initialProjectTarget?: ProjectWindowTarget,
  platform: NodeJS.Platform = process.platform,
): OctantHostBridge {
  const invoke = async (channel: string, ...args: readonly unknown[]): Promise<void> =>
    void (await ipc.invoke(channel, ...args));
  const invokeRemote = async (channel: string, ...args: readonly unknown[]): Promise<unknown> => {
    try {
      return await ipc.invoke(channel, ...args);
    } catch (error) {
      if (error instanceof Error && isAllowlistedRemoteDeviceFailure(error.message)) {
        throw new Error(error.message);
      }
      throw new Error("Octant could not apply the local device controls.");
    }
  };
  const frozenInitialProjectTarget: ProjectWindowTarget | undefined =
    initialProjectTarget === undefined
      ? undefined
      : initialProjectTarget.kind === "project"
        ? Object.freeze({ kind: "project", projectId: initialProjectTarget.projectId })
        : Object.freeze({
            kind: "project-thread",
            projectId: initialProjectTarget.projectId,
            mode: initialProjectTarget.mode,
            threadId: initialProjectTarget.threadId,
          });
  return Object.freeze({
    notifyAttention: (request: AttentionNotificationBridgeRequest) => {
      try {
        validateAttentionNotificationRequest(request);
      } catch (error) {
        return Promise.reject(error);
      }
      return invoke(IPC_CHANNELS.attentionNotify, request);
    },
    setAttentionBadge: (count: number) => {
      if (typeof count !== "number" || !Number.isFinite(count)) {
        return Promise.reject(new TypeError("Invalid attention badge count."));
      }
      return invoke(IPC_CHANNELS.attentionBadge, count);
    },
    attachBrowserSurface: async (request: BrowserSurfaceRequest) => {
      validateBrowserSurfaceRequest(request);
      return decodeBrowserSurfaceState(
        await ipc.invoke(IPC_CHANNELS.browserSurfaceAttach, request),
      );
    },
    updateBrowserSurfaceBounds: (request: BrowserSurfaceRequest) => {
      validateBrowserSurfaceRequest(request);
      return invoke(IPC_CHANNELS.browserSurfaceBounds, request);
    },
    detachBrowserSurface: (request: Omit<BrowserSurfaceRequest, "bounds">) => {
      validateBrowserSurfaceIdentity(request);
      return invoke(IPC_CHANNELS.browserSurfaceDetach, request);
    },
    commandBrowserSurface: (
      request: Omit<BrowserSurfaceRequest, "bounds"> & {
        readonly command: "back" | "forward" | "reload" | "stop";
      },
    ) => {
      validateBrowserSurfaceIdentity(request);
      if (!["back", "forward", "reload", "stop"].includes(request.command)) {
        return Promise.reject(new TypeError("Invalid Browser surface command."));
      }
      return invoke(IPC_CHANNELS.browserSurfaceCommand, request);
    },
    tabBrowserSurface: async (
      request: Omit<BrowserSurfaceRequest, "bounds"> & {
        readonly command: BrowserSurfaceTabCommand;
      },
    ) => {
      validateBrowserSurfaceIdentity(request);
      const command = request.command;
      if (
        !isRecord(command) ||
        (command.kind !== "open" &&
          ((command.kind !== "select" && command.kind !== "close") ||
            typeof command.tabId !== "string" ||
            command.tabId.length === 0 ||
            command.tabId.length > 64))
      ) {
        return Promise.reject(new TypeError("Invalid Browser tab command."));
      }
      return decodeBrowserSurfaceState(await ipc.invoke(IPC_CHANNELS.browserSurfaceTab, request));
    },
    checkForAppUpdate: async () =>
      decodeAppUpdateState(await ipc.invoke(IPC_CHANNELS.appUpdateCheck)),
    downloadAppUpdate: async () =>
      decodeAppUpdateState(await ipc.invoke(IPC_CHANNELS.appUpdateDownload)),
    installAppUpdate: async () =>
      decodeAppUpdateInstallOutcome(await ipc.invoke(IPC_CHANNELS.appUpdateInstall)),
    setAutomaticAppUpdateChecks: async (enabled: boolean) => {
      if (typeof enabled !== "boolean") {
        return Promise.reject(new TypeError("Invalid update setting."));
      }
      return decodeAppUpdateState(await ipc.invoke(IPC_CHANNELS.appUpdateAutomatic, enabled));
    },
    setAppUpdateRing: async (ring: string) => {
      // Rejected here as well as in the host. The bridge is the renderer's
      // whole vocabulary, so a value it will not carry is one the host never
      // has to have an opinion about.
      if (!isReleaseRing(ring)) return Promise.reject(new TypeError("Invalid release ring."));
      return decodeAppUpdateState(await ipc.invoke(IPC_CHANNELS.appUpdateRing, ring));
    },
    subscribeAppUpdateState: (listener: (state: AppUpdateState) => void) => {
      const receive: MaterialListener = (_event, value) => {
        try {
          listener(decodeAppUpdateState(value));
        } catch {
          // Ignore malformed native state instead of widening the bridge.
        }
      };
      ipc.on(IPC_CHANNELS.appUpdateState, receive);
      return () => ipc.removeListener(IPC_CHANNELS.appUpdateState, receive);
    },
    openBrowserExternal: (url: string) => {
      validateExternalBrowserUrl(url);
      return invoke(IPC_CHANNELS.browserSurfaceOpenExternal, url);
    },
    clearProviderCredential: async (providerInstanceId: string) => {
      validateProviderInstanceId(providerInstanceId);
      try {
        await invoke(IPC_CHANNELS.clearProviderCredential, providerInstanceId);
      } catch {
        throw new Error("Octant could not clear the provider credential.");
      }
    },
    close: () => invoke(IPC_CHANNELS.close),
    getHostCapabilities: async () => {
      const value = await ipc.invoke(IPC_CHANNELS.hostCapabilities);
      if (
        !isRecord(value) ||
        typeof value.sidebarVibrancySupported !== "boolean" ||
        typeof value.liveBrowserSupported !== "boolean" ||
        typeof value.liveSimulatorFrameSupported !== "boolean"
      ) {
        throw new Error("Octant received invalid host capabilities.");
      }
      return Object.freeze({
        sidebarVibrancySupported: value.sidebarVibrancySupported,
        liveBrowserSupported: value.liveBrowserSupported,
        liveSimulatorFrameSupported: value.liveSimulatorFrameSupported,
      });
    },
    // Mirrors the window this host actually creates: `resolveWindowPresentation`
    // gives macOS the hiddenInset titlebar and every other platform a framed
    // window. The renderer reserves the titlebar inset only on the former.
    windowChrome: platform === "darwin" ? "hidden-inset" : "system-frame",
    initialProjectTarget: frozenInitialProjectTarget,
    maximizeOrRestore: () => invoke(IPC_CHANNELS.maximizeOrRestore),
    minimize: () => invoke(IPC_CHANNELS.minimize),
    openCodeExternalEditor: (request: CodeExternalEditorRequest) => {
      validateCodeExternalEditorRequest(request);
      return invoke(IPC_CHANNELS.openCodeExternalEditor, request);
    },
    listOpenInApplications: async () => {
      const value: unknown = await ipc.invoke(IPC_CHANNELS.listOpenInApplications);
      if (!Array.isArray(value) || !value.every(isOpenInApplicationDescriptor)) {
        throw new Error("Octant received an invalid Open in application catalogue.");
      }
      return Object.freeze(value.map((entry) => Object.freeze({ ...entry })));
    },
    openCodeCheckoutInApplication: (request: CodeCheckoutOpenRequest) => {
      validateCodeCheckoutOpenRequest(request);
      return invoke(IPC_CHANNELS.openCodeCheckoutInApplication, request);
    },
    openInNewWindow: async (target: ProjectWindowTarget) => {
      validateProjectWindowTarget(target);
      await invoke(IPC_CHANNELS.openInNewWindow, target);
    },
    previewHandoff: (request: PreviewHandoffRequest) => {
      validatePreviewHandoffRequest(request);
      return invoke(IPC_CHANNELS.previewHandoff, request);
    },
    requestCodeOperationApproval: async (request: CodeOperationApprovalRequest) => {
      // The main-process IPC handler performs the authoritative contract decode. Keep the
      // sandboxed preload free of runtime package imports so the bridge can be exposed.
      const value = await ipc.invoke(IPC_CHANNELS.requestCodeOperationApproval, request);
      if (value === undefined) return undefined;
      if (typeof value !== "string" || !PROVIDER_INSTANCE_ID_PATTERN.test(value)) {
        throw new Error("Octant received an invalid Code approval receipt.");
      }
      return value as CodeApprovalId;
    },
    projectWindowCapability,
    providerCredentialStatus: async (providerInstanceId: string) => {
      validateProviderInstanceId(providerInstanceId);
      let value: unknown;
      try {
        value = await ipc.invoke(IPC_CHANNELS.providerCredentialStatus, providerInstanceId);
      } catch {
        throw new Error("Octant could not check the provider credential.");
      }
      if (value !== "stored" && value !== "missing" && value !== "unavailable") {
        throw new Error("Octant received an invalid provider credential status.");
      }
      return value;
    },
    resetBounds: () => invoke(IPC_CHANNELS.resetBounds),
    selectProjectRoot: async (projectType: BoundProjectType) => {
      if (projectType !== "work" && projectType !== "code") {
        throw new TypeError("Invalid Project type.");
      }
      try {
        return decodeProjectRootPickerResult(
          await ipc.invoke(IPC_CHANNELS.selectProjectRoot, projectType),
        );
      } catch (error) {
        // ipcRenderer.invoke recreates main-process errors with a remote
        // context prefix; rethrow the allowlisted guidance verbatim so the
        // renderer can surface it.
        const message = error instanceof Error ? error.message : "";
        if (message.includes("Choose an accessible directory.")) {
          throw new Error("Choose an accessible directory.");
        }
        throw error;
      }
    },
    selectLocalPluginFolder: async () =>
      decodeLocalPluginFolderPickerResult(await ipc.invoke(IPC_CHANNELS.selectLocalPluginFolder)),
    setProviderCredential: async (providerInstanceId: string, credential: string) => {
      validateProviderInstanceId(providerInstanceId);
      if (
        typeof credential !== "string" ||
        credential.length === 0 ||
        new TextEncoder().encode(credential).byteLength > MAX_PROVIDER_CREDENTIAL_BYTES
      ) {
        throw new TypeError("Invalid provider credential.");
      }
      try {
        await invoke(IPC_CHANNELS.setProviderCredential, providerInstanceId, credential);
      } catch {
        throw new Error("Octant could not store the provider credential.");
      }
    },
    setSidebarMaterialPreference: (preference: SidebarMaterialPreference) => {
      if (preference !== "opaque" && preference !== "system") {
        return Promise.reject(new TypeError("Invalid sidebar material preference."));
      }
      return invoke(IPC_CHANNELS.sidebarMaterialPreference, preference);
    },
    setSidebarVibrancyMode: (mode: SidebarVibrancyMode) => {
      if (mode !== "off" && mode !== "subtle" && mode !== "strong") {
        return Promise.reject(new TypeError("Invalid sidebar vibrancy mode."));
      }
      return invoke(IPC_CHANNELS.sidebarVibrancyMode, mode);
    },
    subscribeResolvedMaterial: (listener: (material: ResolvedSidebarMaterial) => void) => {
      const receive: MaterialListener = (_event, material) => {
        if (material === "opaque" || material === "translucent") listener(material);
      };
      ipc.on(IPC_CHANNELS.resolvedMaterial, receive);
      return () => ipc.removeListener(IPC_CHANNELS.resolvedMaterial, receive);
    },
    subscribeResolvedSidebarVibrancy: (listener: (vibrancy: "sidebar" | null) => void) => {
      const receive: MaterialListener = (_event, vibrancy) => {
        if (vibrancy === "sidebar" || vibrancy === null) listener(vibrancy);
      };
      ipc.on(IPC_CHANNELS.resolvedSidebarVibrancy, receive);
      return () => ipc.removeListener(IPC_CHANNELS.resolvedSidebarVibrancy, receive);
    },
    subscribeBrowserSurfaceState: (listener: (state: BrowserSurfaceState) => void) => {
      const receive: MaterialListener = (_event, value) => {
        try {
          listener(decodeBrowserSurfaceState(value));
        } catch {
          // Ignore malformed native state instead of widening the preload bridge.
        }
      };
      ipc.on(IPC_CHANNELS.browserSurfaceState, receive);
      return () => ipc.removeListener(IPC_CHANNELS.browserSurfaceState, receive);
    },
    subscribeCodeDeepLinks: (listener: (target: unknown) => void) => {
      const receive: DeepLinkListener = (_event, target) => listener(target);
      ipc.on(IPC_CHANNELS.codeDeepLink, receive);
      return () => ipc.removeListener(IPC_CHANNELS.codeDeepLink, receive);
    },
    subscribeOpenSettings: (listener: () => void) => {
      const receive: SettingsOpenListener = () => listener();
      ipc.on(IPC_CHANNELS.openSettings, receive);
      return () => ipc.removeListener(IPC_CHANNELS.openSettings, receive);
    },
    subscribeStartNewAgent: (listener: () => void) => {
      const receive: AgentStartListener = () => listener();
      ipc.on(IPC_CHANNELS.startNewAgent, receive);
      return () => ipc.removeListener(IPC_CHANNELS.startNewAgent, receive);
    },
    getPrivateListenerStatus: async () =>
      decodePrivateListenerStatus(await ipc.invoke(IPC_CHANNELS.privateListenerStatus)),
    enablePrivateListener: async (request: PrivateListenerEnableBridgeRequest) => {
      validatePrivateListenerEnableRequest(request);
      try {
        return decodePrivateListenerStatus(
          await ipc.invoke(IPC_CHANNELS.privateListenerEnable, {
            hostname: request.hostname,
            port: request.port,
            origin: request.origin,
            certificatePem: request.certificatePem,
            privateKeyPem: request.privateKeyPem,
            localConfirmation: true,
          }),
        );
      } catch {
        throw new Error("Octant could not enable the private listener.");
      }
    },
    restartPrivateListener: async (request: PrivateListenerEnableBridgeRequest) => {
      validatePrivateListenerEnableRequest(request);
      try {
        return decodePrivateListenerStatus(
          await ipc.invoke(IPC_CHANNELS.privateListenerRestart, {
            hostname: request.hostname,
            port: request.port,
            origin: request.origin,
            certificatePem: request.certificatePem,
            privateKeyPem: request.privateKeyPem,
            localConfirmation: true,
          }),
        );
      } catch {
        throw new Error("Octant could not restart the private listener.");
      }
    },
    disablePrivateListener: async () => {
      try {
        return decodePrivateListenerStatus(await ipc.invoke(IPC_CHANNELS.privateListenerDisable));
      } catch {
        throw new Error("Octant could not disable the private listener.");
      }
    },
    listRemotePairingRequests: async () =>
      decodeRemotePendingList(await invokeRemote(IPC_CHANNELS.remotePairingRequests)),
    approveRemotePairingRequest: async (ticketId: string) => {
      validateRemoteUuid(ticketId);
      return decodeRemotePairingApproval(
        await invokeRemote(IPC_CHANNELS.remotePairingApprove, ticketId),
      );
    },
    denyRemotePairingRequest: async (ticketId: string, reasonCode: string) => {
      validateRemoteUuid(ticketId);
      validateRemoteReason(reasonCode);
      return decodeRemotePairingDenial(
        await invokeRemote(IPC_CHANNELS.remotePairingDeny, ticketId, reasonCode),
      );
    },
    getRemoteDeviceInventory: async () =>
      decodeRemoteDeviceList(await invokeRemote(IPC_CHANNELS.remoteDeviceInventory)),
    renameRemoteDevice: async (deviceId: string, deviceLabel: string) => {
      validateRemoteUuid(deviceId);
      validateRemoteDeviceLabel(deviceLabel);
      return decodeRemoteDevice(
        await invokeRemote(IPC_CHANNELS.remoteDeviceRename, deviceId, deviceLabel.trim()),
      );
    },
    revokeRemoteDevice: async (deviceId: string) => {
      validateRemoteUuid(deviceId);
      return decodeRemoteReceipt(await invokeRemote(IPC_CHANNELS.remoteDeviceRevoke, deviceId));
    },
    revokeAllRemoteDevices: async () =>
      decodeRemoteReceipt(await invokeRemote(IPC_CHANNELS.remoteDeviceRevokeAll)),
    reconcileExpiredRemoteDevices: async () =>
      decodeRemoteReceipt(await invokeRemote(IPC_CHANNELS.remoteDeviceReconcileExpired)),
    getRemoteHostIdentityRecovery: async () =>
      decodeRemoteHostIdentityRecovery(await invokeRemote(IPC_CHANNELS.remoteHostIdentityStatus)),
    rotateRemoteHostIdentity: async () =>
      decodeRemoteHostIdentityRotation(await invokeRemote(IPC_CHANNELS.remoteHostIdentityRotate)),
    recoverRemoteHostIdentity: async () =>
      decodeRemoteHostIdentityRecovery(await invokeRemote(IPC_CHANNELS.remoteHostIdentityRecover)),
  });
}

const REMOTE_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REMOTE_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const REMOTE_LABEL_PATTERN = /^(?!.*[\\/])[^\r\n]{1,128}$/;
const REMOTE_REASON_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

function decodeRemotePendingList(value: unknown): ReadonlyArray<RemotePendingPairingRequest> {
  if (!Array.isArray(value)) throw new TypeError("Invalid local pairing request list.");
  return Object.freeze(value.map(decodeRemotePending));
}

function decodeRemotePairingApproval(value: unknown): RemotePairingApprovalResult {
  requireRemoteExactKeys(value, ["decision", "device"]);
  if (value.decision !== "approved") throw new TypeError("Invalid local pairing approval.");
  return Object.freeze({ decision: "approved", device: decodeRemoteDevice(value.device) });
}

function decodeRemotePairingDenial(value: unknown): RemotePairingDenialResult {
  requireRemoteExactKeys(value, ["decision"]);
  if (value.decision !== "denied") throw new TypeError("Invalid local pairing denial.");
  return Object.freeze({ decision: "denied" });
}

function decodeRemoteDeviceList(value: unknown): ReadonlyArray<RemoteDeviceInventoryEntry> {
  if (!Array.isArray(value)) throw new TypeError("Invalid local device inventory.");
  return Object.freeze(value.map((entry) => decodeRemoteDevice(entry)));
}

function decodeRemoteDevice(value: unknown): RemoteDeviceInventoryEntry {
  if (!isRecord(value)) throw new TypeError("Invalid local device inventory entry.");
  const keys = Object.keys(value).sort();
  const required = [
    "createdAt",
    "credentialGeneration",
    "deviceId",
    "deviceKeyFingerprint",
    "deviceLabel",
    "expiresAt",
    "hostId",
    "lastSeenAt",
    "origin",
    "protocolFloor",
    "state",
  ];
  const allowed = new Set([...required, "revokedAt", "revokedReason"]);
  if (keys.some((key) => !allowed.has(key)) || required.some((key) => !(key in value))) {
    throw new TypeError("Invalid local device inventory entry.");
  }
  if (
    !REMOTE_UUID_PATTERN.test(String(value.hostId)) ||
    !REMOTE_UUID_PATTERN.test(String(value.deviceId)) ||
    !REMOTE_FINGERPRINT_PATTERN.test(String(value.deviceKeyFingerprint)) ||
    typeof value.deviceLabel !== "string" ||
    !REMOTE_LABEL_PATTERN.test(value.deviceLabel) ||
    typeof value.origin !== "string" ||
    !isHttpsOrigin(value.origin) ||
    !Number.isSafeInteger(value.protocolFloor as number) ||
    (value.protocolFloor as number) < 1 ||
    !Number.isSafeInteger(value.credentialGeneration as number) ||
    (value.credentialGeneration as number) < 1 ||
    !isUtcTimestamp(value.createdAt) ||
    !isUtcTimestamp(value.expiresAt) ||
    !isUtcTimestamp(value.lastSeenAt) ||
    (value.state !== "active" && value.state !== "revoked" && value.state !== "expired") ||
    (value.revokedAt !== undefined && !isUtcTimestamp(value.revokedAt)) ||
    (value.revokedReason !== undefined &&
      (typeof value.revokedReason !== "string" || !REMOTE_REASON_PATTERN.test(value.revokedReason)))
  ) {
    throw new TypeError("Invalid local device inventory entry.");
  }
  return Object.freeze({
    hostId: value.hostId as string,
    deviceId: value.deviceId as string,
    deviceKeyFingerprint: value.deviceKeyFingerprint as string,
    deviceLabel: value.deviceLabel,
    origin: value.origin,
    protocolFloor: value.protocolFloor as number,
    credentialGeneration: value.credentialGeneration as number,
    createdAt: value.createdAt as string,
    expiresAt: value.expiresAt as string,
    lastSeenAt: value.lastSeenAt as string,
    state: value.state as RemoteDeviceState,
    ...(value.revokedAt === undefined ? {} : { revokedAt: value.revokedAt }),
    ...(value.revokedReason === undefined ? {} : { revokedReason: value.revokedReason }),
  });
}

function decodeRemotePending(value: unknown): RemotePendingPairingRequest {
  if (!isRecord(value)) throw new TypeError("Invalid local pairing request.");
  requireRemoteExactKeys(value, [
    "claimedAt",
    "comparisonCode",
    "deviceKeyFingerprint",
    "deviceLabel",
    "expiresAt",
    "hostId",
    "kind",
    "origin",
    "sourceClass",
    "ticketId",
  ]);
  if (
    value.kind !== "pending" ||
    !REMOTE_UUID_PATTERN.test(String(value.ticketId)) ||
    !REMOTE_UUID_PATTERN.test(String(value.hostId)) ||
    typeof value.deviceLabel !== "string" ||
    !REMOTE_LABEL_PATTERN.test(value.deviceLabel) ||
    !REMOTE_FINGERPRINT_PATTERN.test(String(value.deviceKeyFingerprint)) ||
    typeof value.origin !== "string" ||
    !isHttpsOrigin(value.origin) ||
    !["loopback", "lan-private", "tailscale", "unknown"].includes(String(value.sourceClass)) ||
    !/^\d{6}$/.test(String(value.comparisonCode)) ||
    !isUtcTimestamp(value.claimedAt) ||
    !isUtcTimestamp(value.expiresAt)
  ) {
    throw new TypeError("Invalid local pairing request.");
  }
  return Object.freeze({
    kind: "pending",
    ticketId: value.ticketId as string,
    hostId: value.hostId as string,
    deviceLabel: value.deviceLabel,
    deviceKeyFingerprint: value.deviceKeyFingerprint as string,
    origin: value.origin,
    sourceClass: value.sourceClass as RemoteDeviceSourceClass,
    comparisonCode: value.comparisonCode as string,
    claimedAt: value.claimedAt as string,
    expiresAt: value.expiresAt as string,
  });
}

function decodeRemoteReceipt(value: unknown): RemoteCredentialOperationReceipt {
  requireRemoteExactKeys(value, ["commandId", "occurredAt", "result"]);
  if (
    !REMOTE_UUID_PATTERN.test(String(value.commandId)) ||
    (value.result !== "applied" && value.result !== "already-applied") ||
    !isUtcTimestamp(value.occurredAt)
  ) {
    throw new TypeError("Invalid local device operation receipt.");
  }
  return Object.freeze({
    commandId: value.commandId as string,
    result: value.result,
    occurredAt: value.occurredAt as string,
  });
}

function decodeRemoteHostIdentityRecovery(value: unknown): RemoteHostIdentityRecoveryState {
  if (!isRecord(value)) throw new TypeError("Invalid host-identity recovery state.");
  if (value.status === "ready") {
    requireRemoteExactKeys(value, [
      "fingerprint",
      "localDesktopUsable",
      "reason",
      "remoteIdentityUsable",
      "status",
    ]);
    if (
      value.reason !== null ||
      value.remoteIdentityUsable !== true ||
      value.localDesktopUsable !== true ||
      !REMOTE_FINGERPRINT_PATTERN.test(String(value.fingerprint))
    ) {
      throw new TypeError("Invalid host-identity recovery state.");
    }
    return Object.freeze({
      status: "ready",
      reason: null,
      remoteIdentityUsable: true,
      localDesktopUsable: true,
      fingerprint: value.fingerprint as string,
    });
  }
  requireRemoteExactKeys(value, ["localDesktopUsable", "reason", "remoteIdentityUsable", "status"]);
  if (
    value.status !== "recovery-required" ||
    value.remoteIdentityUsable !== false ||
    value.localDesktopUsable !== true ||
    !["failed", "invalid", "missing", "unavailable"].includes(String(value.reason))
  ) {
    throw new TypeError("Invalid host-identity recovery state.");
  }
  return Object.freeze({
    status: "recovery-required",
    reason: value.reason as "failed" | "invalid" | "missing" | "unavailable",
    remoteIdentityUsable: false,
    localDesktopUsable: true,
  });
}

function decodeRemoteHostIdentityRotation(value: unknown): RemoteHostIdentityRotationResult {
  requireRemoteExactKeys(value, ["fingerprint", "status"]);
  if (value.status !== "rotated" || !REMOTE_FINGERPRINT_PATTERN.test(String(value.fingerprint))) {
    throw new TypeError("Invalid host-identity rotation result.");
  }
  return Object.freeze({ status: "rotated", fingerprint: value.fingerprint as string });
}

function requireRemoteExactKeys(
  value: unknown,
  expected: readonly string[],
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError("Invalid local device response.");
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new TypeError("Invalid local device response.");
  }
}

function validateRemoteUuid(value: string): void {
  if (typeof value !== "string" || !REMOTE_UUID_PATTERN.test(value)) {
    throw new TypeError("Invalid local device identity.");
  }
}

function validateRemoteReason(value: string): void {
  if (typeof value !== "string" || !REMOTE_REASON_PATTERN.test(value)) {
    throw new TypeError("Invalid local device reason.");
  }
}

function validateRemoteDeviceLabel(value: string): void {
  if (typeof value !== "string" || !REMOTE_LABEL_PATTERN.test(value.trim())) {
    throw new TypeError("Invalid local device label.");
  }
}

function isHttpsOrigin(value: string): boolean {
  try {
    const origin = new URL(value);
    return origin.protocol === "https:" && origin.username === "" && origin.password === "";
  } catch {
    return false;
  }
}

function isUtcTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isAllowlistedRemoteDeviceFailure(message: string): boolean {
  return [
    "Octant local device controls are unavailable.",
    "Octant rejected an invalid local device request.",
    "Octant rejected the local device request.",
    "Octant could not find that device or pairing request.",
    "Octant could not apply the device change because state changed.",
    "Octant could not apply the local device change.",
    "Octant could not apply the local device controls.",
    "The secure host-identity operation failed.",
    "The host-identity request is invalid.",
    "No host-identity key is available.",
    "The secure host-identity store is unavailable. Remote identity remains recovery-only while local desktop stays usable.",
    "Octant could not update the host identity.",
  ].includes(message);
}

function validateProviderInstanceId(providerInstanceId: string): void {
  if (
    typeof providerInstanceId !== "string" ||
    !PROVIDER_INSTANCE_ID_PATTERN.test(providerInstanceId)
  ) {
    throw new TypeError("Invalid provider instance ID.");
  }
}

function validateCodeExternalEditorRequest(value: CodeExternalEditorRequest): void {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join("\0") !==
      ["threadId", "checkoutId", "fileId", "line", "column"].sort().join("\0") ||
    ![value.threadId, value.checkoutId, value.fileId].every(
      (id) => typeof id === "string" && PROVIDER_INSTANCE_ID_PATTERN.test(id),
    ) ||
    !Number.isSafeInteger(value.line) ||
    value.line < 1 ||
    !Number.isSafeInteger(value.column) ||
    value.column < 1
  ) {
    throw new TypeError("Invalid Code external editor request.");
  }
}

const OPEN_IN_APPLICATION_IDS: ReadonlySet<string> = new Set([
  "vscode",
  "cursor",
  "zed",
  "finder",
  "terminal",
  "ghostty",
  "xcode",
]);

function isOpenInApplicationDescriptor(value: unknown): value is OpenInApplicationDescriptor {
  return (
    isRecord(value) &&
    Object.keys(value).sort().join("\0") === ["id", "label", "available"].sort().join("\0") &&
    typeof value.id === "string" &&
    OPEN_IN_APPLICATION_IDS.has(value.id) &&
    typeof value.label === "string" &&
    value.label.trim() !== "" &&
    typeof value.available === "boolean"
  );
}

function validateCodeCheckoutOpenRequest(value: CodeCheckoutOpenRequest): void {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join("\0") !== ["threadId", "applicationId"].sort().join("\0") ||
    typeof value.threadId !== "string" ||
    !PROVIDER_INSTANCE_ID_PATTERN.test(value.threadId) ||
    typeof value.applicationId !== "string" ||
    !OPEN_IN_APPLICATION_IDS.has(value.applicationId)
  ) {
    throw new TypeError("Invalid Code checkout Open in request.");
  }
}

/**
 * Runtime-free shape check for a preview handoff request. The target is
 * path-free by contract: every field is a plain string token and the kind is
 * one of the three authenticated handoff commands, so a host path can never
 * reach the main process through this channel.
 */
function validatePreviewHandoffRequest(value: PreviewHandoffRequest): void {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join("\0") !== ["target", "kind"].sort().join("\0") ||
    !isRecord(value.target) ||
    Object.keys(value.target).sort().join("\0") !==
      ["targetId", "projectId", "hostId", "kind", "opaqueRef", "displayName"].sort().join("\0") ||
    ![value.target.targetId, value.target.projectId, value.target.hostId].every(
      (id) => typeof id === "string" && PROVIDER_INSTANCE_ID_PATTERN.test(id),
    ) ||
    typeof value.target.kind !== "string" ||
    typeof value.target.opaqueRef !== "string" ||
    value.target.opaqueRef.length === 0 ||
    /[\\/]/.test(value.target.opaqueRef) ||
    typeof value.target.displayName !== "string" ||
    /[\\/]/.test(value.target.displayName) ||
    (value.kind !== "reveal-in-finder" &&
      value.kind !== "quick-look" &&
      value.kind !== "open-external")
  ) {
    throw new TypeError("Invalid preview handoff request.");
  }
}

function validateProjectWindowTarget(value: ProjectWindowTarget): void {
  if (
    !isRecord(value) ||
    typeof value.projectId !== "string" ||
    !PROVIDER_INSTANCE_ID_PATTERN.test(value.projectId)
  ) {
    throw new TypeError("Invalid Project window target.");
  }
  if (
    value.kind === "project" &&
    Object.keys(value).sort().join("\0") === ["kind", "projectId"].sort().join("\0")
  ) {
    return;
  }
  if (
    value.kind === "project-thread" &&
    Object.keys(value).sort().join("\0") ===
      ["kind", "mode", "projectId", "threadId"].sort().join("\0") &&
    (value.mode === "code" || value.mode === "work") &&
    typeof value.threadId === "string" &&
    PROVIDER_INSTANCE_ID_PATTERN.test(value.threadId)
  ) {
    return;
  }
  throw new TypeError("Invalid Project window target.");
}

function decodeProjectRootPickerResult(value: unknown): ProjectRootPickerResult {
  if (!isRecord(value)) throw new TypeError("Invalid Project root picker result.");
  const keys = Object.keys(value).sort();
  if (keys.length === 1 && keys[0] === "kind" && value.kind === "cancelled") {
    return Object.freeze({ kind: "cancelled" });
  }
  if (
    keys.length === 3 &&
    keys[0] === "displayName" &&
    keys[1] === "kind" &&
    keys[2] === "receiptId" &&
    value.kind === "selected" &&
    typeof value.receiptId === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(value.receiptId) &&
    typeof value.displayName === "string" &&
    value.displayName.trim().length > 0 &&
    !/[\\/]/.test(value.displayName)
  ) {
    return Object.freeze({
      kind: "selected",
      receiptId: value.receiptId,
      displayName: value.displayName.trim(),
    });
  }
  throw new TypeError("Invalid Project root picker result.");
}

function decodeLocalPluginFolderPickerResult(value: unknown): LocalPluginFolderPickerResult {
  if (!isRecord(value)) throw new TypeError("Invalid local plugin folder picker result.");
  const keys = Object.keys(value).sort();
  if (keys.length === 1 && keys[0] === "kind" && value.kind === "cancelled") {
    return Object.freeze({ kind: "cancelled" });
  }
  if (
    keys.length === 3 &&
    keys[0] === "displayName" &&
    keys[1] === "kind" &&
    keys[2] === "receiptId" &&
    value.kind === "selected" &&
    typeof value.receiptId === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(value.receiptId) &&
    typeof value.displayName === "string" &&
    value.displayName.trim().length > 0 &&
    !/[\\/]/.test(value.displayName)
  ) {
    return Object.freeze({
      kind: "selected",
      receiptId: value.receiptId,
      displayName: value.displayName.trim(),
    });
  }
  throw new TypeError("Invalid local plugin folder picker result.");
}

function validateAttentionNotificationRequest(value: unknown): void {
  if (!isRecord(value)) throw new TypeError("Invalid attention notification request.");
  if (
    (value.reason !== "turn-finished" &&
      value.reason !== "approval-required" &&
      value.reason !== "question-asked") ||
    typeof value.threadTitle !== "string" ||
    value.threadTitle.trim() === "" ||
    (value.detail !== undefined && typeof value.detail !== "string")
  ) {
    throw new TypeError("Invalid attention notification request.");
  }
}

function validateBrowserSurfaceIdentity(value: unknown): asserts value is {
  readonly contextId: string;
  readonly threadId: string;
} {
  if (!isRecord(value)) throw new TypeError("Invalid Browser surface request.");
  if (
    typeof value.contextId !== "string" ||
    typeof value.threadId !== "string" ||
    !PROVIDER_INSTANCE_ID_PATTERN.test(value.contextId) ||
    !PROVIDER_INSTANCE_ID_PATTERN.test(value.threadId)
  ) {
    throw new TypeError("Invalid Browser surface request.");
  }
}

function validateBrowserSurfaceRequest(value: BrowserSurfaceRequest): void {
  validateBrowserSurfaceIdentity(value);
  if (!isRecord(value.bounds)) throw new TypeError("Invalid Browser surface bounds.");
  const bounds = value.bounds;
  if (
    ![bounds.x, bounds.y, bounds.width, bounds.height].every(
      (entry) => typeof entry === "number" && Number.isFinite(entry),
    ) ||
    bounds.x < 0 ||
    bounds.y < 0 ||
    bounds.width < 1 ||
    bounds.height < 1
  ) {
    throw new TypeError("Invalid Browser surface bounds.");
  }
}

function validateExternalBrowserUrl(value: string): void {
  if (typeof value !== "string" || value.length > 4_096) {
    throw new TypeError("Invalid external Browser URL.");
  }
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username !== "" ||
      url.password !== ""
    ) {
      throw new TypeError("Invalid external Browser URL.");
    }
  } catch {
    throw new TypeError("Invalid external Browser URL.");
  }
}

function decodeBrowserSurfaceState(value: unknown): BrowserSurfaceState {
  if (!isRecord(value)) throw new TypeError("Invalid Browser surface state.");
  if (
    typeof value.contextId !== "string" ||
    !PROVIDER_INSTANCE_ID_PATTERN.test(value.contextId) ||
    typeof value.url !== "string" ||
    value.url.length > 4_096 ||
    typeof value.title !== "string" ||
    value.title.length > 1_024 ||
    typeof value.loading !== "boolean" ||
    typeof value.canGoBack !== "boolean" ||
    typeof value.canGoForward !== "boolean" ||
    (value.control !== "idle" && value.control !== "user" && value.control !== "agent") ||
    !Array.isArray(value.tabs) ||
    value.tabs.length > 16 ||
    typeof value.activeTabId !== "string" ||
    value.activeTabId.length > 64
  ) {
    throw new TypeError("Invalid Browser surface state.");
  }
  return Object.freeze({
    contextId: value.contextId,
    url: value.url,
    title: value.title,
    loading: value.loading,
    canGoBack: value.canGoBack,
    canGoForward: value.canGoForward,
    control: value.control,
    tabs: Object.freeze(value.tabs.map(decodeBrowserSurfaceTabState)),
    activeTabId: value.activeTabId,
  });
}

/**
 * The rings, mirrored rather than imported, for the same reason the statuses
 * below are: the preload is sandboxed and must not pull a runtime package in.
 */
function isReleaseRing(value: unknown): value is "stable" | "preview" {
  return value === "stable" || value === "preview";
}

const APP_UPDATE_STATUSES = [
  "idle",
  "checking",
  "up-to-date",
  "available",
  "downloading",
  "ready",
  "refused",
  "failed",
];

/**
 * Validate update state by hand rather than importing the contract decoder.
 *
 * The preload is sandboxed and must not pull a runtime package in with it, so
 * this mirrors the shape the way the Browser surface state already does.
 */
function decodeAppUpdateState(value: unknown): AppUpdateState {
  if (
    !isRecord(value) ||
    typeof value.status !== "string" ||
    !APP_UPDATE_STATUSES.includes(value.status) ||
    typeof value.currentVersion !== "string" ||
    value.currentVersion.length > 64 ||
    typeof value.automaticChecks !== "boolean" ||
    !isReleaseRing(value.ring) ||
    (value.refusal !== undefined && typeof value.refusal !== "string") ||
    (value.message !== undefined && typeof value.message !== "string") ||
    (value.checkedAt !== undefined && typeof value.checkedAt !== "string")
  ) {
    throw new TypeError("Invalid update state.");
  }
  return Object.freeze({
    status: value.status,
    currentVersion: value.currentVersion,
    automaticChecks: value.automaticChecks,
    ring: value.ring,
    ...(value.available === undefined
      ? {}
      : { available: decodeAppUpdateRelease(value.available) }),
    ...(value.refusal === undefined ? {} : { refusal: value.refusal }),
    ...(value.message === undefined ? {} : { message: value.message }),
    ...(value.checkedAt === undefined ? {} : { checkedAt: value.checkedAt }),
  });
}

function decodeAppUpdateRelease(value: unknown): AppUpdateRelease {
  if (
    !isRecord(value) ||
    typeof value.version !== "string" ||
    typeof value.platform !== "string" ||
    typeof value.arch !== "string" ||
    !isReleaseRing(value.ring) ||
    typeof value.url !== "string" ||
    !value.url.startsWith("https://") ||
    typeof value.sha256 !== "string" ||
    typeof value.releasedAt !== "string" ||
    (value.notes !== undefined && typeof value.notes !== "string")
  ) {
    throw new TypeError("Invalid update release.");
  }
  return Object.freeze({
    version: value.version,
    platform: value.platform,
    arch: value.arch,
    ring: value.ring,
    url: value.url,
    sha256: value.sha256,
    releasedAt: value.releasedAt,
    ...(value.notes === undefined ? {} : { notes: value.notes }),
  });
}

function decodeAppUpdateInstallOutcome(value: unknown): AppUpdateInstallOutcome {
  if (!isRecord(value)) throw new TypeError("Invalid update install outcome.");
  if (value.kind === "installing" || value.kind === "not-ready")
    return Object.freeze({ kind: value.kind });
  if (
    value.kind !== "wait" ||
    !Number.isInteger(value.activeAgentCount) ||
    typeof value.attentionRequired !== "boolean"
  ) {
    throw new TypeError("Invalid update install outcome.");
  }
  return Object.freeze({
    kind: "wait",
    activeAgentCount: value.activeAgentCount as number,
    attentionRequired: value.attentionRequired,
  });
}

function decodeBrowserSurfaceTabState(value: unknown): BrowserSurfaceTabState {
  if (
    !isRecord(value) ||
    typeof value.tabId !== "string" ||
    value.tabId.length === 0 ||
    value.tabId.length > 64 ||
    typeof value.url !== "string" ||
    value.url.length > 4_096 ||
    typeof value.title !== "string" ||
    value.title.length > 1_024
  ) {
    throw new TypeError("Invalid Browser surface tab.");
  }
  return Object.freeze({ tabId: value.tabId, url: value.url, title: value.title });
}

function validatePrivateListenerEnableRequest(value: PrivateListenerEnableBridgeRequest): void {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join("\0") !==
      ["certificatePem", "hostname", "localConfirmation", "origin", "port", "privateKeyPem"]
        .sort()
        .join("\0") ||
    typeof value.hostname !== "string" ||
    value.hostname.trim().length === 0 ||
    !Number.isSafeInteger(value.port) ||
    value.port < 1 ||
    value.port > 65_535 ||
    typeof value.origin !== "string" ||
    typeof value.certificatePem !== "string" ||
    value.certificatePem.length === 0 ||
    typeof value.privateKeyPem !== "string" ||
    value.privateKeyPem.length === 0 ||
    value.localConfirmation !== true
  ) {
    throw new TypeError("Invalid private listener enable request.");
  }
}

function decodePrivateListenerStatus(value: unknown): PrivateListenerPublicStatus {
  if (!isRecord(value)) throw new TypeError("Invalid private listener status.");
  const keys = Object.keys(value).sort();
  const allowed = new Set([
    "certificateFingerprint",
    "certificateReady",
    "enabled",
    "errorCode",
    "exposureClass",
    "hostname",
    "origin",
    "port",
    "state",
  ]);
  if (keys.some((key) => !allowed.has(key))) {
    throw new TypeError("Invalid private listener status.");
  }
  if (
    typeof value.enabled !== "boolean" ||
    (value.state !== "disabled" && value.state !== "ready" && value.state !== "failed") ||
    !(typeof value.hostname === "string" || value.hostname === null) ||
    !(typeof value.port === "number" || value.port === null) ||
    (typeof value.port === "number" &&
      (!Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65_535)) ||
    !(typeof value.origin === "string" || value.origin === null) ||
    !(
      value.exposureClass === null ||
      value.exposureClass === "lan-private" ||
      value.exposureClass === "tailscale"
    ) ||
    !(
      value.certificateFingerprint === null ||
      (typeof value.certificateFingerprint === "string" &&
        /^[a-f0-9]{64}$/.test(value.certificateFingerprint))
    ) ||
    typeof value.certificateReady !== "boolean" ||
    (value.errorCode !== undefined &&
      ![
        "local-confirmation-required",
        "invalid-bind",
        "invalid-origin",
        "invalid-tls",
        "occupied-port",
        "interface-unavailable",
        "bind-failed",
        "shutdown-failed",
        "unavailable",
      ].includes(String(value.errorCode)))
  ) {
    throw new TypeError("Invalid private listener status.");
  }
  return Object.freeze({
    enabled: value.enabled,
    state: value.state,
    hostname: value.hostname,
    port: value.port,
    origin: value.origin,
    exposureClass: value.exposureClass,
    certificateFingerprint: value.certificateFingerprint,
    certificateReady: value.certificateReady,
    ...(value.errorCode === undefined
      ? {}
      : { errorCode: value.errorCode as PrivateListenerControlFailureCode }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeProjectWindowCapability(argv: readonly string[]): string {
  const prefix = "--octant-project-capability=";
  const values = argv.filter((argument) => argument.startsWith(prefix));
  if (values.length !== 1) throw new TypeError("Invalid Project window capability.");
  const capability = values[0]?.slice(prefix.length);
  if (capability === undefined || !/^[A-Za-z0-9_-]{43}$/.test(capability)) {
    throw new TypeError("Invalid Project window capability.");
  }
  return capability;
}

export function decodeInitialProjectTarget(
  argv: readonly string[],
): ProjectWindowTarget | undefined {
  const projectPrefix = "--octant-initial-project-id=";
  const modePrefix = "--octant-initial-thread-mode=";
  const threadPrefix = "--octant-initial-thread-id=";
  const values = argv.filter((argument) => argument.startsWith(projectPrefix));
  const modes = argv.filter((argument) => argument.startsWith(modePrefix));
  const threadIds = argv.filter((argument) => argument.startsWith(threadPrefix));
  if (values.length === 0) {
    if (modes.length !== 0 || threadIds.length !== 0) {
      throw new TypeError("Invalid initial Project target.");
    }
    return undefined;
  }
  if (values.length !== 1) throw new TypeError("Invalid initial Project target.");
  const projectId = values[0]?.slice(projectPrefix.length);
  if (projectId === undefined || !PROVIDER_INSTANCE_ID_PATTERN.test(projectId)) {
    throw new TypeError("Invalid initial Project target.");
  }
  if (modes.length === 0 && threadIds.length === 0) {
    return Object.freeze({ kind: "project", projectId });
  }
  if (modes.length !== 1 || threadIds.length !== 1) {
    throw new TypeError("Invalid initial Project target.");
  }
  const mode = modes[0]?.slice(modePrefix.length);
  const threadId = threadIds[0]?.slice(threadPrefix.length);
  if (
    (mode !== "code" && mode !== "work") ||
    threadId === undefined ||
    !PROVIDER_INSTANCE_ID_PATTERN.test(threadId)
  ) {
    throw new TypeError("Invalid initial Project target.");
  }
  return Object.freeze({ kind: "project-thread", projectId, mode, threadId });
}

export function installHostBridge(
  context: ContextBridgePort,
  ipc: IpcRendererPort,
  projectWindowCapability = decodeProjectWindowCapability(process.argv),
  initialProjectTarget = decodeInitialProjectTarget(process.argv),
  platform: NodeJS.Platform = process.platform,
): void {
  context.exposeInMainWorld(
    HOST_BRIDGE_KEY,
    createHostBridge(ipc, projectWindowCapability, initialProjectTarget, platform),
  );
}

if (process.versions.electron !== undefined) {
  installHostBridge(contextBridge, ipcRenderer);
}
