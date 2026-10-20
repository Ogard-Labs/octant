import type { MobileHostHealthKind } from "./session/MobileHostSessionHub";

/** User-facing mobile copy. Keep Octant-owned; no third-party product names. */
export const MOBILE_PRODUCT_NAME = "Octant";
export const MOBILE_PRODUCT_TAGLINE = "Remote control for your hosts";

export const MOBILE_ROUTE_IDS = ["home", "agents", "thread", "hosts"] as const;
export type MobileRouteId = (typeof MOBILE_ROUTE_IDS)[number];

export const MOBILE_TAB_LABELS = {
  home: "Inbox",
  agents: "Agents",
  thread: "Thread",
  hosts: "Hosts",
} as const satisfies Record<MobileRouteId, string>;

export const MOBILE_HOST_HEALTH_LABELS = {
  ready: "Ready",
  stale: "Stale",
  unavailable: "Unavailable",
} as const;

export function mobileHostHealthLabel(kind: MobileHostHealthKind): string {
  if (kind === "ready" || kind === "stale" || kind === "unavailable") {
    return MOBILE_HOST_HEALTH_LABELS[kind];
  }
  return kind === "idle" ? "Idle" : kind;
}

export function mobileModelLabel(
  options: ReadonlyArray<{ readonly modelId: string; readonly label: string }>,
  modelId: string,
): string {
  return (
    options.find((option) => String(option.modelId) === String(modelId))?.label ?? String(modelId)
  );
}

