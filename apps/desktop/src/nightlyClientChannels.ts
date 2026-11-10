import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";

/**
 * How an Octant Nightly client window treats each desktop channel.
 *
 * - `local`: Nightly's own main process answers it.
 * - `brokered`: it needs Octant's host and will reach it through the native
 *   window lease; until then Nightly refuses it as not available yet.
 * - `octant-only`: administration that stays with Octant (remote access,
 *   pairing, hubs, owner unlock, host identity, installing Nightly). The
 *   Nightly client bridge omits it, so its screens are hidden.
 * - `replaced`: Nightly reaches the same outcome another way, such as the
 *   Browser's human presentation instead of an attached native view.
 *
 * Only Nightly's client mode reads this table. Nightly's test-host mode runs
 * the full host-owning main and keeps every channel.
 */
export type NightlyChannelClass = "local" | "brokered" | "octant-only" | "replaced";

type ChannelKey = keyof typeof DESKTOP_IPC_CHANNELS;

export const NIGHTLY_CLIENT_CHANNELS = {
  nativeMenu: "local",
  menuBarOpenThread: "local",
  menuBarTask: "local",
  attentionBadge: "local",
  attentionNotify: "local",
  browserHumanPresentation: "local",
  browserSurfaceAttach: "replaced",
  browserSurfaceBounds: "replaced",
  browserSurfaceCommand: "local",
  browserSurfaceDetach: "replaced",
  browserSurfaceOpenExternal: "local",
  browserSurfaceState: "replaced",
  browserSurfaceTab: "local",
  browserSurfacePoint: "brokered",
  browserExtensionPopupOpen: "brokered",
  browserExtensionPopupClose: "brokered",
  browserExtensionTabs: "brokered",
  browserExtensionActionClicked: "brokered",
  canvasPrototypeSurface: "brokered",
  canvasPrototypeOpen: "brokered",
  canvasPrototypeInput: "brokered",
  canvasPrototypeResize: "brokered",
  canvasPrototypeClose: "brokered",
  canvasPrototypeDrawn: "brokered",
  canvasPrototypeEvent: "brokered",
  appUpdateState: "local",
  appUpdateCheck: "local",
  appUpdateDownload: "local",
  appUpdateInstall: "local",
  appUpdateAutomatic: "local",
  computerUseTest: "octant-only",
  computerUseStatus: "brokered",
  computerUsePermissions: "brokered",
  computerUsePermissionSettings: "brokered",
  computerUseCheckUpdates: "brokered",
  managedToolsStatus: "brokered",
  managedToolsCheckUpdates: "brokered",
  managedToolsConfigure: "brokered",
  appUpdateRing: "local",
  appUpdateWhatsNew: "local",
  appUpdateWhatsNewAck: "local",
  nightlyInstallState: "octant-only",
  nightlyInstall: "octant-only",
  nightlyInstallOpen: "octant-only",
  nightlyInstallRemove: "octant-only",
  nightlyDataState: "local",
  nightlyDataChoose: "local",
  nightlyDataRemove: "local",
  nightlyDataRelaunch: "local",
  approvalSurfacePalette: "local",
  clearProviderCredential: "local",
  codeDeepLink: "local",
  close: "local",
  projectWindowCapability: "local",
  maximizeOrRestore: "local",
  minimize: "local",
  openCodeExternalEditor: "local",
  listOpenInApplications: "local",
  openCodeCheckoutInApplication: "local",
  openInNewWindow: "brokered",
  openSettings: "local",
  quitShortcutHint: "local",
  // Prepare to shut down moves threads through Octant's hub administration.
  prepareToShutDown: "octant-only",
  shutdownMovesOffered: "octant-only",
  shutdownProgress: "octant-only",
  requestQuit: "octant-only",
  previewHandoff: "local",
  requestCodeOperationApproval: "local",
  updateCodeOperationApprovalAnchor: "local",
  cancelCodeOperationApproval: "local",
  startNewAgent: "local",
  providerCredentialStatus: "local",
  resetBounds: "local",
  selectProjectRoot: "local",
  selectLocalPluginFolder: "local",
  selectSkillFolder: "local",
  selectRuntimeBinary: "local",
  saveSupportBundle: "local",
  saveBrowserProofScreenshots: "local",
  windowCaptureList: "local",
  windowCapturePermission: "local",
  windowCaptureTake: "local",
  setProviderCredential: "local",
  listProviderApiKeys: "local",
  addProviderApiKey: "local",
  renameProviderApiKey: "local",
  replaceProviderApiKey: "local",
  removeProviderApiKey: "local",
  setActiveProviderApiKey: "local",
  moveProviderApiKey: "local",
  hostCapabilities: "local",
  resolvedMaterial: "local",
  resolvedSidebarVibrancy: "local",
  sidebarMaterialPreference: "local",
  sidebarVibrancyMode: "local",
  privateListenerStatus: "octant-only",
  privateListenerEnable: "octant-only",
  privateListenerDisable: "octant-only",
  privateListenerRestart: "octant-only",
  remotePairingTicket: "octant-only",
  remotePairingRequests: "octant-only",
  remotePairingApprove: "octant-only",
  remotePairingDeny: "octant-only",
  remoteDeviceInventory: "octant-only",
  remoteDeviceRename: "octant-only",
  remoteDeviceRevoke: "octant-only",
  remoteDeviceRevokeAll: "octant-only",
  remoteDeviceReconcileExpired: "octant-only",
  hubAdministrationRequest: "octant-only",
  threadMoveOpenThere: "octant-only",
  ownerUnlockMake: "octant-only",
  ownerUnlockSign: "octant-only",
  ownerUnlockForget: "octant-only",
  remoteHostIdentityStatus: "octant-only",
  remoteHostIdentityRotate: "octant-only",
  remoteHostIdentityRecover: "octant-only",
  pairedComputerPair: "octant-only",
  pairedComputerList: "octant-only",
  pairedComputerForget: "octant-only",
  pairedComputerSettle: "octant-only",
  pairedComputerRequest: "octant-only",
  remoteServerPageOpen: "octant-only",
  remoteServerPageSign: "octant-only",
  remoteServerPageSigned: "octant-only",
  remoteServerPageForgetHost: "octant-only",
} as const satisfies Readonly<Record<ChannelKey, NightlyChannelClass>>;

