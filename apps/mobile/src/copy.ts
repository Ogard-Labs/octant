/** User-facing mobile copy. Keep Octant-owned; no third-party product names. */
export const MOBILE_PRODUCT_NAME = "Octant";
export const MOBILE_PRODUCT_TAGLINE = "Remote control for your hosts";

export const MOBILE_ROUTE_IDS = ["home", "agents", "thread", "hosts"] as const;
export type MobileRouteId = (typeof MOBILE_ROUTE_IDS)[number];

export const MOBILE_TAB_LABELS = {
  home: "Inbox",
  agents: "All Agents",
  thread: "Thread",
  hosts: "Hosts",
} as const satisfies Record<MobileRouteId, string>;

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
  hostsHint: "Enter the host HTTPS origin and pairing ticket from the desktop host.",
  pairHostTitle: "Pair a host",
  pairHostBody: "Connect your laptop to create and follow Chat, Work, and Code threads.",
  pairHostCta: "Pair host",
  pairHostScreenTitle: "Pair host",
  pairHostHeadline: "Connect this phone to your laptop.",
  pairHostSubhead: "Use the short-lived ticket from desktop Remote Access.",
  pairBeforeCreate: "Pair a host before starting a thread.",
  pairRevokeNote: "Other paired devices stay connected if you revoke later.",
  allHosts: "All Hosts",
  allAgents: "All Agents",
  workspaces: "Workspaces",
  addWorkspace: "Add Workspace",
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
  needsAttention: "Needs Attention",
  inReview: "In Review",
  read: "Read",
  placementHint: "New threads use the placement host.",
  createModeChat: "Chat",
  createModeWork: "Work",
  createModeCode: "Code",
  createModeCodeHelp: "Start approval-gated Code tasks on a bound repository.",
  codeNoProject: "No available Code project on this host. Bind a repository on the host first.",
  workNoProject: "No active Work project on this host. Create one on the desktop first.",
  workInventoryOnly: "Work steering from mobile uses inventory only in this slice.",
  workReadOnlyPlaceholder: "Continue this Work thread on the desktop host.",
  codeReviewOnly: "Code review is available here; steering and edits stay on the desktop host.",
  codeReviewTitle: "Review Code on mobile",
  codeReviewEntryBody:
    "Inspect host-owned changes and checks here. Start, steer, and edit on desktop.",
  codeBrowseThreads: "Browse Code threads",
  codeReadOnlyPlaceholder: "Continue this Code thread on the desktop host.",
  hostsUnavailable: "hosts unavailable",
  approvalDesktopOnly:
    "Approve or reject on the desktop host. High-risk approval challenges stay local-host-only.",
  revokeDeviceHint:
    "Revoke removes only this phone’s registration. Other paired clients stay connected.",
  appearanceTitle: "Appearance",
  appearanceHelp:
    "Choose theme, glass or flat panels, and a Distilled atmosphere canvas or a photo from this device.",
  themeSectionTitle: "Theme",
  themeSystem: "System",
  themeLight: "Light",
  themeDark: "Dark",
  themeSystemHelp: "Match this phone’s light or dark setting.",
  surfaceSectionTitle: "Surfaces",
  surfaceGlass: "Glass",
  surfaceFlat: "Flat",
  surfaceHelp: "Glass frosts over the canvas. Flat uses solid Distilled panels.",
  backgroundSectionTitle: "Background",
  backgroundModeCodeGradient: "Atmosphere (default)",
  backgroundModeCustom: "Custom photo",
  backgroundPickImage: "Choose background photo",
  backgroundUseCodeGradient: "Use atmosphere canvas",
  backgroundClearImage: "Remove photo",
  backgroundImageSet: "Background photo applied.",
  backgroundImageCleared: "Returned to atmosphere canvas.",
  backgroundImageFailed: "Could not set background photo.",
  backgroundImageTooLarge: "That photo is too large. Try a smaller image.",
  backgroundPermissionDenied: "Photo library access is required to set a background.",
  privacySecurityTitle: "Privacy & security",
  privacySecurityHelp:
    "Biometric gates protect revoke. Push and recents stay redacted; integrity checks fail soft.",
  screenshotPrivacyHint:
    "Prefer hide-in-recents on travel phones. Native capture blocking needs a device build.",
} as const;

export function mobileThreadReadOnlyCopy(mode: "work" | "code"): {
  readonly placeholder: string;
  readonly footerHint: string;
} {
  if (mode === "code") {
    return {
      placeholder: MOBILE_COPY.codeReadOnlyPlaceholder,
      footerHint: MOBILE_COPY.codeReviewOnly,
    };
  }
  return {
    placeholder: MOBILE_COPY.workReadOnlyPlaceholder,
    footerHint: MOBILE_COPY.workInventoryOnly,
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
