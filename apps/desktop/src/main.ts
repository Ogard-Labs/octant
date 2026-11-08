import { createDesktopBrowserCredentialFill } from "./desktopBrowserCredentialFill";
import { createDesktopClientLifetime } from "./desktopClientLifetime";
import {
  attachWindowsDesktopHost,
  resolveWindowsDesktopHost,
  requestWindowsDesktopHostStop,
} from "./windowsDesktopHost";
import { resolvePackagedDesktopLaunch } from "./desktopLaunch";
import { createOffscreenBrowserSurface } from "./offscreenBrowserSurface";
import { ownNightlyWindowLeases } from "./nightlyBrowserLease";
import { desktopWindowProtocol } from "./desktopPeerWindows";
import {
  createMainBrowserWindowOptions,
  createTrustedRendererRequestRegistry,
  decorateTrustedRendererHeaders,
} from "./desktopWindowBootstrap";
export {
  createMainBrowserWindowOptions,
  createTrustedRendererRequestRegistry,
  decorateTrustedRendererHeaders,
} from "./desktopWindowBootstrap";
export type { TrustedRendererRequestContext } from "./desktopWindowBootstrap";
import {
  loadDesktopPeerStatus,
  ownDesktopPeerStatus,
  writeLinuxLauncherRecord,
} from "./desktopPeerStatus";
import {
  createDesktopHostLaunch,
  startDesktopHostServer,
  type DesktopHostLaunch,
} from "./desktopHostLaunch";
import { popupNativeMenu, installNativeEditingMenus } from "./nativeContextMenus";
import { createNativeCodeApprovalViewHost } from "./nativeCodeApprovalView";
import { startComputerUseBroker } from "./computerUseBroker";
import { startSimulatorDeviceBroker } from "./simulatorDeviceBroker";
import { createSimulatorDeviceHelpers } from "./simulatorDeviceHelper";
import {
  createManagedSimulatorHelpers,
  createUnavailableSimulatorHelpers,
} from "./managedSimulatorHelpers";
import { startServeAvdBroker } from "./serveAvdBroker";
import {
  createComputerUseDesktopService,
  type ComputerUseDesktopService,
} from "./computerUseDesktopService";
import {
  CUA_DRIVER_FILENAME,
  DEVICE_HELPER_FILENAME,
  resolveDesktopNodeRuntime,
  resolveDesktopHostRoot,
} from "./runtimePaths";
import { createWindowCapture } from "./windowCapture";
import { grabWindowFrame } from "./windowFrameGrab";
import { createManagedToolService, type ManagedToolService } from "./managedToolService";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  app,
  autoUpdater as electronAutoUpdater,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  desktopCapturer,
  powerMonitor,
  screen,
  session,
  shell,
  systemPreferences,
  Tray,
  WebContentsView,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";
import {
  CredentialStoreFailure,
  desktopIdentity,
  desktopIdentityForPackage,
  desktopWindowStorageDirectory,
  deriveHostRuntimeHostId,
  loadWindowsHostProfileNative,
  KEYCHAIN_SERVICE_FAMILY_ENVIRONMENT,
  isLinkedSecretMaterial,
  linkedSecretStoresStatePath,
  makeLinkedSecretStores,
  prepareHostRuntimePaths,
  readHostInfoReceipt,
  ServicePolicyStore,
  addApiKey,
  ApiKeyPoolError,
  listApiKeys,
  prepareBrowserDownloadHoldRoot,
  moveApiKey,
  removeApiKey,
  renameApiKey,
  replaceApiKeySecret,
  setActiveApiKey,
  startCredentialBroker,
  writeBridgeSecretProjection,
  type CredentialBroker,
  type CredentialStore,
  type HostRuntimePaths,
} from "@octant/host-runtime";
import {
  decodePreviewHandoffRequest,
  type PreviewHandoffRequest,
} from "@octant/contracts/previews";
import { type AppVersion, isAppReleaseRing } from "@octant/contracts/app-updates";
import { decodeCodeOperationApprovalRequest } from "@octant/contracts/code-operations";
import { decodeStoredBrowserProfile } from "@octant/contracts/browser-profiles";
import {
  DESKTOP_IPC_CHANNELS as IPC_CHANNELS,
  KEYRING_ADVICE_MARKER,
  MAX_PROVIDER_CREDENTIAL_BYTES,
  PROVIDER_INSTANCE_ID_PATTERN,
  decodeCodeCheckoutOpenRequest,
  decodeCodeExternalEditorRequest,
} from "./ipcChannels";
import type {
  CodeCheckoutOpenRequest,
  CodeExternalEditorRequest,
  HostCapabilities,
} from "@octant/contracts/desktop-bridge";
import { createAppUpdateService } from "./appUpdateService";
import { createNightlyInstaller } from "./nightlyInstaller";
import {
  createNightlyDataControl,
  createRelaunchIntent,
  resolveHostOwningStartup,
  resolveStartupHostRole,
} from "./nightlyTestData";
import {
  createPortableImagePort,
  defaultProcessIsAlive,
  REPLACED_PROCESS_POLL_MS,
  REPLACED_PROCESS_WAIT_BOUND_MS,
  takeReplacedProcessId,
  waitForReplacedProcessExit,
} from "./portableImageUpdate";
import { createQuitShortcutGuard } from "./quitShortcutGuard";
import {
  buildApplicationMenuTemplate,
  buildStableMenuTemplate,
  developerToolsAllowed,
} from "./applicationMenu";
import { resolveUpdateFeedBaseUrl } from "./appUpdateFeed";
import {
  acknowledgeWhatsNew,
  loadBundledWhatsNew,
  resolveBundledWhatsNewPath,
  resolveWhatsNewStatePath,
} from "./bundledWhatsNew";
import {
  createBrowserSurfaceHost,
  type BrowserSurfaceTabCommand,
  type BrowserSurfaceViewPort,
  type ReturnTypeOfBrowserSurfaceHost,
} from "./browserSurfaceHost";
import { startBrowserRuntimeBroker, type BrowserRuntimeBroker } from "./browserRuntimeBroker";
import { createBrowserProfileStore } from "./browserProfileStore";
import {
  createExtensionPopupHost,
  type ExtensionPopupShellWindow,
  type ExtensionPopupView,
} from "./browserExtensionPopupHost";
import { fitPopupBounds, validateExtensionPopupRequest } from "./browserExtensionPopupRequest";
import { createExtensionBridge } from "./browserExtensionBridge";
import { createExtensionTabsService } from "./browserExtensionTabs";
import { openCodeExternalEditorFromServer } from "./codeExternalEditor";
import {
  detectOpenInApplications,
  launchOpenInApplication,
  openCodeCheckoutInApplicationFromServer,
} from "./openInApplications";
import { createNativePreviewHandoffExecutor, openPreviewHandoffFromServer } from "./previewHandoff";
import {
  createRendererNavigationPolicy,
  installRendererNavigationGuards,
  type RendererNavigationWebContentsPort,
} from "./rendererNavigationPolicy";
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
  type CodeOperationApprovalPalette,
} from "./codeOperationApprovalView";
import { parseCodeDeepLink, type CodeDeepLink } from "./codeDeepLinks";
import { validateExternalBrowserUrl } from "./externalBrowserUrl";
import {
  resolveDesktopCredentialBackend,
  type DesktopCredentialBackend,
} from "./desktopCredentialStore";
import { browserProfilePartition, ringForVersion } from "@octant/domain";
import { keyringAdvice } from "@octant/domain/keyring-advice";
import {
  HostIdentitySigningFailure,
  makeHostIdentitySigningService,
  type HostIdentitySigningService,
} from "./hostIdentityKeychain";
import {
  makeOwnerUnlockKeyService,
  type OwnerUnlockChallenge,
  type OwnerUnlockKeyService,
} from "./ownerUnlockKeychain";
import {
  centeredNativeWindowState,
  createNativeWindowStateStore,
  flushNativeWindowState,
  type NativeWindowStateStore,
} from "./nativeWindowState";
import {
  createProjectRootPicker,
  createProjectWindowAuthority,
  generateProjectBridgeToken,
  namesItsCause,
} from "./projectRootPicker";
import { createBrowserLaunchLink } from "./browserLaunchLink";
import { createLocalPluginFolderPicker } from "./localPluginFolderPicker";
import { createRuntimeBinaryPicker } from "./runtimeBinaryPicker";
import { createBrowserProofSaver } from "./browserProofSaver";
import { createSupportBundleSaver } from "./supportBundleSaver";
import {
  createSingleFlight,
  assertAutomaticHostStartupEnabled,
  formatDesktopStartupFailure,
  probeHostInfoReceipt,
  probeLocalHost,
  createStderrTail,
  reserveLoopbackPort,
  resolveManagedServerUrl,
  resolveStableHostAttachment,
  serverSpawnSpec,
  shutdownManagedServer,
  waitForStorageReady,
} from "./serverProcess";
import {
  createHostLifecycleController,
  workInFlight,
  type HostAdmission,
  type LocalHostDescriptor,
} from "./hostLifecycle";
import { createDesktopBackendSupervisor } from "./desktopBackendSupervision";
import {
  buildMenuBarItems,
  formatRedactedHostDiagnostics,
  decodeMenuBarOpenThread,
  MenuBarFleet,
  menuBarTitle,
  type MenuBarOpenThread,
} from "./menuBar";
import { createMenuBarFleetReader } from "./menuBarFleetRead";
import { createHostTrayImage, shouldPresentHostTray } from "./menuBarIcon";
import { buildQuitConfirmation, evaluateQuitRequest } from "./quitGuard";
import {
  WINDOW_CLOSE_GRACE_MS,
  armQuitDeadline,
  saveWindowStateWithoutBlocking,
  shutDownForQuit,
} from "./quitShutdown";
import {
  attentionBadgeLabel,
  attentionNotificationPresentation,
  decodeAttentionBadgeCount,
  decodeAttentionNotificationRequest,
} from "./attentionNotifications";
import {
  CODE_FILE_HELPER_FILENAME,
  CODE_APPROVAL_PRELOAD_FILENAME,
  DESKTOP_PRELOAD_FILENAME,
  EXTENSION_BRIDGE_PRELOAD_FILENAME,
  KEYCHAIN_HELPER_FILENAME,
  resolveDesktopHostRuntimePaths,
  resolveDesktopNativeHelperPath,
  WINDOWS_CREDENTIAL_HELPER_FILENAME,
  WINDOWS_HOST_OWNER_FILENAME,
  resolveManagedToolsDirectory,
  resolveTerminalLauncherDirectory,
  type DesktopNativeHelperPathOptions,
} from "./runtimePaths";
import {
  INITIAL_SIDEBAR_MATERIAL_PREFERENCE,
  createWindowPresentationController,
  observeThermalPerformance,
  resolveWindowPresentation,
  type ResolvedSidebarMaterial,
  type WindowPresentationController,
} from "./windowPresentation";
import {
  createPrivateListenerControlService,
  createPrivateListenerHostRuntime,
  PrivateListenerControlFailure,
  type PrivateListenerControlService,
  type PrivateListenerEnableRequest,
} from "./privateListenerControls";
import {
  createRemoteDeviceControlHttpRuntime,
  createRemoteDeviceControlService,
  RemoteDeviceControlFailure,
  type RemoteDeviceControlService,
} from "./remoteDeviceControls";
import {
  HubAdministrationControlFailure,
  sendHubAdministrationOperation,
  type HubAdministrationControlRuntime,
} from "./hubAdministrationControls";
import {
  installPairedComputerIpcHandlers,
  type PageStoragePort,
  PairedComputerPins,
} from "./pairedComputers";
import { markHostInteraction } from "./interactionTrace";
import {
  installCanvasFrameGuards,
  isolateEachCanvasFrameDocument,
  type CanvasFrameGuardWebContentsPort,
} from "./canvasFrameGuard";
import {
  closeCanvasPrototypesWith,
  createCanvasPrototypeSurface,
  spawnCanvasPrototypeHost,
  type CanvasPrototypeOwner,
  type CanvasPrototypeOwnerContentsPort,
  type CanvasPrototypeSurface,
} from "./canvasPrototypeSurface";
import { CANVAS_PROTOTYPE_HOST_SWITCH } from "./canvasPrototypeHost";
import {
  createRemoteServerPages,
  pageAccessHeader,
  pageNavigation,
  readRecordedForwarderPort,
  readRecordedRemotePages,
  recordForwarderPort,
  recordRemotePages,
  validateRemoteServerPageOpenRequest,
  type RemoteServerPages,
} from "./remoteServerPages";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Bounds how long a failed start waits for the child's final stderr bytes.
const STDERR_DRAIN_TIMEOUT_MS = 500;

type ProjectWindowTarget =
  | Readonly<{ kind: "project"; projectId: string }>
  | Readonly<{
      kind: "project-thread";
      projectId: string;
      mode: "code" | "work";
      threadId: string;
    }>;

interface DesktopWindowIdentity {
  readonly windowId: string;
  readonly capability: string;
}

export function createDesktopWindowContextRegistry<
  TWindow extends { readonly id: number; readonly isDestroyed: () => boolean },
  TContext extends DesktopWindowIdentity = DesktopWindowIdentity,
>() {
  const contexts = new Map<number, Readonly<TContext & { readonly window: TWindow }>>();
  const unauthorized = (): never => {
    throw new Error("Octant rejected an unauthorized native window request.");
  };
  return Object.freeze({
    active: (): ReadonlyArray<Readonly<TContext & { readonly window: TWindow }>> =>
      Object.freeze([...contexts.values()].filter(({ window }) => !window.isDestroyed())),
    hasWindowId: (windowId: string): boolean =>
      [...contexts.values()].some(
        (context) => context.windowId === windowId && !context.window.isDestroyed(),
      ),
    register: (window: TWindow, context: TContext): void => {
      if (contexts.has(window.id)) unauthorized();
      contexts.set(window.id, Object.freeze({ ...context, window }));
    },
    remove: (window: TWindow): void => {
      const context = contexts.get(window.id);
      if (context?.window === window) contexts.delete(window.id);
    },
    replaceCapability: (
      window: TWindow,
      capability: string,
    ): Readonly<TContext & { readonly window: TWindow }> | undefined => {
      if (window.isDestroyed()) return undefined;
      const context = contexts.get(window.id);
      if (context === undefined || context.window !== window) return undefined;
      const replacement = Object.freeze({ ...context, capability, window });
      contexts.set(window.id, replacement);
      return replacement;
    },
    resolve: (window: TWindow | null): Readonly<TContext & { readonly window: TWindow }> => {
      if (window === null || window.isDestroyed()) return unauthorized();
      const context = contexts.get(window.id);
      if (context === undefined || context.window !== window) return unauthorized();
      return context;
    },
  });
}

export function validateProjectWindowTarget(value: unknown): ProjectWindowTarget {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Octant rejected an invalid Project window target.");
  }
  const target = value as Record<string, unknown>;
  if (
    typeof target.projectId !== "string" ||
    !PROVIDER_INSTANCE_ID_PATTERN.test(target.projectId)
  ) {
    throw new Error("Octant rejected an invalid Project window target.");
  }
  if (
    target.kind === "project" &&
    Object.keys(target).sort().join("\0") === ["kind", "projectId"].sort().join("\0")
  ) {
    return Object.freeze({ kind: "project", projectId: target.projectId });
  }
  if (
    target.kind === "project-thread" &&
    Object.keys(target).sort().join("\0") ===
      ["kind", "mode", "projectId", "threadId"].sort().join("\0") &&
    (target.mode === "code" || target.mode === "work") &&
    typeof target.threadId === "string" &&
    PROVIDER_INSTANCE_ID_PATTERN.test(target.threadId)
  ) {
    return Object.freeze({
      kind: "project-thread",
      projectId: target.projectId,
      mode: target.mode,
      threadId: target.threadId,
    });
  }
  throw new Error("Octant rejected an invalid Project window target.");
}

export function resolveDesktopHostCapabilities(
  platform: NodeJS.Platform,
  liveBrowserSupported = false,
): HostCapabilities {
  return {
    sidebarVibrancySupported: platform === "darwin",
    liveBrowserSupported,
    liveSimulatorFrameSupported: platform === "darwin",
    // The Android emulator is reached over adb on every desktop host, unlike
    // the Simulator frame, which needs the macOS native helper.
    liveAndroidFrameSupported: true,
  };
}

interface ProviderCredentialIpcPort {
  readonly handle: (
    channel: string,
    handler: (event: unknown, ...args: readonly unknown[]) => unknown,
  ) => void;
}

export function installNativeMenuIpcHandlers<Window>(options: {
  readonly handle: (channel: string, handler: (event: unknown, value: unknown) => unknown) => void;
  readonly resolveOwnedTopLevelWindow: (event: unknown) => Window;
  readonly popup: (window: Window, value: unknown) => unknown;
}): void {
  options.handle(IPC_CHANNELS.nativeMenu, (event, value) => {
    const window = options.resolveOwnedTopLevelWindow(event);
    return options.popup(window, value);
  });
}

export function installPrivateListenerIpcHandlers(options: {
  readonly handle: (
    channel: string,
    handler: (event: unknown, ...args: readonly unknown[]) => unknown,
  ) => void;
  readonly resolveOwnedWindow: (event: unknown) => void;
  readonly service?: PrivateListenerControlService;
  readonly resolveService?: (event: unknown) => PrivateListenerControlService;
}): void {
  if (options.service === undefined && options.resolveService === undefined) {
    throw new TypeError("Octant private listener control service is unavailable.");
  }
  const serviceFor = (event: unknown): PrivateListenerControlService => {
    try {
      options.resolveOwnedWindow(event);
    } catch {
      throw new Error("Octant rejected an unauthorized private listener request.");
    }
    try {
      return options.resolveService?.(event) ?? options.service!;
    } catch (error) {
      if (error instanceof PrivateListenerControlFailure) throw new Error(error.message);
      throw new Error("Octant private listener controls are unavailable.");
    }
  };
  const run = async (
    event: unknown,
    operation: (service: PrivateListenerControlService) => Promise<unknown>,
    fallbackMessage: string,
  ): Promise<unknown> => {
    const service = serviceFor(event);
    try {
      return await operation(service);
    } catch (error) {
      if (error instanceof PrivateListenerControlFailure) throw new Error(error.message);
      throw new Error(fallbackMessage);
    }
  };
  options.handle(IPC_CHANNELS.privateListenerStatus, (event) =>
    run(
      event,
      (service) => service.syncStatus(),
      "Octant could not read the private listener status.",
    ),
  );
  options.handle(IPC_CHANNELS.privateListenerEnable, (event, request) =>
    run(
      event,
      (service) => service.enable(validatePrivateListenerEnableRequest(request)),
      "Octant could not enable the private listener.",
    ),
  );
  options.handle(IPC_CHANNELS.privateListenerRestart, (event, request) =>
    run(
      event,
      (service) => service.restart(validatePrivateListenerEnableRequest(request)),
      "Octant could not restart the private listener.",
    ),
  );
  options.handle(IPC_CHANNELS.privateListenerDisable, (event) =>
    run(event, (service) => service.disable(), "Octant could not disable the private listener."),
  );
}

/**
 * Settings › Hub: an owned window's request goes to the host's loopback hub
 * administration route it names, with that window's own capability.
 */
export function installHubAdministrationIpcHandlers(options: {
  readonly handle: (
    channel: string,
    handler: (event: unknown, ...args: readonly unknown[]) => unknown,
  ) => void;
  readonly runtimeFor: (event: unknown) => HubAdministrationControlRuntime;
}): void {
  options.handle(IPC_CHANNELS.hubAdministrationRequest, async (event, operation, body) => {
    let runtime: HubAdministrationControlRuntime;
    try {
      runtime = options.runtimeFor(event);
    } catch {
      throw new Error("Octant rejected an unauthorized hub request.");
    }
    try {
      return await sendHubAdministrationOperation(runtime, operation, body);
    } catch (error) {
      throw new Error(
        error instanceof HubAdministrationControlFailure
          ? error.message
          : "Octant hub controls are unavailable.",
      );
    }
  });
}

/**
 * A Mac owner device's unlock key. An owned window may make the key, have it
 * sign one owner unlock challenge (Touch ID), and forget it. Nothing here
 * returns the private key or signs text the service did not build itself.
 */
export function installOwnerUnlockIpcHandlers(options: {
  readonly handle: (
    channel: string,
    handler: (event: unknown, ...args: readonly unknown[]) => unknown,
  ) => void;
  readonly resolveOwnedWindow: (event: unknown) => void;
  /** Absent when this computer has no Secure Enclave helper (not a Mac). */
  readonly service: () => OwnerUnlockKeyService | undefined;
}): void {
  const unavailable = { status: "refused", kind: "unavailable" } as const;
  const run = async <T>(
    event: unknown,
    use: (service: OwnerUnlockKeyService) => Promise<T>,
  ): Promise<T | typeof unavailable> => {
    try {
      options.resolveOwnedWindow(event);
    } catch {
      throw new Error("Octant rejected an unauthorized unlock request.");
    }
    const service = options.service();
    return service === undefined ? unavailable : use(service);
  };
  options.handle(IPC_CHANNELS.ownerUnlockMake, (event) => run(event, (s) => s.makeKey()));
  options.handle(IPC_CHANNELS.ownerUnlockSign, (event, challenge) =>
    run(event, (s) => s.sign(challenge as OwnerUnlockChallenge)),
  );
  options.handle(IPC_CHANNELS.ownerUnlockForget, (event) => run(event, (s) => s.forgetKey()));
}

