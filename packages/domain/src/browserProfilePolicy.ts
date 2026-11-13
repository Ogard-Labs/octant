import {
  ANY_BROWSER_ORIGIN,
  decodeBrowserAccountProfileId,
  type BrowserProfileChoice,
  type ProjectId,
} from "@octant/contracts";
import type {
  BrowserContextId,
  BrowserProfile,
  BrowserProfileRefusalReason,
  RememberedBrowserProfileSite,
  StoredBrowserProfile,
  ToolActionAuthority,
} from "@octant/contracts";

/** The Electron partition a stored profile keeps its site data in. */
const PERSONAL_PARTITION = "persist:octant-profile-personal";
const PROJECT_PARTITION_PREFIX = "persist:octant-profile-project-";
const ACCOUNT_PARTITION_PREFIX = "persist:octant-profile-account-";
const PRIVATE_PARTITION_PREFIX = "octant-browser-";
const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A profile that writes to disk; Private has no store to name. */
export function storedBrowserProfile(
  profile: BrowserProfile | undefined,
): StoredBrowserProfile | undefined {
  if (profile === undefined || profile.kind === "private") return undefined;
  return profile;
}

/** One stable string per profile, for maps and for comparing without unbranding ids. */
export function browserProfileKey(profile: BrowserProfile | undefined): string {
  if (profile === undefined || profile.kind === "private") return "private";
  if (profile.kind === "personal") return "personal";
  if (profile.kind === "account") return `account:${String(profile.profileId)}`;
  return `project:${String(profile.projectId)}`;
}

export function sameBrowserProfile(
  a: BrowserProfile | undefined,
  b: BrowserProfile | undefined,
): boolean {
  return browserProfileKey(a) === browserProfileKey(b);
}

/**
 * Where a page keeps its cookies and site data.
 *
 * A Private page keeps the in-memory partition of its own browsing context; a
 * stored profile keeps one persistent partition no matter how many contexts
 * open in it, which is what lets two pages of one profile share a sign-in.
 */
export function browserProfilePartition(
  profile: BrowserProfile | undefined,
  contextId: BrowserContextId | string,
): string {
  if (profile === undefined || profile.kind === "private") {
    return `${PRIVATE_PARTITION_PREFIX}${String(contextId)}`;
  }
  if (profile.kind === "personal") return PERSONAL_PARTITION;
  if (profile.kind === "account")
    return `${ACCOUNT_PARTITION_PREFIX}${String(profile.profileId).toLowerCase()}`;
  return `${PROJECT_PARTITION_PREFIX}${String(profile.projectId).toLowerCase()}`;
}

/**
 * The profile a persistent partition directory name belongs to, or undefined
 * for a folder that is not one of Octant's profile stores. Electron names the
 * folder under `Partitions` after the partition without its `persist:` prefix.
 */
export function storedBrowserProfileOfPartitionFolder(
  folder: string,
):
  | { readonly kind: "account"; readonly profileId: string }
  | { readonly kind: "personal" }
  | { readonly kind: "project"; readonly projectId: string }
  | undefined {
  if (folder === PERSONAL_PARTITION.slice("persist:".length)) return { kind: "personal" };
  const accountPrefix = ACCOUNT_PARTITION_PREFIX.slice("persist:".length);
  if (folder.startsWith(accountPrefix)) {
    const profileId = folder.slice(accountPrefix.length);
    return PROJECT_ID_PATTERN.test(profileId) ? { kind: "account", profileId } : undefined;
  }
  const prefix = PROJECT_PARTITION_PREFIX.slice("persist:".length);
  if (!folder.startsWith(prefix)) return undefined;
  const projectId = folder.slice(prefix.length);
  return PROJECT_ID_PATTERN.test(projectId) ? { kind: "project", projectId } : undefined;
}

/** The folder under `Partitions` that holds a stored profile. */
export function browserProfilePartitionFolder(profile: StoredBrowserProfile): string {
  return browserProfilePartition(profile, "").slice("persist:".length);
}

export type BrowserProfileCaller =
  /** The person at a local window. */
  | "person"
  /** A paired device. */
  | "remote-device"
  /** A routine, goal loop, or subagent turn: nobody is at the machine. */
  | "unattended"
  /** A CLI typed into a thread terminal. */
  | "terminal-grant";

export type BrowserProfileDecision =
  | { readonly kind: "allowed" }
  | {
      readonly kind: "refused";
      readonly reason: BrowserProfileRefusalReason;
      readonly message: string;
    };

