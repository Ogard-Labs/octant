import type { StoredBrowserProfile } from "@octant/contracts/browser-profiles";
import type { BrowserProfileChoice } from "@octant/contracts/project-browser";

/** The files an upload approval names; see the Browser approval contract. */
interface BrowserUploadRequest {
  readonly files: ReadonlyArray<{ readonly name: string; readonly sizeBytes: number }>;
}

/** The words a person sees for a profile choice. */
export const BROWSER_PROFILE_LABELS: Readonly<Record<BrowserProfileChoice, string>> = {
  private: "Private",
  project: "Project",
  personal: "Personal",
};

export const BROWSER_PROFILE_DESCRIPTIONS: Readonly<Record<BrowserProfileChoice, string>> = {
  private: "Forgotten when the page closes. Nothing is signed in.",
  project: "Shared by every page of this Project. Sign in once.",
  personal: "Shared by every Project that chooses it. Kept on this Mac.",
};

export function profileChoiceOf(profile: StoredBrowserProfile | undefined): BrowserProfileChoice {
  return profile === undefined ? "private" : profile.kind;
}

/**
 * The question a signed-in page raises. It names the site and the profile,
 * because the page acts as the person's account there.
 */
export function browserApprovalSummary(approval: {
  readonly origin: string;
  readonly profile?: StoredBrowserProfile | undefined;
  readonly upload?: BrowserUploadRequest | undefined;
}): string {
  if (approval.upload !== undefined) {
    const named = approval.upload.files
      .map((file) => `${file.name} (${formatProfileSize(file.sizeBytes)})`)
      .join(", ");
    return `Let the agent upload ${named} to ${approval.origin}?`;
  }
  if (approval.profile === undefined) return `Allow Browser to open ${approval.origin}?`;
  return `Let the agent use ${approval.origin} in the ${BROWSER_PROFILE_LABELS[approval.profile.kind]} profile?`;
}

export function browserApprovalDetail(approval: {
  readonly profile?: StoredBrowserProfile | undefined;
  readonly extensionCount?: number | undefined;
  readonly upload?: BrowserUploadRequest | undefined;
}): string {
  if (approval.upload !== undefined) {
    return "The files leave this computer for that site. This answer covers these files once";
  }
  if (approval.profile === undefined) return "Shell and file access stay unchanged";
  const extensions =
    approval.extensionCount === undefined || approval.extensionCount < 1
      ? ""
      : `${
          approval.extensionCount === 1
            ? "1 extension is"
            : `${String(approval.extensionCount)} extensions are`
        } on in this profile and can read what the agent reads. `;
  return `This page may be signed in as you. Reading it reads your account. ${extensions}Shell and file access stay unchanged`;
}

const STORAGE_PREFIX = "octant.browser.profile.";

/** The person's last choice for a Project's new pages, kept in this renderer only. */
export function readRememberedProfileChoice(projectKey: string): BrowserProfileChoice {
  try {
    const stored = globalThis.localStorage?.getItem(`${STORAGE_PREFIX}${projectKey}`);
    return stored === "project" || stored === "personal" ? stored : "private";
  } catch {
    return "private";
  }
}

export function writeRememberedProfileChoice(
  projectKey: string,
  choice: BrowserProfileChoice,
): void {
  try {
    globalThis.localStorage?.setItem(`${STORAGE_PREFIX}${projectKey}`, choice);
  } catch {
    // Remembering is a convenience; the page still opens in the chosen profile.
  }
}

export function formatProfileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
