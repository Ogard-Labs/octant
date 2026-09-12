import type { OpenInApplicationId } from "@octant/contracts/shell";

export type ResolvedSidebarMaterial = "opaque" | "translucent";
export type BoundProjectType = "work" | "code";
export type ProviderCredentialStatus = "stored" | "missing" | "unavailable";
export type ProjectRootPickerResult =
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "selected"; receiptId: string; displayName: string }>;
export type LocalPluginFolderPickerResult =
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
export type CodeDeepLink =
  | Readonly<{ kind: "project"; projectId: string }>
  | Readonly<{ kind: "thread"; threadId: string }>
  | Readonly<{ kind: "diff"; threadId: string; checkoutId: string }>
  | Readonly<{ kind: "test"; threadId: string; testRunId: string }>
  | Readonly<{
      kind: "file";
      threadId: string;
      checkoutId: string;
      fileId: string;
      relativePath: string;
      line: number;
      column: number;
    }>
  | Readonly<{ kind: "new-thread"; projectId: string; checkoutId: string }>;

export interface HostCapabilities {
  readonly sidebarVibrancySupported: boolean;
  readonly liveBrowserSupported?: boolean;
  readonly liveSimulatorFrameSupported?: boolean;
}

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
  /**
   * Every page open in this context. Older hosts report no tabs at all, so a
   * rail reads an absent list as the one page it already shows.
   */
  readonly tabs?: ReadonlyArray<BrowserSurfaceTabState>;
  readonly activeTabId?: string;
}

import type {
  AppReleaseRing,
  AppUpdateState as AppUpdateStateView,
} from "@octant/contracts/app-updates";

export type { AppUpdateStateView };

export interface AppUpdateReleaseView {
  readonly version: string;
  readonly platform: string;
  readonly arch: string;
  readonly ring: AppReleaseRing;
  readonly url: string;
  readonly sha256: string;
  readonly releasedAt: string;
  readonly notes?: string;
}

/**
 * What the host is still busy with, as it already reports it for the quit
 * guard. The renderer never supplies this — the host reads it itself.
 */
export type AppUpdateInstallOutcome =
  | { readonly kind: "installing" }
  | {
      readonly kind: "wait";
      readonly activeAgentCount: number;
      readonly attentionRequired: boolean;
    }
  | { readonly kind: "not-ready" };

/**
 * Bundled notes for the running desktop build. Absent on a remote client,
 * which must not fetch notes or pretend to update the Machine.
 */
export type BundledWhatsNewView =
  | {
      readonly kind: "notes";
      readonly version: string;
      readonly text: string;
      readonly showAfterApply: boolean;
    }
  | {
      readonly kind: "empty";
      readonly version: string;
      readonly showAfterApply: false;
    };

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

export type CodeOperationApprovalAnchor =
  | {
      readonly kind: "thread";
      readonly projectId: string;
      readonly threadId: string;
      readonly bounds: {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
      };
    }
  | {
      readonly kind: "draft";
      readonly projectId: string;
      readonly composerId: string;
      readonly bounds: {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
      };
    };

export type ProjectWindowTarget =
  | Readonly<{ kind: "project"; projectId: string }>
  | Readonly<{
      kind: "project-thread";
      projectId: string;
      mode: "code" | "work";
      threadId: string;
    }>;

export type AttentionReason =
  | "turn-finished"
  | "approval-required"
  | "question-asked"
  | "follow-up-due";

export interface AttentionNotificationRequest {
  readonly reason: AttentionReason;
  readonly threadTitle: string;
  readonly detail?: string;
}

export type PrivateListenerExposureClass = "lan-private" | "tailscale";

export interface PrivateListenerPublicStatus {
  readonly enabled: boolean;
  readonly state: "disabled" | "ready" | "failed";
  readonly hostname: string | null;
  readonly port: number | null;
  readonly origin: string | null;
  readonly exposureClass: PrivateListenerExposureClass | null;
  readonly certificateFingerprint: string | null;
  readonly certificateReady: boolean;
  readonly errorCode?: string;
}

