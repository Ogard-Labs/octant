import type {
  BrowserToolApproval,
  BrowserToolApprovalDecision,
} from "@octant/contracts/browser-automation-rpc";
import type { MobileBrowserApprovalOutcome } from "@octant/client-runtime";
import { browserDownloadQuestion, formatBrowserDownloadSize } from "@octant/domain";

/**
 * What the phone's Browser approval card says and offers for a prompt the host
 * listed, in the words the desktop card uses. The host decides which prompts
 * this session sees; this decides only which answers are worth offering, so a
 * restricted session is never offered a "remember" the host would not keep.
 */

export interface BrowserApprovalAnswer {
  readonly id: "once" | "always" | "profile" | "deny";
  readonly label: string;
  readonly decision: Pick<BrowserToolApprovalDecision, "decision" | "remember" | "rememberProfile">;
}

export interface BrowserApprovalView {
  readonly kind: "site" | "terminal" | "upload" | "download" | "sign-in" | "script" | "page-tool";
  readonly label: string;
  /** The question, as the desktop card asks it. */
  readonly summary: string;
  readonly detail: string;
  readonly site: string;
  /** The profile the page lives in; "Private" when it is in none. */
  readonly profile: string;
  readonly direction?: "upload" | "download";
  /** Each file an upload or a download names, with its size. */
  readonly files: ReadonlyArray<string>;
  /** Why the agent asks for a sign-in, as the agent gave it. */
  readonly reason?: string;
  /** The exact script, or the arguments a page's tool is called with. */
  readonly context?: string;
  readonly answers: ReadonlyArray<BrowserApprovalAnswer>;
}

/**
 * The longest script, and the longest page-tool arguments, the contract
 * carries. A card shows either whole; longer text is never shown in full, so it
 * is never approved here.
 */
const MAX_SHOWN_SCRIPT = 8192;
const MAX_SHOWN_ARGUMENTS = 4096;

const PROFILE_WORDS = { personal: "Personal", project: "Project" } as const;

function profileWords(approval: BrowserToolApproval): string {
  const profile = approval.profile;
  if (profile === undefined) return "Private";
  if (profile.kind === "account") {
    return `${approval.profileLabel ?? "Account"} (${String(profile.profileId).slice(0, 8)})`;
  }
  return PROFILE_WORDS[profile.kind];
}

export function browserApprovalView(
  approval: BrowserToolApproval,
  options: { readonly actsAsHostPerson: boolean; readonly threadTitle?: string },
): BrowserApprovalView {
  const view = browserApprovalViewOf(approval, options);
  // A script or a page tool's arguments is approved only as seen, so text the
  // card cannot show in full leaves the person Cancel alone.
  const shownLimit = view.kind === "script" ? MAX_SHOWN_SCRIPT : MAX_SHOWN_ARGUMENTS;
  if (view.context === undefined || view.context.length <= shownLimit) return view;
  return {
    ...view,
    detail: `${view.detail}. This text is too long to show here in full, so it can only be cancelled from the phone`,
    answers: view.answers.filter((answer) => answer.id === "deny"),
  };
}

