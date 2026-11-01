import type {
  CodeCheckoutOpenRequest,
  CodeExternalEditorRequest,
} from "@octant/contracts/desktop-bridge";
import type { OpenInApplicationId } from "@octant/contracts/shell";

/**
 * The contextBridge channel map and the request decodes the desktop's own
 * processes share. The renderer never names a channel — the bridge methods
 * do — so this stays inside apps/desktop: the main process and the sandboxed
 * preload both import it, and the preload may not import a runtime package
 * (its type imports from @octant/contracts are erased at build time).
 */
export const DESKTOP_IPC_CHANNELS = {
  nativeMenu: "octant:menu:popup",
  menuBarOpenThread: "octant:menu:open-thread",
  menuBarTask: "octant:menu:task",
  attentionBadge: "octant:attention:badge",
  attentionNotify: "octant:attention:notify",
  browserSurfaceAttach: "octant:browser-surface:attach",
  browserSurfaceBounds: "octant:browser-surface:bounds",
  browserSurfaceCommand: "octant:browser-surface:command",
  browserSurfaceDetach: "octant:browser-surface:detach",
  browserSurfaceOpenExternal: "octant:browser-surface:open-external",
  browserSurfaceState: "octant:browser-surface:state",
  browserSurfaceTab: "octant:browser-surface:tab",
  browserExtensionPopupOpen: "octant:browser-extension-popup:open",
  browserExtensionPopupClose: "octant:browser-extension-popup:close",
  browserExtensionTabs: "octant:browser-extension-tabs",
  browserExtensionActionClicked: "octant:browser-extension-action-clicked",
  canvasPrototypeSurface: "octant:canvas:prototype-surface:prepare",
  canvasPrototypeOpen: "octant:canvas:prototype:open",
  canvasPrototypeInput: "octant:canvas:prototype:input",
  canvasPrototypeResize: "octant:canvas:prototype:resize",
  canvasPrototypeClose: "octant:canvas:prototype:close",
  canvasPrototypeDrawn: "octant:canvas:prototype:drawn",
  canvasPrototypeEvent: "octant:canvas:prototype:event",
  appUpdateState: "octant:app-update:state",
  appUpdateCheck: "octant:app-update:check",
  appUpdateDownload: "octant:app-update:download",
  appUpdateInstall: "octant:app-update:install",
  appUpdateAutomatic: "octant:app-update:automatic",
  computerUseStatus: "octant:computer-use:status",
  computerUsePermissions: "octant:computer-use:permissions",
  computerUsePermissionSettings: "octant:computer-use:permission-settings",
  computerUseCheckUpdates: "octant:computer-use:check-updates",
  managedToolsStatus: "octant:managed-tools:status",
  managedToolsCheckUpdates: "octant:managed-tools:check-updates",
  managedToolsConfigure: "octant:managed-tools:configure",
  appUpdateRing: "octant:app-update:ring",
  appUpdateWhatsNew: "octant:app-update:whats-new",
  appUpdateWhatsNewAck: "octant:app-update:whats-new-ack",
  approvalSurfacePalette: "octant:window:approval-surface-palette",
  clearProviderCredential: "octant:provider-credential:clear",
  codeDeepLink: "octant:code:deep-link",
  close: "octant:window:close",
  projectWindowCapability: "octant:window:project-capability",
  maximizeOrRestore: "octant:window:maximize-or-restore",
  minimize: "octant:window:minimize",
  openCodeExternalEditor: "octant:code:open-external-editor",
  listOpenInApplications: "octant:code:list-open-in-applications",
  openCodeCheckoutInApplication: "octant:code:open-checkout-in-application",
  openInNewWindow: "octant:window:open-project",
  openSettings: "octant:menu:open-settings",
  quitShortcutHint: "octant:menu:quit-shortcut-hint",
  previewHandoff: "octant:preview:handoff",
  requestCodeOperationApproval: "octant:code:request-operation-approval",
  updateCodeOperationApprovalAnchor: "octant:code:update-operation-approval-anchor",
  cancelCodeOperationApproval: "octant:code:cancel-operation-approval",
  startNewAgent: "octant:menu:start-new-agent",
  providerCredentialStatus: "octant:provider-credential:status",
  resetBounds: "octant:window:reset-bounds",
  selectProjectRoot: "octant:project:select-root",
  selectLocalPluginFolder: "octant:extensions:select-local-plugin-folder",
  selectRuntimeBinary: "octant:providers:select-runtime-binary",
  saveSupportBundle: "octant:diagnostics:save-support-bundle",
  windowCaptureList: "octant:window-capture:list",
  windowCapturePermission: "octant:window-capture:permission",
  windowCaptureTake: "octant:window-capture:take",
  setProviderCredential: "octant:provider-credential:set",
  listProviderApiKeys: "octant:provider-api-key:list",
  addProviderApiKey: "octant:provider-api-key:add",
  renameProviderApiKey: "octant:provider-api-key:rename",
  replaceProviderApiKey: "octant:provider-api-key:replace",
  removeProviderApiKey: "octant:provider-api-key:remove",
  setActiveProviderApiKey: "octant:provider-api-key:set-active",
  moveProviderApiKey: "octant:provider-api-key:move",
  hostCapabilities: "octant:window:host-capabilities",
  resolvedMaterial: "octant:window:resolved-material",
  resolvedSidebarVibrancy: "octant:window:resolved-sidebar-vibrancy",
  sidebarMaterialPreference: "octant:window:sidebar-material-preference",
  sidebarVibrancyMode: "octant:window:sidebar-vibrancy-mode",
  privateListenerStatus: "octant:private-listener:status",
  privateListenerEnable: "octant:private-listener:enable",
  privateListenerDisable: "octant:private-listener:disable",
  privateListenerRestart: "octant:private-listener:restart",
  remotePairingTicket: "octant:remote-device:pairing-ticket",
  remotePairingRequests: "octant:remote-device:pairing-requests",
  remotePairingApprove: "octant:remote-device:pairing-approve",
  remotePairingDeny: "octant:remote-device:pairing-deny",
  remoteDeviceInventory: "octant:remote-device:inventory",
  remoteDeviceRename: "octant:remote-device:rename",
  remoteDeviceRevoke: "octant:remote-device:revoke",
  remoteDeviceRevokeAll: "octant:remote-device:revoke-all",
  remoteDeviceReconcileExpired: "octant:remote-device:reconcile-expired",
  hubAdministrationRequest: "octant:hub-administration:request",
  ownerUnlockMake: "octant:owner-unlock:make",
  ownerUnlockSign: "octant:owner-unlock:sign",
  ownerUnlockForget: "octant:owner-unlock:forget",
  remoteHostIdentityStatus: "octant:remote-host-identity:status",
  remoteHostIdentityRotate: "octant:remote-host-identity:rotate",
  remoteHostIdentityRecover: "octant:remote-host-identity:recover",
  pairedComputerPair: "octant:paired-computers:pair",
  pairedComputerList: "octant:paired-computers:list",
  pairedComputerForget: "octant:paired-computers:forget",
  pairedComputerSettle: "octant:paired-computers:settle",
  pairedComputerRequest: "octant:paired-computers:request",
  remoteServerPageOpen: "octant:remote-server-page:open",
  remoteServerPageSign: "octant:remote-server-page:sign",
  remoteServerPageSigned: "octant:remote-server-page:signed",
  remoteServerPageForgetHost: "octant:remote-server-page:forget-host",
} as const;

