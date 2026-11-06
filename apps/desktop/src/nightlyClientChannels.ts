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
  approvalSurfacePalette: "brokered",
  clearProviderCredential: "brokered",
  codeDeepLink: "local",
  close: "local",
  projectWindowCapability: "local",
  maximizeOrRestore: "local",
  minimize: "local",
  openCodeExternalEditor: "brokered",
  listOpenInApplications: "local",
  openCodeCheckoutInApplication: "brokered",
  openInNewWindow: "local",
  openSettings: "local",
  quitShortcutHint: "local",
  previewHandoff: "brokered",
  requestCodeOperationApproval: "brokered",
  updateCodeOperationApprovalAnchor: "brokered",
  cancelCodeOperationApproval: "brokered",
  startNewAgent: "local",
  providerCredentialStatus: "brokered",
  resetBounds: "local",
  selectProjectRoot: "brokered",
  selectLocalPluginFolder: "brokered",
  selectSkillFolder: "brokered",
  selectRuntimeBinary: "brokered",
  saveSupportBundle: "brokered",
  saveBrowserProofScreenshots: "local",
  windowCaptureList: "local",
  windowCapturePermission: "local",
  windowCaptureTake: "local",
  setProviderCredential: "brokered",
  listProviderApiKeys: "brokered",
  addProviderApiKey: "brokered",
  renameProviderApiKey: "brokered",
  replaceProviderApiKey: "brokered",
  removeProviderApiKey: "brokered",
  setActiveProviderApiKey: "brokered",
  moveProviderApiKey: "brokered",
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

/** The class of a channel value; an unlisted channel is treated as Octant-only. */
export function nightlyClientChannelClass(channel: string): NightlyChannelClass {
  return CLASS_BY_CHANNEL.get(channel) ?? "octant-only";
}

/**
 * What a Nightly client says when it refuses a channel it does not answer.
 * "Needs a newer Octant" is kept for a host that lacks a feature Nightly
 * asks for; none of these refusals is that case.
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