export function installRemoteDeviceIpcHandlers(options: {
  readonly handle: (
    channel: string,
    handler: (event: unknown, ...args: readonly unknown[]) => unknown,
  ) => void;
  readonly resolveOwnedWindow: (event: unknown) => void;
  readonly service?: RemoteDeviceControlService;
  readonly resolveService?: (event: unknown) => RemoteDeviceControlService;
}): void {
  if (options.service === undefined && options.resolveService === undefined) {
    throw new TypeError("Octant local device control service is unavailable.");
  }
  const serviceFor = (event: unknown): RemoteDeviceControlService => {
    try {
      options.resolveOwnedWindow(event);
    } catch {
      throw new Error("Octant rejected an unauthorized local device request.");
    }
    try {
      return options.resolveService?.(event) ?? options.service!;
    } catch (error) {
      throw sanitizeRemoteDeviceControlError(error);
    }
  };
  const run = async <T>(
    event: unknown,
    operation: (service: RemoteDeviceControlService) => Promise<T>,
  ) => {
    const service = serviceFor(event);
    try {
      return await operation(service);
    } catch (error) {
      throw sanitizeRemoteDeviceControlError(error);
    }
  };

  options.handle(IPC_CHANNELS.remotePairingTicket, (event, sourceClass) =>
    run(event, (service) => service.mintPairingTicket(sourceClass as string)),
  );
  options.handle(IPC_CHANNELS.remotePairingRequests, (event) =>
    run(event, (service) => service.listPairingRequests()),
  );
  options.handle(IPC_CHANNELS.remotePairingApprove, (event, ticketId) =>
    run(event, (service) => service.approvePairingRequest(ticketId as string)),
  );
  options.handle(IPC_CHANNELS.remotePairingDeny, (event, ticketId, reasonCode) =>
    run(event, (service) => service.denyPairingRequest(ticketId as string, reasonCode as string)),
  );
  options.handle(IPC_CHANNELS.remoteDeviceInventory, (event) =>
    run(event, (service) => service.getDeviceInventory()),
  );
  options.handle(IPC_CHANNELS.remoteDeviceRename, (event, deviceId, deviceLabel) =>
    run(event, (service) => service.renameDevice(deviceId as string, deviceLabel as string)),
  );
  options.handle(IPC_CHANNELS.remoteDeviceRevoke, (event, deviceId) =>
    run(event, (service) => service.revokeDevice(deviceId as string)),
  );
  options.handle(IPC_CHANNELS.remoteDeviceRevokeAll, (event) =>
    run(event, (service) => service.revokeAllDevices()),
  );
  options.handle(IPC_CHANNELS.remoteDeviceReconcileExpired, (event) =>
    run(event, (service) => service.reconcileExpiredDevices()),
  );
}

function sanitizeRemoteDeviceControlError(error: unknown): Error {
  if (error instanceof RemoteDeviceControlFailure) return new Error(error.message);
  return new Error("Octant could not apply the local device controls.");
}

export function installHostIdentityIpcHandlers(options: {
  readonly handle: (
    channel: string,
    handler: (event: unknown, ...args: readonly unknown[]) => unknown,
  ) => void;
  readonly resolveOwnedWindow: (event: unknown) => void;
  readonly service: HostIdentitySigningService;
}): void {
  const authorize = (event: unknown): void => {
    try {
      options.resolveOwnedWindow(event);
    } catch {
      throw new Error("Octant rejected an unauthorized host-identity request.");
    }
  };
  options.handle(IPC_CHANNELS.remoteHostIdentityStatus, async (event) => {
    authorize(event);
    try {
      return await options.service.probeRecoveryState();
    } catch (error) {
      throw sanitizeHostIdentityError(error);
    }
  });
  options.handle(IPC_CHANNELS.remoteHostIdentityRotate, async (event) => {
    authorize(event);
    try {
      const result = await options.service.rotateIdentityKey();
      return Object.freeze({ status: "rotated" as const, fingerprint: result.fingerprint });
    } catch (error) {
      throw sanitizeHostIdentityError(error);
    }
  });
  options.handle(IPC_CHANNELS.remoteHostIdentityRecover, async (event) => {
    authorize(event);
    try {
      await options.service.ensureIdentityKey();
      return await options.service.probeRecoveryState();
    } catch (error) {
      throw sanitizeHostIdentityError(error);
    }
  });
}

function sanitizeHostIdentityError(error: unknown): Error {
  if (error instanceof HostIdentitySigningFailure) return new Error(error.message);
  return new Error("Octant could not update the host identity.");
}

function validatePrivateListenerEnableRequest(value: unknown): PrivateListenerEnableRequest {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as { hostname?: unknown }).hostname !== "string" ||
    !Number.isSafeInteger((value as { port?: unknown }).port) ||
    (value as { port: number }).port < 1 ||
    (value as { port: number }).port > 65_535 ||
    typeof (value as { origin?: unknown }).origin !== "string" ||
    typeof (value as { certificatePem?: unknown }).certificatePem !== "string" ||
    (value as { certificatePem: string }).certificatePem.length === 0 ||
    typeof (value as { privateKeyPem?: unknown }).privateKeyPem !== "string" ||
    (value as { privateKeyPem: string }).privateKeyPem.length === 0 ||
    (value as { localConfirmation?: unknown }).localConfirmation !== true
  ) {
    throw new Error("Octant rejected an invalid private listener enable request.");
  }
  const request = value as {
    readonly hostname: string;
    readonly port: number;
    readonly origin: string;
    readonly certificatePem: string;
    readonly privateKeyPem: string;
  };
  return {
    hostname: request.hostname,
    port: request.port,
    origin: request.origin,
    certificatePem: request.certificatePem,
    privateKeyPem: request.privateKeyPem,
    localConfirmation: true,
  };
}

export function installProviderCredentialIpcHandlers(options: {
  readonly handle: ProviderCredentialIpcPort["handle"];
  readonly resolveOwnedWindow: (event: unknown) => void;
  readonly store: CredentialStore;
}): void {
  const authorize = (event: unknown): void => {
    try {
      options.resolveOwnedWindow(event);
    } catch {
      throw new Error("Octant rejected an unauthorized credential request.");
    }
  };
  options.handle(IPC_CHANNELS.setProviderCredential, async (event, instanceId, credential) => {
    authorize(event);
    const validated = validateProviderCredentialRequest(instanceId, credential);
    // A pointer changes only through the journaled secret-store routes, so a
    // pasted key never silently replaces one.
    if (await holdsLinkedReference(options.store, validated.providerInstanceId)) {
      throw new Error(LINKED_REFERENCE_MESSAGE);
    }
    try {
      await options.store.set(validated.providerInstanceId, validated.credential);
    } catch {
      throw new Error("Octant could not store the provider credential.");
    }
  });
  options.handle(IPC_CHANNELS.providerCredentialStatus, async (event, instanceId) => {
    authorize(event);
    const providerInstanceId = validateProviderInstanceId(instanceId);
    try {
      return (await options.store.has(providerInstanceId)) ? "stored" : "missing";
    } catch {
      return "unavailable";
    }
  });
  options.handle(IPC_CHANNELS.clearProviderCredential, async (event, instanceId) => {
    authorize(event);
    const providerInstanceId = validateProviderInstanceId(instanceId);
    if (await holdsLinkedReference(options.store, providerInstanceId)) {
      throw new Error(LINKED_REFERENCE_MESSAGE);
    }
    try {
      await options.store.delete(providerInstanceId);
    } catch {
      throw new Error("Octant could not clear the provider credential.");
    }
  });
  // Labels and secrets are read here, never by the renderer. A list answers
  // labels only; every change returns nothing or the new key's label.
  options.handle(IPC_CHANNELS.listProviderApiKeys, async (event, instanceId) => {
    authorize(event);
    const providerInstanceId = validateProviderInstanceId(instanceId);
    return queueApiKeyOperation(async () => {
      const stored = await readStoredApiKeys(options.store, providerInstanceId);
      // A linked reference is not a list of keys; Settings shows it apart.
      return stored === undefined || isLinkedSecretMaterial(stored) ? [] : listApiKeys(stored);
    });
  });
  options.handle(IPC_CHANNELS.addProviderApiKey, async (event, instanceId, credential, label) => {
    authorize(event);
    const validated = validateProviderCredentialRequest(instanceId, credential);
    const requestedLabel = label === undefined ? undefined : validateApiKeyLabel(label);
    return queueApiKeyOperation(async () => {
      const stored = await readStoredApiKeys(options.store, validated.providerInstanceId);
      if (stored !== undefined && isLinkedSecretMaterial(stored)) {
        throw new ApiKeyPoolError("linked-secret");
      }
      const added = addApiKey(stored, { secret: validated.credential, label: requestedLabel });
      await options.store.set(validated.providerInstanceId, added.stored);
      return added.key;
    });
  });
  options.handle(IPC_CHANNELS.renameProviderApiKey, async (event, instanceId, keyId, label) => {
    authorize(event);
    const providerInstanceId = validateProviderInstanceId(instanceId);
    const validKeyId = validateApiKeyId(keyId);
    const validLabel = validateApiKeyLabel(label);
    return queueApiKeyOperation(async () => {
      const stored = await requireStoredApiKeys(options.store, providerInstanceId);
      await options.store.set(providerInstanceId, renameApiKey(stored, validKeyId, validLabel));
    });
  });
  options.handle(
    IPC_CHANNELS.replaceProviderApiKey,
    async (event, instanceId, keyId, credential) => {
      authorize(event);
      const validated = validateProviderCredentialRequest(instanceId, credential);
      const validKeyId = validateApiKeyId(keyId);
      return queueApiKeyOperation(async () => {
        const stored = await requireStoredApiKeys(options.store, validated.providerInstanceId);
        await options.store.set(
          validated.providerInstanceId,
          replaceApiKeySecret(stored, validKeyId, validated.credential),
        );
      });
    },
  );
  options.handle(IPC_CHANNELS.removeProviderApiKey, async (event, instanceId, keyId) => {
    authorize(event);
    const providerInstanceId = validateProviderInstanceId(instanceId);
    const validKeyId = validateApiKeyId(keyId);
    return queueApiKeyOperation(async () => {
      const stored = await requireStoredApiKeys(options.store, providerInstanceId);
      const remaining = removeApiKey(stored, validKeyId);
      if (remaining === undefined) await options.store.delete(providerInstanceId);
      else await options.store.set(providerInstanceId, remaining);
    });
  });
  options.handle(IPC_CHANNELS.setActiveProviderApiKey, async (event, instanceId, keyId) => {
    authorize(event);
    const providerInstanceId = validateProviderInstanceId(instanceId);
    const validKeyId = validateApiKeyId(keyId);
    return queueApiKeyOperation(async () => {
      const stored = await requireStoredApiKeys(options.store, providerInstanceId);
      await options.store.set(providerInstanceId, setActiveApiKey(stored, validKeyId));
    });
  });
  options.handle(IPC_CHANNELS.moveProviderApiKey, async (event, instanceId, keyId, direction) => {
    authorize(event);
    const providerInstanceId = validateProviderInstanceId(instanceId);
    const validKeyId = validateApiKeyId(keyId);
    const validDirection = validateApiKeyMoveDirection(direction);
    return queueApiKeyOperation(async () => {
      const stored = await requireStoredApiKeys(options.store, providerInstanceId);
      await options.store.set(providerInstanceId, moveApiKey(stored, validKeyId, validDirection));
    });
  });
}

let apiKeyWriteQueue: Promise<unknown> = Promise.resolve();

/**
 * Runs one key change after the previous one, so two edits never read the
 * same stored value and one overwrites the other.
 */
function queueApiKeyOperation<T>(task: () => Promise<T>): Promise<T> {
  const run = apiKeyWriteQueue.then(task);
  apiKeyWriteQueue = run.catch(() => undefined);
  return run.catch((error: unknown) => {
    throw sanitizeApiKeyError(error);
  });
}

async function readStoredApiKeys(
  store: CredentialStore,
  providerInstanceId: string,
): Promise<string | undefined> {
  if (!(await store.has(providerInstanceId))) return undefined;
  return store.resolve(providerInstanceId);
}

const LINKED_REFERENCE_MESSAGE =
  "This provider's key comes from a linked secret store. Remove the link in Settings first.";

async function holdsLinkedReference(
  store: CredentialStore,
  providerInstanceId: string,
): Promise<boolean> {
  try {
    const stored = await readStoredApiKeys(store, providerInstanceId);
    return stored !== undefined && isLinkedSecretMaterial(stored);
  } catch {
    return false;
  }
}

async function requireStoredApiKeys(
  store: CredentialStore,
  providerInstanceId: string,
): Promise<string> {
  const stored = await readStoredApiKeys(store, providerInstanceId);
  if (stored === undefined) throw new ApiKeyPoolError("unknown-key");
  if (isLinkedSecretMaterial(stored)) throw new ApiKeyPoolError("linked-secret");
  return stored;
}

function sanitizeApiKeyError(error: unknown): Error {
  if (error instanceof ApiKeyPoolError) return new Error(error.message);
  // Shown to the person as written, so preload.ts lets exactly these through.
  if (error instanceof CredentialStoreFailure) {
    const advice = keyringAdvice(error);
    if (advice !== undefined) return new Error(`${KEYRING_ADVICE_MARKER}${advice}`);
  }
  return new Error("Octant could not update the provider API keys.");
}

function validateApiKeyId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(default|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(value)
  ) {
    throw new Error("Octant rejected an invalid API key request.");
  }
  return value;
}

function validateApiKeyMoveDirection(value: unknown): "up" | "down" {
  if (value !== "up" && value !== "down") {
    throw new Error("Octant rejected an invalid API key request.");
  }
  return value;
}

function validateApiKeyLabel(value: unknown): string {
  if (typeof value !== "string") throw new Error("Octant rejected an invalid API key request.");
  return value;
}

function validateProviderInstanceId(value: unknown): string {
  if (typeof value !== "string" || !PROVIDER_INSTANCE_ID_PATTERN.test(value)) {
    throw new Error("Octant rejected an invalid credential request.");
  }
  return value;
}

function validateProviderCredentialRequest(
  instanceId: unknown,
  credential: unknown,
): { readonly providerInstanceId: string; readonly credential: string } {
  const providerInstanceId = validateProviderInstanceId(instanceId);
  if (
    typeof credential !== "string" ||
    credential.length === 0 ||
    Buffer.byteLength(credential, "utf8") > MAX_PROVIDER_CREDENTIAL_BYTES
  ) {
    throw new Error("Octant rejected an invalid credential request.");
  }
  return { providerInstanceId, credential };
}

interface ProjectWindowAuthority {
  readonly capability: string;
  readonly rendererIdentity?: string;
  readonly revoke: () => Promise<void>;
}

interface ProjectWindowOpenOptions<TWindow> {
  readonly register: () => Promise<ProjectWindowAuthority>;
  readonly construct: (capability: string) => TWindow;
  readonly prepare: (window: TWindow, close: () => Promise<void>) => void;
  readonly load: (window: TWindow) => Promise<void>;
  readonly dispose?: (window: TWindow) => void;
}

interface ProjectWindowSession<TWindow> {
  readonly window: TWindow;
  readonly close: () => Promise<void>;
}

interface TrackedProjectWindowAuthority {
  authority: ProjectWindowAuthority;
  revocation?: Promise<void>;
}

interface DisposablePresentationController {
  readonly dispose: () => void;
}

export function createProjectWindowPreparationCleanup() {
  let controller: DisposablePresentationController | undefined;
  let stopThermal: (() => void) | undefined;
  let disposed = false;

  return Object.freeze({
    trackPresentationController: (value: DisposablePresentationController): void => {
      if (disposed) value.dispose();
      else controller = value;
    },
    trackThermalObserver: (stop: () => void): void => {
      if (disposed) stop();
      else stopThermal = stop;
    },
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      try {
        stopThermal?.();
      } catch {
        // Native observer cleanup is best effort during window teardown.
      }
      try {
        controller?.dispose();
      } catch {
        // Presentation cleanup must not prevent authority revocation.
      }
    },
  });
}

export function requestProjectWindowWhileRunning(options: {
  readonly isTearingDown: () => boolean;
  readonly request: () => Promise<unknown>;
  readonly handleFailure: (error: unknown) => Promise<void> | void;
}): void {
  if (options.isTearingDown()) return;
  void options.request().catch((error: unknown) => {
    if (options.isTearingDown()) return;
    void Promise.resolve(options.handleFailure(error)).catch(() => undefined);
  });
}

export function createProjectWindowAuthorityLifecycle() {
  let active: TrackedProjectWindowAuthority | undefined;
  let pendingOpen: Promise<void> = Promise.resolve();
  let pendingRevocation: Promise<void> = Promise.resolve();
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;

  const revoke = (tracked: TrackedProjectWindowAuthority): Promise<void> => {
    if (tracked.revocation !== undefined) return tracked.revocation;
    if (active === tracked) active = undefined;
    const revocation = pendingRevocation
      .then(() => tracked.authority.revoke())
      .catch(() => undefined);
    tracked.revocation = revocation;
    pendingRevocation = revocation;
    return revocation;
  };

  const open = <TWindow>(
    options: ProjectWindowOpenOptions<TWindow>,
  ): Promise<ProjectWindowSession<TWindow>> => {
    if (shuttingDown) {
      return Promise.reject(new Error("Octant Project window lifecycle is unavailable."));
    }
    const operation = pendingOpen.then(async () => {
      await pendingRevocation;
      let tracked: TrackedProjectWindowAuthority | undefined;
      let window: TWindow | undefined;
      try {
        const registered = { authority: await options.register() };
        tracked = registered;
        active = registered;
        window = options.construct(registered.authority.capability);
        const close = () => revoke(registered);
        options.prepare(window, close);
        await options.load(window);
        return Object.freeze({ window, close });
      } catch (cause) {
        if (window !== undefined) {
          try {
            options.dispose?.(window);
          } catch {
            // Startup cleanup is best effort; authority revocation remains mandatory.
          }
        }
        if (tracked !== undefined) await revoke(tracked);
        // A failure that names its own cause is a fixed sentence about host
        // state, and the person looking at the error dialog needs it: the
        // generic sentence sent them to the logs for a reason the app already
        // knew. Every other rejection stays behind that sentence, because one
        // raised while handling a capability can carry it in its message.
        if (namesItsCause(cause)) throw cause;
        throw new Error("Octant could not open its Project window.");
      }
    });
    pendingOpen = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };

  const refreshAfterHostRestart = (
    register: () => Promise<ProjectWindowAuthority>,
  ): Promise<ProjectWindowAuthority | undefined> => {
    if (shuttingDown) {
      return Promise.reject(new Error("Octant Project window lifecycle is unavailable."));
    }
    const operation = pendingOpen.then(async () => {
      await pendingRevocation;
      const tracked = active;
      if (tracked === undefined) return undefined;
      let replacement: ProjectWindowAuthority;
      try {
        replacement = await register();
      } catch (cause) {
        if (namesItsCause(cause)) throw cause;
        throw new Error("Octant could not refresh its Project window authority.");
      }
      if (active !== tracked || tracked.revocation !== undefined) {
        await replacement.revoke().catch(() => undefined);
        return undefined;
      }
      tracked.authority = replacement;
      return replacement;
    });
    pendingOpen = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };

  const shutdown = (stopServer: () => Promise<void>): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise;
    shuttingDown = true;
    const operation = (async () => {
      await pendingOpen;
      if (active !== undefined) await revoke(active);
      await pendingRevocation;
      await stopServer();
    })();
    shutdownPromise = operation;
    return operation;
  };

  return Object.freeze({
    open,
    refreshAfterHostRestart,
    shutdown,
  });
}

export function resolveDesktopDataDirectory(
  configuredDirectory: string | undefined,
  appDataDirectory: string,
  platform: NodeJS.Platform = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return resolveDesktopHostRuntimePaths(configuredDirectory, appDataDirectory, platform, env)
    .dataDirectory;
}

async function writeDesktopBridgeProjection(): Promise<void> {
  if (desktopWindowsHost !== undefined) {
    // The native child owner publishes this projection from its launch seed.
    // Desktop main authenticates it but has no file-mutation authority.
    if ((await desktopWindowsHost.startup.readBridgeSecret()) !== desktopBridgeSecret)
      throw new Error("Octant's native Windows child did not publish its bridge projection.");
    return;
  }
  await writeBridgeSecretProjection(desktopPosixHostPaths(), desktopBridgeSecret);
}

const BRIDGE_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function readStoredDesktopBridgeSecret(directory: string): string | undefined {
  try {
    const secret = readFileSync(resolve(directory, "octant-bridge-secret"), "utf8").trim();
    return BRIDGE_SECRET_PATTERN.test(secret) ? secret : undefined;
  } catch {
    return undefined;
  }
}

const applicationIdentity = app.isPackaged
  ? desktopIdentityForPackage(
      JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8")),
    )
  : desktopIdentity("stable");
app.setName(applicationIdentity.productName);
isolateEachCanvasFrameDocument(app.commandLine);
// Decided once here from Nightly's stored Data choice, never from a renderer.
const desktopHostRole = resolveStartupHostRole({
  identity: applicationIdentity,
  windowStorageDirectory: desktopWindowStorageDirectory(
    applicationIdentity,
    "",
    app.getPath("appData"),
  ),
  appDataDirectory: app.getPath("appData"),
  platform: process.platform,
  env: process.env,
});
const resolvedHostStartup = resolveHostOwningStartup({
  identity: applicationIdentity,
  role: desktopHostRole,
  platform: process.platform,
  appDataDirectory: app.getPath("appData"),
  env: process.env,
});
// Refuses before any host path is resolved or created.
if (resolvedHostStartup.kind === "refused") throw new Error(resolvedHostStartup.message);
const desktopHostStartup = resolvedHostStartup;
const desktopMayStartHost =
  applicationIdentity.mayStartHost || desktopHostRole.kind === "test-host";
const desktopWindowsHost = (() => {
  if (process.platform !== "win32") return undefined;
  const native = loadWindowsHostProfileNative(
    resolveDesktopNativeHelperPath(
      {
        packaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        moduleUrl: import.meta.url,
      },
      WINDOWS_HOST_OWNER_FILENAME,
    ),
  );
  if (native === undefined) throw new Error("Octant's native Windows host binding is unavailable.");
  return resolveWindowsDesktopHost({ native, profile: "octant", env: process.env });
})();
const desktopHostRuntimePaths =
  desktopWindowsHost === undefined
    ? resolveDesktopHostRuntimePaths(
        desktopHostStartup.configuredDataDirectory,
        app.getPath("appData"),
        process.platform,
        desktopHostStartup.logsDirectory === undefined
          ? process.env
          : { ...process.env, OCTANT_LOGS_DIR: desktopHostStartup.logsDirectory },
      )
    : undefined;
