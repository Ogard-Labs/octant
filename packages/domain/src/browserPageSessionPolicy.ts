import type { BrowserPageOpened, BrowserProfile } from "@octant/contracts";

/**
 * What decides whether a page is a Browser session the host records so that a
 * restart can offer it back. Only the person's own page in a thread's Browser
 * pane is one: a routine, a subagent's delivered result, a terminal grant, a
 * page the host runs for a scheduled owner, and the page a single Open of its
 * own takes keep the restore they already have, and Chat has no Browser.
 */
export interface BrowserPageRecordFacts {
  readonly mode: "chat" | "work" | "code";
  readonly dedicated: boolean;
  readonly hostRun: boolean;
  readonly unattended: boolean;
  readonly terminalGrant: boolean;
}

export function isRecordedBrowserSession(facts: BrowserPageRecordFacts): boolean {
  return (
    facts.mode !== "chat" &&
    !facts.dedicated &&
    !facts.hostRun &&
    !facts.unattended &&
    !facts.terminalGrant
  );
}

/** The kind and the one identity a record keeps of a page's profile. */
export function browserPageProfileFacts(
  profile: BrowserProfile | undefined,
): Pick<BrowserPageOpened, "profileKind" | "accountId"> {
  if (profile === undefined || profile.kind === "private") return { profileKind: "private" };
  if (profile.kind === "account") return { profileKind: "account", accountId: profile.profileId };
  return { profileKind: profile.kind };
}

/** The profile a blank page opens in, as the record names it. */
export function browserPageOfferProfile(
  page: Pick<BrowserPageOpened, "profileKind" | "projectId" | "accountId">,
): BrowserProfile {
  if (page.profileKind === "account" && page.accountId !== undefined)
    return { kind: "account", profileId: page.accountId };
  if (page.profileKind === "project") return { kind: "project", projectId: page.projectId };
  if (page.profileKind === "personal") return { kind: "personal" };
  return { kind: "private" };
}

export interface BrowserPageOfferCandidate {
  readonly pageId: string;
  readonly threadId: string;
  readonly openedAt: string;
}

/**
 * Of the pages a restart left open, one per thread is offered: the newest.
 * An older page of the same thread was already replaced by a later one, so its
 * record is superseded rather than offered a second time.
 */
export function chooseBrowserPageOffers<T extends BrowserPageOfferCandidate>(
  pages: ReadonlyArray<T>,
): { readonly offered: ReadonlyArray<T>; readonly superseded: ReadonlyArray<T> } {
  const newest = new Map<string, T>();
  for (const page of pages) {
    const held = newest.get(page.threadId);
    if (held === undefined || page.openedAt >= held.openedAt) newest.set(page.threadId, page);
  }
  const offered = [...newest.values()];
  const keep = new Set(offered.map((page) => page.pageId));
  return { offered, superseded: pages.filter((page) => !keep.has(page.pageId)) };
}