const CLASS_BY_CHANNEL: ReadonlyMap<string, NightlyChannelClass> = new Map(
  (Object.keys(DESKTOP_IPC_CHANNELS) as ChannelKey[]).map((key) => [
    DESKTOP_IPC_CHANNELS[key],
    NIGHTLY_CLIENT_CHANNELS[key],
  ]),
);

/**
 * Local channels Nightly's main sends to the renderer rather than answers:
 * menu commands, Code links, the resolved sidebar material and a menu-bar task.
 */
export const NIGHTLY_CLIENT_PUSH_CHANNELS: ReadonlySet<string> = new Set([
  DESKTOP_IPC_CHANNELS.menuBarTask,
  DESKTOP_IPC_CHANNELS.openSettings,
  DESKTOP_IPC_CHANNELS.quitShortcutHint,
  DESKTOP_IPC_CHANNELS.startNewAgent,
  DESKTOP_IPC_CHANNELS.codeDeepLink,
  DESKTOP_IPC_CHANNELS.resolvedMaterial,
  DESKTOP_IPC_CHANNELS.resolvedSidebarVibrancy,
]);

/**
 * Where Nightly's answered channels and its table disagree: an answered
 * channel the table does not mark local, or a local channel that is neither
 * answered, sent to the renderer, nor withheld on purpose (Data on a platform
 * that does not offer it). Nightly refuses to start while either list is
 * non-empty.
 */
export function nightlyClientChannelGaps(
  answered: ReadonlySet<string>,
  withheld: ReadonlySet<string>,
): { readonly unmarked: ReadonlyArray<string>; readonly unanswered: ReadonlyArray<string> } {
  const channels = Object.values(DESKTOP_IPC_CHANNELS);
  return {
    unmarked: channels.filter(
      (channel) => answered.has(channel) && nightlyClientChannelClass(channel) !== "local",
    ),
    unanswered: channels.filter(
      (channel) =>
        nightlyClientChannelClass(channel) === "local" &&
        !answered.has(channel) &&
        !NIGHTLY_CLIENT_PUSH_CHANNELS.has(channel) &&
        !withheld.has(channel),
    ),
  };
}

/** The class of a channel value; an unlisted channel is treated as Octant-only. */
export function nightlyClientChannelClass(channel: string): NightlyChannelClass {
  return CLASS_BY_CHANNEL.get(channel) ?? "octant-only";
}

export { NEEDS_NEWER_OCTANT } from "./ipcChannels";

/**
 * What a Nightly client says when it refuses a channel it does not answer.
 * None of these refusals is the missing-feature case above.
 */
export function nightlyClientRefusal(channelClass: NightlyChannelClass): string {
  switch (channelClass) {
    case "octant-only":
      return "Managed in Octant. Open Octant to change this.";
    case "replaced":
      return "Octant Nightly shows this through its own Browser presentation.";
    case "brokered":
    case "local":
      return "Not available in Octant Nightly yet.";
  }
}