function desktopPosixHostPaths(): HostRuntimePaths {
  if (desktopHostRuntimePaths === undefined)
    throw new Error("POSIX host paths are unavailable for the native Windows profile.");
  return desktopHostRuntimePaths;
}
const desktopDataDirectory =
  desktopWindowsHost?.paths.dataDirectory ?? desktopPosixHostPaths().dataDirectory;
const desktopKeychainServiceFamily = desktopHostStartup.keychainServiceFamily;
// The relaunch quits through the same interactive path as Quit in the menu, so
// running work is confirmed first and a cancelled confirmation cancels it.
const nightlyRelaunch = createRelaunchIntent({
  quit: requestInteractiveQuit,
  relaunch: () => app.relaunch(),
});
const nightlyDataControl =
  desktopHostRole.kind === "test-host"
    ? createNightlyDataControl({
        identity: applicationIdentity,
        role: desktopHostRole,
        platform: process.platform,
        appDataDirectory: app.getPath("appData"),
        windowStorageDirectory: desktopWindowStorageDirectory(
          applicationIdentity,
          "",
          app.getPath("appData"),
        ),
        env: process.env,
        trashItem: (path) => shell.trashItem(path),
        requestRelaunch: () => nightlyRelaunch.request(),
      })
    : undefined;
/** The Nightly label and its "Test data" label for the test host's windows. */
const nightlyWindowIdentity =
  desktopHostRole.kind === "test-host"
    ? {
        applicationFlavor: "nightly" as const,
        productName: applicationIdentity.productName,
        applicationData: "test-data" as const,
      }
    : {};
const desktopHostId =
  desktopWindowsHost?.paths.profileId ?? deriveHostRuntimeHostId(desktopDataDirectory);
app.setPath(
  "userData",
  desktopWindowStorageDirectory(applicationIdentity, desktopDataDirectory, app.getPath("appData")),
);

let server: ChildProcess | undefined;
let desktopHostLaunch: DesktopHostLaunch | undefined;
let acceptedQuitLaunch: DesktopHostLaunch | undefined;
let desktopQuitAccepted = false;
let credentialBroker: CredentialBroker | undefined;
let browserRuntimeBroker: BrowserRuntimeBroker | undefined;
let computerUseService: ComputerUseDesktopService | undefined;
let managedToolService: ManagedToolService | undefined;
let browserSurfaceHost: ReturnTypeOfBrowserSurfaceHost | undefined;
let browserExtensionPopupHost: ReturnType<typeof createExtensionPopupHost> | undefined;
let browserExtensionBridge: ReturnType<typeof createExtensionBridge> | undefined;
let canvasPrototypeSurface: CanvasPrototypeSurface | undefined;
let appUpdateService: ReturnType<typeof createAppUpdateService> | undefined;
let nightlyInstallerInstance: ReturnType<typeof createNightlyInstaller> | undefined;
let credentialBackendPromise: Promise<DesktopCredentialBackend> | undefined;
let desktopBridgeSecret =
  (desktopWindowsHost === undefined
    ? readStoredDesktopBridgeSecret(desktopDataDirectory)
    : undefined) ?? generateProjectBridgeToken(randomBytes);
/** Stable's brokered host calls carry the bridge secret it holds now. */
const desktopBrokerHeaders = (): Readonly<Record<string, string>> => ({
  "x-octant-desktop-secret": desktopBridgeSecret,
});
let serverInstanceId: string | undefined;
let mainWindow: BrowserWindow | undefined;
let nativeStateStore: NativeWindowStateStore | undefined;
let presentationController: WindowPresentationController | undefined;
let stableWindowId: string | undefined;
let stableWindowCapability: string | undefined;
let activeServerUrl: string | undefined;
let hostTray: Tray | undefined;
let hostStatusPoll: ReturnType<typeof setInterval> | undefined;
const pendingCodeDeepLinks: CodeDeepLink[] = [];
let quitPrepared = false;
let quitAccepted = false;
let preparingQuit = false;
// The active-work confirmation only applies to quits the user starts inside
// the app (menu, Cmd+Q). Signal- or event-driven termination (SIGTERM,
// AppleScript "quit", logout) cannot answer a dialog and must still proceed.
let quitCanPrompt = false;
let handlersInstalled = false;
let projectRootPicker: ReturnType<typeof createProjectRootPicker> | undefined;
const projectWindowLifecycle = createProjectWindowAuthorityLifecycle();
interface DesktopWindowContext extends DesktopWindowIdentity {
  readonly primary: boolean;
  readonly picker: ReturnType<typeof createProjectRootPicker>;
  readonly localPluginFolderPicker: ReturnType<typeof createLocalPluginFolderPicker>;
  readonly runtimeBinaryPicker: ReturnType<typeof createRuntimeBinaryPicker>;
  readonly supportBundleSaver: ReturnType<typeof createSupportBundleSaver>;
  readonly browserProofSaver: ReturnType<typeof createBrowserProofSaver>;
  readonly presentationController: WindowPresentationController;
  readonly refreshAuthorityAfterHostRestart: (host: LocalHostDescriptor) => Promise<void>;
}
const desktopWindows = createDesktopWindowContextRegistry<BrowserWindow, DesktopWindowContext>();
let codeOperationApprovalViews:
  | ReturnType<typeof createCodeOperationApprovalViewController<BrowserWindow>>
  | undefined;
// The resolved palette each open window reported for its own theme. The
// approval document belongs to the desktop, so this only ever holds values a
// decoder accepted; a window that reported none keeps the system palette.
const approvalPalettesByWindow = new Map<string, CodeOperationApprovalPalette>();

function installCodeOperationApprovalViews(): void {
  codeOperationApprovalViews ??= createCodeOperationApprovalViewController<BrowserWindow>({
    host: {
      ...createNativeCodeApprovalViewHost(
        resolve(dirname(fileURLToPath(import.meta.url)), CODE_APPROVAL_PRELOAD_FILENAME),
        (id) => codeOperationApprovalViews?.viewDestroyed(id),
      ),
      boundsForAnchor: codeApprovalBoundsForAnchor,
      fallbackBounds: codeApprovalFallbackBounds,
      approvalPalette: (windowId) => approvalPalettesByWindow.get(windowId),
      isWindowDestroyed: (window) => window.isDestroyed(),
    },
    prepare: ({ request, windowCapability }) => {
      if (activeServerUrl === undefined) throw new Error("Octant Code approval is unavailable.");
      return prepareCodeOperationApprovalChallengeFromServer({
        serverUrl: activeServerUrl,
        brokerHeaders: {
          ...desktopBrokerHeaders(),
          "x-octant-window-capability": windowCapability,
        },
        request,
        fetch: globalThis.fetch,
      });
    },
    confirm: ({ challengeId, windowCapability }) => {
      if (activeServerUrl === undefined) throw new Error("Octant Code approval is unavailable.");
      return confirmCodeOperationApprovalFromServer({
        serverUrl: activeServerUrl,
        brokerHeaders: {
          ...desktopBrokerHeaders(),
          "x-octant-window-capability": windowCapability,
        },
        challengeId,
        fetch: globalThis.fetch,
      });
    },
    cancel: ({ challengeId, windowCapability }) => {
      if (activeServerUrl === undefined) return Promise.resolve();
      return cancelCodeOperationApprovalFromServer({
        serverUrl: activeServerUrl,
        brokerHeaders: {
          ...desktopBrokerHeaders(),
          "x-octant-window-capability": windowCapability,
        },
        challengeId,
        fetch: globalThis.fetch,
      });
    },
  });
}
let desktopWindowAuthorityInstanceId: string | undefined;
let desktopWindowAuthorityRefresh:
  | { readonly instanceId: string; readonly operation: Promise<void> }
  | undefined;
const secondaryWindowLifecycles = new Set<
  ReturnType<typeof createProjectWindowAuthorityLifecycle>
>();
const trustedRendererRequests = createTrustedRendererRequestRegistry();
let trustedRendererRequestHeadersInstalled = false;

async function refreshDesktopProjectWindowAuthorityAfterHostRestart(options: {
  readonly host: LocalHostDescriptor;
  readonly lifecycle: ReturnType<typeof createProjectWindowAuthorityLifecycle>;
  readonly primary: boolean;
  readonly window: BrowserWindow;
  readonly windowId: string;
}): Promise<void> {
  const authority = await options.lifecycle.refreshAfterHostRestart(() =>
    createProjectWindowAuthority({
      desktopBridgeSecret,
      serverUrl: options.host.url,
      windowId: options.windowId,
    }),
  );
  if (authority === undefined) return;
  if (authority.rendererIdentity === undefined) {
    throw new Error("Octant could not refresh its Project window authority.");
  }
  const context = desktopWindows.replaceCapability(options.window, authority.capability);
  if (
    context === undefined ||
    options.window.isDestroyed() ||
    options.window.webContents.isDestroyed()
  ) {
    return;
  }
  if (options.primary) stableWindowCapability = authority.capability;
  registerTrustedRendererRequestContext(options.window, {
    serverUrl: options.host.url,
    rendererIdentity: authority.rendererIdentity,
    ...(process.env.OCTANT_WEB_URL === undefined
      ? {}
      : { developmentUrl: process.env.OCTANT_WEB_URL }),
  });
  options.window.webContents.send(IPC_CHANNELS.projectWindowCapability, authority.capability);
}

async function refreshDesktopWindowAuthorities(host: LocalHostDescriptor): Promise<void> {
  if (desktopWindowAuthorityInstanceId === host.instanceId) return;
  const pending = desktopWindowAuthorityRefresh;
  if (pending !== undefined) {
    if (pending.instanceId === host.instanceId) return pending.operation;
    await pending.operation.catch(() => undefined);
    return await refreshDesktopWindowAuthorities(host);
  }
  const started = refreshProjectWindowAuthoritiesAfterHostRestart(
    host,
    desktopWindows.active(),
  ).then(() => {
    desktopWindowAuthorityInstanceId = host.instanceId;
  });
  const observed = started.finally(() => {
    if (desktopWindowAuthorityRefresh?.operation === observed) {
      desktopWindowAuthorityRefresh = undefined;
    }
  });
  desktopWindowAuthorityRefresh = { instanceId: host.instanceId, operation: observed };
  return await observed;
}

let pairedComputerPinStore: PairedComputerPins | undefined;

function pairedComputerPins(): PairedComputerPins {
  pairedComputerPinStore ??= new PairedComputerPins(
    join(app.getPath("userData"), "paired-computer-pins.json"),
  );
  return pairedComputerPinStore;
}

function installTrustedRendererRequestHeaders(): void {
  if (trustedRendererRequestHeadersInstalled) return;
  trustedRendererRequestHeadersInstalled = true;
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ["http://*/*", "https://*/*"] },
    (details, callback) => {
      const context =
        details.webContentsId === undefined
          ? undefined
          : trustedRendererRequests.get(details.webContentsId);
      const frameUrl = details.frame?.url ?? details.webContents?.getURL();
      callback({
        requestHeaders: decorateTrustedRendererHeaders({
          requestHeaders: details.requestHeaders,
          requestUrl: details.url,
          ...(frameUrl === undefined ? {} : { frameUrl }),
          ...(context === undefined ? {} : { context }),
        }),
      });
    },
  );
}

function registerTrustedRendererRequestContext(
  window: BrowserWindow,
  input: {
    readonly serverUrl: string;
    readonly rendererIdentity: string;
    readonly developmentUrl?: string;
  },
): void {
  installTrustedRendererRequestHeaders();
  const developmentOrigin =
    input.developmentUrl === undefined ? undefined : safeOrigin(input.developmentUrl);
  const webContentsId = window.webContents.id;
  trustedRendererWebContentsIds.set(window, webContentsId);
  trustedRendererRequests.set(webContentsId, {
    serverOrigin: new URL(input.serverUrl).origin,
    rendererIdentity: input.rendererIdentity,
    ...(developmentOrigin === undefined ? {} : { developmentOrigin }),
  });
}

/**
 * Electron marks the window wrapper destroyed before it emits `closed`, so
 * reading `window.webContents.id` from inside a `closed` handler can throw and
 * take the rest of that handler's cleanup with it — the window registry entry,
 * the attention badge, and the authority close all sit after this call. The id
 * is captured while the window is alive and read from here instead.
 */
const trustedRendererWebContentsIds = new WeakMap<BrowserWindow, number>();

function unregisterTrustedRendererRequestContext(window: BrowserWindow): void {
  const webContentsId = trustedRendererWebContentsIds.get(window);
  if (webContentsId === undefined) return;
  trustedRendererWebContentsIds.delete(window);
  trustedRendererRequests.remove(webContentsId);
}

function repositoryRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

export function resolveKeychainHelperPath(options: DesktopNativeHelperPathOptions): string {
  return resolveDesktopNativeHelperPath(options, KEYCHAIN_HELPER_FILENAME);
}

export function resolveCodeFileHelperPath(options: DesktopNativeHelperPathOptions): string {
  return resolveDesktopNativeHelperPath(options, CODE_FILE_HELPER_FILENAME);
}

export function prepareDevelopmentRendererUrl(
  developmentUrl: string,
  windowId: string,
  serverUrl: string,
): string {
  const launchUrl = new URL(developmentUrl);
  launchUrl.searchParams.set("windowId", windowId);
  launchUrl.searchParams.set("serverUrl", serverUrl);
  return launchUrl.toString();
}

/** Packaged `loadFile` query: server URL only. Window identity stays in argv. */
export function preparePackagedRendererQuery(serverUrl: string): { readonly serverUrl: string } {
  return { serverUrl };
}

function getCredentialBackend(): Promise<DesktopCredentialBackend> {
  credentialBackendPromise ??= resolveDesktopCredentialBackend({
    platform: process.platform,
    keychainHelperPath: resolveKeychainHelperPath({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      moduleUrl: import.meta.url,
    }),
    ...(process.platform === "win32"
      ? {
          windowsCredentialHelperPath: resolveDesktopNativeHelperPath(
            {
              packaged: app.isPackaged,
              resourcesPath: process.resourcesPath,
              moduleUrl: import.meta.url,
            },
            WINDOWS_CREDENTIAL_HELPER_FILENAME,
          ),
        }
      : {}),
    storeScope: desktopHostId,
    serviceFamily: desktopKeychainServiceFamily,
  }).then((backend) => {
    return backend;
  });
  return credentialBackendPromise;
}

function lazyCredentialStore(): CredentialStore {
  return {
    set: async (providerInstanceId, credential) => {
      const backend = await getCredentialBackend();
      if (backend.store === undefined) {
        throw new CredentialStoreFailure("unavailable");
      }
      await backend.store.set(providerInstanceId, credential);
    },
    has: async (providerInstanceId) => {
      const backend = await getCredentialBackend();
      if (backend.store === undefined) {
        throw new CredentialStoreFailure("unavailable");
      }
      return await backend.store.has(providerInstanceId);
    },
    resolve: async (providerInstanceId) => {
      const backend = await getCredentialBackend();
      if (backend.store === undefined) {
        throw new CredentialStoreFailure("unavailable");
      }
      return await backend.store.resolve(providerInstanceId);
    },
    delete: async (providerInstanceId) => {
      const backend = await getCredentialBackend();
      if (backend.store === undefined) {
        throw new CredentialStoreFailure("unavailable");
      }
      await backend.store.delete(providerInstanceId);
    },
  };
}

async function startDesktopCredentialBroker(): Promise<CredentialBroker | undefined> {
  // Windows credentials belong to the actual child owner. The generic
  // desktop broker would create unaudited linked-store JSON on this path.
  if (desktopWindowsHost !== undefined) return undefined;
  if (credentialBroker !== undefined) return credentialBroker;
  const backend = await getCredentialBackend();
  if (backend.store === undefined) return undefined;
  const linkedStores = makeLinkedSecretStores({
    statePath: linkedSecretStoresStatePath(desktopDataDirectory),
  });
  return await startCredentialBroker(
    backend.store,
    backend.purgeStore,
    undefined,
    backend.replicaDeviceKeys,
    backend.replicaStoreCredentials,
    backend.canvasPublicShareSecrets,
    backend.mcpServerCredentials,
    backend.desktopProviderCredentials,
    backend.pushPlatformCredentials,
    linkedStores,
    backend.sshKeys,
    createDesktopBrowserCredentialFill({ stores: linkedStores, surface: () => browserSurfaceHost }),
  );
}

async function resolveExistingHostAttachment(startingChild?: ChildProcess) {
  if (desktopWindowsHost !== undefined)
    return await attachWindowsDesktopHost(desktopWindowsHost, startingChild);
  return await resolveStableHostAttachment({
    readReceipt: () => readHostInfoReceipt(desktopPosixHostPaths()),
    readBridgeSecret: () => readStoredDesktopBridgeSecret(desktopDataDirectory),
    probeReceipt: (receipt) =>
      probeHostInfoReceipt({
        receipt,
        expectedHostId: desktopHostId,
        expectedWireVersion: "1",
        expectedControlEndpoint: desktopPosixHostPaths().socketPath,
      }),
  });
}

async function attachExistingLocalHost(): Promise<LocalHostDescriptor | undefined> {
  if (!desktopMayStartHost) {
    throw new Error(
      "Needs a newer Octant. The stable desktop client bridge is not available in this build of Octant Nightly.",
    );
  }
  if (server !== undefined) return undefined;
  const attachment = await resolveExistingHostAttachment();
  if (attachment === undefined) return undefined;
  desktopBridgeSecret = attachment.bridgeSecret;
  activeServerUrl = attachment.probe.url;
  serverInstanceId = attachment.probe.instanceId;
  return {
    url: attachment.probe.url,
    instanceId: attachment.probe.instanceId,
    ownership: "managed",
  };
}

/** The popup host's view port over a real native view; each method is a plain pass-through. */
function popupViewOf(view: WebContentsView): ExtensionPopupView {
  return {
    native: view,
    setBounds: (bounds) => view.setBounds(bounds),
    webContents: {
      id: view.webContents.id,
      loadURL: (url) => view.webContents.loadURL(url),
      close: () => view.webContents.close(),
      isDestroyed: () => view.webContents.isDestroyed(),
      on: (event, listener) => {
        view.webContents.on(event as never, listener as never);
      },
      setWindowOpenHandler: (handler) => view.webContents.setWindowOpenHandler(handler),
      session: {
        setPermissionCheckHandler: (handler) =>
          view.webContents.session.setPermissionCheckHandler(handler),
        setPermissionRequestHandler: (handler) =>
          view.webContents.session.setPermissionRequestHandler((contents, permission, callback) =>
            handler(contents, permission, callback),
          ),
      },
    },
  };
}

function popupWindowOf(window: BrowserWindow): ExtensionPopupShellWindow {
  return {
    isDestroyed: () => window.isDestroyed(),
    contentView: {
      addChildView: (view) => {
        if (view instanceof WebContentsView) window.contentView.addChildView(view);
      },
      removeChildView: (view) => {
        if (view instanceof WebContentsView) window.contentView.removeChildView(view);
      },
    },
  };
}

/** Where Electron keeps the persistent stores of the Project and Personal Browser profiles. */
function browserProfilesDirectory(): string {
  return join(app.getPath("userData"), "Partitions");
}