export interface PrivateListenerEnableRequest {
  readonly hostname: string;
  readonly port: number;
  readonly origin: string;
  readonly certificatePem: string;
  readonly privateKeyPem: string;
  readonly localConfirmation: true;
}

export type RemotePairingTicketSourceClass = "loopback" | "lan-private" | "tailscale";

export interface RemoteMintedPairingTicket {
  readonly ticketId: string;
  readonly ticketProof: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
  readonly sourceClass: RemotePairingTicketSourceClass;
}

export interface RemotePendingPairingRequest {
  readonly kind: "pending";
  readonly ticketId: string;
  readonly hostId: string;
  readonly deviceLabel: string;
  readonly deviceKeyFingerprint: string;
  readonly origin: string;
  readonly sourceClass: RemotePairingTicketSourceClass | "unknown";
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
  readonly state: "active" | "revoked" | "expired";
  readonly revokedAt?: string;
  readonly revokedReason?: string;
}

export interface RemoteCredentialOperationReceipt {
  readonly commandId: string;
  readonly result: "applied" | "already-applied";
  readonly occurredAt: string;
}

/**
 * Listener and paired-device administration. Present only on the packaged
 * desktop host: these are `desktop.*` actions the server refuses for a
 * remote principal, so a paired browser never receives them.
 */
export interface RemoteAccessAdministrationBridge {
  readonly getPrivateListenerStatus: () => Promise<PrivateListenerPublicStatus>;
  readonly enablePrivateListener: (
    request: PrivateListenerEnableRequest,
  ) => Promise<PrivateListenerPublicStatus>;
  readonly restartPrivateListener: (
    request: PrivateListenerEnableRequest,
  ) => Promise<PrivateListenerPublicStatus>;
  readonly disablePrivateListener: () => Promise<PrivateListenerPublicStatus>;
  readonly mintRemotePairingTicket: (
    sourceClass: RemotePairingTicketSourceClass,
  ) => Promise<RemoteMintedPairingTicket>;
  readonly listRemotePairingRequests: () => Promise<ReadonlyArray<RemotePendingPairingRequest>>;
  readonly approveRemotePairingRequest: (
    ticketId: string,
  ) => Promise<{ readonly decision: "approved"; readonly device: RemoteDeviceInventoryEntry }>;
  readonly denyRemotePairingRequest: (
    ticketId: string,
    reasonCode: string,
  ) => Promise<{ readonly decision: "denied" }>;
  readonly getRemoteDeviceInventory: () => Promise<ReadonlyArray<RemoteDeviceInventoryEntry>>;
  readonly renameRemoteDevice: (
    deviceId: string,
    deviceLabel: string,
  ) => Promise<RemoteDeviceInventoryEntry>;
  readonly revokeRemoteDevice: (deviceId: string) => Promise<RemoteCredentialOperationReceipt>;
  readonly revokeAllRemoteDevices: () => Promise<RemoteCredentialOperationReceipt>;
}

/** The administration bridge when the host exposes every part of it, else nothing. */
export function remoteAccessAdministrationOf(
  bridge: OctantHostBridge | undefined,
): RemoteAccessAdministrationBridge | undefined {
  if (
    bridge?.getPrivateListenerStatus === undefined ||
    bridge.enablePrivateListener === undefined ||
    bridge.restartPrivateListener === undefined ||
    bridge.disablePrivateListener === undefined ||
    bridge.mintRemotePairingTicket === undefined ||
    bridge.listRemotePairingRequests === undefined ||
    bridge.approveRemotePairingRequest === undefined ||
    bridge.denyRemotePairingRequest === undefined ||
    bridge.getRemoteDeviceInventory === undefined ||
    bridge.renameRemoteDevice === undefined ||
    bridge.revokeRemoteDevice === undefined ||
    bridge.revokeAllRemoteDevices === undefined
  ) {
    return undefined;
  }
  return {
    getPrivateListenerStatus: bridge.getPrivateListenerStatus,
    enablePrivateListener: bridge.enablePrivateListener,
    restartPrivateListener: bridge.restartPrivateListener,
    disablePrivateListener: bridge.disablePrivateListener,
    mintRemotePairingTicket: bridge.mintRemotePairingTicket,
    listRemotePairingRequests: bridge.listRemotePairingRequests,
    approveRemotePairingRequest: bridge.approveRemotePairingRequest,
    denyRemotePairingRequest: bridge.denyRemotePairingRequest,
    getRemoteDeviceInventory: bridge.getRemoteDeviceInventory,
    renameRemoteDevice: bridge.renameRemoteDevice,
    revokeRemoteDevice: bridge.revokeRemoteDevice,
    revokeAllRemoteDevices: bridge.revokeAllRemoteDevices,
  };
}