function browserApprovalViewOf(
  approval: BrowserToolApproval,
  options: { readonly actsAsHostPerson: boolean; readonly threadTitle?: string },
): BrowserApprovalView {
  const site = approval.origin;
  const profile = profileWords(approval);
  const once = (label: string): BrowserApprovalAnswer => ({
    id: "once",
    label,
    decision: { decision: "approved" },
  });
  const deny = (label: string): BrowserApprovalAnswer => ({
    id: "deny",
    label,
    decision: { decision: "denied" },
  });
  // "Always allow" is the person's: the host keeps it only from a session that
  // acts as its own person, so no other session is offered it.
  const always: ReadonlyArray<BrowserApprovalAnswer> = options.actsAsHostPerson
    ? [{ id: "always", label: "Always allow", decision: { decision: "approved", remember: true } }]
    : [];

  if (approval.pageTool !== undefined) {
    return {
      kind: "page-tool",
      label: "Browser page tool",
      summary: `Let the agent call ${site}'s tool “${approval.pageTool.name}” once?`,
      detail:
        "The page declared this tool itself. It may fill the page's form and submit it. This answer covers this call once",
      site,
      profile,
      files: [],
      context: approval.pageTool.arguments,
      answers: [once("Call once"), deny("Cancel")],
    };
  }
  if (approval.script !== undefined) {
    return {
      kind: "script",
      label: "Browser script permission",
      summary: `Run this script once on ${site}?`,
      detail: `Profile: ${profile}. This script can read and change the page using its signed-in account authority. This permission covers this exact source once. Shell and file access stay unchanged.`,
      site,
      profile,
      files: [],
      context: approval.script.source,
      answers: [once("Run once"), deny("Cancel")],
    };
  }
  if (approval.signIn !== undefined) {
    return {
      kind: "sign-in",
      label: "Browser sign-in",
      summary: `The agent asks you to sign in on ${site}`,
      detail:
        "Sign in on the Browser page yourself, then press Continue. The agent waits and never sees what you type",
      site,
      profile,
      files: [],
      ...(approval.signIn.reason === undefined ? {} : { reason: approval.signIn.reason }),
      answers: [once("Continue"), deny("Cancel")],
    };
  }
  if (approval.download !== undefined) {
    return {
      kind: "download",
      label: "Browser download approval",
      summary: browserDownloadQuestion(site, {
        name: approval.download.name,
        sizeBytes: approval.download.sizeBytes,
        mediaType: approval.download.mediaType,
        ...(approval.download.source === undefined ? {} : { source: approval.download.source }),
      }),
      detail:
        "The file comes from the page and is checked first. This answer covers this file once",
      site,
      profile,
      direction: "download",
      files: [
        `${approval.download.name} (${formatBrowserDownloadSize(approval.download.sizeBytes)})`,
      ],
      answers: [once("Save once"), ...always, deny("Deny")],
    };
  }
  if (approval.upload !== undefined) {
    const files = approval.upload.files.map(
      (file) => `${file.name} (${formatBrowserDownloadSize(file.sizeBytes)})`,
    );
    return {
      kind: "upload",
      label: "Browser upload approval",
      summary: `Let the agent upload ${files.join(", ")} to ${site}?`,
      detail: "The files leave this computer for that site. This answer covers these files once",
      site,
      profile,
      direction: "upload",
      files,
      answers: [once("Upload once"), ...always, deny("Deny")],
    };
  }
  // A terminal's grant reaches Private pages only, so a Code thread's site ask
  // that names no profile came from a program in one of its terminals, not from
  // the thread's agent. It is never offered a profile-wide answer.
  if (approval.mode === "code" && approval.profile === undefined) {
    const title = options.threadTitle === undefined ? "this thread" : `“${options.threadTitle}”`;
    return {
      kind: "terminal",
      label: "Browser request from a terminal",
      summary: `Let the terminal open ${site} in the Browser?`,
      detail: `Asked by a program in a terminal of ${title}, not by this thread's agent`,
      site,
      profile,
      files: [],
      answers: [once("Approve once"), ...always, deny("Deny")],
    };
  }
  const signedIn = approval.profile !== undefined;
  const extensions =
    approval.extensionCount === undefined
      ? ""
      : `${approval.extensionCount === 1 ? "1 extension is" : `${approval.extensionCount} extensions are`} on in this profile and can read what the agent reads. `;
  return {
    kind: "site",
    label: "Browser origin approval",
    summary: signedIn
      ? `Let the agent use ${site} in the ${profile} profile?`
      : `Allow Browser to open ${site}?`,
    detail: signedIn
      ? `This page may be signed in as you. Reading it reads your account. ${extensions}Shell and file access stay unchanged`
      : "Shell and file access stay unchanged",
    site,
    profile,
    files: [],
    answers: [
      once("Approve once"),
      ...always,
      ...(options.actsAsHostPerson && signedIn
        ? [
            {
              id: "profile" as const,
              label: "Allow all sites in this profile",
              decision: { decision: "approved" as const, rememberProfile: true },
            },
          ]
        : []),
      deny("Deny"),
    ],
  };
}

/** What the card says after an answer, or undefined when it needs no note. */
export function browserApprovalNote(
  outcome: MobileBrowserApprovalOutcome,
  view: Pick<BrowserApprovalView, "kind" | "site">,
): string | undefined {
  if (outcome === "accepted") return undefined;
  if (outcome === "refused") return "The host refused that answer. Nothing was changed.";
  const ended = "had already been answered or ended";
  switch (view.kind) {
    case "upload":
      return `The agent's upload to ${view.site} ${ended}, so nothing was sent.`;
    case "download":
      return `The agent's download from ${view.site} ${ended}, so nothing was saved.`;
    case "sign-in":
      return `The agent's sign-in request for ${view.site} ${ended}.`;
    case "terminal":
      return `The terminal's request to open ${view.site} ${ended}, so nothing was let through.`;
    default:
      return `The request for ${view.site} ${ended}, by another device or window or because it ran out.`;
  }
}