async function startDesktopOwnedHost(): Promise<LocalHostDescriptor> {
  if (!desktopMayStartHost) {
    throw new Error("Octant Nightly cannot start a host or migrate shared data.");
  }
  if (desktopHostLaunch !== undefined && desktopHostLaunch.state !== "closed") {
    if (desktopHostLaunch.state !== "acquiring")
      throw new Error("Octant still owns resources whose shutdown was not confirmed.");
  }
  if (server !== undefined && activeServerUrl !== undefined && serverInstanceId !== undefined) {
    return {
      url: activeServerUrl,
      instanceId: serverInstanceId,
      ownership: "desktop-owned",
    };
  }
  await assertAutomaticHostStartupEnabled(
    desktopWindowsHost?.startup.servicePolicy ??
      new ServicePolicyStore({ path: desktopPosixHostPaths().servicePolicyPath }),
  );
  if (desktopWindowsHost === undefined) await prepareHostRuntimePaths(desktopPosixHostPaths());
  const root = repositoryRoot();
  const portReservation = await reserveLoopbackPort(
    resolveConfiguredServerPort(process.env, desktopHostStartup.serverPort),
  );
  const serverUrl = resolveManagedServerUrl({
    needsServerStart: true,
    activeServerUrl: undefined,
    reservedPort: portReservation.port,
  });
  const port = Number(new URL(serverUrl).port);
  // The reservation only selects a collision-free port. Release the listener
  // before spawning the managed server, which must bind that same port.
  await portReservation.close();
  const serverStderr = createStderrTail();
  const instanceId = randomUUID();
  const launch = createDesktopHostLaunch({
    shutdownServer:
      desktopWindowsHost === undefined
        ? shutdownManagedServer
        : (child) =>
            shutdownManagedServer(child, {
              requestStop: () => requestWindowsDesktopHostStop(desktopWindowsHost, instanceId),
            }),
  });
  desktopHostLaunch = launch;
  try {
    // Files held for the agent are cleared when the app starts; if the folder
    // cannot be made private, downloads simply stay blocked.
    const browserDownloadRoot = await prepareBrowserDownloadHoldRoot("desktop").catch(
      () => undefined,
    );
    browserSurfaceHost ??= createBrowserSurfaceHost({
      ...(browserDownloadRoot === undefined ? {} : { downloadRoot: browserDownloadRoot }),
      isOwnerWindowAvailable: (windowId) =>
        desktopWindows.hasWindowId(windowId) || nightlyWindowLeases?.hasWindow(windowId) === true,
      isEmbeddedOwner: (windowId) => nightlyWindowLeases?.hasWindow(windowId) === true,
      clipboard: { writeText: (text) => clipboard.writeText(text) },
      createView: (options) => {
        if (nightlyWindowLeases?.hasWindow(options.owner.windowId) === true)
          return createOffscreenBrowserSurface(options);
        return new WebContentsView({
          webPreferences: { partition: options.partition, ...options.webPreferences },
        }) as unknown as BrowserSurfaceViewPort;
      },
    });
    const surfaceHost = browserSurfaceHost;
    const profileStore = createBrowserProfileStore({
      partitionsDirectory: browserProfilesDirectory(),
      sessionFor: (partition) => session.fromPartition(partition),
      closeProfilePages: (profile) => surfaceHost.closeProfileContexts(profile),
      onExtensionSession: (profile) => browserExtensionBridge?.attachProfile(profile),
    });
    const extensionPreloadPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      EXTENSION_BRIDGE_PRELOAD_FILENAME,
    );
    browserExtensionBridge = createExtensionBridge({
      preloadPath: extensionPreloadPath,
      tabsChannel: IPC_CHANNELS.browserExtensionTabs,
      actionChannel: IPC_CHANNELS.browserExtensionActionClicked,
      sessionFor: (profile) => session.fromPartition(browserProfilePartition(profile, "")),
      store: profileStore,
      tabs: createExtensionTabsService(surfaceHost),
    });
    browserExtensionPopupHost ??= createExtensionPopupHost({
      store: profileStore,
      preloadPath: extensionPreloadPath,
      createView: ({ partition, webPreferences }) =>
        popupViewOf(new WebContentsView({ webPreferences: { partition, ...webPreferences } })),
    });
    const nextBrowserRuntimeBroker = await startBrowserRuntimeBroker(surfaceHost, profileStore);
    launch.acquired({ browserBroker: nextBrowserRuntimeBroker });
    const nextComputerService = createComputerUseDesktopService({
      bundledPath: resolveDesktopNativeHelperPath(
        {
          packaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          moduleUrl: import.meta.url,
        },
        CUA_DRIVER_FILENAME,
      ),
      dataDirectory: desktopDataDirectory,
      isWindowAvailable: (windowId) => desktopWindows.hasWindowId(windowId),
    });
    launch.acquired({ computerService: nextComputerService });
    const nextComputerBroker = await startComputerUseBroker(nextComputerService);
    launch.acquired({ computerBroker: nextComputerBroker });
    const nextManagedToolService = createManagedToolService({
      bundledToolsDirectory: resolveManagedToolsDirectory({
        packaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        moduleUrl: import.meta.url,
      }),
      dataDirectory: desktopDataDirectory,
      execPath: resolveDesktopNodeRuntime({
        packaged: app.isPackaged,
        platform: process.platform,
        resourcesPath: process.resourcesPath,
        execPath: process.execPath,
      }),
    });
    launch.acquired({ managedTools: nextManagedToolService });
    const deviceHelperPath = resolveDesktopNativeHelperPath(
      {
        packaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        moduleUrl: import.meta.url,
      },
      DEVICE_HELPER_FILENAME,
    );
    // Simulators exist on macOS only. The broker still starts when the native
    // helper binary is missing, so a managed serve-sim stream can drive the
    // pane. Without either, input is reported unavailable.
    const nextSimulatorHelpers =
      process.platform === "darwin"
        ? createManagedSimulatorHelpers(
            existsSync(deviceHelperPath)
              ? createSimulatorDeviceHelpers({ helperPath: deviceHelperPath })
              : createUnavailableSimulatorHelpers(),
            nextManagedToolService,
            { captureDirectory: join(desktopDataDirectory, "apple-runtime", "captures") },
          )
        : undefined;
    if (nextSimulatorHelpers !== undefined)
      launch.acquired({ simulatorHelpers: nextSimulatorHelpers });
    const nextDeviceBroker =
      nextSimulatorHelpers === undefined
        ? undefined
        : await startSimulatorDeviceBroker(nextSimulatorHelpers);
    if (nextDeviceBroker !== undefined) launch.acquired({ simulatorBroker: nextDeviceBroker });
    const nextServeAvdBroker = await startServeAvdBroker(nextManagedToolService);
    launch.acquired({ avdBroker: nextServeAvdBroker });
    const { broker, server: child } = await startDesktopHostServer(launch, {
      startBroker: startDesktopCredentialBroker,
      startServer: (broker) => {
        const codeFileHelperPath = resolveCodeFileHelperPath({
          packaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          moduleUrl: import.meta.url,
        });
        const terminalLauncherDirectory = resolveTerminalLauncherDirectory({
          packaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
        });
        const spec = serverSpawnSpec({
          browserBrokerToken: nextBrowserRuntimeBroker.token,
          browserBrokerUrl: nextBrowserRuntimeBroker.url,
          browserProfilesDirectory: browserProfilesDirectory(),
          computerUseBrokerUrl: nextComputerBroker.url,
          computerUseBrokerToken: nextComputerBroker.token,
          ...(nextDeviceBroker === undefined
            ? {}
            : {
                simulatorDeviceBrokerUrl: nextDeviceBroker.url,
                simulatorDeviceBrokerToken: nextDeviceBroker.token,
              }),
          serveAvdBrokerUrl: nextServeAvdBroker.url,
          serveAvdBrokerToken: nextServeAvdBroker.token,
          ...(process.platform === "darwin" && existsSync(codeFileHelperPath)
            ? { codeFileHelperPath }
            : {}),
          ...(process.platform === "darwin" &&
          terminalLauncherDirectory !== undefined &&
          existsSync(terminalLauncherDirectory)
            ? { terminalLauncherDirectory }
            : {}),
          ...(broker === undefined
            ? {}
            : {
                credentialBrokerToken: broker.token,
                credentialBrokerUrl: broker.url,
              }),
          desktopBridgeSecret,
          root: resolveDesktopHostRoot({
            packaged: app.isPackaged,
            platform: process.platform,
            resourcesPath: process.resourcesPath,
            appRoot: root,
          }),
          port,
          instanceId,
          packaged: app.isPackaged,
          ...(app.isPackaged ? { appVersion: app.getVersion() } : {}),
          execPath: resolveDesktopNodeRuntime({
            packaged: app.isPackaged,
            platform: process.platform,
            resourcesPath: process.resourcesPath,
            execPath: process.execPath,
          }),
          env: {
            ...process.env,
            ...(desktopWindowsHost === undefined
              ? { OCTANT_DATA_DIR: desktopDataDirectory, ...desktopHostStartup.hostEnvironment }
              : { [KEYCHAIN_SERVICE_FAMILY_ENVIRONMENT]: desktopKeychainServiceFamily }),
          },
        });
        return spawn(spec.command, spec.args, {
          env: spec.env,
          stdio: [...spec.stdio] as ["pipe", "inherit", "pipe"],
        });
      },
    });
    // pipe() honours backpressure from a slow parent stderr; the tail
    // listener only keeps a bounded copy.
    child.stderr.pipe(process.stderr, { end: false });
    child.stderr.on("data", (chunk: Buffer) => serverStderr.append(chunk));
    child.stderr.once("end", serverStderr.end);
    credentialBroker = broker;
    browserRuntimeBroker = nextBrowserRuntimeBroker;
    computerUseService = nextComputerService;
    managedToolService = nextManagedToolService;
    server = child;
    serverInstanceId = instanceId;
    activeServerUrl = serverUrl;
    const attached = await waitForStorageReady({
      serverUrl,
      instanceId,
      ...(server === undefined
        ? {}
        : {
            child: server,
            lastOutput: async () => {
              await serverStderr.drained(STDERR_DRAIN_TIMEOUT_MS);
              return serverStderr.text();
            },
          }),
      resolveAttachedHost: async () => {
        return (await resolveExistingHostAttachment(child))?.probe;
      },
    });
    if (attached !== undefined) {
      const winningAttachment = await resolveExistingHostAttachment();
      if (
        winningAttachment === undefined ||
        winningAttachment.probe.instanceId !== attached.instanceId ||
        winningAttachment.probe.url !== attached.url
      ) {
        throw new Error("Octant could not load the attached host authority.");
      }
      desktopBackendSupervisor.release();
      await closeDesktopHostLaunch(launch);
      desktopBridgeSecret = winningAttachment.bridgeSecret;
      serverInstanceId = attached.instanceId;
      activeServerUrl = attached.url;
      return { url: attached.url, instanceId: attached.instanceId, ownership: "managed" };
    }
    if (server !== undefined && !desktopQuitAccepted) desktopBackendSupervisor.observe(server);
    return { url: serverUrl, instanceId, ownership: "desktop-owned" };
  } catch (error) {
    if (desktopBackendSupervisor.snapshot().status !== "restarting") {
      desktopBackendSupervisor.release();
    }
    await closeDesktopHostLaunch(launch).catch((cleanupError: unknown) => {
      // Cleanup errors contain only fixed stage names; preserve the original
      // startup error so retry policy still sees its actual classification.
      logQuitProblem(String(cleanupError));
    });
    throw error;
  }
}

async function closeDesktopHostLaunch(launch: DesktopHostLaunch): Promise<void> {
  const result = await launch.close();
  if (result.status === "failed") {
    throw new Error(`Octant could not close owned host resources: ${result.stages.join(", ")}.`);
  }
  if (desktopHostLaunch !== launch) return;
  // Normal API closure does not prove tracked helper exit. Keep the one
  // quit-owned launch reachable through the existing application deadline.
  if (desktopQuitAccepted) acceptedQuitLaunch = launch;
  desktopHostLaunch = undefined;
  computerUseService = undefined;
  managedToolService = undefined;
  server = undefined;
  credentialBroker = undefined;
  browserRuntimeBroker = undefined;
  serverInstanceId = undefined;
  activeServerUrl = undefined;
}

async function stopDesktopOwnedHost(host: LocalHostDescriptor): Promise<void> {
  if (host.ownership !== "desktop-owned") return;
  // Supervisor-driven restart uses stop()+start() to replace the child.
  // Releasing here would cancel that restart if the replacement start fails.
  if (desktopBackendSupervisor.snapshot().status !== "restarting") {
    desktopBackendSupervisor.release();
  }
  const launch = desktopHostLaunch;
  if (launch !== undefined) await closeDesktopHostLaunch(launch);
}

const hostLifecycle = createHostLifecycleController({
  attach: attachExistingLocalHost,
  start: startDesktopOwnedHost,
  stop: stopDesktopOwnedHost,
});

interface RestartRecoverableProjectWindow {
  readonly refreshAuthorityAfterHostRestart: (host: LocalHostDescriptor) => Promise<void>;
}

export function createProjectWindowAuthorityRefresh(
  initialInstanceId: string,
  refresh: (host: LocalHostDescriptor) => Promise<void>,
): (host: LocalHostDescriptor) => Promise<void> {
  let authorityInstanceId = initialInstanceId;
  let pending: { readonly instanceId: string; readonly operation: Promise<void> } | undefined;
  const run = async (host: LocalHostDescriptor): Promise<void> => {
    if (authorityInstanceId === host.instanceId) return;
    const activeRefresh = pending;
    if (activeRefresh !== undefined) {
      if (activeRefresh.instanceId === host.instanceId) return activeRefresh.operation;
      await activeRefresh.operation.catch(() => undefined);
      return await run(host);
    }
    const started = refresh(host).then(() => {
      authorityInstanceId = host.instanceId;
    });
    const observed = started.finally(() => {
      if (pending?.operation === observed) pending = undefined;
    });
    pending = { instanceId: host.instanceId, operation: observed };
    return await observed;
  };
  return run;
}

export async function refreshProjectWindowAuthoritiesAfterHostRestart(
  host: LocalHostDescriptor,
  windows: ReadonlyArray<RestartRecoverableProjectWindow>,
): Promise<void> {
  await Promise.all(windows.map((window) => window.refreshAuthorityAfterHostRestart(host)));
}

export async function restartDesktopHostAndRefreshWindowAuthorities(options: {
  readonly restart: () => Promise<HostAdmission>;
  readonly refreshWindowAuthorities: (host: LocalHostDescriptor) => Promise<void>;
}): Promise<
  | { readonly status: "closing" }
  | {
      readonly status: "running";
      readonly host: LocalHostDescriptor;
      readonly windowAuthorities: "ready" | "attention-required";
    }
> {
  const admission = await options.restart();
  if (admission.status === "closing") return admission;
  const host = admission.host;
  try {
    await options.refreshWindowAuthorities(host);
    return Object.freeze({ status: "running", host, windowAuthorities: "ready" });
  } catch {
    return Object.freeze({ status: "running", host, windowAuthorities: "attention-required" });
  }
}

async function restartDesktopHost(): Promise<HostAdmission> {
  const finishRestart = desktopClientLifetime.beginHostRestart();
  const outcome = await restartDesktopHostAndRefreshWindowAuthorities({
    restart: async () => {
      try {
        const admission = await hostLifecycle.restart();
        finishRestart(admission.status !== "closing");
        return admission;
      } catch (error) {
        finishRestart(false);
        throw error;
      }
    },
    refreshWindowAuthorities: refreshDesktopWindowAuthorities,
  });
  if (outcome.status === "closing") return outcome;
  if (outcome.windowAuthorities === "attention-required") {
    hostLifecycle.setActivity({
      activeAgentCount: 0,
      attentionRequired: true,
      activityUnconfirmed: true,
    });
    updateHostTray();
  }
  return { status: "running", host: outcome.host };
}

const desktopBackendSupervisor = createDesktopBackendSupervisor({
  restart: async () => {
    const admission = await restartDesktopHost();
    // An accepted quit ends supervision; releasing here makes the supervisor
    // treat this refused restart as a stop rather than a crash to retry.
    if (admission.status === "closing") {
      desktopBackendSupervisor.release();
      return undefined;
    }
    return server;
  },
  reportFatal: (error) => {
    dialog.showErrorBox(
      "Octant could not restart its local server",
      formatDesktopStartupFailure(error),
    );
    hostLifecycle.setActivity({
      activeAgentCount: 0,
      attentionRequired: true,
      activityUnconfirmed: true,
    });
    updateHostTray();
  },
});

async function createWindow(stillRequested: () => boolean): Promise<void> {
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) return;
  const root = repositoryRoot();
  markHostInteraction("host", "window-create-start");
  const admission = await hostLifecycle.ensureRunning();
  if (admission.status === "closing") return;
  const host = admission.host;
  markHostInteraction("server", "host-running");
  const serverUrl = host.url;
  activeServerUrl = serverUrl;
  serverInstanceId = host.instanceId;
  await refreshHostActivity();
  if (host.ownership === "desktop-owned") {
    await writeDesktopBridgeProjection();
  }
  ensureHostTray();

  const displays = screen.getAllDisplays().map(({ workArea }) => workArea);
  nativeStateStore = createNativeWindowStateStore({
    directory: app.getPath("userData"),
    displays,
    files: {
      mkdir: async (path) => void (await mkdir(path, { recursive: true })),
      readFile: (path) => readFile(path, "utf8"),
      rename,
      writeFile: async (path, contents) => void (await writeFile(path, contents, "utf8")),
    },
    uuid: randomUUID,
  });
  const state = await nativeStateStore.load();
  stableWindowId = state.windowId;
  const presentation = resolveWindowPresentation({
    platform: process.platform,
    sidebarMaterial: INITIAL_SIDEBAR_MATERIAL_PREFERENCE,
    sidebarVibrancyMode: "off",
    compositionSupported: process.platform === "darwin",
    performanceSafe: false,
    prefersReducedTransparency: nativeTheme.prefersReducedTransparency,
    highContrast: nativeTheme.shouldUseHighContrastColors,
  });
  const preparationCleanup = createProjectWindowPreparationCleanup();
  let preparedController: WindowPresentationController | undefined;
  const disposePreparation = (): void => {
    preparationCleanup.dispose();
    if (presentationController === preparedController) presentationController = undefined;
  };
  let rendererIdentity: string | undefined;
  await projectWindowLifecycle.open({
    register: async () => {
      const authority = await createProjectWindowAuthority({
        desktopBridgeSecret,
        serverUrl,
        windowId: state.windowId,
      });
      rendererIdentity = authority.rendererIdentity;
      return authority;
    },
    construct: (capability) => {
      if (!stillRequested()) throw new Error("Octant replaced this local window request.");
      stableWindowCapability = capability;
      const window = new BrowserWindow(
        createMainBrowserWindowOptions({
          bounds: state.bounds,
          capability,
          windowId: state.windowId,
          ...nightlyWindowIdentity,
          preloadPath: resolve(dirname(fileURLToPath(import.meta.url)), DESKTOP_PRELOAD_FILENAME),
          browserWindow: presentation.browserWindow,
        }),
      );
      if (rendererIdentity !== undefined) {
        registerTrustedRendererRequestContext(window, {
          serverUrl,
          rendererIdentity,
          ...(process.env.OCTANT_WEB_URL === undefined
            ? {}
            : { developmentUrl: process.env.OCTANT_WEB_URL }),
        });
      }
      return window;
    },
    prepare: (window, closeAuthority) => {
      installNativeEditingMenus(window);
      mainWindow = window;
      if (state.maximized) window.maximize();
      projectRootPicker = createProjectRootPicker<BrowserWindow>({
        brokerHeaders: desktopBrokerHeaders,
        dialog: {
          showOpenDialog: (owner, options) =>
            dialog.showOpenDialog(owner, { properties: [...options.properties] }),
        },
        resolveOwnedWindow: (sender) => {
          const owner = BrowserWindow.fromWebContents(sender as Electron.WebContents);
          return owner !== null && owner === window ? owner : undefined;
        },
        serverUrl,
        windowId: state.windowId,
      });
      const localPluginFolderPicker = createLocalPluginFolderPicker<BrowserWindow>({
        brokerHeaders: desktopBrokerHeaders,
        dialog: {
          showOpenDialog: (owner, options) =>
            dialog.showOpenDialog(owner, { properties: [...options.properties] }),
        },
        resolveOwnedWindow: (sender) => {
          const owner = BrowserWindow.fromWebContents(sender as Electron.WebContents);
          return owner !== null && owner === window ? owner : undefined;
        },
        serverUrl,
        windowId: state.windowId,
      });
      const runtimeBinaryPicker = createRuntimeBinaryPicker<BrowserWindow>({
        brokerHeaders: desktopBrokerHeaders,
        dialog: {
          showOpenDialog: (owner, options) =>
            dialog.showOpenDialog(owner, { properties: [...options.properties] }),
        },
        resolveOwnedWindow: (sender) => {
          const owner = BrowserWindow.fromWebContents(sender as Electron.WebContents);
          return owner !== null && owner === window ? owner : undefined;
        },
        serverUrl,
        windowId: state.windowId,
      });

      const supportBundleSaver = createSupportBundleSaver<BrowserWindow>({
        brokerHeaders: desktopBrokerHeaders,
        dialog: {
          showSaveDialog: async (owner, options) => {
            const chosen = await dialog.showSaveDialog(owner, {
              title: options.title,
              defaultPath: options.defaultPath,
              buttonLabel: options.buttonLabel,
              filters: [...options.filters],
              properties: [...options.properties],
            });
            return { canceled: chosen.canceled, filePath: chosen.filePath ?? "" };
          },
        },
        defaultDirectory: app.getPath("downloads"),
        resolveOwnedWindow: (sender) => {
          const owner = BrowserWindow.fromWebContents(sender as Electron.WebContents);
          return owner !== null && owner === window ? owner : undefined;
        },
        serverUrl,
      });
      const browserProofSaver = createBrowserProofSaver<BrowserWindow>({
        dialog: {
          showOpenDialog: async (owner, options) => {
            const chosen = await dialog.showOpenDialog(owner, {
              title: options.title,
              buttonLabel: options.buttonLabel,
              defaultPath: options.defaultPath,
              properties: [...options.properties],
            });
            return { canceled: chosen.canceled, filePaths: chosen.filePaths };
          },
        },
        defaultDirectory: app.getPath("downloads"),
        resolveOwnedWindow: (sender) => {
          const owner = BrowserWindow.fromWebContents(sender as Electron.WebContents);
          return owner !== null && owner === window ? owner : undefined;
        },
      });
      let resolvedMaterial: ResolvedSidebarMaterial = presentation.material;
      let resolvedSidebarVibrancy: "sidebar" | null = presentation.vibrancy;
      const controller = createWindowPresentationController({
        window: {
          setVibrancy: (value) => window.setVibrancy(value),
          publishResolvedMaterial: (material) => {
            resolvedMaterial = material;
            if (!window.webContents.isDestroyed()) {
              window.webContents.send(IPC_CHANNELS.resolvedMaterial, material);
            }
          },
          publishSidebarVibrancy: (vibrancy) => {
            resolvedSidebarVibrancy = vibrancy;
            if (!window.webContents.isDestroyed()) {
              window.webContents.send(IPC_CHANNELS.resolvedSidebarVibrancy, vibrancy);
            }
          },
        },
        nativeTheme,
        platform: process.platform,
        sidebarMaterial: INITIAL_SIDEBAR_MATERIAL_PREFERENCE,
        sidebarVibrancyMode: "off",
        compositionSupported: process.platform === "darwin",
        performanceSafe: false,
      });
      preparedController = controller;
      preparationCleanup.trackPresentationController(controller);
      presentationController = controller;
      if (stableWindowCapability === undefined) {
        throw new Error("Octant Project window capability is unavailable.");
      }
      desktopWindows.register(window, {
        windowId: state.windowId,
        capability: stableWindowCapability,
        primary: true,
        picker: projectRootPicker,
        localPluginFolderPicker,
        runtimeBinaryPicker,
        supportBundleSaver,
        browserProofSaver,
        presentationController: controller,
        refreshAuthorityAfterHostRestart: createProjectWindowAuthorityRefresh(
          host.instanceId,
          (replacementHost) =>
            refreshDesktopProjectWindowAuthorityAfterHostRestart({
              host: replacementHost,
              lifecycle: projectWindowLifecycle,
              primary: true,
              window,
              windowId: state.windowId,
            }),
        ),
      });
      installRendererNavigationGuards(
        rendererNavigationWebContents(window),
        rendererNavigationPolicyOptions(),
      );
      installCanvasFrameGuards(canvasFrameGuardWebContents(window), {
        serverUrl: () => activeServerUrl,
      });
      closeCanvasPrototypesWith(canvasPrototypeOwnerContents(window), () => canvasPrototypeSurface);
      const stopThermalPerformance = observeThermalPerformance({
        platform: process.platform,
        powerMonitor,
        richEffectsAllowed: systemPreferences.getAnimationSettings().shouldRenderRichAnimation,
        updatePerformanceSafe: (performanceSafe) => controller.update({ performanceSafe }),
      });
      preparationCleanup.trackThermalObserver(stopThermalPerformance);

      window.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
        if (!isMainFrame || isInPlace) return;
        menuBarOpenThreads.delete(window.id);
        updateHostTray();
      });
      window.webContents.on("did-finish-load", () => {
        window.webContents.send(IPC_CHANNELS.resolvedMaterial, resolvedMaterial);
        window.webContents.send(IPC_CHANNELS.resolvedSidebarVibrancy, resolvedSidebarVibrancy);
        while (pendingCodeDeepLinks.length > 0) {
          window.webContents.send(IPC_CHANNELS.codeDeepLink, pendingCodeDeepLinks.shift());
        }
      });
      window.webContents.on("render-process-gone", (_event, details) => {
        codeOperationApprovalViews?.closeWindow(state.windowId);
        void Promise.all([
          browserSurfaceHost?.closeOwnerContexts(state.windowId),
          closeAuthority(),
        ]).finally(() => {
          if (!window.isDestroyed()) window.destroy();
          if (desktopClientLifetime.localWindowAdmission()())
            recoverWindowAfterRendererExit(details.reason);
        });
      });
      window.once("ready-to-show", () => {
        markHostInteraction("native-window", "ready-to-show");
        window.show();
      });
      window.on("close", (event) => {
        if (quitPrepared) return;
        event.preventDefault();
        void saveWindowStateWithoutBlocking({
          flushWindowState,
          log: logQuitProblem,
        }).finally(() => {
          if (!window.isDestroyed()) window.destroy();
        });
      });
      window.once("closed", () => {
        codeOperationApprovalViews?.closeWindow(state.windowId);
        approvalPalettesByWindow.delete(state.windowId);
        void browserSurfaceHost?.closeOwnerContexts(state.windowId).catch(() => undefined);
        unregisterTrustedRendererRequestContext(window);
        desktopWindows.remove(window);
        forgetAttentionBadge(window.id);
        projectRootPicker = undefined;
        void closeAuthority();
        disposePreparation();
        if (mainWindow === window) mainWindow = undefined;
        hostLifecycle.onLastWindowClosed();
      });
      installIpcHandlers();
    },
    load: async (window) => {
      const developmentUrl = process.env.OCTANT_WEB_URL;
      if (developmentUrl) {
        await window.loadURL(
          prepareDevelopmentRendererUrl(developmentUrl, state.windowId, serverUrl),
        );
      } else {
        await window.loadFile(resolve(root, "apps/web/dist/index.html"), {
          query: preparePackagedRendererQuery(serverUrl),
        });
      }
    },
    dispose: (window) => {
      unregisterTrustedRendererRequestContext(window);
      desktopWindows.remove(window);
      stableWindowCapability = undefined;
      projectRootPicker = undefined;
      disposePreparation();
      if (mainWindow === window) mainWindow = undefined;
      if (!window.isDestroyed()) window.destroy();
    },
  });
}

