import type { StoredBrowserProfile } from "@octant/contracts/browser-profiles";
import type { BrowserProfileChoice } from "@octant/contracts/project-browser";

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
}): string {
  if (approval.profile === undefined) return `Allow Browser to open ${approval.origin}?`;
  return `Let the agent use ${approval.origin} in the ${BROWSER_PROFILE_LABELS[approval.profile.kind]} profile?`;
}

export function browserApprovalDetail(approval: {
  readonly profile?: StoredBrowserProfile | undefined;
}): string {
  return approval.profile === undefined
    ? "Shell and file access stay unchanged"
    : "This page may be signed in as you. Reading it reads your account. Shell and file access stay unchanged";
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
