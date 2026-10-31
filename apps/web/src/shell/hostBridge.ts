import type { CodeOperationApprovalRequest } from "@octant/contracts/code-operations";
import type { AppReleaseRing, AppUpdateState } from "@octant/contracts/app-updates";
import type { DesktopOwnerUnlockPort } from "@octant/client-runtime";
import type { NativeMenuRequest, NativeMenuOutcome } from "@octant/contracts/shell";

export type { AppUpdateState };

/**
 * The desktop bridge's payload types come from one shared contract,
 * `@octant/contracts/desktop-bridge`, which the main process, the preload
 * script, and this renderer all import, so the three bundles can never again
 * drift apart on the same shape. They are re-exported here for the surfaces
 * that already reached for them through this module.
 */
import type {
  ApprovalSurfacePalette,
  AppUpdateInstallOutcome,
  AttentionNotificationRequest,
  BoundProjectType,
  BrowserSurfaceRequest,
  BrowserSurfaceState,
  BrowserSurfaceTabCommand,
  BundledWhatsNew,
  CanvasPrototypeOpenRequest,
  CanvasPrototypeOpenResult,
  CanvasPrototypeSurfacePreparation,
  CodeCheckoutOpenRequest,
  CodeDeepLink,
  CodeExternalEditorRequest,
  CodeOperationApprovalAnchor,
  ForgetPairedComputerOutcome,
  HostCapabilities,
  LocalPluginFolderPickerResult,
  MenuBarOpenThread,
  OpenInApplicationDescriptor,
  PairedComputer,
  PairedComputerAnswer,
  PairedComputerOutcome,
  PairedComputerRequest,
  PrivateListenerEnableRequest,
  PrivateListenerPublicStatus,
  ProjectRootPickerResult,
  ProjectWindowTarget,
  ProviderApiKeySummary,
  ProviderCredentialStatus,
  RemoteCredentialOperationReceipt,
  RemoteDeviceInventoryEntry,
  RemoteMintedPairingTicket,
  RemotePendingPairingRequest,
  RemotePairingTicketSourceClass,
  ResolvedSidebarMaterial,
  SettlePairedComputerOutcome,
} from "@octant/contracts/desktop-bridge";

export type {
  ApprovalSurfacePalette,
  AppUpdateInstallOutcome,
  AttentionNotificationRequest,
  AttentionReason,
  BoundProjectType,
  BrowserSurfaceRequest,
  BrowserSurfaceState,
  BrowserSurfaceTabCommand,
  BrowserSurfaceTabState,
  BundledWhatsNew,
  CanvasPrototypeOpenRequest,
  CanvasPrototypeOpenResult,
  CanvasPrototypeSurfacePreparation,
  CodeCheckoutOpenRequest,
  CodeDeepLink,
  CodeExternalEditorRequest,
  CodeOperationApprovalAnchor,
  ForgetPairedComputerOutcome,
  HostCapabilities,
  LocalPluginFolderPickerResult,
  MenuBarOpenThread,
  OpenInApplicationDescriptor,
  PairedComputer,
  PairedComputerAnswer,
  PairedComputerOutcome,
  PairedComputerRequest,
  PrivateListenerEnableRequest,
  PrivateListenerPublicStatus,
  ProjectRootPickerResult,
  ProjectWindowTarget,
  ProviderApiKeySummary,
  ProviderCredentialStatus,
  RemoteCredentialOperationReceipt,
  RemoteDeviceInventoryEntry,
  RemoteMintedPairingTicket,
  RemotePendingPairingRequest,
  RemotePairingTicketSourceClass,
  ResolvedSidebarMaterial,
  SettlePairedComputerOutcome,
} from "@octant/contracts/desktop-bridge";

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

/**
 * Pairing this desktop app with another computer from its pasted app pairing
 * code, and reaching it afterwards. Present only in the desktop app, whose
 * main process checks that computer's key against the code's pin and sends
 * this window's requests over a connection held to it; a browser cannot.
 */
export interface PairedComputersBridge {
  readonly pairWithPairingCode: (code: string) => Promise<PairedComputerOutcome>;
  readonly listPairedComputers: () => Promise<ReadonlyArray<PairedComputer>>;
  readonly forgetPairedComputer: (origin: string) => Promise<ForgetPairedComputerOutcome>;
  /**
   * Ends the pairing the desktop has open for a computer. `approved` once the
   * computer approved this window's device, which makes the desktop keep its
   * pin; `abandoned` when the person leaves first, which drops only what that
   * pairing staged and never a computer already paired.
   */
  readonly settlePairedComputer: (
    origin: string,
    outcome: "approved" | "abandoned",
  ) => Promise<SettlePairedComputerOutcome>;
  readonly requestPairedComputer: (request: PairedComputerRequest) => Promise<PairedComputerAnswer>;
}

const pairedComputersByBridge = new WeakMap<OctantHostBridge, PairedComputersBridge>();

/**
 * The paired-computers bridge when the desktop app exposes every part of it,
 * else nothing. The same host bridge always yields the same object: a pairing
 * in progress keys its client and its device-key cleanup on this identity, so
 * a fresh object per render would delete the key it just claimed with.
 */