async function openSecondaryProjectWindow(target: ProjectWindowTarget): Promise<void> {
  const stillRequested = desktopClientLifetime.localWindowAdmission();
  if (!stillRequested()) return;
  const serverUrl = activeServerUrl;
  const initialAuthorityInstanceId = serverInstanceId;
  if (serverUrl === undefined || initialAuthorityInstanceId === undefined) {
    throw new Error("Octant Project window handoff is unavailable.");
  }
  const windowId = randomUUID();
  const presentation = resolveWindowPresentation({
    platform: process.platform,
    sidebarMaterial: INITIAL_SIDEBAR_MATERIAL_PREFERENCE,
    sidebarVibrancyMode: "off",
    compositionSupported: process.platform === "darwin",
    performanceSafe: false,
    prefersReducedTransparency: nativeTheme.prefersReducedTransparency,
    highContrast: nativeTheme.shouldUseHighContrastColors,
  });
  const state = centeredNativeWindowState(
    screen.getAllDisplays().map(({ workArea }) => workArea),
    windowId,
  );
  const lifecycle = createProjectWindowAuthorityLifecycle();
  secondaryWindowLifecycles.add(lifecycle);
  const preparationCleanup = createProjectWindowPreparationCleanup();
  let windowCapability: string | undefined;
  let rendererIdentity: string | undefined;
  try {
    await lifecycle.open({
      register: async () => {
        const authority = await createProjectWindowAuthority({
          desktopBridgeSecret,
          serverUrl,
          windowId,
        });
        rendererIdentity = authority.rendererIdentity;
        return authority;
      },
      construct: (capability) => {
        if (!stillRequested()) throw new Error("Octant replaced this local window request.");
        windowCapability = capability;
        const window = new BrowserWindow(
          createMainBrowserWindowOptions({
            bounds: state.bounds,
            capability,
            windowId,
            initialProjectId: target.projectId,
            ...(target.kind === "project-thread"
              ? { initialThreadMode: target.mode, initialThreadId: target.threadId }
              : {}),
            ...nightlyWindowIdentity,
            preloadPath: resolve(dirname(fileURLToPath(import.meta.url)), DESKTOP_PRELOAD_FILENAME),
            browserWindow: presentation.browserWindow,
          }),
        );
        if (rendererIdentity !== undefined) {
          registerTrustedRendererRequestContext(window, {
            serverUrl,
            rendererIdentity,
            ...(process.env.OCTANT_WEB_URL === undefined
              ? {}
              : { developmentUrl: process.env.OCTANT_WEB_URL }),
          });
        }
        return window;
      },
      prepare: (window, closeAuthority) => {
        installNativeEditingMenus(window);
        if (windowCapability === undefined) {
          throw new Error("Octant Project window capability is unavailable.");
        }
        const picker = createProjectRootPicker<BrowserWindow>({
          brokerHeaders: desktopBrokerHeaders,
          dialog: {
            showOpenDialog: (owner, options) =>
              dialog.showOpenDialog(owner, { properties: [...options.properties] }),
          },
          resolveOwnedWindow: (sender) => {
            const owner = BrowserWindow.fromWebContents(sender as Electron.WebContents);
            return owner !== null && owner === window ? owner : undefined;
          },
          serverUrl,
          windowId,
        });
        const localPluginFolderPicker = createLocalPluginFolderPicker<BrowserWindow>({
          brokerHeaders: desktopBrokerHeaders,
          dialog: {
            showOpenDialog: (owner, options) =>
              dialog.showOpenDialog(owner, { properties: [...options.properties] }),
          },
          resolveOwnedWindow: (sender) => {
            const owner = BrowserWindow.fromWebContents(sender as Electron.WebContents);
            return owner !== null && owner === window ? owner : undefined;
          },
          serverUrl,
          windowId,
        });
        const runtimeBinaryPicker = createRuntimeBinaryPicker<BrowserWindow>({
          brokerHeaders: desktopBrokerHeaders,
          dialog: {
            showOpenDialog: (owner, options) =>
              dialog.showOpenDialog(owner, { properties: [...options.properties] }),
          },
          resolveOwnedWindow: (sender) => {
            const owner = BrowserWindow.fromWebContents(sender as Electron.WebContents);
            return owner !== null && owner === window ? owner : undefined;
          },
          serverUrl,
          windowId,
        });
        const supportBundleSaver = createSupportBundleSaver<BrowserWindow>({
          brokerHeaders: desktopBrokerHeaders,
          dialog: {
            showSaveDialog: async (owner, options) => {
              const chosen = await dialog.showSaveDialog(owner, {
                title: options.title,
                defaultPath: options.defaultPath,
                buttonLabel: options.buttonLabel,
                filters: [...options.filters],
                properties: [...options.properties],
              });
              return { canceled: chosen.canceled, filePath: chosen.filePath ?? "" };
            },
          },
          defaultDirectory: app.getPath("downloads"),
          resolveOwnedWindow: (sender) => {
            const owner = BrowserWindow.fromWebContents(sender as Electron.WebContents);
            return owner !== null && owner === window ? owner : undefined;
          },
          serverUrl,
        });
        const browserProofSaver = createBrowserProofSaver<BrowserWindow>({
          dialog: {
            showOpenDialog: async (owner, options) => {
              const chosen = await dialog.showOpenDialog(owner, {
                title: options.title,
                buttonLabel: options.buttonLabel,
                defaultPath: options.defaultPath,
                properties: [...options.properties],
              });
              return { canceled: chosen.canceled, filePaths: chosen.filePaths };
            },
          },
          defaultDirectory: app.getPath("downloads"),
          resolveOwnedWindow: (sender) => {
            const owner = BrowserWindow.fromWebContents(sender as Electron.WebContents);
            return owner !== null && owner === window ? owner : undefined;
          },
        });
        let resolvedMaterial: ResolvedSidebarMaterial = presentation.material;
        let resolvedSidebarVibrancy: "sidebar" | null = presentation.vibrancy;
        const controller = createWindowPresentationController({
          window: {
            setVibrancy: (value) => window.setVibrancy(value),
            publishResolvedMaterial: (material) => {
              resolvedMaterial = material;
              if (!window.webContents.isDestroyed()) {
                window.webContents.send(IPC_CHANNELS.resolvedMaterial, material);
              }
            },
            publishSidebarVibrancy: (vibrancy) => {
              resolvedSidebarVibrancy = vibrancy;
              if (!window.webContents.isDestroyed()) {
                window.webContents.send(IPC_CHANNELS.resolvedSidebarVibrancy, vibrancy);
              }
            },
          },
          nativeTheme,
          platform: process.platform,
          sidebarMaterial: INITIAL_SIDEBAR_MATERIAL_PREFERENCE,
          sidebarVibrancyMode: "off",
          compositionSupported: process.platform === "darwin",
          performanceSafe: false,
        });
        preparationCleanup.trackPresentationController(controller);
        preparationCleanup.trackThermalObserver(
          observeThermalPerformance({
            platform: process.platform,
            powerMonitor,
            richEffectsAllowed: systemPreferences.getAnimationSettings().shouldRenderRichAnimation,
            updatePerformanceSafe: (performanceSafe) => controller.update({ performanceSafe }),
          }),
        );
        desktopWindows.register(window, {
          windowId,
          capability: windowCapability,
          primary: false,
          picker,
          localPluginFolderPicker,
          runtimeBinaryPicker,
          supportBundleSaver,
          browserProofSaver,
          presentationController: controller,
          refreshAuthorityAfterHostRestart: createProjectWindowAuthorityRefresh(
            initialAuthorityInstanceId,
            (replacementHost) =>
              refreshDesktopProjectWindowAuthorityAfterHostRestart({
                host: replacementHost,
                lifecycle,
                primary: false,
                window,
                windowId,
              }),
          ),
        });
        installRendererNavigationGuards(
          rendererNavigationWebContents(window),
          rendererNavigationPolicyOptions(),
        );
        installCanvasFrameGuards(canvasFrameGuardWebContents(window), {
          serverUrl: () => activeServerUrl,
        });
        closeCanvasPrototypesWith(
          canvasPrototypeOwnerContents(window),
          () => canvasPrototypeSurface,
        );
        window.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
          if (!isMainFrame || isInPlace) return;
          menuBarOpenThreads.delete(window.id);
          updateHostTray();
        });
        window.webContents.on("did-finish-load", () => {
          window.webContents.send(IPC_CHANNELS.resolvedMaterial, resolvedMaterial);
          window.webContents.send(IPC_CHANNELS.resolvedSidebarVibrancy, resolvedSidebarVibrancy);
        });
        window.webContents.on("render-process-gone", () => {
          codeOperationApprovalViews?.closeWindow(windowId);
          void Promise.all([
            browserSurfaceHost?.closeOwnerContexts(windowId),
            closeAuthority(),
          ]).finally(() => {
            if (!window.isDestroyed()) window.destroy();
          });
        });
        window.once("ready-to-show", () => {
          markHostInteraction("native-window", "ready-to-show");
          window.show();
        });
        window.once("closed", () => {
          codeOperationApprovalViews?.closeWindow(windowId);
          approvalPalettesByWindow.delete(windowId);
          void browserSurfaceHost?.closeOwnerContexts(windowId).catch(() => undefined);
          unregisterTrustedRendererRequestContext(window);
          desktopWindows.remove(window);
          forgetAttentionBadge(window.id);
          preparationCleanup.dispose();
          void closeAuthority().finally(() => secondaryWindowLifecycles.delete(lifecycle));
        });
        installIpcHandlers();
      },
      load: async (window) => {
        const developmentUrl = process.env.OCTANT_WEB_URL;
        if (developmentUrl) {
          await window.loadURL(prepareDevelopmentRendererUrl(developmentUrl, windowId, serverUrl));
        } else {
          await window.loadFile(resolve(repositoryRoot(), "apps/web/dist/index.html"), {
            query: preparePackagedRendererQuery(serverUrl),
          });
        }
      },
      dispose: (window) => {
        unregisterTrustedRendererRequestContext(window);
        desktopWindows.remove(window);
        preparationCleanup.dispose();
        if (!window.isDestroyed()) window.destroy();
      },
    });
  } catch (error) {
    secondaryWindowLifecycles.delete(lifecycle);
    if (stillRequested()) throw error;
  }
}

function hostStatusLabel(): string {
  const snapshot = hostLifecycle.snapshot();
  if (snapshot.state === "attention-required") return "Attention needed";
  if (snapshot.state === "running") return "Running";
  if (snapshot.state === "starting") return "Starting";
  return "Stopped";
}

/** The thread each trusted window last reported showing; `undefined` when none. */
const menuBarOpenThreads = new Map<number, MenuBarOpenThread | undefined>();
const menuBarFleet = new MenuBarFleet();
let menuBarFleetInstanceId: string | undefined;
/** A row picked while no window could open it yet; the next ready main window takes it. */
let pendingMenuBarOpen: MenuBarOpenThread | undefined;
const menuBarFleetReader = createMenuBarFleetReader({
  register: (host) =>
    createProjectWindowAuthority({
      desktopBridgeSecret,
      serverUrl: host.url,
      windowId: randomUUID(),
    }),
  fetch: (input, init) => globalThis.fetch(input, init),
});

function watchedMenuBarThreads(): ReadonlyArray<MenuBarOpenThread> {
  const watched: MenuBarOpenThread[] = [];
  for (const [windowId, thread] of menuBarOpenThreads) {
    const window = BrowserWindow.fromId(windowId);
    if (thread !== undefined && window !== null && !window.isDestroyed() && window.isFocused()) {
      watched.push(thread);
    }
  }
  return watched;
}

async function refreshMenuBarFleet(host: { readonly url: string; readonly instanceId: string }) {
  if (menuBarFleetInstanceId !== host.instanceId) {
    menuBarFleet.clear();
    menuBarFleetInstanceId = host.instanceId;
  }
  const activity = await menuBarFleetReader.read(host);
  // A failed read says nothing about which threads finished, so it changes nothing.
  if (activity === undefined || menuBarFleetInstanceId !== host.instanceId) return;
  menuBarFleet.observe(activity, watchedMenuBarThreads());
}

function sendMenuBarOpen(window: BrowserWindow, thread: MenuBarOpenThread): void {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  window.webContents.send(IPC_CHANNELS.menuBarTask, thread);
}

async function openMenuBarThread(thread: MenuBarOpenThread): Promise<void> {
  menuBarFleet.looked(thread);
  updateHostTray();
  const ready =
    mainWindow !== undefined && !mainWindow.isDestroyed() && menuBarOpenThreads.has(mainWindow.id)
      ? mainWindow
      : undefined;
  if (ready !== undefined) {
    sendMenuBarOpen(ready, thread);
    return;
  }
  // No window can take it yet: open one, and hand it the thread once its
  // renderer reports it is ready to open threads.
  pendingMenuBarOpen = thread;
  await ensureMenuWindow();
  mainWindow?.show();
  mainWindow?.focus();
}

function updateHostTray(): void {
  if (hostTray === undefined) return;
  const snapshot = hostLifecycle.snapshot();
  const fleet = snapshot.state === "stopped" ? [] : menuBarFleet.threads();
  const items = buildMenuBarItems(snapshot, fleet);
  const toTemplate = (item: (typeof items)[number]): MenuItemConstructorOptions => {
    if (item.id === "separator") return { type: "separator" };
    const thread = item.thread;
    if (thread !== undefined)
      return {
        label: item.label,
        enabled: item.enabled,
        ...(item.toolTip === undefined ? {} : { toolTip: item.toolTip }),
        click: () => {
          void openMenuBarThread({ mode: thread.mode, threadId: thread.threadId }).catch(() => {
            dialog.showErrorBox(
              "Octant could not open that thread",
              "Open Octant and choose the thread from the sidebar.",
            );
          });
        },
      };
    return {
      label: item.label,
      enabled: item.enabled,
      ...(item.submenu === undefined
        ? { click: () => void runMenuBarAction(item.id) }
        : { submenu: item.submenu.map(toTemplate) }),
    };
  };
  const template = items.map(toTemplate);
  hostTray.setContextMenu(Menu.buildFromTemplate(template));
  hostTray.setToolTip(`Octant — ${hostStatusLabel()}`);
  hostTray.setTitle?.(menuBarTitle(snapshot, fleet));
}

function ensureHostTray(): void {
  const snapshot = hostLifecycle.snapshot();
  if (!shouldPresentHostTray(process.platform, snapshot.state)) return;
  if (hostTray === undefined) {
    const iconPath = resolve(repositoryRoot(), "apps/desktop/resources/menuBarTemplate.png");
    hostTray = new Tray(createHostTrayImage(nativeImage, iconPath, process.platform));
    hostTray.on("click", () => hostTray?.popUpContextMenu());
  }
  updateHostTray();
  if (hostStatusPoll === undefined) {
    // The tray is often the only visible surface, so it cannot stop probing
    // when every window is closed. It can probe less often: 2 s while a window
    // is visible, 10 s when the app is only in the menu bar.
    let idleTicks = 0;
    let probing = false;
    hostStatusPoll = setInterval(() => {
      const visible = BrowserWindow.getAllWindows().some((window) => window.isVisible());
      if (visible) {
        idleTicks = 0;
      } else {
        idleTicks += 1;
        if (idleTicks % 5 !== 0) return;
      }
      if (probing) return;
      probing = true;
      void refreshHostActivity().finally(() => {
        probing = false;
      });
    }, 2_000);
    hostStatusPoll.unref?.();
  }
}

function destroyHostTray(): void {
  if (hostStatusPoll !== undefined) {
    clearInterval(hostStatusPoll);
    hostStatusPoll = undefined;
  }
  hostTray?.destroy();
  hostTray = undefined;
  menuBarFleet.clear();
  void menuBarFleetReader.revoke();
}

async function refreshHostActivity(): Promise<void> {
  let snapshot = hostLifecycle.snapshot();
  if (snapshot.url === undefined || snapshot.state === "stopped") return;
  let probe = await probeLocalHost({ url: snapshot.url });
  if (
    snapshot.ownership === "managed" &&
    (probe === undefined || probe.instanceId !== snapshot.instanceId)
  ) {
    const replacement = await hostLifecycle.reattachManagedHost();
    if (replacement !== undefined) {
      activeServerUrl = replacement.url;
      serverInstanceId = replacement.instanceId;
      snapshot = hostLifecycle.snapshot();
      probe = await probeLocalHost({ url: replacement.url });
    }
  }
  if (probe === undefined || probe.instanceId !== snapshot.instanceId) {
    hostLifecycle.setActivity({
      activeAgentCount: 0,
      attentionRequired: true,
      activityUnconfirmed: true,
    });
    updateHostTray();
    return;
  }
  if (
    snapshot.url === undefined ||
    snapshot.instanceId === undefined ||
    snapshot.ownership === undefined
  ) {
    hostLifecycle.setActivity({
      activeAgentCount: 0,
      attentionRequired: true,
      activityUnconfirmed: true,
    });
    updateHostTray();
    return;
  }
  try {
    await refreshDesktopWindowAuthorities({
      url: snapshot.url,
      instanceId: snapshot.instanceId,
      ownership: snapshot.ownership,
    });
  } catch {
    hostLifecycle.setActivity({
      activeAgentCount: 0,
      attentionRequired: true,
      activityUnconfirmed: true,
    });
    updateHostTray();
    return;
  }
  hostLifecycle.setActivity({
    activeAgentCount: probe.activeAgentCount ?? 0,
    attentionRequired: probe.attentionRequired ?? false,
  });
  // Only a present menu bar reads the roster; window startup never waits on it.
  if (hostTray !== undefined) {
    await refreshMenuBarFleet({ url: snapshot.url, instanceId: snapshot.instanceId });
  }
  updateHostTray();
}

async function openLocalWebApp(): Promise<void> {
  const snapshot = hostLifecycle.snapshot();
  if (snapshot.url === undefined || snapshot.state === "stopped") {
    throw new Error("Octant local web app is unavailable while the host is stopped.");
  }
  await shell.openExternal(
    await createBrowserLaunchLink({ hostUrl: snapshot.url, desktopBridgeSecret }),
  );
}

async function startHostFromMenu(): Promise<void> {
  const admission = await hostLifecycle.ensureRunning();
  if (admission.status === "closing") return;
  const host = admission.host;
  activeServerUrl = host.url;
  serverInstanceId = host.instanceId;
  if (host.ownership === "desktop-owned") {
    await writeDesktopBridgeProjection();
  }
  ensureHostTray();
  await refreshHostActivity();
}

async function stopHostFromMenu(): Promise<void> {
  const snapshot = hostLifecycle.snapshot();
  if (snapshot.ownership !== "desktop-owned") {
    throw new Error("Octant cannot stop a separately managed host.");
  }
  await hostLifecycle.stop();
  updateHostTray();
}

async function restartHostFromMenu(): Promise<void> {
  const admission = await restartDesktopHost();
  if (admission.status === "closing") return;
  const host = admission.host;
  activeServerUrl = host.url;
  serverInstanceId = host.instanceId;
  await writeDesktopBridgeProjection();
  ensureHostTray();
  await refreshHostActivity();
}

