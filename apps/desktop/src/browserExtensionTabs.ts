import type { StoredBrowserProfile } from "@octant/contracts";
import type { ProfileTab, ProfileTabResult } from "./browserSurfaceHost";

/** The pages a profile has in a window, and the only ways an extension may change them. */
export interface ExtensionTabsSurface {
  profileTabs(profile: StoredBrowserProfile, windowId: string): ReadonlyArray<ProfileTab>;
  openProfileTab(
    profile: StoredBrowserProfile,
    windowId: string,
    url: string | undefined,
  ): Promise<ProfileTabResult>;
  updateProfileTab(
    profile: StoredBrowserProfile,
    windowId: string,
    id: number,
    change: { readonly url?: string; readonly active?: boolean },
  ): Promise<ProfileTabResult>;
}

/** Who is asking: an enabled extension of one profile, acting in one window. */
export interface ExtensionTabsCaller {
  readonly profile: StoredBrowserProfile;
  readonly windowId: string;
  /** Whether the extension asked for `tabs`, which is what shows an address or a title. */
  readonly seesTabAddresses: boolean;
}

export type ExtensionTabsAnswer =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };

export interface ExtensionTab {
  readonly id: number;
  readonly index: number;
  readonly windowId: number;
  readonly active: boolean;
  readonly highlighted: boolean;
  readonly pinned: false;
  readonly incognito: false;
  readonly url?: string;
  readonly title?: string;
}

const METHODS = ["query", "get", "create", "update", "authorize"] as const;
type Method = (typeof METHODS)[number];

/** The reasons an answer can be a refusal, in the words an extension sees. */
const REFUSALS = {
  noTab: (id: number) => `No tab with id: ${String(id)}.`,
  noPage: "This profile has no page open in this window.",
  origin: "Octant opens only pages this window's profile page already allows.",
  limit: "This window has no room for another tab.",
} as const;

/**
 * The part of `chrome.tabs` a popup needs, answered for one profile in one
 * window. A profile's pages are the only pages an extension in it can see or
 * change: the surface host never lists a Private page or another profile's
 * page, so a tab id from elsewhere is just unknown. An address or title is
 * shown only to an extension that asked for `tabs`, as in Chrome. Anything
 * beyond these calls is not a call at all and is refused by name.
 */
export function createExtensionTabsService(surface: ExtensionTabsSurface) {
  const view = (caller: ExtensionTabsCaller, tab: ProfileTab, index: number): ExtensionTab => ({
    id: tab.id,
    index,
    windowId: 1,
    active: tab.active,
    highlighted: tab.active,
    pinned: false,
    incognito: false,
    ...(caller.seesTabAddresses ? { url: tab.url, title: tab.title } : {}),
  });
  const answer = (caller: ExtensionTabsCaller, result: ProfileTabResult): ExtensionTabsAnswer => {
    if (result.status === "tab") {
      const index = surface
        .profileTabs(caller.profile, caller.windowId)
        .findIndex((tab) => tab.id === result.tab.id);
      return { ok: true, value: view(caller, result.tab, Math.max(0, index)) };
    }
    if (result.status === "origin-refused") return refused(REFUSALS.origin);
    if (result.status === "tab-limit") return refused(REFUSALS.limit);
    return refused(REFUSALS.noPage);
  };

  return Object.freeze({
    async handle(caller: ExtensionTabsCaller, request: unknown): Promise<ExtensionTabsAnswer> {
      const parsed = parse(request);
      if (typeof parsed === "string") return refused(parsed);
      const tabs = surface.profileTabs(caller.profile, caller.windowId);
      const [first, second] = parsed.args;
      switch (parsed.method) {
        case "query": {
          const filter = queryFilter(first);
          if (typeof filter === "string") return refused(filter);
          const found = tabs
            .map((tab, index) => view(caller, tab, index))
            .filter((tab) => filter.active === undefined || tab.active === filter.active);
          return { ok: true, value: found };
        }
        case "get": {
          const index = tabs.findIndex((tab) => tab.id === first);
          const tab = tabs[index];
          return tab === undefined
            ? refused(REFUSALS.noTab(Number(first)))
            : { ok: true, value: view(caller, tab, index) };
        }
        case "authorize":
          return tabs.some((tab) => tab.id === first)
            ? { ok: true, value: null }
            : refused(REFUSALS.noTab(Number(first)));
        case "create": {
          const change = tabChange(first, false);
          if (typeof change === "string") return refused(change);
          return answer(
            caller,
            await surface.openProfileTab(caller.profile, caller.windowId, change.url),
          );
        }
        case "update": {
          // `update(properties)` acts on the active tab; `update(tabId, properties)` on that one.
          const target = typeof first === "number" ? first : tabs.find((tab) => tab.active)?.id;
          const change = tabChange(typeof first === "number" ? second : first, true);
          if (typeof change === "string") return refused(change);
          if (target === undefined) return refused(REFUSALS.noPage);
          if (!tabs.some((tab) => tab.id === target)) return refused(REFUSALS.noTab(target));
          return answer(
            caller,
            await surface.updateProfileTab(caller.profile, caller.windowId, target, change),
          );
        }
      }
    },
  });
}

function refused(error: string): ExtensionTabsAnswer {
  return { ok: false, error };
}

function parse(request: unknown): { method: Method; args: ReadonlyArray<unknown> } | string {
  if (typeof request !== "object" || request === null) return "Octant rejected the tabs call.";
  const { method, args, ...rest } = request as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || !Array.isArray(args) || args.length > 3) {
    return "Octant rejected the tabs call.";
  }
  const named = METHODS.find((entry) => entry === method);
  return named === undefined
    ? `chrome.tabs.${typeof method === "string" ? method.slice(0, 40) : "?"} is not supported here.`
    : { method: named, args };
}

function queryFilter(value: unknown): { active?: boolean } | string {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null) return "tabs.query needs a query object.";
  const filter: { active?: boolean } = {};
  for (const [key, entry] of Object.entries(value)) {
    if ((key === "currentWindow" || key === "lastFocusedWindow") && entry === true) continue;
    if (key === "active" && typeof entry === "boolean") {
      filter.active = entry;
      continue;
    }
    return `chrome.tabs.query does not support "${key.slice(0, 40)}" here.`;
  }
  return filter;
}

/** What a created or updated tab may carry: an address, and being brought to the front. */
function tabChange(
  value: unknown,
  allowActive: boolean,
): { url?: string; active?: boolean } | string {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null) return "The tab properties are not an object.";
  const change: { url?: string; active?: boolean } = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "url" && typeof entry === "string" && webAddress(entry)) {
      change.url = entry;
    } else if (key === "active" && entry === true) {
      // A new tab is always brought to the front, so only an update needs to say so.
      if (allowActive) change.active = true;
    } else {
      return `The tab property "${key.slice(0, 40)}" is not supported here.`;
    }
  }
  return change;
}

/** A page address an extension may open: the web, or a blank page. */
function webAddress(value: string): boolean {
  if (value === "about:blank") return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