export interface OctantHostBridge extends Partial<RemoteAccessAdministrationBridge> {
  readonly getComputerUseStatus?: () => Promise<unknown>;
  readonly requestComputerUsePermissions?: () => Promise<unknown>;
  readonly openComputerUsePermissionSettings?: () => Promise<void>;
  readonly checkComputerUseUpdates?: () => Promise<unknown>;
  readonly notifyAttention?: (request: AttentionNotificationRequest) => Promise<void>;
  readonly setAttentionBadge?: (count: number) => Promise<void>;
  readonly attachBrowserSurface?: (request: BrowserSurfaceRequest) => Promise<BrowserSurfaceState>;
  readonly updateBrowserSurfaceBounds?: (request: BrowserSurfaceRequest) => Promise<void>;
  readonly detachBrowserSurface?: (request: Omit<BrowserSurfaceRequest, "bounds">) => Promise<void>;
  readonly commandBrowserSurface?: (
    request: Omit<BrowserSurfaceRequest, "bounds"> & {
      readonly command: "back" | "forward" | "reload" | "stop";
    },
  ) => Promise<void>;
  readonly tabBrowserSurface?: (
    request: Omit<BrowserSurfaceRequest, "bounds"> & {
      readonly command: BrowserSurfaceTabCommand;
    },
  ) => Promise<BrowserSurfaceState>;
  /**
   * The desktop app's own update path. Absent on a remote client, which is
   * served by a host it does not update.
   */
  readonly checkForAppUpdate?: () => Promise<AppUpdateStateView>;
  readonly downloadAppUpdate?: () => Promise<AppUpdateStateView>;
  readonly installAppUpdate?: () => Promise<AppUpdateInstallOutcome>;
  readonly setAutomaticAppUpdateChecks?: (enabled: boolean) => Promise<AppUpdateStateView>;
  readonly setAppUpdateRing?: (ring: AppReleaseRing) => Promise<AppUpdateStateView>;
  readonly subscribeAppUpdateState?: (listener: (state: AppUpdateStateView) => void) => () => void;
  /**
   * Local What's new for the build on disk. Desktop-owned; never a network
   * fetch. Absent on a remote client.
   */
  readonly readBundledWhatsNew?: () => Promise<BundledWhatsNewView>;
  readonly acknowledgeWhatsNew?: () => Promise<void>;
  readonly openBrowserExternal?: (url: string) => Promise<void>;
  readonly subscribeBrowserSurfaceState?: (
    listener: (state: BrowserSurfaceState) => void,
  ) => () => void;
  readonly clearProviderCredential: (providerInstanceId: string) => Promise<void>;
  readonly close: () => Promise<void> | void;
  readonly getHostCapabilities?: () => HostCapabilities | Promise<HostCapabilities>;
  /**
   * The chrome the host actually gave this window. Only the macOS hiddenInset
   * presentation leaves the titlebar area to the renderer; a system-framed
   * window already draws its own titlebar, so reserving the inset there wastes
   * a strip of the window and lays a drag region over the real title bar.
   * Absent on a host that does not report it, which is read as system frame.
   */
  readonly windowChrome?: "hidden-inset" | "system-frame";
  readonly initialProjectTarget?: ProjectWindowTarget;
  readonly maximizeOrRestore: () => Promise<void> | void;
  readonly minimize: () => Promise<void> | void;
  readonly openCodeExternalEditor?: (request: CodeExternalEditorRequest) => Promise<void>;
  readonly listOpenInApplications?: () => Promise<ReadonlyArray<OpenInApplicationDescriptor>>;
  readonly openCodeCheckoutInApplication?: (request: CodeCheckoutOpenRequest) => Promise<void>;
  readonly openInNewWindow?: (target: ProjectWindowTarget) => Promise<void> | void;
  readonly requestCodeOperationApproval?: (
    request: CodeOperationApprovalRequest,
    presentation?: { readonly projectId: string; readonly composerId: string },
  ) => Promise<string | undefined>;
  /** Positions an owner-only native approval view; it cannot confirm one. */
  readonly updateCodeOperationApprovalAnchor?: (
    anchor: CodeOperationApprovalAnchor,
  ) => Promise<void>;
  /** Cancels any pending native approval owned by this window. */
  readonly cancelCodeOperationApproval?: () => Promise<void>;
  readonly projectWindowCapability: string;
  readonly subscribeProjectWindowCapability?: (
    listener: (capability: string) => void,
  ) => () => void;
  /** Capability-bound window identity from Electron argv, never from a query. */
  readonly windowId?: string;
  readonly providerCredentialStatus: (
    providerInstanceId: string,
  ) => Promise<ProviderCredentialStatus>;
  readonly resetBounds: () => Promise<void> | void;
  readonly selectProjectRoot: (projectType: BoundProjectType) => Promise<ProjectRootPickerResult>;
  readonly selectLocalPluginFolder?: () => Promise<LocalPluginFolderPickerResult>;
  readonly setProviderCredential: (providerInstanceId: string, credential: string) => Promise<void>;
  readonly setSidebarMaterialPreference: (preference: "opaque" | "system") => Promise<void> | void;
  readonly setSidebarVibrancyMode?: (mode: "off" | "subtle" | "strong") => Promise<void> | void;
  readonly subscribeResolvedMaterial: (
    listener: (material: ResolvedSidebarMaterial) => void,
  ) => () => void;
  /**
   * The host's word that native window vibrancy is actually applied. The
   * renderer keeps its near-opaque native sidebar wash until this reports
   * "sidebar", because CSS backdrop-filter cannot frost another app's window —
   * translucency without host vibrancy shows the desktop behind sharp. Absent
   * on hosts that never apply vibrancy.
   */
  readonly subscribeResolvedSidebarVibrancy?: (
    listener: (vibrancy: "sidebar" | null) => void,
  ) => () => void;
  readonly subscribeCodeDeepLinks?: (listener: (target: CodeDeepLink) => void) => () => void;
  readonly subscribeOpenSettings?: (listener: () => void) => () => void;
  readonly subscribeStartNewAgent?: (listener: () => void) => () => void;
}

declare global {
  interface Window {
    readonly octantHost?: OctantHostBridge;
  }
}

export interface HostBridgeGlobal {
  readonly octantHost?: unknown;
}

export function getInjectedHostBridge(
  host: HostBridgeGlobal = window,
): OctantHostBridge | undefined {
  const bridge = host.octantHost;
  if (bridge === undefined) return undefined;
  if (
    typeof bridge !== "object" ||
    bridge === null ||
    typeof (bridge as Record<string, unknown>).setProviderCredential !== "function" ||
    typeof (bridge as Record<string, unknown>).providerCredentialStatus !== "function" ||
    typeof (bridge as Record<string, unknown>).clearProviderCredential !== "function"
  ) {
    throw new TypeError("Invalid Octant host bridge.");
  }
  return bridge as OctantHostBridge;
}
import type { CodeOperationApprovalRequest } from "@octant/contracts/code-operations";