async function runMenuBarAction(
  action: ReturnType<typeof buildMenuBarItems>[number]["id"],
): Promise<void> {
  try {
    if (action === "open-app") {
      await ensureMenuWindow();
      mainWindow?.show();
      mainWindow?.focus();
    } else if (action === "open-web") {
      await openLocalWebApp();
    } else if (action === "start-new-agent") {
      await ensureMenuWindow();
      mainWindow?.show();
      mainWindow?.focus();
      if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.startNewAgent);
      }
    } else if (action === "start-host") {
      await startHostFromMenu();
    } else if (action === "stop-host") {
      await stopHostFromMenu();
    } else if (action === "restart-host") {
      await restartHostFromMenu();
    } else if (action === "diagnostics") {
      await dialog.showMessageBox({
        type: "info",
        title: "Octant host diagnostics",
        message: formatRedactedHostDiagnostics(hostLifecycle.snapshot()),
      });
    } else if (action === "fully-quit") {
      requestInteractiveQuit();
    }
  } catch {
    dialog.showErrorBox(
      "Octant host action unavailable",
      "The selected host action was not authorized or could not be completed.",
    );
  }
}

export function resolveConfiguredServerPort(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  defaultPort = 13_773,
): number {
  const value = environment.OCTANT_SERVER_PORT;
  if (value === undefined) return defaultPort;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("OCTANT_SERVER_PORT must be an integer between 1 and 65535");
  }
  return port;
}

let hostIdentitySigningService: HostIdentitySigningService | undefined;
const HOST_IDENTITY_FINGERPRINT_PATH = "/api/desktop/private-listener/host-identity-fingerprint";

/**
 * Resolve a private listener control service bound to the owning window's
 * capability. The service drives the server-owned dual-listener lifecycle over
 * the loopback bridge; it never echoes endpoint facts through a stub.
 * A missing managed server URL fails closed as `unavailable`.
 */
function resolvePrivateListenerControlService(event: unknown): PrivateListenerControlService {
  const context = ownedWindowContext(event as IpcMainInvokeEvent);
  if (activeServerUrl === undefined) {
    throw new PrivateListenerControlFailure("unavailable");
  }
  return createPrivateListenerControlService({
    runtime: createPrivateListenerHostRuntime({
      serverUrl: activeServerUrl,
      desktopBridgeSecret,
      windowCapability: context.capability,
      fetch: globalThis.fetch,
    }),
  });
}

let ownerUnlockKeyService: OwnerUnlockKeyService | undefined;

function getOwnerUnlockKeyService(): OwnerUnlockKeyService | undefined {
  if (process.platform !== "darwin") return undefined;
  ownerUnlockKeyService ??= makeOwnerUnlockKeyService(
    resolveKeychainHelperPath({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      moduleUrl: import.meta.url,
    }),
    { storeScope: desktopHostId, serviceFamily: desktopKeychainServiceFamily },
  );
  return ownerUnlockKeyService;
}

function getHostIdentitySigningService(): HostIdentitySigningService {
  hostIdentitySigningService ??= makeHostIdentitySigningService(
    resolveDesktopNativeHelperPath(
      {
        packaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        moduleUrl: import.meta.url,
      },
      process.platform === "win32" ? WINDOWS_CREDENTIAL_HELPER_FILENAME : KEYCHAIN_HELPER_FILENAME,
    ),
    {
      ...(process.platform === "win32" ? { platform: "win32" as const } : {}),
      storeScope: desktopHostId,
      serviceFamily: desktopKeychainServiceFamily,
      expectedLegacyFingerprint: readPersistedHostIdentityFingerprint,
    },
  );
  return hostIdentitySigningService;
}

/**
 * Reads the selected store's public host-key fingerprint through the
 * authenticated local server, keeping SQLite ownership and recovery decisions
 * on the server. The native helper uses this value only as migration proof;
 * private key material never crosses this boundary.
 */
async function readPersistedHostIdentityFingerprint(): Promise<string | undefined> {
  if (activeServerUrl === undefined) {
    throw new HostIdentitySigningFailure("unavailable");
  }
  let response: Response;
  try {
    response = await fetch(new URL(HOST_IDENTITY_FINGERPRINT_PATH, activeServerUrl), {
      method: "GET",
      redirect: "error",
      headers: { "x-octant-desktop-secret": desktopBridgeSecret },
    });
  } catch {
    throw new HostIdentitySigningFailure("unavailable");
  }
  if (!response.ok) throw new HostIdentitySigningFailure("unavailable");

  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new HostIdentitySigningFailure("unavailable");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, "fingerprint")
  ) {
    throw new HostIdentitySigningFailure("unavailable");
  }
  const fingerprint = (value as { readonly fingerprint: unknown }).fingerprint;
  if (fingerprint === null) return undefined;
  if (typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new HostIdentitySigningFailure("unavailable");
  }
  return fingerprint;
}

/**
 * Each Octant window reports the threads waiting on the user; the dock badge is
 * per-application, so the counts are summed and cleared when a window closes.
 */
const attentionBadgeCounts = new Map<number, number>();

function applyAttentionBadge(): void {
  let total = 0;
  for (const count of attentionBadgeCounts.values()) total += count;
  app.dock?.setBadge(attentionBadgeLabel(total));
}

function forgetAttentionBadge(windowId: number): void {
  menuBarOpenThreads.delete(windowId);
  updateHostTray();
  if (!attentionBadgeCounts.delete(windowId)) return;
  applyAttentionBadge();
}

function installIpcHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  installCodeOperationApprovalViews();
  installProviderCredentialIpcHandlers({
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    resolveOwnedWindow: (event) => void ownedWindowContext(event as IpcMainInvokeEvent),
    store: lazyCredentialStore(),
  });
  installPrivateListenerIpcHandlers({
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    resolveOwnedWindow: (event) => void ownedWindowContext(event as IpcMainInvokeEvent),
    resolveService: (event) => resolvePrivateListenerControlService(event),
  });
  installRemoteDeviceIpcHandlers({
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    resolveOwnedWindow: (event) => void ownedWindowContext(event as IpcMainInvokeEvent),
    resolveService: (event) => {
      const context = ownedWindowContext(event as IpcMainInvokeEvent);
      if (activeServerUrl === undefined) {
        throw new RemoteDeviceControlFailure("unavailable");
      }
      return createRemoteDeviceControlService({
        runtime: createRemoteDeviceControlHttpRuntime({
          serverUrl: activeServerUrl,
          desktopBridgeSecret,
          windowCapability: context.capability,
          fetch: globalThis.fetch,
        }),
      });
    },
  });
  installOwnerUnlockIpcHandlers({
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    resolveOwnedWindow: (event) => void ownedWindowContext(event as IpcMainInvokeEvent),
    service: getOwnerUnlockKeyService,
  });
  installHubAdministrationIpcHandlers({
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    runtimeFor: (event) => {
      const context = ownedWindowContext(event as IpcMainInvokeEvent);
      if (activeServerUrl === undefined) {
        throw new HubAdministrationControlFailure("Octant hub controls are unavailable.");
      }
      return {
        serverUrl: activeServerUrl,
        desktopBridgeSecret,
        windowCapability: context.capability,
        fetch: globalThis.fetch,
      };
    },
  });
  installHostIdentityIpcHandlers({
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    resolveOwnedWindow: (event) => void ownedWindowContext(event as IpcMainInvokeEvent),
    service: getHostIdentitySigningService(),
  });
  installPairedComputerIpcHandlers({
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    resolveOwnedWindow: (event) => void ownedWindowContext(event as IpcMainInvokeEvent),
    pins: pairedComputerPins,
    serverPages: { forgetListener: (origin) => remoteServerPages().forgetListener(origin) },
    webBuildVersion: app.getVersion(),
  });
  installNativeMenuIpcHandlers({
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    resolveOwnedTopLevelWindow: (event) =>
      ownedTopLevelWindowContext(event as IpcMainInvokeEvent).window,
    popup: popupNativeMenu,
  });
  ipcMain.handle(IPC_CHANNELS.menuBarOpenThread, (event, value: unknown) => {
    const { window } = ownedTopLevelWindowContext(event);
    const thread = decodeMenuBarOpenThread(value);
    menuBarOpenThreads.set(window.id, thread);
    if (thread !== undefined) menuBarFleet.looked(thread);
    // The first report from the main window means its renderer can open a
    // thread, so a row picked while it was still loading goes to it now.
    const pending = pendingMenuBarOpen;
    if (pending !== undefined && window === mainWindow) {
      pendingMenuBarOpen = undefined;
      sendMenuBarOpen(window, pending);
    }
    updateHostTray();
  });
  ipcMain.handle(IPC_CHANNELS.attentionNotify, (event, request: unknown) => {
    const window = ownedWindow(event);
    // A focused window is already showing the thread, so a banner would only
    // repeat what the user is looking at.
    if (window.isFocused() || !Notification.isSupported()) return;
    const presentation = attentionNotificationPresentation(
      decodeAttentionNotificationRequest(request),
    );
    const notification = new Notification({
      title: presentation.title,
      body: presentation.body,
      silent: presentation.silent,
    });
    notification.on("click", () => {
      if (window.isDestroyed()) return;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    });
    notification.show();
  });
  ipcMain.handle(IPC_CHANNELS.attentionBadge, (event, value: unknown) => {
    const window = ownedWindow(event);
    const count = decodeAttentionBadgeCount(value);
    if (count === 0) attentionBadgeCounts.delete(window.id);
    else attentionBadgeCounts.set(window.id, count);
    applyAttentionBadge();
  });
  ipcMain.handle(IPC_CHANNELS.minimize, (event) => ownedWindow(event).minimize());
  ipcMain.handle(IPC_CHANNELS.openCodeExternalEditor, async (event, request: unknown) => {
    const context = ownedWindowContext(event);
    if (activeServerUrl === undefined) {
      throw new Error("Octant external editor handoff is unavailable.");
    }
    let editorRequest: CodeExternalEditorRequest;
    try {
      editorRequest = decodeCodeExternalEditorRequest(request);
    } catch {
      throw new Error("Octant rejected an invalid external editor request.");
    }
    await openCodeExternalEditorFromServer({
      serverUrl: activeServerUrl,
      brokerHeaders: desktopBrokerHeaders,
      windowId: context.windowId,
      request: editorRequest,
      fetch: globalThis.fetch,
      spawn: (executable, arguments_, options) => spawn(executable, [...arguments_], options),
    });
  });
  ipcMain.handle(IPC_CHANNELS.listOpenInApplications, () =>
    detectOpenInApplications({
      exists: existsSync,
      homeDirectory: homedir(),
      platform: process.platform,
      ...(process.env.PATH === undefined ? {} : { pathEnv: process.env.PATH }),
    }),
  );
  ipcMain.handle(IPC_CHANNELS.openCodeCheckoutInApplication, async (event, request: unknown) => {
    const context = ownedWindowContext(event);
    if (activeServerUrl === undefined) {
      throw new Error("Octant Open in is unavailable.");
    }
    let openRequest: CodeCheckoutOpenRequest;
    try {
      openRequest = decodeCodeCheckoutOpenRequest(request);
    } catch {
      throw new Error("Octant rejected an invalid Open in request.");
    }
    await openCodeCheckoutInApplicationFromServer({
      serverUrl: activeServerUrl,
      brokerHeaders: desktopBrokerHeaders,
      windowId: context.windowId,
      request: openRequest,
      fetch: globalThis.fetch,
      launch: ({ applicationId, checkoutRoot }) =>
        launchOpenInApplication({
          applicationId,
          checkoutRoot,
          exists: existsSync,
          homeDirectory: homedir(),
          platform: process.platform,
          ...(process.env.PATH === undefined ? {} : { pathEnv: process.env.PATH }),
          shell,
          spawn: (executable, arguments_, options) => spawn(executable, [...arguments_], options),
        }),
    });
  });
  const activePreviewHandoffs = new Map<string, AbortController>();
  const previewHandoffExecutor = createNativePreviewHandoffExecutor({
    shell,
    platform: process.platform,
    ...(process.env.PATH === undefined ? {} : { pathEnv: process.env.PATH }),
    exists: existsSync,
    spawn: (command, args) => spawn(command, [...args], { shell: false, stdio: "ignore" }),
  });
  ipcMain.handle(IPC_CHANNELS.previewHandoff, async (event, request: unknown) => {
    const context = ownedWindowContext(event);
    if (activeServerUrl === undefined) {
      throw new Error("Octant preview handoff is unavailable.");
    }
    let decoded: PreviewHandoffRequest;
    try {
      decoded = decodePreviewHandoffRequest(request);
    } catch {
      throw new Error("Octant rejected an invalid preview handoff request.");
    }
    const targetId = String(decoded.target.targetId);
    // A new handoff for the same target supersedes the previous one: the
    // prior Quick Look child is aborted so at most one native handoff per
    // target is ever live per window.
    const previous = activePreviewHandoffs.get(targetId);
    if (previous !== undefined) previous.abort();
    const controller = new AbortController();
    activePreviewHandoffs.set(targetId, controller);
    try {
      await openPreviewHandoffFromServer({
        serverUrl: activeServerUrl,
        brokerHeaders: desktopBrokerHeaders,
        windowId: context.windowId,
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
        fetch: globalThis.fetch,
        execute: previewHandoffExecutor,
        signal: controller.signal,
      });
    } finally {
      if (activePreviewHandoffs.get(targetId) === controller) {
        activePreviewHandoffs.delete(targetId);
      }
    }
  });
  ipcMain.handle(
    IPC_CHANNELS.requestCodeOperationApproval,
    async (event, request: unknown, requestPresentation: unknown) => {
      const context = ownedWindowContext(event);
      if (activeServerUrl === undefined) {
        throw new Error("Octant Code approval is unavailable.");
      }
      const decoded = decodeCodeOperationApprovalRequest(request);
      if (codeOperationApprovalViews === undefined) {
        throw new Error("Octant Code approval is unavailable.");
      }
      const presentation =
        requestPresentation === undefined
          ? undefined
          : decodeCodeOperationApprovalPresentation(requestPresentation);
      return await codeOperationApprovalViews.request({
        window: context.window,
        windowId: context.windowId,
        windowCapability: context.capability,
        request: decoded,
        ...(presentation === undefined ? {} : { presentation }),
      });
    },
  );
  ipcMain.handle(IPC_CHANNELS.updateCodeOperationApprovalAnchor, (event, value: unknown) => {
    const context = ownedTopLevelWindowContext(event);
    const anchor = decodeCodeOperationApprovalAnchor(value);
    codeOperationApprovalViews?.updateAnchor({
      window: context.window,
      windowId: context.windowId,
      anchor,
    });
  });
  ipcMain.handle(IPC_CHANNELS.cancelCodeOperationApproval, (event) => {
    const context = ownedTopLevelWindowContext(event);
    codeOperationApprovalViews?.cancel(context.windowId);
  });
  ipcMain.handle(CODE_OPERATION_APPROVAL_VIEW_CHANNELS.decision, async (event, value: unknown) => {
    if (codeOperationApprovalViews === undefined) return undefined;
    const decision = decodeCodeOperationApprovalViewDecision(value);
    return await codeOperationApprovalViews.decision({
      senderId: event.sender.id,
      ...decision,
    });
  });
  ipcMain.handle(IPC_CHANNELS.maximizeOrRestore, (event) => {
    const window = ownedWindow(event);
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });
  ipcMain.handle(IPC_CHANNELS.close, (event) => ownedWindow(event).close());
  ipcMain.handle(
    IPC_CHANNELS.projectWindowCapability,
    (event) => ownedTopLevelWindowContext(event).capability,
  );
  ipcMain.handle(IPC_CHANNELS.openInNewWindow, async (event, value: unknown) => {
    ownedWindowContext(event);
    await openSecondaryProjectWindow(validateProjectWindowTarget(value));
  });
  ipcMain.handle(IPC_CHANNELS.hostCapabilities, (event) => {
    ownedWindow(event);
    return resolveDesktopHostCapabilities(process.platform, browserRuntimeBroker !== undefined);
  });
  ipcMain.handle(IPC_CHANNELS.browserSurfaceAttach, (event, value: unknown) => {
    const context = ownedTopLevelWindowContext(event);
    const request = validateBrowserSurfaceRequest(value);
    validateBrowserSurfaceBounds(request.bounds, context.window);
    if (browserSurfaceHost === undefined || browserRuntimeBroker === undefined) {
      throw new Error("Octant live Browser is unavailable.");
    }
    return browserSurfaceHost.attach(
      request.contextId,
      { windowId: context.windowId, threadId: request.threadId },
      context.window as unknown as import("./browserSurfaceHost").BrowserSurfaceShellWindowPort,
      request.bounds,
    );
  });
  ipcMain.handle(IPC_CHANNELS.browserSurfaceBounds, (event, value: unknown) => {
    const context = ownedTopLevelWindowContext(event);
    const request = validateBrowserSurfaceRequest(value);
    validateBrowserSurfaceBounds(request.bounds, context.window);
    browserSurfaceHost?.updateBounds(
      request.contextId,
      { windowId: context.windowId, threadId: request.threadId },
      request.bounds,
    );
  });
  ipcMain.handle(IPC_CHANNELS.browserSurfaceDetach, (event, value: unknown) => {
    const context = ownedTopLevelWindowContext(event);
    const request = validateBrowserSurfaceIdentity(value);
    browserSurfaceHost?.detach(request.contextId, {
      windowId: context.windowId,
      threadId: request.threadId,
    });
  });
  ipcMain.handle(IPC_CHANNELS.browserSurfaceCommand, async (event, value: unknown) => {
    const context = ownedTopLevelWindowContext(event);
    const request = validateBrowserSurfaceCommand(value);
    await browserSurfaceHost?.command(
      request.contextId,
      { windowId: context.windowId, threadId: request.threadId },
      request.command,
    );
    return { windowId: context.windowId };
  });
  ipcMain.handle(IPC_CHANNELS.browserSurfaceTab, async (event, value: unknown) => {
    const context = ownedTopLevelWindowContext(event);
    const request = validateBrowserSurfaceTabCommand(value);
    if (browserSurfaceHost === undefined) throw new Error("Octant live Browser is unavailable.");
    return await browserSurfaceHost.tabCommand(
      request.contextId,
      { windowId: context.windowId, threadId: request.threadId },
      request.command,
    );
  });
  ipcMain.handle(IPC_CHANNELS.browserExtensionPopupOpen, async (event, value: unknown) => {
    const context = ownedTopLevelWindowContext(event);
    const request = validateExtensionPopupRequest(value);
    const bounds = fitPopupBounds(request.anchor, request.size, context.window.getContentBounds());
    validateBrowserSurfaceBounds(bounds, context.window);
    if (browserExtensionPopupHost === undefined) return { opened: false };
    const profile = decodeStoredBrowserProfile(request.profile);
    browserExtensionBridge?.useWindow(profile, context.windowId);
    const shown = await browserExtensionPopupHost.open({
      windowId: context.windowId,
      window: popupWindowOf(context.window),
      profile,
      extensionId: request.extensionId,
      kind: request.kind,
      bounds,
    });
    if (shown.opened || request.kind !== "popup" || browserExtensionBridge === undefined) {
      return shown;
    }
    // No popup page: the click is the extension's own `action.onClicked`.
    return {
      opened: await browserExtensionBridge.clickAction(
        profile,
        context.windowId,
        request.extensionId,
      ),
    };
  });
  ipcMain.handle(IPC_CHANNELS.browserExtensionTabs, async (event, request: unknown) => {
    const popup =
      event.senderFrame === event.sender.mainFrame
        ? browserExtensionPopupHost?.contextOf(event.sender.id)
        : undefined;
    return (
      (await browserExtensionBridge?.answerPopup(popup, event.senderFrame?.url ?? "", request)) ?? {
        ok: false,
        error: "Octant extensions are unavailable.",
      }
    );
  });
  ipcMain.handle(IPC_CHANNELS.browserExtensionPopupClose, (event) => {
    const context = ownedTopLevelWindowContext(event);
    browserExtensionPopupHost?.close(context.windowId);
  });
  ipcMain.handle(IPC_CHANNELS.computerUseStatus, async (event) => {
    ownedTopLevelWindowContext(event);
    if (computerUseService === undefined)
      return {
        supported: false,
        enabled: false,
        automaticUpdates: false,
        permissions: { accessibility: false, screenRecording: false },
        driver: "unavailable",
        activeSessions: 0,
        update: "idle",
        message: "Computer use requires a host owned by this Octant desktop app.",
      };
    return computerUseService.status();
  });
  ipcMain.handle(IPC_CHANNELS.computerUsePermissions, async (event) => {
    ownedTopLevelWindowContext(event);
    if (computerUseService === undefined)
      throw new Error("Computer use is unavailable for this host.");
    return computerUseService.requestPermissions();
  });
  ipcMain.handle(IPC_CHANNELS.computerUsePermissionSettings, async (event) => {
    ownedTopLevelWindowContext(event);
    if (computerUseService === undefined)
      throw new Error("Computer use is unavailable for this host.");
    await computerUseService.openPermissionSettings();
  });
  ipcMain.handle(IPC_CHANNELS.computerUseCheckUpdates, async (event) => {
    ownedTopLevelWindowContext(event);
    if (computerUseService === undefined)
      throw new Error("Computer use is unavailable for this host.");
    return computerUseService.checkUpdates();
  });
  ipcMain.handle(IPC_CHANNELS.managedToolsStatus, async (event) => {
    ownedTopLevelWindowContext(event);
    if (managedToolService === undefined)
      return {
        supported: false,
        automaticUpdates: false,
        tools: [],
        message: "Managed tools require a host owned by this Octant desktop app.",
      };
    return managedToolService.status();
  });
  ipcMain.handle(IPC_CHANNELS.managedToolsCheckUpdates, async (event, tool: unknown) => {
    ownedTopLevelWindowContext(event);
    if (managedToolService === undefined)
      throw new Error("Managed tools are unavailable for this host.");
    if (tool !== undefined && typeof tool !== "string")
      throw new TypeError("Invalid managed tool.");
    return managedToolService.checkUpdates(tool);
  });
  ipcMain.handle(IPC_CHANNELS.managedToolsConfigure, async (event, settings) => {
    ownedTopLevelWindowContext(event);
    if (managedToolService === undefined)
      throw new Error("Managed tools are unavailable for this host.");
    if (
      typeof settings !== "object" ||
      settings === null ||
      typeof (settings as { automaticUpdates?: unknown }).automaticUpdates !== "boolean"
    )
      throw new TypeError("Invalid managed tools settings.");
    await managedToolService.configure({
      automaticUpdates: (settings as { automaticUpdates: boolean }).automaticUpdates,
    });
    return managedToolService.status();
  });
  ipcMain.handle(IPC_CHANNELS.appUpdateState, (event) => {
    ownedTopLevelWindowContext(event);
    return appUpdates().state();
  });
  ipcMain.handle(IPC_CHANNELS.appUpdateCheck, async (event) => {
    ownedTopLevelWindowContext(event);
    return await appUpdates().check();
  });
  ipcMain.handle(IPC_CHANNELS.appUpdateDownload, async (event) => {
    ownedTopLevelWindowContext(event);
    return await appUpdates().download();
  });
  ipcMain.handle(IPC_CHANNELS.appUpdateInstall, async (event) => {
    ownedTopLevelWindowContext(event);
    // Read freshly here rather than taken from the renderer or a cached poll:
    // this is the same activity the quit guard trusts to decide whether
    // stopping would interrupt something, and a second notion of "busy" would
    // disagree with it exactly when it mattered. `workInFlight` is that shared
    // reading; the host's `attentionRequired` is not, because a provider that
    // only needs sign-in sets it with nothing running.
    return appUpdates().install(
      await workInFlight({
        refreshActivity: refreshHostActivity,
        snapshot: hostLifecycle.snapshot,
      }),
    );
  });
  ipcMain.handle(IPC_CHANNELS.appUpdateAutomatic, (event, value: unknown) => {
    ownedTopLevelWindowContext(event);
    if (typeof value !== "boolean") throw new Error("Octant rejected an invalid update setting.");
    return appUpdates().setAutomaticChecks(value);
  });
  ipcMain.handle(IPC_CHANNELS.appUpdateRing, (event, value: unknown) => {
    ownedTopLevelWindowContext(event);
    // Checked against the known rings rather than passed through: the ring
    // becomes a path segment in the feed address, so an unchecked string from
    // the renderer would be choosing where the host makes its next request.
    if (!isAppReleaseRing(value)) throw new Error("Octant rejected an unknown release ring.");
    return appUpdates().setRing(value);
  });
  // The renderer only asks. Each request carries nothing: the install
  // location, the feed and the ring are main's own, never a caller's choice.
  for (const [channel, request] of [
    [IPC_CHANNELS.nightlyInstallState, () => nightlyInstaller().state()],
    [IPC_CHANNELS.nightlyInstall, () => nightlyInstaller().install()],
    [IPC_CHANNELS.nightlyInstallOpen, () => nightlyInstaller().open()],
    [IPC_CHANNELS.nightlyInstallRemove, () => nightlyInstaller().remove()],
  ] as const) {
    ipcMain.handle(channel, (event, ...rest: ReadonlyArray<unknown>) => {
      ownedTopLevelWindowContext(event);
      if (rest.length !== 0) throw new Error("Octant rejected an Octant Nightly request.");
      return request();
    });
  }
  // Nightly's test host keeps its Data setting here; the choice, relaunch and
  // removal requests carry nothing but the fixed choice values.
  if (nightlyDataControl !== undefined) {
    const data = nightlyDataControl;
    for (const [channel, request] of [
      [IPC_CHANNELS.nightlyDataState, () => data.state()],
      [IPC_CHANNELS.nightlyDataRemove, () => data.remove()],
      [IPC_CHANNELS.nightlyDataRelaunch, () => data.relaunch()],
    ] as const) {
      ipcMain.handle(channel, (event, ...rest: ReadonlyArray<unknown>) => {
        ownedTopLevelWindowContext(event);
        if (rest.length !== 0) throw new Error("Octant Nightly rejected a Data request.");
        return request();
      });
    }
    ipcMain.handle(IPC_CHANNELS.nightlyDataChoose, (event, value: unknown) => {
      ownedTopLevelWindowContext(event);
      return data.choose(value);
    });
  }
  ipcMain.handle(IPC_CHANNELS.appUpdateWhatsNew, async (event) => {
    ownedTopLevelWindowContext(event);
    return await loadBundledWhatsNew(bundledWhatsNewOptions());
  });
  ipcMain.handle(IPC_CHANNELS.appUpdateWhatsNewAck, async (event) => {
    ownedTopLevelWindowContext(event);
    const options = bundledWhatsNewOptions();
    await acknowledgeWhatsNew({
      currentVersion: options.currentVersion,
      statePath: options.statePath,
      writeFile: options.writeFile,
    });
  });
  ipcMain.handle(IPC_CHANNELS.remoteServerPageOpen, async (event, value: unknown) => {
    ownedTopLevelWindowContext(event);
    const request = validateRemoteServerPageOpenRequest(value);
    const signer = event.sender;
    if (!remoteServerPageSigners.has(signer.id)) {
      remoteServerPageSigners.set(signer.id, signer);
      const signerId = signer.id;
      signer.once("destroyed", () => {
        remoteServerPageSigners.delete(signerId);
        remoteServerPages().windowClosed(signerId);
      });
    }
    return await remoteServerPages().open(signer.id, request);
  });
  ipcMain.handle(IPC_CHANNELS.remoteServerPageForgetHost, async (event, hostId: unknown) => {
    ownedTopLevelWindowContext(event);
    if (typeof hostId !== "string" || !UUID_PATTERN.test(hostId)) {
      throw new Error("Octant rejected an invalid request to forget a host's pages.");
    }
    return await remoteServerPages().forgetHost(hostId);
  });
  ipcMain.handle(IPC_CHANNELS.remoteServerPageSigned, (event, value: unknown) => {
    ownedTopLevelWindowContext(event);
    if (typeof value !== "object" || value === null) return;
    const answer = value as { readonly requestId?: unknown; readonly signing?: unknown };
    remoteServerPages().answer(event.sender.id, answer.requestId, answer.signing);
  });
  ipcMain.handle(IPC_CHANNELS.browserSurfaceOpenExternal, async (event, value: unknown) => {
    ownedTopLevelWindowContext(event);
    await shell.openExternal(validateExternalBrowserUrl(value));
  });
  ipcMain.handle(IPC_CHANNELS.canvasPrototypeSurface, async (event) => {
    ownedTopLevelWindowContext(event);
    return await desktopCanvasPrototypeSurface().prepare(canvasPrototypeOwner(event.sender));
  });
  ipcMain.handle(IPC_CHANNELS.canvasPrototypeOpen, async (event, request: unknown) => {
    ownedTopLevelWindowContext(event);
    return await desktopCanvasPrototypeSurface().open(canvasPrototypeOwner(event.sender), request);
  });
  ipcMain.handle(IPC_CHANNELS.canvasPrototypeClose, (event, surfaceId: unknown) => {
    ownedTopLevelWindowContext(event);
    canvasPrototypeSurface?.close(canvasPrototypeOwner(event.sender), surfaceId);
  });
  ipcMain.handle(IPC_CHANNELS.canvasPrototypeDrawn, (event, surfaceId: unknown) => {
    ownedTopLevelWindowContext(event);
    canvasPrototypeSurface?.drawn(canvasPrototypeOwner(event.sender), surfaceId);
  });
  ipcMain.handle(IPC_CHANNELS.canvasPrototypeInput, (event, surfaceId: unknown, input: unknown) => {
    ownedTopLevelWindowContext(event);
    canvasPrototypeSurface?.input(canvasPrototypeOwner(event.sender), surfaceId, input);
  });
  ipcMain.handle(
    IPC_CHANNELS.canvasPrototypeResize,
    (event, surfaceId: unknown, width: unknown, height: unknown) => {
      ownedTopLevelWindowContext(event);
      canvasPrototypeSurface?.resize(canvasPrototypeOwner(event.sender), surfaceId, width, height);
    },
  );
  ipcMain.handle(IPC_CHANNELS.resetBounds, async (event) => {
    const context = ownedWindowContext(event);
    const window = context.window;
    const state = centeredNativeWindowState(
      screen.getAllDisplays().map(({ workArea }) => workArea),
      context.windowId,
    );
    if (window.isMaximized()) window.unmaximize();
    window.setBounds(state.bounds);
    if (context.primary && nativeStateStore !== undefined) await nativeStateStore.save(state);
  });
  ipcMain.handle(IPC_CHANNELS.selectProjectRoot, async (event, projectType: unknown) => {
    return await ownedWindowContext(event).picker(event, projectType);
  });
  ipcMain.handle(IPC_CHANNELS.selectLocalPluginFolder, async (event) => {
    return await ownedWindowContext(event).localPluginFolderPicker(event);
  });
  ipcMain.handle(IPC_CHANNELS.selectSkillFolder, async (event) => {
    return await ownedWindowContext(event).localPluginFolderPicker(event, "skill-folder");
  });
  // Window capture for the composer. Each step re-checks that the caller is
  // this app's own top-level window; the renderer never names a screen or a
  // file, only a window id the list just returned.
  const windowCapture = createWindowCapture({
    platform: process.platform,
    screenAccess: () => systemPreferences.getMediaAccessStatus("screen"),
    // Zero-size thumbnails: titles and ids only. A non-zero size would make
    // Electron read every open window's pixels, not just the chosen one's.
    windowSources: async () =>
      await desktopCapturer.getSources({
        types: ["window"],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: false,
      }),
    grabFrame: grabWindowFrame,
    openScreenRecordingSettings: () =>
      shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
      ),
  });
  ipcMain.handle(IPC_CHANNELS.windowCaptureList, async (event) => {
    ownedTopLevelWindowContext(event);
    return await windowCapture.list();
  });
  ipcMain.handle(IPC_CHANNELS.windowCapturePermission, async (event) => {
    ownedTopLevelWindowContext(event);
    return await windowCapture.requestPermission();
  });
  ipcMain.handle(IPC_CHANNELS.windowCaptureTake, async (event, windowId: unknown) => {
    ownedTopLevelWindowContext(event);
    if (typeof windowId !== "string" || windowId.length === 0 || windowId.length > 256)
      throw new Error("Octant rejected an invalid window to capture.");
    return await windowCapture.capture(windowId);
  });
  ipcMain.handle(IPC_CHANNELS.selectRuntimeBinary, async (event) => {
    return await ownedWindowContext(event).runtimeBinaryPicker(event);
  });
  ipcMain.handle(IPC_CHANNELS.saveSupportBundle, async (event) => {
    return await ownedWindowContext(event).supportBundleSaver(event);
  });
  ipcMain.handle(IPC_CHANNELS.saveBrowserProofScreenshots, async (event, pictures: unknown) => {
    return await ownedWindowContext(event).browserProofSaver(event, pictures);
  });
  ipcMain.handle(IPC_CHANNELS.sidebarMaterialPreference, (event, preference: unknown) => {
    const context = ownedWindowContext(event);
    if (preference !== "opaque" && preference !== "system") {
      throw new Error("Octant rejected an invalid sidebar material preference.");
    }
    context.presentationController.update({ sidebarMaterial: preference });
  });
  ipcMain.handle(IPC_CHANNELS.sidebarVibrancyMode, (event, mode: unknown) => {
    const context = ownedWindowContext(event);
    if (mode !== "off" && mode !== "subtle" && mode !== "strong") {
      throw new Error("Octant rejected an invalid sidebar vibrancy mode.");
    }
    context.presentationController.update({ sidebarVibrancyMode: mode });
  });
  ipcMain.handle(IPC_CHANNELS.approvalSurfacePalette, (event, palette: unknown) => {
    const context = ownedWindowContext(event);
    const decoded = decodeCodeOperationApprovalPalette(palette);
    // An unreadable palette must not block an approval: the view keeps
    // drawing the system palette it falls back to.
    if (decoded === undefined) return;
    approvalPalettesByWindow.set(context.windowId, decoded);
  });
}

