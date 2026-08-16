import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  powerMonitor,
  screen,
  shell,
  systemPreferences,
  Tray,
  WebContentsView,
  type BrowserWindowConstructorOptions,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from "electron";
import {
  deriveHostRuntimeHostId,
  readHostInfoReceipt,
  resolveHostRuntimePaths,
  ServicePolicyStore,
  writeBridgeSecretProjection,
  type HostRuntimePaths,
} from "@octant/host-runtime";
import {
  decodePreviewHandoffRequest,
  type PreviewHandoffRequest,
} from "@octant/contracts/previews";
import { startCredentialBroker, type CredentialBroker } from "./credentialBroker";
import {
  createBrowserSurfaceHost,
  type BrowserSurfaceViewPort,
  type ReturnTypeOfBrowserSurfaceHost,
} from "./browserSurfaceHost";
import { startBrowserRuntimeBroker, type BrowserRuntimeBroker } from "./browserRuntimeBroker";
import { openCodeExternalEditorFromServer } from "./codeExternalEditor";
import { createNativePreviewHandoffExecutor, openPreviewHandoffFromServer } from "./previewHandoff";
import {
  requestCodeOperationApprovalFromServer,
  type NativeCodeOperationApprovalRequest,
} from "./codeOperationApproval";
import { parseCodeDeepLink, type CodeDeepLink } from "./codeDeepLinks";
import type { CredentialStore } from "./credentialStore";
import {
  makeKeychainCredentialPurgeStore,
  makeKeychainCredentialStore,
  type CredentialPurgeStore,
} from "./keychainCredentialStore";
import {
  HostIdentitySigningFailure,
  makeHostIdentitySigningService,
  type HostIdentitySigningService,
} from "./hostIdentityKeychain";
import {
  centeredNativeWindowState,
  createNativeWindowStateStore,
  flushNativeWindowState,
  type NativeWindowStateStore,
  type WindowBounds,
} from "./nativeWindowState";
import {
  createProjectRootPicker,
  createProjectWindowAuthority,
  generateProjectBridgeToken,
} from "./projectRootPicker";
import { createLocalPluginFolderPicker } from "./localPluginFolderPicker";
import {
  createSingleFlight,
  assertAutomaticHostStartupEnabled,
  probeHostInfoReceipt,
  probeLocalHost,
  reserveLoopbackPort,
  resolveManagedServerUrl,
  resolveStableHostAttachment,
  serverSpawnSpec,
  shutdownManagedServer,
  waitForStorageReady,
} from "./serverProcess";
import {
  createHostLifecycleController,
  shouldConfirmQuit,
  type LocalHostDescriptor,
} from "./hostLifecycle";
import { buildMenuBarItems, formatRedactedHostDiagnostics } from "./menuBar";
import { createHostTrayImage, shouldPresentHostTray } from "./menuBarIcon";
import {
  CODE_FILE_HELPER_FILENAME,
  DESKTOP_PRELOAD_FILENAME,
  KEYCHAIN_HELPER_FILENAME,
  resolveDesktopNativeHelperPath,
  type DesktopNativeHelperPathOptions,
} from "./runtimePaths";
import {
  INITIAL_SIDEBAR_MATERIAL_PREFERENCE,
  createWindowPresentationController,
  observeThermalPerformance,
  resolveWindowPresentation,
  type ResolvedSidebarMaterial,
  type WindowPresentation,
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

const IPC_CHANNELS = {
  clearProviderCredential: "octant:provider-credential:clear",
  browserSurfaceAttach: "octant:browser-surface:attach",
  browserSurfaceBounds: "octant:browser-surface:bounds",
  browserSurfaceCommand: "octant:browser-surface:command",
  browserSurfaceDetach: "octant:browser-surface:detach",
  browserSurfaceOpenExternal: "octant:browser-surface:open-external",
  codeDeepLink: "octant:code:deep-link",
  close: "octant:window:close",
  hostCapabilities: "octant:window:host-capabilities",
  maximizeOrRestore: "octant:window:maximize-or-restore",
  minimize: "octant:window:minimize",
  openCodeExternalEditor: "octant:code:open-external-editor",
  openInNewWindow: "octant:window:open-project",
  previewHandoff: "octant:preview:handoff",
  requestCodeOperationApproval: "octant:code:request-operation-approval",
  startNewAgent: "octant:menu:start-new-agent",
  providerCredentialStatus: "octant:provider-credential:status",
  resetBounds: "octant:window:reset-bounds",
  selectProjectRoot: "octant:project:select-root",
  selectLocalPluginFolder: "octant:extensions:select-local-plugin-folder",
  setProviderCredential: "octant:provider-credential:set",
  resolvedMaterial: "octant:window:resolved-material",
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

const MAX_PROVIDER_CREDENTIAL_BYTES = 12 * 1_024;
const PROVIDER_INSTANCE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
): {
  readonly sidebarVibrancySupported: boolean;
  readonly liveBrowserSupported: boolean;
} {
  return {
    sidebarVibrancySupported: platform === "darwin",
    liveBrowserSupported,
  };
}

interface ProviderCredentialIpcPort {
  readonly handle: (
    channel: string,
    handler: (event: unknown, ...args: readonly unknown[]) => unknown,
  ) => void;
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
    try {
      await options.store.delete(providerInstanceId);
    } catch {
      throw new Error("Octant could not clear the provider credential.");
    }
  });
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
  readonly authority: ProjectWindowAuthority;
  revocation?: Promise<void>;
}