/**
 * Whether a caller may put a page in a profile.
 *
 * A stored profile holds sign-ins, so it opens only for the person at a local
 * window or an explicitly delegated session, only in a desktop Browser (a headless copy would hold different
 * cookies from the native one), only for a Work or Code Project the thread
 * actually belongs to, and never for Chat, which has no Browser. Private is
 * always allowed here; it carries no sign-in.
 */
export function evaluateBrowserProfileUse(input: {
  readonly profile: BrowserProfile | undefined;
  readonly caller: BrowserProfileCaller;
  /** Verified by the host for the exact caller/profile/sites; never a wire request field. */
  readonly delegatedSession?: boolean;
  /** Whether the desktop app's own Browser can hold this page. */
  readonly nativeBrowserAvailable: boolean;
  readonly authority?: Pick<ToolActionAuthority, "mode" | "projectId">;
}): BrowserProfileDecision {
  const stored = storedBrowserProfile(input.profile);
  if (stored === undefined) return { kind: "allowed" };
  if (input.caller === "remote-device") {
    return refused("profile-not-local", "Signed-in pages open only on this Mac.");
  }
  if (
    (input.caller === "unattended" || input.caller === "terminal-grant") &&
    input.delegatedSession !== true
  ) {
    return refused(
      "profile-needs-a-person",
      "A signed-in page needs a person at this Mac; this turn has none.",
    );
  }
  if (!input.nativeBrowserAvailable) {
    return refused(
      "profile-unavailable",
      "Signed-in pages open only in the Octant app's own Browser.",
    );
  }
  if (input.authority !== undefined) {
    if (input.authority.mode === "chat") {
      return refused("profile-unavailable", "Chat has no Browser profiles.");
    }
    if (
      stored.kind === "project" &&
      String(input.authority.projectId ?? "") !== String(stored.projectId)
    ) {
      return refused(
        "profile-unavailable",
        "This thread belongs to another Project, so it cannot use that Project's profile.",
      );
    }
  }
  return { kind: "allowed" };
}

/**
 * Whether the person's remembered answers cover a site in exactly this
 * profile: the pair itself, or "Allow all sites in this profile".
 */
export function isBrowserProfileSiteRemembered(
  remembered: ReadonlyArray<RememberedBrowserProfileSite>,
  origin: string,
  profile: StoredBrowserProfile,
): boolean {
  return (
    browserProfileSiteListed(remembered, origin, profile) ||
    browserProfileSiteListed(remembered, ANY_BROWSER_ORIGIN, profile)
  );
}

/**
 * Whether this exact entry is in the list. Growing and forgetting compare
 * entries, not coverage: a profile allowed for all sites must not let a
 * settings write add a pair the approval never showed.
 */
export function browserProfileSiteListed(
  remembered: ReadonlyArray<RememberedBrowserProfileSite>,
  origin: string,
  profile: StoredBrowserProfile,
): boolean {
  const key = browserProfileKey(profile);
  return remembered.some(
    (entry) => entry.origin === origin && browserProfileKey(entry.profile) === key,
  );
}

/**
 * A settings write may forget remembered profile sites but never add one: the
 * set grows only through the approval answer, so a client cannot grant itself a
 * site the prompt never showed.
 */
export function resolveRememberedBrowserProfileSites(
  current: ReadonlyArray<RememberedBrowserProfileSite>,
  replacement: ReadonlyArray<RememberedBrowserProfileSite> | undefined,
):
  | { readonly kind: "kept"; readonly sites: ReadonlyArray<RememberedBrowserProfileSite> }
  | {
      readonly kind: "rejected";
    } {
  if (replacement === undefined) return { kind: "kept", sites: current };
  const added = replacement.some(
    (entry) => !browserProfileSiteListed(current, entry.origin, entry.profile),
  );
  return added ? { kind: "rejected" } : { kind: "kept", sites: replacement };
}

function refused(reason: BrowserProfileRefusalReason, message: string): BrowserProfileDecision {
  return { kind: "refused", reason, message };
}

/** Resolve a person's explicit choice; a Project choice always means this Project. */
export function browserProfileFromChoice(
  choice: BrowserProfileChoice,
  projectId: ProjectId | undefined,
): BrowserProfile | undefined {
  if (choice === "private") return { kind: "private" };
  if (choice === "personal") return { kind: "personal" };
  if (choice === "project")
    return projectId === undefined ? undefined : { kind: "project", projectId };
  return {
    kind: "account",
    profileId: decodeBrowserAccountProfileId(choice.slice("account:".length)),
  };
}

export function browserProfileChoiceOf(profile: BrowserProfile | undefined): BrowserProfileChoice {
  if (profile === undefined || profile.kind === "private") return "private";
  return profile.kind === "account" ? `account:${String(profile.profileId)}` : profile.kind;
}