interface BrowserSurfaceIdentityRequest {
  readonly contextId: string;
  readonly threadId: string;
}

interface BrowserSurfaceRequest extends BrowserSurfaceIdentityRequest {
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

function validateBrowserSurfaceIdentity(value: unknown): BrowserSurfaceIdentityRequest {
  if (!isStrictRecord(value, ["contextId", "threadId"])) {
    throw new Error("Octant rejected an invalid Browser surface request.");
  }
  if (
    !PROVIDER_INSTANCE_ID_PATTERN.test(String(value.contextId)) ||
    !PROVIDER_INSTANCE_ID_PATTERN.test(String(value.threadId))
  ) {
    throw new Error("Octant rejected an invalid Browser surface request.");
  }
  return { contextId: String(value.contextId), threadId: String(value.threadId) };
}

function validateBrowserSurfaceRequest(value: unknown): BrowserSurfaceRequest {
  if (
    !isStrictRecord(value, ["bounds", "contextId", "threadId"]) ||
    !isStrictRecord(value.bounds, ["height", "width", "x", "y"])
  ) {
    throw new Error("Octant rejected an invalid Browser surface request.");
  }
  const identity = validateBrowserSurfaceIdentity({
    contextId: value.contextId,
    threadId: value.threadId,
  });
  const bounds = value.bounds;
  if (
    ![bounds.x, bounds.y, bounds.width, bounds.height].every(
      (entry) => typeof entry === "number" && Number.isFinite(entry),
    )
  ) {
    throw new Error("Octant rejected invalid Browser surface bounds.");
  }
  return { ...identity, bounds: bounds as BrowserSurfaceRequest["bounds"] };
}

function validateBrowserSurfaceCommand(value: unknown): BrowserSurfaceIdentityRequest & {
  readonly command: "back" | "forward" | "reload" | "stop";
} {
  if (!isStrictRecord(value, ["command", "contextId", "threadId"])) {
    throw new Error("Octant rejected an invalid Browser surface command.");
  }
  const identity = validateBrowserSurfaceIdentity({
    contextId: value.contextId,
    threadId: value.threadId,
  });
  if (!["back", "forward", "reload", "stop"].includes(String(value.command))) {
    throw new Error("Octant rejected an invalid Browser surface command.");
  }
  return { ...identity, command: value.command as "back" | "forward" | "reload" | "stop" };
}

function validateBrowserSurfaceTabCommand(
  value: unknown,
): BrowserSurfaceIdentityRequest & { readonly command: BrowserSurfaceTabCommand } {
  if (!isStrictRecord(value, ["command", "contextId", "threadId"])) {
    throw new Error("Octant rejected an invalid Browser tab command.");
  }
  const identity = validateBrowserSurfaceIdentity({
    contextId: value.contextId,
    threadId: value.threadId,
  });
  const command = value.command;
  if (!isStrictRecord(command, ["kind"]) && !isStrictRecord(command, ["kind", "tabId"])) {
    throw new Error("Octant rejected an invalid Browser tab command.");
  }
  if (command.kind === "open") return { ...identity, command: { kind: "open" } };
  if (
    (command.kind !== "select" && command.kind !== "close") ||
    typeof command.tabId !== "string" ||
    command.tabId.length === 0 ||
    command.tabId.length > 64
  ) {
    throw new Error("Octant rejected an invalid Browser tab command.");
  }
  return { ...identity, command: { kind: command.kind, tabId: command.tabId } };
}

/**
 * The one update service this app runs.
 *
 * Built from what the running app actually is — `app.getVersion()` rather than
 * a constant a build could forget to bump — so the version the updater compares
 * against the feed is the version on disk.
 */
function bundledWhatsNewOptions(): {
  readonly currentVersion: string;
  readonly notesPath: string;
  readonly statePath: string;
  readonly readFile: (path: string) => Promise<string>;
  readonly writeFile: (path: string, contents: string) => Promise<void>;
} {
  const statePath = resolveWhatsNewStatePath(app.getPath("userData"));
  return {
    currentVersion: app.getVersion(),
    notesPath: resolveBundledWhatsNewPath({
      packaged: app.isPackaged,
      appPath: app.getAppPath(),
      moduleUrl: import.meta.url,
    }),
    statePath,
    readFile: (path) => readFile(path, "utf8"),
    writeFile: async (path, contents) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents, "utf8");
    },
  };
}

/**
 * The ring a packaged build follows before the person's choice arrives: the
 * one its version was built on. An Octant installed from a candidate build
 * would otherwise start on Stable and see nothing until the next stable
 * release; a version outside this app's rings falls back to its default.
 */
function packagedUpdateRing(): (typeof applicationIdentity.rings)[number] {
  const built = ringForVersion(app.getVersion() as AppVersion);
  return (
    applicationIdentity.rings.find((ring) => ring === built) ?? applicationIdentity.defaultRing
  );
}

function appUpdates(): ReturnType<typeof createAppUpdateService> {
  appUpdateService ??= createAppUpdateService({
    updater: electronAutoUpdater,
    portableImage: createPortableImagePort({ quit: () => app.quit() }),
    feedBaseUrl: resolveUpdateFeedBaseUrl(process.env),
    app: {
      version: app.getVersion() as AppVersion,
      platform: process.platform,
      arch: process.arch,
      product: applicationIdentity.updateProduct,
    },
    ...(app.isPackaged
      ? { ring: packagedUpdateRing(), allowedRings: applicationIdentity.rings }
      : {}),
    // Starts off, and stays off until the renderer reports the persisted
    // preference. A default of "on" would mean a host that had been told not to
    // check still checked once on every launch, in the window before the
    // setting was read — which is exactly what the switch promises it does not
    // do.
    automaticChecks: false,
    onState: (state) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.appUpdateState, state);
      }
    },
  });
  return appUpdateService;
}

function nightlyInstaller(): ReturnType<typeof createNightlyInstaller> {
  nightlyInstallerInstance ??= createNightlyInstaller({
    role: () => ({
      packaged: app.isPackaged,
      flavor: applicationIdentity.flavor,
      platform: process.platform,
      ring: appUpdates().state().ring,
    }),
    executablePath: process.execPath,
    feedBaseUrl: resolveUpdateFeedBaseUrl(process.env),
    app: {
      version: app.getVersion() as AppVersion,
      platform: process.platform,
      arch: process.arch,
    },
    temporaryDirectory: app.getPath("temp"),
    // The same signed native component that already authenticates Nightly
    // peers; it is absent outside packaged macOS, which refuses the check.
    native: () =>
      loadDesktopPeerStatus({
        packaged: app.isPackaged,
        platform: process.platform,
        resourcesPath: process.resourcesPath,
      }),
    trash: (path) => shell.trashItem(path),
  });
  return nightlyInstallerInstance;
}

function validateBrowserSurfaceBounds(
  bounds: BrowserSurfaceRequest["bounds"],
  window: BrowserWindow,
): void {
  const content = window.getContentBounds();
  if (
    bounds.x < 0 ||
    bounds.y < 36 ||
    bounds.width < 1 ||
    bounds.height < 1 ||
    bounds.x + bounds.width > content.width ||
    bounds.y + bounds.height > content.height
  ) {
    throw new Error("Octant rejected Browser surface bounds outside the owning window.");
  }
}

function isStrictRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value as object)
      .sort()
      .join("\0") === [...keys].sort().join("\0")
  );
}

function ownedWindow(event: IpcMainInvokeEvent): BrowserWindow {
  return ownedWindowContext(event).window;
}

// The windows that opened a page of another computer, which sign its requests.
const remoteServerPageSigners = new Map<number, Electron.WebContents>();
// Octant's browser windows for opened pages, by page name, and the origin each
// name is served at now (the forwarder's port is part of it).
const remoteServerPageWindows = new Map<string, BrowserWindow>();
const remoteServerPageOrigins = new Map<string, string>();
let remoteServerPagesInstance: RemoteServerPages | undefined;

function remoteServerPages(): RemoteServerPages {
  remoteServerPagesInstance ??= createRemoteServerPages({
    readRecordedPort: () => readRecordedForwarderPort(app.getPath("userData")),
    recordPort: (port) => recordForwarderPort(app.getPath("userData"), port),
    askWindowToSign: (windowId, requestId, request) => {
      const signer = remoteServerPageSigners.get(windowId);
      if (signer === undefined || signer.isDestroyed()) return false;
      signer.send(IPC_CHANNELS.remoteServerPageSign, { requestId, request });
      return true;
    },
    readPageRecords: () => readRecordedRemotePages(app.getPath("userData")),
    writePageRecords: (pages) => recordRemotePages(app.getPath("userData"), pages),
    closePageWindow: closeRemoteServerPageWindow,
    pageStorage: remoteServerPageStorage,
    showInOctantBrowser: showRemoteServerPage,
    openExternal: (url) => shell.openExternal(url),
    pairedTrust: (listenerOrigin) => {
      const pin = pairedComputerPins().pinFor(listenerOrigin);
      return pin === undefined ? undefined : { current: { kind: "pinned", pin } };
    },
  });
  return remoteServerPagesInstance;
}

function remoteServerPagePartition(name: string): string {
  return `persist:octant-remote-page-${name}`;
}

function closeRemoteServerPageWindow(name: string): void {
  const window = remoteServerPageWindows.get(name);
  remoteServerPageWindows.delete(name);
  remoteServerPageOrigins.delete(name);
  if (window !== undefined && !window.isDestroyed()) window.destroy();
}

function remoteServerPageStorage(name: string): PageStoragePort {
  const pageSession = session.fromPartition(remoteServerPagePartition(name));
  return {
    // The whole partition, not one origin: the forwarder's port may have moved.
    clearStorageData: () => pageSession.clearStorageData(),
    clearCache: () => pageSession.clearCache(),
    clearAuthCache: () => pageSession.clearAuthCache(),
  };
}

/**
 * Octant's browser for an opened page: a window of its own in a persistent
 * partition per page name, which only the person drives. It adds the page's
 * secret to requests for the page's exact origin, keeps navigation on that
 * origin, sends other links to the default browser, and grants no permission.
 */