interface DisposablePresentationController {
  readonly dispose: () => void;
}

interface ManagedBrokerResource {
  readonly url: string;
  readonly token: string;
  readonly close: () => Promise<void>;
}

export async function startManagedServerResources<
  TBroker extends ManagedBrokerResource,
  TServer,
>(options: {
  readonly startBroker: () => Promise<TBroker>;
  readonly startServer: (broker: TBroker) => TServer;
}): Promise<{ readonly broker: TBroker; readonly server: TServer }> {
  let broker: TBroker | undefined;
  try {
    broker = await options.startBroker();
    return { broker, server: options.startServer(broker) };
  } catch {
    try {
      await broker?.close();
    } catch {
      // The fixed startup error remains sanitized even if broker cleanup also fails.
    }
    throw new Error("Octant could not start its managed server resources.");
  }
}

export async function shutdownManagedServerResources<TServer>(options: {
  readonly broker: ManagedBrokerResource | undefined;
  readonly server: TServer | undefined;
  readonly shutdownServer: (server: TServer) => Promise<void>;
}): Promise<void> {
  let failed = false;
  try {
    if (options.server !== undefined) await options.shutdownServer(options.server);
  } catch {
    failed = true;
  } finally {
    try {
      await options.broker?.close();
    } catch {
      failed = true;
    }
  }
  if (failed) throw new Error("Octant could not stop its managed server resources.");
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
      } catch {
        if (window !== undefined) {
          try {
            options.dispose?.(window);
          } catch {
            // Startup cleanup is best effort; authority revocation remains mandatory.
          }
        }
        if (tracked !== undefined) await revoke(tracked);
        throw new Error("Octant could not open its Project window.");
      }
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
    shutdown,
  });
}

export function resolveDesktopDataDirectory(
  configuredDirectory: string | undefined,
  appDataDirectory: string,
): string {
  return resolveDesktopHostRuntimePaths(configuredDirectory, appDataDirectory).dataDirectory;
}

function resolveDesktopHostRuntimePaths(
  configuredDirectory: string | undefined,
  appDataDirectory: string,
): HostRuntimePaths {
  return resolveHostRuntimePaths({
    env: { OCTANT_DATA_DIR: configuredDirectory },
    platform: "darwin",
    home: resolve(appDataDirectory, "..", ".."),
    temporaryDirectory: canonicalTemporaryDirectory(),
    uid: process.getuid?.() ?? 0,
  });
}

function canonicalTemporaryDirectory(): string {
  try {
    return realpathSync(tmpdir());
  } catch {
    return resolve(tmpdir());
  }
}