/** The most a renderer may hand the host as a provider credential. */
export const MAX_PROVIDER_CREDENTIAL_BYTES = 12 * 1_024;

/**
 * Marks a message the main process wrote from its own advice table for a
 * keyring that would not take a key. The preload hands the window the sentence
 * after the marker and nothing else a store said, and the window shows only
 * sentences it recognises from the same table.
 */
export const KEYRING_ADVICE_MARKER = "keyring-advice: ";

/** Provider instance ids as the bridge accepts them: a plain UUID, any version bits. */
export const PROVIDER_INSTANCE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const OPEN_IN_APPLICATION_IDS: ReadonlySet<string> = new Set([
  "vscode",
  "cursor",
  "zed",
  "finder",
  "terminal",
  "ghostty",
  "xcode",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireBridgeUuid(value: unknown): string {
  if (typeof value !== "string" || !PROVIDER_INSTANCE_ID_PATTERN.test(value)) {
    throw new TypeError("Invalid Code external editor request.");
  }
  return value;
}

function requireBridgePositiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("Invalid Code external editor request.");
  }
  return value;
}

/**
 * Decodes the external-editor request at the process boundary it enters. The
 * server route re-validates the same shape with the same rules; the decode
 * here keeps a malformed renderer payload from crossing the bridge at all.
 */
export function decodeCodeExternalEditorRequest(value: unknown): CodeExternalEditorRequest {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join("\0") !==
      ["threadId", "checkoutId", "fileId", "line", "column"].sort().join("\0")
  ) {
    throw new TypeError("Invalid Code external editor request.");
  }
  return {
    threadId: requireBridgeUuid(value.threadId),
    checkoutId: requireBridgeUuid(value.checkoutId),
    fileId: requireBridgeUuid(value.fileId),
    line: requireBridgePositiveInteger(value.line),
    column: requireBridgePositiveInteger(value.column),
  };
}

/** Decodes the Open-in request at the process boundary it enters. */
export function decodeCodeCheckoutOpenRequest(value: unknown): CodeCheckoutOpenRequest {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join("\0") !== ["threadId", "applicationId"].sort().join("\0") ||
    typeof value.applicationId !== "string" ||
    !OPEN_IN_APPLICATION_IDS.has(value.applicationId)
  ) {
    throw new TypeError("Invalid Code checkout Open in request.");
  }
  return {
    threadId: requireBridgeUuid(value.threadId),
    applicationId: value.applicationId as OpenInApplicationId,
  };
}