function showRemoteServerPage(page: { readonly name: string; readonly pageOrigin: string }): void {
  remoteServerPageOrigins.set(page.name, page.pageOrigin);
  const existing = remoteServerPageWindows.get(page.name);
  if (existing !== undefined && !existing.isDestroyed()) {
    void existing.loadURL(`${page.pageOrigin}/`);
    existing.show();
    existing.focus();
    return;
  }
  const partition = remoteServerPagePartition(page.name);
  const pageSession = session.fromPartition(partition);
  const currentOrigin = () => remoteServerPageOrigins.get(page.name) ?? page.pageOrigin;
  pageSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  pageSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const header = pageAccessHeader(details.url, currentOrigin(), (origin) =>
      remoteServerPages().accessFor(origin),
    );
    callback({
      requestHeaders:
        header === undefined
          ? details.requestHeaders
          : { ...details.requestHeaders, [header.name]: header.value },
    });
  });
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    title: page.name,
    webPreferences: {
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (pageNavigation(url, currentOrigin()) === "external") void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    const decision = pageNavigation(url, currentOrigin());
    if (decision === "stay") return;
    event.preventDefault();
    if (decision === "external") void shell.openExternal(url);
  });
  window.on("closed", () => remoteServerPageWindows.delete(page.name));
  remoteServerPageWindows.set(page.name, window);
  void window.loadURL(`${page.pageOrigin}/`);
}

function ownedWindowContext(
  event: IpcMainInvokeEvent,
): Readonly<DesktopWindowContext & { readonly window: BrowserWindow }> {
  const window = BrowserWindow.fromWebContents(event.sender);
  const context = desktopWindows.resolve(window);
  if (
    !createRendererNavigationPolicy(rendererNavigationPolicyOptions()).allows(
      event.senderFrame?.url ?? "",
    )
  ) {
    throw new Error("Octant rejected an IPC request from an untrusted renderer origin.");
  }
  return context;
}

function ownedTopLevelWindowContext(
  event: IpcMainInvokeEvent,
): Readonly<DesktopWindowContext & { readonly window: BrowserWindow }> {
  const context = ownedWindowContext(event);
  if (event.senderFrame !== context.window.webContents.mainFrame) {
    throw new Error("Octant rejected a non-top-level Browser surface request.");
  }
  const senderUrl = event.senderFrame.url;
  const developmentUrl = process.env.OCTANT_WEB_URL;
  const allowed =
    developmentUrl === undefined
      ? isPackagedRendererUrl(senderUrl)
      : safeOrigin(senderUrl) === safeOrigin(developmentUrl);
  if (!allowed) throw new Error("Octant rejected an unexpected Browser surface origin.");
  return context;
}

function isPackagedRendererUrl(value: string): boolean {
  return createRendererNavigationPolicy({
    packagedRendererPath: resolve(repositoryRoot(), "apps/web/dist/index.html"),
  }).allows(value);
}

function rendererNavigationPolicyOptions() {
  return {
    developmentUrl: process.env.OCTANT_WEB_URL,
    packagedRendererPath: resolve(repositoryRoot(), "apps/web/dist/index.html"),
  } as const;
}

/** The window's own contents, as the Canvas frame guard sees them. */
function canvasFrameGuardWebContents(window: BrowserWindow): CanvasFrameGuardWebContentsPort {
  const contents = window.webContents;
  return {
    onFrameNavigate: (listener) => {
      contents.on("will-frame-navigate", (details) => {
        listener({
          url: details.url,
          isMainFrame: details.isMainFrame,
          preventDefault: () => details.preventDefault(),
        });
      });
    },
    setWebRTCIPHandlingPolicy: (policy) => contents.setWebRTCIPHandlingPolicy(policy),
  };
}

/**
 * The prototype host, started when the first window prepares it. The packaged
 * app always runs its own entry, so the host is the same executable started
 * with the host's switch; unpackaged, Electron is told which entry to run.
 */
function desktopCanvasPrototypeSurface(): CanvasPrototypeSurface {
  if (canvasPrototypeSurface !== undefined) return canvasPrototypeSurface;
  const entry = fileURLToPath(new URL("./entry.mjs", import.meta.url));
  const surface = createCanvasPrototypeSurface({
    launchHost: () =>
      spawnCanvasPrototypeHost({
        executable: process.execPath,
        args: app.isPackaged
          ? [CANVAS_PROTOTYPE_HOST_SWITCH]
          : [entry, CANVAS_PROTOTYPE_HOST_SWITCH],
      }),
    serverUrl: () => activeServerUrl,
    fetch: globalThis.fetch,
    platform: process.platform,
  });
  app.on("will-quit", () => surface.stop());
  canvasPrototypeSurface = surface;
  return surface;
}

/** The window that sent a prototype request, which alone hears that prototype's events. */
function canvasPrototypeOwner(sender: WebContents): CanvasPrototypeOwner {
  return {
    id: sender.id,
    send: (event) => {
      if (!sender.isDestroyed()) sender.send(IPC_CHANNELS.canvasPrototypeEvent, event);
    },
  };
}

function canvasPrototypeOwnerContents(window: BrowserWindow): CanvasPrototypeOwnerContentsPort {
  const contents = window.webContents;
  return {
    id: contents.id,
    onNavigation: (listener) =>
      contents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) =>
        listener({ isMainFrame, isInPlace }),
      ),
    onRendererGone: (listener) => contents.on("render-process-gone", () => listener()),
    onDestroyed: (listener) => {
      contents.once("destroyed", listener);
      window.once("closed", listener);
    },
  };
}

function rendererNavigationWebContents(window: BrowserWindow): RendererNavigationWebContentsPort {
  return {
    on: (event, listener) => {
      if (event === "will-navigate") {
        window.webContents.on("will-navigate", (nativeEvent) => {
          listener(nativeEvent, { url: nativeEvent.url });
        });
      } else {
        window.webContents.on("will-redirect", (nativeEvent) => {
          listener(nativeEvent, { url: nativeEvent.url });
        });
      }
    },
    setWindowOpenHandler: (handler) => window.webContents.setWindowOpenHandler(handler),
  };
}

function safeOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

async function flushWindowState(): Promise<void> {
  if (
    mainWindow === undefined ||
    mainWindow.isDestroyed() ||
    nativeStateStore === undefined ||
    stableWindowId === undefined
  ) {
    return;
  }
  await flushNativeWindowState(mainWindow, stableWindowId, nativeStateStore);
}

async function closeLocalWindowsForRetainedHost(): Promise<"closed" | "failed"> {
  await saveWindowStateWithoutBlocking({ flushWindowState, log: logQuitProblem });
  const outcomes = await Promise.all(
    desktopWindows.active().map(
      ({ window }) =>
        new Promise<boolean>((resolveClosed) => {
          let settled = false;
          const finish = (didClose: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            window.removeListener("closed", closed);
            resolveClosed(didClose);
          };
          const closed = () => finish(true);
          const timer = setTimeout(() => finish(window.isDestroyed()), WINDOW_CLOSE_GRACE_MS);
          window.once("closed", closed);
          try {
            window.close();
          } catch {
            finish(false);
          }
        }),
    ),
  );
  return outcomes.every(Boolean) ? "closed" : "failed";
}

async function shutdownSecondaryProjectWindows(): Promise<void> {
  const lifecycles = [...secondaryWindowLifecycles];
  await Promise.all(lifecycles.map((lifecycle) => lifecycle.shutdown(async () => undefined)));
  for (const lifecycle of lifecycles) secondaryWindowLifecycles.delete(lifecycle);
}

async function confirmQuitWithActiveWork(
  snapshot: ReturnType<typeof hostLifecycle.snapshot>,
): Promise<boolean> {
  const copy = buildQuitConfirmation(snapshot);
  const options = {
    type: "warning" as const,
    ...copy,
    buttons: [...copy.buttons],
  };
  const result =
    mainWindow === undefined
      ? await dialog.showMessageBox(options)
      : await dialog.showMessageBox(mainWindow, options);
  return result.response === 1;
}

function logQuitProblem(message: string): void {
  try {
    process.stderr.write(`${message}\n`);
  } catch {
    // Nothing is left to report to when stderr is closed.
  }
}

// Ends the app when graceful shutdown stalls. It first kills the processes the
// current launch owns, including acquisitions completed after quit acceptance.
// Failed cleanup keeps that owner reachable until the deadline fires.
function forceExitAfterStalledQuit(): () => void {
  let exiting = false;
  return () => {
    if (exiting) return;
    exiting = true;
    logQuitProblem("Octant quit did not finish in time; ending the application.");
    desktopHostLaunch?.forceStop();
    if (acceptedQuitLaunch !== desktopHostLaunch) acceptedQuitLaunch?.forceStop();
    app.exit(0);
  };
}

let desktopPeerStatusOwner: ReturnType<typeof ownDesktopPeerStatus> | undefined;
let nightlyWindowLeases: ReturnType<typeof ownNightlyWindowLeases> | undefined;
const desktopClientLifetime = createDesktopClientLifetime({
  currentNightlyWindows: () => nightlyWindowLeases?.activeWindowCount() ?? 0,
  closeLocalWindows: closeLocalWindowsForRetainedHost,
  quitHost: quitHostAfterLastClient,
});

async function quitHostAfterLastClient(
  stillRequested: () => boolean = () => (nightlyWindowLeases?.activeWindowCount() ?? 0) === 0,
): Promise<"accepted" | "cancelled"> {
  if (quitPrepared) return "accepted";
  if (preparingQuit) return "cancelled";
  quitCanPrompt = true;
  preparingQuit = true;
  await prepareToQuit(stillRequested);
  return quitAccepted ? "accepted" : "cancelled";
}

async function stopHostForQuit(): Promise<void> {
  const prototypesStopped = canvasPrototypeSurface?.stop();
  const hostStopped = (async () => {
    await shutdownSecondaryProjectWindows();
    await projectWindowLifecycle.shutdown(async () => {
      const result = await hostLifecycle.prepareQuit(() => true);
      if (result === "cancelled") throw new Error("Octant quit was cancelled.");
      const retained = desktopHostLaunch;
      if (retained !== undefined) await closeDesktopHostLaunch(retained);
    });
  })();
  const native = desktopPeerStatusOwner?.close();
  const windows = nightlyWindowLeases?.close();
  const [hostResult, prototypeResult, nativeResult, windowsResult] = await Promise.allSettled([
    hostStopped,
    prototypesStopped,
    native,
    windows,
  ]);
  const windowsFailed =
    windowsResult.status === "rejected" || windowsResult.value?.kind === "failed";
  const nativeFailed = nativeResult.status === "rejected" || nativeResult.value?.kind === "failed";
  if (windowsFailed) logQuitProblem("Octant could not finish closing its Nightly window leases.");
  if (nativeFailed) logQuitProblem("Octant could not finish closing its desktop status endpoint.");
  if (hostResult.status === "rejected") throw hostResult.reason;
  if (prototypeResult.status === "rejected") throw prototypeResult.reason;
  if (prototypeResult.value?.status === "failed") {
    throw new Error(`Canvas prototype shutdown failed: ${prototypeResult.value.reason}.`);
  }
  // Native close can retain an OS launch after its deadline. Report failure
  // only after every sibling has settled, so quit never records it as clean.
  if (windowsFailed || nativeFailed)
    throw new Error("Octant could not finish closing its native desktop owners.");
}

function finishQuit(): void {
  try {
    destroyHostTray();
  } catch (error) {
    logQuitProblem(`Octant could not remove its menu bar item at quit: ${String(error)}`);
  }
  quitPrepared = true;
  preparingQuit = false;
  armQuitDeadline({
    forceExit: forceExitAfterStalledQuit(),
    boundMs: WINDOW_CLOSE_GRACE_MS,
  });
  app.quit();
}

async function prepareToQuit(stillRequested?: () => boolean): Promise<void> {
  const interactive = quitCanPrompt;
  quitCanPrompt = false;
  let accepted = true;
  if (interactive) {
    try {
      accepted = await evaluateQuitRequest({
        refreshActivity: refreshHostActivity,
        snapshot: hostLifecycle.snapshot,
        confirm: confirmQuitWithActiveWork,
      });
    } catch (error) {
      // Quit stays cancelled when the question could not be asked: the
      // confirmation protects running work, and the person can ask again.
      logQuitProblem(`Octant could not confirm the quit: ${String(error)}`);
      accepted = false;
    }
  }
  if (!accepted || stillRequested?.() === false) {
    preparingQuit = false;
    nightlyRelaunch.quitCancelled();
    return;
  }
  desktopQuitAccepted = true;
  nightlyRelaunch.quitAccepted();
  hostLifecycle.acceptQuit();
  desktopBackendSupervisor.release();
  // Closing admission here fences a client arriving during the later flush.
  quitAccepted = true;
  // Armed only once the quit is accepted, so the time a person spends on the
  // confirmation does not count against it.
  armQuitDeadline({
    forceExit: forceExitAfterStalledQuit(),
  });
  await shutDownForQuit({
    flushWindowState,
    stopHost: stopHostForQuit,
    log: logQuitProblem,
  });
  finishQuit();
}

async function handleFatalStartup(error: unknown): Promise<void> {
  preparingQuit = true;
  desktopQuitAccepted = true;
  hostLifecycle.acceptQuit();
  desktopBackendSupervisor.release();
  dialog.showErrorBox("Octant could not start", formatDesktopStartupFailure(error));
  armQuitDeadline({
    forceExit: forceExitAfterStalledQuit(),
  });
  await shutDownForQuit({
    flushWindowState: async () => undefined,
    stopHost: stopHostForQuit,
    log: logQuitProblem,
  });
  finishQuit();
}

const requestWindow = createSingleFlight(() => desktopClientLifetime.openLocalWindow(createWindow));
async function ensureMenuWindow(): Promise<void> {
  if (!(await desktopClientLifetime.reopen())) throw new Error("Octant is closing.");
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) return;
  if (preparingQuit || quitPrepared) {
    throw new Error("Octant is closing.");
  }
  await requestWindow();
}

const requestActiveWindow = async () => {
  if (!(await desktopClientLifetime.reopen())) return;
  requestProjectWindowWhileRunning({
    isTearingDown: () => preparingQuit || quitPrepared,
    request: requestWindow,
    handleFailure: handleFatalStartup,
  });
};

// An unexpected renderer exit should not leave the running app headless, but a
// renderer that keeps dying must not reopen forever: allow at most two
// automatic recoveries in a minute, then wait for the user to re-activate.
// "clean-exit" and "killed" cover normal window teardown, where reopening would
// resurrect every deliberately closed window.
export function shouldRecoverWindowAfterRendererExit(reason: string): boolean {
  return reason !== "clean-exit" && reason !== "killed";
}

const rendererRecoveryTimestamps: number[] = [];

function recoverWindowAfterRendererExit(reason: string): void {
  if (!shouldRecoverWindowAfterRendererExit(reason)) return;
  const now = Date.now();
  const recent = rendererRecoveryTimestamps.filter((at) => now - at <= 60_000);
  if (recent.length >= 2) return;
  rendererRecoveryTimestamps.length = 0;
  rendererRecoveryTimestamps.push(...recent, now);
  requestActiveWindow();
}

const quitShortcutGuard = createQuitShortcutGuard({
  now: () => performance.now(),
  showNotice: () => {
    // An opened server page has no preload bridge, so a hint sent there is never
    // shown; only a shell window that registered as a trusted renderer can show it.
    const focused = BrowserWindow.getFocusedWindow();
    const window =
      focused !== null && trustedRendererWebContentsIds.has(focused) ? focused : mainWindow;
    if (window === undefined || window.isDestroyed()) return false;
    window.webContents.send(IPC_CHANNELS.quitShortcutHint);
    return true;
  },
  quit: requestInteractiveQuit,
});

/** A person's quit: it may close only local windows, and asks before stopping running work. */
function requestInteractiveQuit(): void {
  quitCanPrompt = true;
  app.quit();
}

function installApplicationMenu(): void {
  const developerTools = developerToolsAllowed({
    packaged: app.isPackaged,
    version: app.getVersion(),
  });
  if (process.platform !== "darwin") {
    // Electron's default menu carries Toggle Developer Tools and its shortcut;
    // replace it with the same menu minus those items, not with no menu.
    if (!developerTools) Menu.setApplicationMenu(Menu.buildFromTemplate(buildStableMenuTemplate()));
    return;
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildApplicationMenuTemplate({
        appName: app.name,
        developerTools,
        onQuit: (request) => quitShortcutGuard.request(request),
        onOpenSettings: () => {
          const window = BrowserWindow.getFocusedWindow() ?? mainWindow;
          if (window === undefined || window.isDestroyed()) return;
          window.webContents.send(IPC_CHANNELS.openSettings);
        },
      }),
    ),
  );
}

function acceptCodeDeepLink(value: string): void {
  try {
    const target = parseCodeDeepLink(value, applicationIdentity.scheme);
    if (mainWindow === undefined || mainWindow.isDestroyed()) pendingCodeDeepLinks.push(target);
    else mainWindow.webContents.send(IPC_CHANNELS.codeDeepLink, target);
  } catch {
    // Invalid or authority-bearing links are ignored without changing application state.
  }
}

/**
 * Packaged Linux Octant listens in its private runtime folder, and each launch
 * from an AppImage records that image so a Nightly can start this Octant's
 * host later. A failure leaves Nightly refused, never Octant unable to start.
 */
async function prepareLinuxPeerEndpoint(): Promise<void> {
  try {
    await prepareHostRuntimePaths(desktopPosixHostPaths());
    await writeLinuxLauncherRecord({
      recordPath: desktopPosixHostPaths().launcherRecordPath,
      appImage: process.env.APPIMAGE,
    });
  } catch (error) {
    logQuitProblem(`Octant could not record its launcher for Octant Nightly: ${String(error)}`);
  }
}

function startDesktopInstance(): void {
  const hasSingleInstanceLock = app.requestSingleInstanceLock();
  if (!hasSingleInstanceLock) {
    app.quit();
    return;
  }
  app.setAsDefaultProtocolClient(applicationIdentity.scheme);
  app.on("open-url", (event, url) => {
    event.preventDefault();
    acceptCodeDeepLink(url);
    requestActiveWindow();
  });
  const hostOnly = (args: ReadonlyArray<string>) =>
    app.isPackaged &&
    (process.platform === "darwin" ||
      process.platform === "linux" ||
      process.platform === "win32") &&
    resolvePackagedDesktopLaunch(applicationIdentity, args).kind === "host-only";
  app.on("second-instance", (_event, commandLine) => {
    // A concurrent Nightly launch joins this owner without opening its shell.
    if (hostOnly(commandLine.slice(1))) return;
    for (const argument of commandLine)
      if (argument.startsWith(`${applicationIdentity.scheme}://`)) acceptCodeDeepLink(argument);
    requestActiveWindow();
  });
  for (const argument of process.argv)
    if (argument.startsWith(`${applicationIdentity.scheme}://`)) acceptCodeDeepLink(argument);
  void app
    .whenReady()
    .then(async () => {
      const withoutWindow = hostOnly(process.argv.slice(1));
      if (withoutWindow) {
        const waitForFirstNightlyWindow = desktopClientLifetime.firstNightlyWindowWait();
        await startHostFromMenu();
        waitForFirstNightlyWindow();
      }
      if (!preparingQuit && !quitPrepared && applicationIdentity.flavor === "stable") {
        const linux = app.isPackaged && process.platform === "linux";
        if (linux) await prepareLinuxPeerEndpoint();
        const native = loadDesktopPeerStatus({
          packaged: app.isPackaged,
          platform: process.platform,
          resourcesPath: process.resourcesPath,
          ...(desktopWindowsHost === undefined
            ? {}
            : {
                windows: {
                  profileId: desktopWindowsHost.paths.profileId,
                  version: app.getVersion(),
                },
              }),
          ...(linux
            ? {
                linux: {
                  windowsSocketPath: desktopPosixHostPaths().windowsSocketPath,
                  launcherRecordPath: desktopPosixHostPaths().launcherRecordPath,
                  version: app.getVersion(),
                },
              }
            : {}),
        });
        if (native !== undefined) {
          desktopPeerStatusOwner = ownDesktopPeerStatus(native);
          const protocol = desktopWindowProtocol(native);
          if (protocol !== undefined)
            nightlyWindowLeases = ownNightlyWindowLeases({
              native: protocol,
              host: () =>
                quitAccepted || activeServerUrl === undefined || serverInstanceId === undefined
                  ? undefined
                  : {
                      origin: new URL(activeServerUrl).origin,
                      instanceId: serverInstanceId,
                      desktopBridgeSecret,
                    },
              onActiveWindowCountChanged: () => desktopClientLifetime.nightlyWindowsChanged(),
              closeOwnerContexts: async (windowId) => {
                await browserSurfaceHost?.closeOwnerContexts(windowId);
              },
            });
        }
      }
      installApplicationMenu();
      if (!withoutWindow) await requestActiveWindow();
    })
    .catch(handleFatalStartup);
}

// A launch started by a self-update waits for the instance it replaces to stop
// before asking for the lock. It does not release the lock early or retry it:
// the first would let two hosts share one data directory, the second would
// raise `second-instance` on an instance that is shutting down. An ordinary
// launch takes the synchronous path it always has.
const replacedProcessId = takeReplacedProcessId(process.env);
if (replacedProcessId === undefined) startDesktopInstance();
else {
  void waitForReplacedProcessExit({
    processId: replacedProcessId,
    boundMs: REPLACED_PROCESS_WAIT_BOUND_MS,
    pollMs: REPLACED_PROCESS_POLL_MS,
    // Elapsed time, not the wall clock: a clock correction or a sleep while the
    // old instance stops must not spend, or stretch, the bound.
    now: () => performance.now(),
    isAlive: defaultProcessIsAlive(),
    sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  }).then(startDesktopInstance, handleFatalStartup);
}
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    quitCanPrompt = true;
    app.quit();
  }
});
app.on("activate", requestActiveWindow);
app.on("before-quit", (event) => {
  if (quitPrepared) return;
  event.preventDefault();
  if (preparingQuit) return;
  if (quitCanPrompt) {
    quitCanPrompt = false;
    void desktopClientLifetime.requestLocalQuit().then((result) => {
      if (result === "quit-required") return quitHostAfterLastClient();
      // Only the windows closed; the app keeps running, so no relaunch.
      nightlyRelaunch.quitCancelled();
      if (result === "failed") logQuitProblem("Octant could not finish closing its local windows.");
    });
    return;
  }
  preparingQuit = true;
  void prepareToQuit();
});
app.on("will-quit", () => desktopClientLifetime.dispose());