async function writeBridgeSecretFile(paths: HostRuntimePaths, secret: string): Promise<void> {
  await writeBridgeSecretProjection(paths, secret);
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

app.setName("Octant");
const desktopHostRuntimePaths = resolveDesktopHostRuntimePaths(
  process.env.OCTANT_DATA_DIR,
  app.getPath("appData"),
);
const desktopDataDirectory = desktopHostRuntimePaths.dataDirectory;
const desktopHostId = deriveHostRuntimeHostId(desktopDataDirectory);
app.setPath("userData", desktopDataDirectory);

let server: ChildProcess | undefined;
let credentialBroker: CredentialBroker | undefined;
let browserRuntimeBroker: BrowserRuntimeBroker | undefined;
let browserSurfaceHost: ReturnTypeOfBrowserSurfaceHost | undefined;
let credentialStore: CredentialStore | undefined;
let credentialPurgeStore: CredentialPurgeStore | undefined;
let desktopBridgeSecret =
  readStoredDesktopBridgeSecret(desktopDataDirectory) ?? generateProjectBridgeToken(randomBytes);
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
let preparingQuit = false;
let handlersInstalled = false;
let projectRootPicker: ReturnType<typeof createProjectRootPicker> | undefined;
const projectWindowLifecycle = createProjectWindowAuthorityLifecycle();
interface DesktopWindowContext extends DesktopWindowIdentity {
  readonly primary: boolean;
  readonly picker: ReturnType<typeof createProjectRootPicker>;
  readonly localPluginFolderPicker: ReturnType<typeof createLocalPluginFolderPicker>;
  readonly presentationController: WindowPresentationController;
}
const desktopWindows = createDesktopWindowContextRegistry<BrowserWindow, DesktopWindowContext>();
const secondaryWindowLifecycles = new Set<
  ReturnType<typeof createProjectWindowAuthorityLifecycle>
>();

function repositoryRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

export function resolveKeychainHelperPath(options: DesktopNativeHelperPathOptions): string {
  return resolveDesktopNativeHelperPath(options, KEYCHAIN_HELPER_FILENAME);
}

export function resolveCodeFileHelperPath(options: DesktopNativeHelperPathOptions): string {
  return resolveDesktopNativeHelperPath(options, CODE_FILE_HELPER_FILENAME);
}

export function createMainBrowserWindowOptions(options: {
  readonly bounds: WindowBounds;
  readonly capability: string;
  readonly initialProjectId?: string;
  readonly initialThreadMode?: "code" | "work";
  readonly initialThreadId?: string;
  readonly preloadPath: string;
  readonly browserWindow: WindowPresentation["browserWindow"];
}): BrowserWindowConstructorOptions {
  if ((options.initialThreadMode === undefined) !== (options.initialThreadId === undefined)) {
    throw new Error("Octant received an incomplete initial thread target.");
  }
  if (options.initialThreadMode !== undefined && options.initialProjectId === undefined) {
    throw new Error("Octant initial thread target requires a Project.");
  }
  return {
    ...options.bounds,
    minWidth: 900,
    minHeight: 600,
    ...options.browserWindow,
    show: false,
    title: "Octant",
    visualEffectState: "followWindow",
    webPreferences: {
      contextIsolation: true,
      additionalArguments: [
        `--octant-project-capability=${options.capability}`,
        ...(options.initialProjectId === undefined
          ? []
          : [`--octant-initial-project-id=${options.initialProjectId}`]),
        ...(options.initialThreadMode === undefined || options.initialThreadId === undefined
          ? []
          : [
              `--octant-initial-thread-mode=${options.initialThreadMode}`,
              `--octant-initial-thread-id=${options.initialThreadId}`,
            ]),
      ],
      nodeIntegration: false,
      preload: options.preloadPath,
      sandbox: true,
    },
  };
}

function getCredentialStore(): CredentialStore {
  credentialStore ??= makeKeychainCredentialStore(
    resolveKeychainHelperPath({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      moduleUrl: import.meta.url,
    }),
    { storeScope: desktopHostId },
  );
  return credentialStore;
}

function getCredentialPurgeStore(): CredentialPurgeStore {
  credentialPurgeStore ??= makeKeychainCredentialPurgeStore(
    resolveKeychainHelperPath({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      moduleUrl: import.meta.url,
    }),
    { storeScope: desktopHostId },
  );
  return credentialPurgeStore;
}

async function resolveExistingHostAttachment() {
  return await resolveStableHostAttachment({
    readReceipt: () => readHostInfoReceipt(desktopHostRuntimePaths),
    readBridgeSecret: () => readStoredDesktopBridgeSecret(desktopDataDirectory),
    probeReceipt: (receipt) =>
      probeHostInfoReceipt({
        receipt,
        expectedHostId: desktopHostId,
        expectedWireVersion: "1",
        expectedControlEndpoint: desktopHostRuntimePaths.socketPath,
      }),
  });
}

async function attachExistingLocalHost(): Promise<LocalHostDescriptor | undefined> {
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

async function startDesktopOwnedHost(): Promise<LocalHostDescriptor> {
  if (server !== undefined && activeServerUrl !== undefined && serverInstanceId !== undefined) {
    return {
      url: activeServerUrl,
      instanceId: serverInstanceId,
      ownership: "desktop-owned",
    };
  }
  await assertAutomaticHostStartupEnabled(
    new ServicePolicyStore({ path: desktopHostRuntimePaths.servicePolicyPath }),
  );
  const root = repositoryRoot();
  const portReservation = await reserveLoopbackPort(resolveConfiguredServerPort());
  const serverUrl = resolveManagedServerUrl({
    needsServerStart: true,
    activeServerUrl: undefined,
    reservedPort: portReservation.port,
  });
  const port = Number(new URL(serverUrl).port);
  // The reservation only selects a collision-free port. Release the listener
  // before spawning the managed server, which must bind that same port.
  await portReservation.close();
  let startingBrowserBroker: BrowserRuntimeBroker | undefined;
  try {
    const instanceId = randomUUID();
    browserSurfaceHost ??= createBrowserSurfaceHost({
      isOwnerWindowAvailable: (windowId) => desktopWindows.hasWindowId(windowId),
      createView: ({ partition, webPreferences }) =>
        new WebContentsView({
          webPreferences: { partition, ...webPreferences },
        }) as unknown as BrowserSurfaceViewPort,
    });
    const nextBrowserRuntimeBroker = await startBrowserRuntimeBroker(browserSurfaceHost);
    startingBrowserBroker = nextBrowserRuntimeBroker;
    const resources = await startManagedServerResources({
      startBroker: () =>
        credentialBroker === undefined
          ? startCredentialBroker(getCredentialStore(), getCredentialPurgeStore())
          : Promise.resolve(credentialBroker),
      startServer: (broker) => {
        const spec = serverSpawnSpec({
          browserBrokerToken: nextBrowserRuntimeBroker.token,
          browserBrokerUrl: nextBrowserRuntimeBroker.url,
          codeFileHelperPath: resolveCodeFileHelperPath({
            packaged: app.isPackaged,
            resourcesPath: process.resourcesPath,
            moduleUrl: import.meta.url,
          }),
          credentialBrokerToken: broker.token,
          credentialBrokerUrl: broker.url,
          desktopBridgeSecret,
          root,
          port,
          instanceId,
          packaged: app.isPackaged,
          execPath: process.execPath,
          env: { ...process.env, OCTANT_DATA_DIR: desktopDataDirectory },
        });
        return spawn(spec.command, spec.args, {
          env: spec.env,
          stdio: [...spec.stdio] as ["pipe", "inherit", "inherit"],
        });
      },
    });
    credentialBroker = resources.broker;
    browserRuntimeBroker = nextBrowserRuntimeBroker;
    server = resources.server;
    serverInstanceId = instanceId;
    activeServerUrl = serverUrl;
    const attached = await waitForStorageReady({
      serverUrl,
      instanceId,
      resolveAttachedHost: async () => {
        return (await resolveExistingHostAttachment())?.probe;
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
      const child = server;
      const broker = credentialBroker;
      server = undefined;
      credentialBroker = undefined;
      browserRuntimeBroker = undefined;
      await shutdownManagedServerResources({
        broker,
        server: child,
        shutdownServer: shutdownManagedServer,
      });
      await nextBrowserRuntimeBroker.close();
      desktopBridgeSecret = winningAttachment.bridgeSecret;
      serverInstanceId = attached.instanceId;
      activeServerUrl = attached.url;
      return { url: attached.url, instanceId: attached.instanceId, ownership: "managed" };
    }
    return { url: serverUrl, instanceId, ownership: "desktop-owned" };
  } catch (error) {
    const child = server;
    const broker = credentialBroker;
    const browserBroker = browserRuntimeBroker ?? startingBrowserBroker;
    server = undefined;
    credentialBroker = undefined;
    browserRuntimeBroker = undefined;
    serverInstanceId = undefined;
    activeServerUrl = undefined;
    await shutdownManagedServerResources({
      broker,
      server: child,
      shutdownServer: shutdownManagedServer,
    }).catch(() => undefined);
    await browserBroker?.close().catch(() => undefined);
    throw error;
  }
}

async function stopDesktopOwnedHost(host: LocalHostDescriptor): Promise<void> {
  if (host.ownership !== "desktop-owned") return;
  const child = server;
  const broker = credentialBroker;
  const browserBroker = browserRuntimeBroker;
  server = undefined;
  credentialBroker = undefined;
  browserRuntimeBroker = undefined;
  serverInstanceId = undefined;
  activeServerUrl = undefined;
  await shutdownManagedServerResources({
    broker,
    server: child,
    shutdownServer: shutdownManagedServer,
  });
  await browserBroker?.close();
}

const hostLifecycle = createHostLifecycleController({
  attach: attachExistingLocalHost,
  start: startDesktopOwnedHost,
  stop: stopDesktopOwnedHost,
});

async function createWindow(): Promise<void> {
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) return;
  const root = repositoryRoot();
  const host = await hostLifecycle.ensureRunning();
  const serverUrl = host.url;
  activeServerUrl = serverUrl;
  serverInstanceId = host.instanceId;
  await refreshHostActivity();
  if (host.ownership === "desktop-owned") {
    await writeBridgeSecretFile(desktopHostRuntimePaths, desktopBridgeSecret);
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
  await projectWindowLifecycle.open({
    register: () =>
      createProjectWindowAuthority({ desktopBridgeSecret, serverUrl, windowId: state.windowId }),
    construct: (capability) => {
      stableWindowCapability = capability;
      return new BrowserWindow(
        createMainBrowserWindowOptions({
          bounds: state.bounds,
          capability,
          preloadPath: resolve(dirname(fileURLToPath(import.meta.url)), DESKTOP_PRELOAD_FILENAME),
          browserWindow: presentation.browserWindow,
        }),
      );
    },
    prepare: (window, closeAuthority) => {
      mainWindow = window;
      if (state.maximized) window.maximize();
      projectRootPicker = createProjectRootPicker<BrowserWindow>({
        desktopBridgeSecret,
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
        desktopBridgeSecret,
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

      let resolvedMaterial: ResolvedSidebarMaterial = presentation.material;
      const controller = createWindowPresentationController({
        window: {
          setVibrancy: (value) => window.setVibrancy(value),
          publishResolvedMaterial: (material) => {
            resolvedMaterial = material;
            if (!window.webContents.isDestroyed()) {
              window.webContents.send(IPC_CHANNELS.resolvedMaterial, material);
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
        presentationController: controller,
      });
      const stopThermalPerformance = observeThermalPerformance({
        platform: process.platform,
        powerMonitor,
        richEffectsAllowed: systemPreferences.getAnimationSettings().shouldRenderRichAnimation,
        updatePerformanceSafe: (performanceSafe) => controller.update({ performanceSafe }),
      });
      preparationCleanup.trackThermalObserver(stopThermalPerformance);

      window.webContents.on("did-finish-load", () => {
        window.webContents.send(IPC_CHANNELS.resolvedMaterial, resolvedMaterial);
        while (pendingCodeDeepLinks.length > 0) {
          window.webContents.send(IPC_CHANNELS.codeDeepLink, pendingCodeDeepLinks.shift());
        }
      });
      window.webContents.on("render-process-gone", () => {
        void Promise.all([
          browserSurfaceHost?.closeOwnerContexts(state.windowId),
          closeAuthority(),
        ]).finally(() => {
          if (!window.isDestroyed()) window.destroy();
        });
      });
      window.once("ready-to-show", () => window.show());
      window.on("close", (event) => {
        if (quitPrepared) return;
        event.preventDefault();
        void flushWindowState()
          .catch(() => {
            dialog.showErrorBox(
              "Octant could not save window state",
              "The window will use safe default bounds the next time it opens.",
            );
          })
          .finally(() => window.destroy());
      });
      window.once("closed", () => {
        void browserSurfaceHost?.closeOwnerContexts(state.windowId).catch(() => undefined);
        desktopWindows.remove(window);
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
        const launchUrl = new URL(developmentUrl);
        launchUrl.searchParams.set("windowId", state.windowId);
        launchUrl.searchParams.set("serverUrl", serverUrl);
        await window.loadURL(launchUrl.toString());
      } else {
        await window.loadFile(resolve(root, "apps/web/dist/index.html"), {
          query: { windowId: state.windowId, serverUrl },
        });
      }
    },
    dispose: (window) => {
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
  const serverUrl = activeServerUrl;
  if (serverUrl === undefined || serverInstanceId === undefined) {
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
  try {
    await lifecycle.open({
      register: () => createProjectWindowAuthority({ desktopBridgeSecret, serverUrl, windowId }),
      construct: (capability) => {
        windowCapability = capability;
        return new BrowserWindow(
          createMainBrowserWindowOptions({
            bounds: state.bounds,
            capability,
            initialProjectId: target.projectId,
            ...(target.kind === "project-thread"
              ? { initialThreadMode: target.mode, initialThreadId: target.threadId }
              : {}),
            preloadPath: resolve(dirname(fileURLToPath(import.meta.url)), DESKTOP_PRELOAD_FILENAME),
            browserWindow: presentation.browserWindow,
          }),
        );
      },
      prepare: (window, closeAuthority) => {
        if (windowCapability === undefined) {
          throw new Error("Octant Project window capability is unavailable.");
        }
        const picker = createProjectRootPicker<BrowserWindow>({
          desktopBridgeSecret,
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
          desktopBridgeSecret,
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
        let resolvedMaterial: ResolvedSidebarMaterial = presentation.material;
        const controller = createWindowPresentationController({
          window: {
            setVibrancy: (value) => window.setVibrancy(value),
            publishResolvedMaterial: (material) => {
              resolvedMaterial = material;
              if (!window.webContents.isDestroyed()) {
                window.webContents.send(IPC_CHANNELS.resolvedMaterial, material);
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
          presentationController: controller,
        });
        window.webContents.on("did-finish-load", () => {
          window.webContents.send(IPC_CHANNELS.resolvedMaterial, resolvedMaterial);
        });
        window.webContents.on("render-process-gone", () => {
          void Promise.all([
            browserSurfaceHost?.closeOwnerContexts(windowId),
            closeAuthority(),
          ]).finally(() => {
            if (!window.isDestroyed()) window.destroy();
          });
        });
        window.once("ready-to-show", () => window.show());
        window.once("closed", () => {
          void browserSurfaceHost?.closeOwnerContexts(windowId).catch(() => undefined);
          desktopWindows.remove(window);
          preparationCleanup.dispose();
          void closeAuthority().finally(() => secondaryWindowLifecycles.delete(lifecycle));
        });
        installIpcHandlers();
      },
      load: async (window) => {
        const developmentUrl = process.env.OCTANT_WEB_URL;
        if (developmentUrl) {
          const launchUrl = new URL(developmentUrl);
          launchUrl.searchParams.set("windowId", windowId);
          launchUrl.searchParams.set("serverUrl", serverUrl);
          await window.loadURL(launchUrl.toString());
        } else {
          await window.loadFile(resolve(repositoryRoot(), "apps/web/dist/index.html"), {
            query: { windowId, serverUrl },
          });
        }
      },
      dispose: (window) => {
        desktopWindows.remove(window);
        preparationCleanup.dispose();
        if (!window.isDestroyed()) window.destroy();
      },
    });
  } catch (error) {
    secondaryWindowLifecycles.delete(lifecycle);
    throw error;
  }
}

function hostStatusLabel(): string {
  const snapshot = hostLifecycle.snapshot();
  if (snapshot.state === "attention-required") return "Attention needed";
  if (snapshot.state === "running") return "Running";
  if (snapshot.state === "starting") return "Starting";
  return "Stopped";
}

function updateHostTray(): void {
  if (hostTray === undefined) return;
  const snapshot = hostLifecycle.snapshot();
  const items = buildMenuBarItems(snapshot);
  const actions = new Map(items.map((item) => [item.id, item]));
  const handler = (id: (typeof items)[number]["id"]): (() => void) | undefined => {
    const item = actions.get(id);
    if (item === undefined || !item.enabled) return undefined;
    return () => void runMenuBarAction(id);
  };
  const template: MenuItemConstructorOptions[] = items.map((item) => {
    const click = handler(item.id);
    return {
      label: item.label,
      enabled: item.enabled,
      ...(click === undefined ? {} : { click: () => click() }),
    };
  });
  hostTray.setContextMenu(Menu.buildFromTemplate(template));
  hostTray.setToolTip(`Octant — ${hostStatusLabel()}`);
  hostTray.setTitle?.(snapshot.attentionRequired ? "!" : "");
}

function ensureHostTray(): void {
  const snapshot = hostLifecycle.snapshot();
  if (!shouldPresentHostTray(process.platform, snapshot.state)) return;
  if (hostTray === undefined) {
    const iconPath = resolve(repositoryRoot(), "apps/desktop/resources/menuBarTemplate.png");
    hostTray = new Tray(createHostTrayImage(nativeImage, iconPath));
    hostTray.on("click", () => hostTray?.popUpContextMenu());
  }
  updateHostTray();
  if (hostStatusPoll === undefined) {
    hostStatusPoll = setInterval(() => void refreshHostActivity(), 2_000);
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
    hostLifecycle.setActivity({ activeAgentCount: 0, attentionRequired: true });
    updateHostTray();
    return;
  }
  hostLifecycle.setActivity({
    activeAgentCount: probe.activeAgentCount ?? 0,
    attentionRequired: probe.attentionRequired ?? false,
  });
  updateHostTray();
}

async function openLocalWebApp(): Promise<void> {
  const snapshot = hostLifecycle.snapshot();
  if (snapshot.url === undefined || snapshot.state === "stopped") {
    throw new Error("Octant local web app is unavailable while the host is stopped.");
  }
  const windowId = randomUUID();
  const capability = generateProjectBridgeToken(randomBytes);
  const response = await fetch(new URL("/api/desktop/launch-sessions", snapshot.url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-octant-desktop-secret": desktopBridgeSecret,
    },
    body: JSON.stringify({ windowId, capability }),
  });
  if (!response.ok) throw new Error("Octant could not authorize the local web app.");
  const payload = (await response.json()) as { readonly launchToken?: unknown };
  if (typeof payload.launchToken !== "string" || !BRIDGE_SECRET_PATTERN.test(payload.launchToken)) {
    throw new Error("Octant received an invalid local web app launch receipt.");
  }
  const url = new URL(snapshot.url);
  url.searchParams.set("serverUrl", snapshot.url);
  url.hash = `launchToken=${payload.launchToken}`;
  await shell.openExternal(url.toString());
}

async function startHostFromMenu(): Promise<void> {
  const host = await hostLifecycle.ensureRunning();
  activeServerUrl = host.url;
  serverInstanceId = host.instanceId;
  if (host.ownership === "desktop-owned") {
    await writeBridgeSecretFile(desktopHostRuntimePaths, desktopBridgeSecret);
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
  const host = await hostLifecycle.restart();
  activeServerUrl = host.url;
  serverInstanceId = host.instanceId;
  await writeBridgeSecretFile(desktopHostRuntimePaths, desktopBridgeSecret);
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
    }
  } catch {
    dialog.showErrorBox(
      "Octant host action unavailable",
      "The selected host action was not authorized or could not be completed.",
    );
  }
}

function resolveConfiguredServerPort(): number | undefined {
  const value = process.env.OCTANT_SERVER_PORT;
  if (value === undefined) return undefined;
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

function getHostIdentitySigningService(): HostIdentitySigningService {
  hostIdentitySigningService ??= makeHostIdentitySigningService(
    resolveKeychainHelperPath({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      moduleUrl: import.meta.url,
    }),
    {
      storeScope: desktopHostId,
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

function installIpcHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  installProviderCredentialIpcHandlers({
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    resolveOwnedWindow: (event) => void ownedWindowContext(event as IpcMainInvokeEvent),
    store: getCredentialStore(),
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
  installHostIdentityIpcHandlers({
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    resolveOwnedWindow: (event) => void ownedWindowContext(event as IpcMainInvokeEvent),
    service: getHostIdentitySigningService(),
  });
  ipcMain.handle(IPC_CHANNELS.minimize, (event) => ownedWindow(event).minimize());
  ipcMain.handle(IPC_CHANNELS.openCodeExternalEditor, async (event, request: unknown) => {
    const context = ownedWindowContext(event);
    if (activeServerUrl === undefined) {
      throw new Error("Octant external editor handoff is unavailable.");
    }
    await openCodeExternalEditorFromServer({
      serverUrl: activeServerUrl,
      desktopBridgeSecret,
      windowId: context.windowId,
      request: request as never,
      fetch: globalThis.fetch,
      spawn: (executable, arguments_, options) => spawn(executable, [...arguments_], options),
    });
  });
  const activePreviewHandoffs = new Map<string, AbortController>();
  const previewHandoffExecutor = createNativePreviewHandoffExecutor({
    shell,
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
        desktopBridgeSecret,
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
  ipcMain.handle(IPC_CHANNELS.requestCodeOperationApproval, async (event, request: unknown) => {
    const context = ownedWindowContext(event);
    if (activeServerUrl === undefined) {
      throw new Error("Octant Code approval is unavailable.");
    }
    return await requestCodeOperationApprovalFromServer({
      serverUrl: activeServerUrl,
      desktopBridgeSecret,
      windowCapability: context.capability,
      request: request as NativeCodeOperationApprovalRequest,
      owner: context.window,
      dialog: {
        showMessageBox: (window, options) =>
          dialog.showMessageBox(window, { ...options, buttons: [...options.buttons] }),
      },
      fetch: globalThis.fetch,
    });
  });
  ipcMain.handle(IPC_CHANNELS.maximizeOrRestore, (event) => {
    const window = ownedWindow(event);
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });
  ipcMain.handle(IPC_CHANNELS.close, (event) => ownedWindow(event).close());
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
  ipcMain.handle(IPC_CHANNELS.browserSurfaceOpenExternal, async (event, value: unknown) => {
    ownedTopLevelWindowContext(event);
    await shell.openExternal(validateExternalBrowserUrl(value));
  });
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

function validateExternalBrowserUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 4_096) {
    throw new Error("Octant rejected an invalid external Browser URL.");
  }
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username !== "" ||
      url.password !== ""
    ) {
      throw new Error();
    }
    return url.toString();
  } catch {
    throw new Error("Octant rejected an invalid external Browser URL.");
  }
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

function ownedWindowContext(
  event: IpcMainInvokeEvent,
): Readonly<DesktopWindowContext & { readonly window: BrowserWindow }> {
  const window = BrowserWindow.fromWebContents(event.sender);
  return desktopWindows.resolve(window);
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
  try {
    const url = new URL(value);
    return (
      url.protocol === "file:" &&
      url.hostname === "" &&
      fileURLToPath(url) === resolve(repositoryRoot(), "apps/web/dist/index.html")
    );
  } catch {
    return false;
  }
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

async function shutdownSecondaryProjectWindows(): Promise<void> {
  const lifecycles = [...secondaryWindowLifecycles];
  await Promise.all(lifecycles.map((lifecycle) => lifecycle.shutdown(async () => undefined)));
  for (const lifecycle of lifecycles) secondaryWindowLifecycles.delete(lifecycle);
}

async function confirmQuitWithActiveWork(): Promise<boolean> {
  const options = {
    type: "warning" as const,
    title: "Quit Octant?",
    message: "Active Octant work will be interrupted.",
    detail: "Quit only if you want the desktop-owned host and its child resources to stop now.",
    buttons: ["Cancel", "Quit Octant"],
    defaultId: 0,
    cancelId: 0,
  };
  const result =
    mainWindow === undefined
      ? await dialog.showMessageBox(options)
      : await dialog.showMessageBox(mainWindow, options);
  return result.response === 1;
}

async function prepareToQuit(): Promise<void> {
  const hostBeforeQuit = hostLifecycle.snapshot();
  if (shouldConfirmQuit(hostBeforeQuit) && !(await confirmQuitWithActiveWork())) {
    preparingQuit = false;
    return;
  }
  try {
    await flushWindowState();
  } catch {
    dialog.showErrorBox(
      "Octant could not save window state",
      "The window will use safe default bounds the next time it opens.",
    );
  }
  try {
    await shutdownSecondaryProjectWindows();
    await projectWindowLifecycle.shutdown(async () => {
      const result = await hostLifecycle.prepareQuit(() => true);
      if (result === "cancelled") throw new Error("Octant quit was cancelled.");
    });
  } catch {
    dialog.showErrorBox(
      "Octant could not stop its local server",
      "The managed server did not confirm shutdown before the application exited.",
    );
  } finally {
    destroyHostTray();
    quitPrepared = true;
    preparingQuit = false;
    app.quit();
  }
}

async function handleFatalStartup(error: unknown): Promise<void> {
  preparingQuit = true;
  const message =
    error instanceof Error ? error.message : "Octant could not start its local server.";
  dialog.showErrorBox("Octant could not start", message);
  try {
    await shutdownSecondaryProjectWindows();
    await projectWindowLifecycle.shutdown(async () => {
      const result = await hostLifecycle.prepareQuit(() => true);
      if (result === "cancelled") throw new Error("Octant quit was cancelled.");
    });
  } catch {
    dialog.showErrorBox(
      "Octant could not stop its local server",
      "The managed server did not confirm shutdown before the application exited.",
    );
  } finally {
    destroyHostTray();
    quitPrepared = true;
    app.quit();
  }
}

const requestWindow = createSingleFlight(createWindow);
async function ensureMenuWindow(): Promise<void> {
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) return;
  if (preparingQuit || quitPrepared) {
    throw new Error("Octant is closing.");
  }
  await requestWindow();
}

const requestActiveWindow = () =>
  requestProjectWindowWhileRunning({
    isTearingDown: () => preparingQuit || quitPrepared,
    request: requestWindow,
    handleFailure: handleFatalStartup,
  });

function acceptCodeDeepLink(value: string): void {
  try {
    const target = parseCodeDeepLink(value);
    if (mainWindow === undefined || mainWindow.isDestroyed()) pendingCodeDeepLinks.push(target);
    else mainWindow.webContents.send(IPC_CHANNELS.codeDeepLink, target);
  } catch {
    // Invalid or authority-bearing links are ignored without changing application state.
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
else {
  app.setAsDefaultProtocolClient("octant");
  app.on("open-url", (event, url) => {
    event.preventDefault();
    acceptCodeDeepLink(url);
    requestActiveWindow();
  });
  app.on("second-instance", (_event, commandLine) => {
    for (const argument of commandLine)
      if (argument.startsWith("octant://")) acceptCodeDeepLink(argument);
    requestActiveWindow();
  });
  for (const argument of process.argv)
    if (argument.startsWith("octant://")) acceptCodeDeepLink(argument);
  void app.whenReady().then(requestActiveWindow).catch(handleFatalStartup);
}
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", requestActiveWindow);
app.on("before-quit", (event) => {
  if (quitPrepared) return;
  event.preventDefault();
  if (preparingQuit) return;
  preparingQuit = true;
  void prepareToQuit();
});
