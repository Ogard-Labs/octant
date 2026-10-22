import type { MobileHostHealthKind } from "./session/MobileHostSessionHub";

/** User-facing mobile copy. Keep Octant-owned; no third-party product names. */
export const MOBILE_PRODUCT_NAME = "Octant";
export const MOBILE_PRODUCT_TAGLINE = "Your computers, from your phone";

export const MOBILE_ROUTE_IDS = ["home", "agents", "thread", "hosts"] as const;
export type MobileRouteId = (typeof MOBILE_ROUTE_IDS)[number];

export const MOBILE_TAB_LABELS = {
  home: "Inbox",
  agents: "Agents",
  thread: "Thread",
  hosts: "Computers",
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
  inboxEmpty: "Pair a computer to see your Chat, Work and Code threads.",
  inboxWelcome: "Pick up your threads from anywhere.",
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
  removeHostHint: "Works offline. The computer keeps listing this phone until you revoke it there.",
  removeHostConfirm:
    "Remove this computer from your phone? The computer is not told, so it keeps listing this phone until you revoke it there.",
  removeHostConfirmAction: "Remove",
  removeHostCancel: "Cancel",
  hostKeyNotDeleted:
    "A host was removed, but its device key could not be deleted from this phone's secure storage.",
  hostsHint:
    "Scan the QR code from Settings → Remote access on your computer, or paste its pairing code.",
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
  pairHostTitle: "Pair a computer",
  pairHostBody: "Connect your laptop to create and follow Chat, Work, and Code threads.",
  pairHostCta: "Pair host",
  pairHostScreenTitle: "Pair host",
  pairHostHeadline: "Connect this phone to your laptop.",
  pairHostSubhead: "Use the short-lived ticket from desktop Remote Access.",
  pairBeforeCreate: "Pair a computer before starting a thread.",
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
  workspaces: "Computers",
  addWorkspace: "Add computer",
  composerHome: "Plan, ask, build…",
  composerChat: "Ask your host…",
  composerWork: "Plan work in this project…",
  composerCode: "Describe a Code task…",
  composerFollowUp: "Reply…",
  composerDisclaimerShort: "Threads live on your computer.",
  newThreadsUse: "New threads use",
  modelHostOnly: "Host models",
  modelUnavailable: "No host models",
  working: "Working",
  handoffWarning: "Some attachments were left out when the computer switched providers.",
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
  placementHint: "New threads go to the computer marked “New threads go here”.",
  createModeChat: "Chat",
  createModeWork: "Work",
  createModeCode: "Code",
  createModeCodeHelp: "Start approval-gated Code tasks on a bound repository.",
  codeNoProject: "No Code project is open on this computer. Open a repository there first.",
  workNoProject: "No active Work project on this host. Create one on the desktop first.",
  workFollowUpHint:
    "Runs on your computer in this thread's folder. Files and the shell stay there.",
  workFollowUpPlaceholder: "Follow up on this Work thread…",
  codeFollowUpHint:
    "Runs on your computer and asks before tools run. Approve and edit files there.",
  codeReviewTitle: "Review Code on mobile",
  codeReviewEntryBody:
    "Read changes and checks, start tasks, and follow up here. Approvals and edits happen on your computer.",
  codeBrowseThreads: "Browse Code threads",
  codeFollowUpPlaceholder: "Follow up on this Code thread…",
  transcriptEmpty: "No turns yet.",
  codeEarlierTurns: "Showing the newest turns. Open the thread on the desktop for earlier ones.",
  turnRunning: "Working on your computer…",
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