export function pairedComputersOf(
  bridge: OctantHostBridge | undefined,
): PairedComputersBridge | undefined {
  if (bridge === undefined) return undefined;
  const known = pairedComputersByBridge.get(bridge);
  if (known !== undefined) return known;
  const made = pairedComputersFrom(bridge);
  if (made !== undefined) pairedComputersByBridge.set(bridge, made);
  return made;
}

function pairedComputersFrom(bridge: OctantHostBridge): PairedComputersBridge | undefined {
  if (
    bridge.pairWithPairingCode === undefined ||
    bridge.listPairedComputers === undefined ||
    bridge.forgetPairedComputer === undefined ||
    bridge.settlePairedComputer === undefined ||
    bridge.requestPairedComputer === undefined
  ) {
    return undefined;
  }
  return {
    pairWithPairingCode: bridge.pairWithPairingCode,
    listPairedComputers: bridge.listPairedComputers,
    forgetPairedComputer: bridge.forgetPairedComputer,
    settlePairedComputer: bridge.settlePairedComputer,
    requestPairedComputer: bridge.requestPairedComputer,
  };
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

/** What a window asks of this host's hub role and hub membership. */
export type HubAdministrationOperation =
  | "status"
  | "enable"
  | "disable"
  | "join-code"
  | "remove"
  | "join"
  | "join-finish"
  | "grant"
  | "leave"
  | "owners-add"
  | "owners-remove"
  | "confirm-new-members"
  | "confirm-member"
  | "alert-dismiss"
  | "alert-remove"
  | "certificate-status"
  | "certificate"
  | "standby-order"
  | "promote"
  | "wake"
  | "wake-hardware-address"
  | "push"
  | "direct-push"
  | "direct-push-environment"
  | "direct-push-credential"
  | "direct-push-credential-remove"
  | "provision"
  | "provision-offer"
  | "provision-withdraw"
  | "provision-apply"
  | "provision-dismiss"
  | "provision-auto-apply"
  | "sign-in-ask"
  | "sign-in-accept"
  | "sign-in-decline"
  | "sign-in-check";

/**
 * The loopback hub administration, which only a local window reaches. Absent
 * on a remote client, so no hub screen is ever offered to one.
 */
export interface HubAdministrationBridge {
  readonly hubAdministrationRequest: (
    operation: HubAdministrationOperation,
    body?: unknown,
  ) => Promise<{ readonly status: number; readonly body: unknown }>;
}

/** The hub administration when this window is a local desktop window, else nothing. */
export function hubAdministrationOf(
  bridge: OctantHostBridge | undefined,
): HubAdministrationBridge | undefined {
  const request = bridge?.hubAdministrationRequest;
  return request === undefined ? undefined : { hubAdministrationRequest: request };
}

/**
 * A Mac owner device's unlock key (Touch ID or the account password). The
 * desktop makes the key and returns only its public half, signs one owner
 * unlock challenge, and forgets the key. Absent outside the desktop app.
 */
export type OwnerUnlockBridge = DesktopOwnerUnlockPort;

/** The Mac's unlock key when this window is a desktop window, else nothing. */
export function ownerUnlockOf(bridge: OctantHostBridge | undefined): OwnerUnlockBridge | undefined {
  if (
    bridge?.ownerUnlockMakeKey === undefined ||
    bridge.ownerUnlockSign === undefined ||
    bridge.ownerUnlockForgetKey === undefined
  ) {
    return undefined;
  }
  return {
    ownerUnlockMakeKey: bridge.ownerUnlockMakeKey,
    ownerUnlockSign: bridge.ownerUnlockSign,
    ownerUnlockForgetKey: bridge.ownerUnlockForgetKey,
  };
}

export interface OctantHostBridge
  extends
    Partial<RemoteAccessAdministrationBridge>,
    Partial<PairedComputersBridge>,
    Partial<HubAdministrationBridge>,
    Partial<OwnerUnlockBridge> {
  /**
   * Shows a server another paired computer granted this device, served by
   * the desktop's loopback forwarder, in Octant's browser or the default one.
   * Absent outside the desktop app.
   */
  readonly openRemoteServerPage?: (
    request: unknown,
  ) => Promise<
    | { readonly kind: "opened"; readonly notice?: string }
    | { readonly kind: "refused"; readonly message: string }
  >;
  /**
   * Closes the windows of a removed host's pages, clears their storage, and
   * forgets their names. Absent outside the desktop app.
   */
  readonly forgetRemoteServerPages?: (
    hostId: string,
  ) => Promise<{ readonly status: "forgotten" | "incomplete"; readonly message?: string }>;
  /** Makes this window the signer for the pages it opened. Absent outside the desktop app. */
  readonly subscribeRemoteServerPageSigning?: (
    signer: (request: unknown) => Promise<unknown>,
  ) => () => void;
  readonly popupNativeMenu?: (request: NativeMenuRequest) => Promise<NativeMenuOutcome>;
  readonly getComputerUseStatus?: () => Promise<unknown>;
  readonly requestComputerUsePermissions?: () => Promise<unknown>;
  readonly openComputerUsePermissionSettings?: () => Promise<void>;
  readonly checkComputerUseUpdates?: () => Promise<unknown>;
  readonly getManagedToolsStatus?: () => Promise<unknown>;
  readonly checkManagedToolUpdates?: (tool?: string) => Promise<unknown>;
  readonly setManagedToolAutomaticUpdates?: (enabled: boolean) => Promise<unknown>;
  readonly notifyAttention?: (request: AttentionNotificationRequest) => Promise<void>;
  /** Tells the menu bar which thread this window shows, so its done row clears. */
  readonly setMenuBarOpenThread?: (thread: MenuBarOpenThread | null) => Promise<void>;
  readonly subscribeMenuBarTask?: (listener: (target: MenuBarOpenThread) => void) => () => void;
  readonly setAttentionBadge?: (count: number) => Promise<void>;
  /**
   * Closes the network of the surface a running Canvas prototype is drawn in.
   * A prototype runs in the desktop app only once this is ready, and nowhere
   * else there. Absent outside the desktop app.
   */
  readonly prepareCanvasPrototypeSurface?: () => Promise<CanvasPrototypeSurfacePreparation>;
  /**
   * The prototype host: a running prototype is opened there under an id this
   * window chose, its pixels and bridge messages come back as events, and a
   * person's input goes to it. Absent outside the desktop app.
   */
  readonly openCanvasPrototype?: (
    request: CanvasPrototypeOpenRequest,
  ) => Promise<CanvasPrototypeOpenResult>;
  readonly sendCanvasPrototypeInput?: (surfaceId: string, input: unknown) => Promise<void>;
  readonly resizeCanvasPrototype?: (
    surfaceId: string,
    width: number,
    height: number,
  ) => Promise<void>;
  readonly closeCanvasPrototype?: (surfaceId: string) => Promise<void>;
  /** Says the window drew a prototype's last frame, so the host sends the next. */
  readonly acknowledgeCanvasPrototypeFrame?: (surfaceId: string) => Promise<void>;
  readonly subscribeCanvasPrototypeEvents?: (listener: (event: unknown) => void) => () => void;
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
  readonly checkForAppUpdate?: () => Promise<AppUpdateState>;
  readonly downloadAppUpdate?: () => Promise<AppUpdateState>;
  readonly installAppUpdate?: () => Promise<AppUpdateInstallOutcome>;
  readonly setAutomaticAppUpdateChecks?: (enabled: boolean) => Promise<AppUpdateState>;
  readonly setAppUpdateRing?: (ring: AppReleaseRing) => Promise<AppUpdateState>;
  readonly subscribeAppUpdateState?: (listener: (state: AppUpdateState) => void) => () => void;
  /**
   * Local What's new for the build on disk. Desktop-owned; never a network
   * fetch. Absent on a remote client.
   */
  readonly readBundledWhatsNew?: () => Promise<BundledWhatsNew>;
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
  /** Reports the resolved theme an approval view should draw. */
  readonly setApprovalSurfacePalette?: (palette: ApprovalSurfacePalette) => Promise<void> | void;
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
  /**
   * Native file picker for a runtime's executable. Answers an opaque receipt
   * the host later redeems for the chosen path; the renderer never sees it.
   */
  readonly selectRuntimeBinary?: () => Promise<LocalPluginFolderPickerResult>;
  readonly setProviderCredential: (providerInstanceId: string, credential: string) => Promise<void>;
  readonly listProviderApiKeys: (
    providerInstanceId: string,
  ) => Promise<readonly ProviderApiKeySummary[]>;
  /** Adds a key after the existing ones. Never replaces or removes a key. */
  readonly addProviderApiKey: (
    providerInstanceId: string,
    credential: string,
    label?: string,
  ) => Promise<ProviderApiKeySummary>;
  readonly renameProviderApiKey: (
    providerInstanceId: string,
    keyId: string,
    label: string,
  ) => Promise<void>;
  readonly replaceProviderApiKey: (
    providerInstanceId: string,
    keyId: string,
    credential: string,
  ) => Promise<void>;
  readonly removeProviderApiKey: (providerInstanceId: string, keyId: string) => Promise<void>;
  readonly setActiveProviderApiKey: (providerInstanceId: string, keyId: string) => Promise<void>;
  /** Swaps a key with its neighbour in the list. The first key up and the last key down do nothing. */
  readonly moveProviderApiKey: (
    providerInstanceId: string,
    keyId: string,
    direction: "up" | "down",
  ) => Promise<void>;
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
  /** The first ⌘Q press: the window shows "press again to quit". */
  readonly subscribeQuitShortcutHint?: (listener: () => void) => () => void;
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
    typeof (bridge as Record<string, unknown>).clearProviderCredential !== "function" ||
    typeof (bridge as Record<string, unknown>).listProviderApiKeys !== "function" ||
    typeof (bridge as Record<string, unknown>).addProviderApiKey !== "function"
  ) {
    throw new TypeError("Invalid Octant host bridge.");
  }
  return bridge as OctantHostBridge;
}