export const MOBILE_COPY = {
  inboxEmpty: "Pair a host to see Chat, Work, and Code threads.",
  inboxWelcome: "Direct your hosts from anywhere.",
  inboxTitle: "Inbox",
  inboxNoThreads: "No threads yet. Start one from the composer below.",
  threadEmpty: "Select a thread from Inbox.",
  threadStart: "Start the conversation with your host.",
  threadStartHelp: "Follow-ups stream on the paired host. Pick a model, then send.",
  reasoningTitle: "Reasoning",
  toolStatusRunning: "Running",
  toolStatusDone: "Done",
  toolStatusFailed: "Failed",
  hostsEmpty: "No hosts paired yet.",
  removeHostAction: "Remove from this phone",
  removeHostHint:
    "Removing works without a connection. It deletes this phone's key for the host and does not tell the host.",
  removeHostConfirm:
    "Remove this host from this phone? The host is not told, so it still lists this device until you revoke it from the desktop.",
  removeHostConfirmAction: "Remove",
  removeHostCancel: "Cancel",
  hostKeyNotDeleted:
    "A host was removed, but its device key could not be deleted from this phone's secure storage.",
  hostsHint: "Enter the host HTTPS origin and pairing ticket from the desktop host.",
  pairCodeHint:
    "On your computer, open Settings → Remote access and scan the QR code shown there, or paste the code.",
  pairScanTitle: "Scan pairing code",
  pairScanHint: "Point the camera at the QR code in Settings → Remote access or in the terminal.",
  pairScanOtherCode:
    "That QR code isn't an Octant pairing code. Scan the one the other computer shows.",
  pairScanCameraAsk:
    "Octant needs the camera to scan the pairing QR code. You can paste the code instead.",
  pairScanCameraDenied:
    "Camera access is off for Octant. Turn it on in the system settings, or paste the pairing code instead.",
  pairHostTitle: "Pair a host",
  pairHostBody: "Connect your laptop to create and follow Chat, Work, and Code threads.",
  pairHostCta: "Pair host",
  pairHostScreenTitle: "Pair host",
  pairHostHeadline: "Connect this phone to your laptop.",
  pairHostSubhead: "Use the short-lived ticket from desktop Remote Access.",
  pairBeforeCreate: "Pair a host before starting a thread.",
  pairEnterCode: "Enter a code instead",
  pairTypeDetails: "Type the details instead",
  pairCompareHint: "Check that this code matches the one on your computer, then approve there.",
  pairCheckNow: "Check now",
  pairTryAgain: "Try again",
  pairAddressInvalid: "The address must start with https://.",
  pairTicketRequired: "Enter the pairing ticket and its secret.",
  pairFailedGeneric:
    "Pairing didn't work. Check the address and the ticket, or scan the QR code again.",
  placementHere: "New threads go here",
  placementMakeHere: "Make new threads go here",
  pairRevokeNote: "Other paired devices stay connected if you revoke later.",
  allHosts: "All hosts",
  allAgents: "Agents",
  workspaces: "Hosts",
  addWorkspace: "Add host",
  composerHome: "Plan, ask, build…",
  composerChat: "Ask your host…",
  composerWork: "Plan work in this project…",
  composerCode: "Describe a Code task…",
  composerFollowUp: "Message your host…",
  composerDisclaimer: "Threads live on your paired host — not on this phone.",
  composerDisclaimerShort: "Threads live on your host.",
  newThreadsUse: "New threads use",
  hostOwnedThread: "Host-owned thread",
  voiceLater: "Voice input comes later.",
  modelHostOnly: "Host models",
  modelUnavailable: "No host models",
  working: "Working",
  handoffWarning: "Some attachments were omitted when handing off providers on the host.",
  attachmentLabel: "Attachment",
  citationLabel: "Source",
  workListLabel: "Work",
  workRemaining: "remaining",
  workBlocked: "blocked",
  workComplete: "Complete",
  workCancel: "Cancel",
  followUpRequired: "Follow-up required",
  followUpComplete: "Complete follow-up",
  attachPermissionDenied: "Photo library permission is required to attach images.",
  attachFailed: "Could not attach that image.",
  attachPending: "Attached",
  needsAttention: "Needs you",
  inReview: "In review",
  read: "Read",
  placementHint: "New threads go to the host marked “New threads go here”.",
  createModeChat: "Chat",
  createModeWork: "Work",
  createModeCode: "Code",
  createModeCodeHelp: "Start approval-gated Code tasks on a bound repository.",
  codeNoProject: "No available Code project on this host. Bind a repository on the host first.",
  workNoProject: "No active Work project on this host. Create one on the desktop first.",
  workFollowUpHint:
    "Runs on the host in this thread's bound folder. Files and shell stay on the desktop.",
  workFollowUpPlaceholder: "Follow up on this Work thread…",
  codeFollowUpHint:
    "Runs approval-gated on the host. Approve tool use and edit files on the desktop.",
  codeReviewTitle: "Review Code on mobile",
  codeReviewEntryBody:
    "Inspect host-owned changes and checks here. Start and follow up on Code from here; approvals and edits stay on the desktop.",
  codeBrowseThreads: "Browse Code threads",
  codeFollowUpPlaceholder: "Follow up on this Code thread…",
  transcriptEmpty: "No turns yet.",
  codeEarlierTurns: "Showing the newest turns. Open the thread on the desktop for earlier ones.",
  turnRunning: "Working on the host…",
  hostsUnavailable: "hosts unavailable",
  approvalDesktopOnly:
    "Approve or reject on the desktop host. High-risk approval challenges stay local-host-only.",
  approvalAllow: "Allow",
  approvalAllowSession: "Allow this session",
  approvalDeny: "Deny",
  approvalSendFailed: "Couldn't send that. Check the connection and try again.",
  approvalReconnecting: "Reconnecting…",
  approvalBiometricUnavailable: "Set up Face ID, Touch ID or a passcode to allow from this phone.",
  approvalBiometricDenied:
    "Allow cancelled. Confirm with Face ID, Touch ID or your passcode to allow.",
  approvalAskedPlain: "This is waiting for your answer before it runs.",
  approvalChildAsked: "Allow this request for this child.",
  approvalShowAll: "Show all",
  approvalShowLess: "Show less",
  outsideContentLead: "This thread has taken in outside content",
  revokeDeviceHint:
    "Revoke removes only this phone’s registration. Other paired clients stay connected.",
  appearanceTitle: "Appearance",
  appearanceHelp:
    "Choose theme, flat or glass panels, and the Octant canvas, an atmosphere photo, or a photo from this device.",
  themeSectionTitle: "Theme",
  themeSystem: "System",
  themeLight: "Light",
  themeDark: "Dark",
  themeSystemHelp: "Match this phone’s light or dark setting.",
  surfaceSectionTitle: "Surfaces",
  surfaceGlass: "Glass",
  surfaceFlat: "Flat",
  surfaceHelp: "Flat uses solid panels like the desktop. Glass frosts over the canvas.",
  backgroundSectionTitle: "Background",
  backgroundModeCodeGradient: "Octant canvas (default)",
  backgroundModeAtmosphere: "Atmosphere",
  backgroundModeCustom: "Custom photo",
  backgroundPickImage: "Choose background photo",
  backgroundUseCodeGradient: "Use Octant canvas",
  backgroundUseAtmosphere: "Use atmosphere",
  backgroundClearImage: "Remove photo",
  backgroundImageSet: "Background photo applied.",
  backgroundImageCleared: "Returned to the Octant canvas.",
  backgroundImageFailed: "Could not set background photo.",
  backgroundImageTooLarge: "That photo is too large. Try a smaller image.",
  backgroundPermissionDenied: "Photo library access is required to set a background.",
  privacySecurityTitle: "Privacy & security",
  privacySecurityHelp:
    "Device authentication protects the vault and device revocation. Available protections are shown below.",
  screenshotPrivacyHint: "Choose how supported capture protection handles app previews.",
} as const;

/**
 * What the composer promises for a Work or Code follow-up: the turn runs on
 * the host under the thread's own authority, and the parts a phone cannot do
 * — approvals, file edits, shell — are named rather than implied.
 */
export function mobileThreadComposerCopy(mode: "work" | "code"): {
  readonly placeholder: string;
  readonly footerHint: string;
} {
  if (mode === "code") {
    return {
      placeholder: MOBILE_COPY.codeFollowUpPlaceholder,
      footerHint: MOBILE_COPY.codeFollowUpHint,
    };
  }
  return {
    placeholder: MOBILE_COPY.workFollowUpPlaceholder,
    footerHint: MOBILE_COPY.workFollowUpHint,
  };
}

export function collectMobileUserFacingCopy(): string {
  return [
    MOBILE_PRODUCT_NAME,
    MOBILE_PRODUCT_TAGLINE,
    ...Object.values(MOBILE_TAB_LABELS),
    ...Object.values(MOBILE_COPY),
  ].join("\n");
}
