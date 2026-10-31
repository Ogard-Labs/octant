import type {
  BrowserExtensionAccess,
  BrowserExtensionId,
  BrowserExtensionRefusalReason,
  BrowserExtensionSummary,
  StoredBrowserProfile,
} from "@octant/contracts";
import { browserProfileKey } from "./browserProfilePolicy";

const VERSION_PATTERN = /^\d{1,9}(\.\d{1,9}){0,3}$/;
const MAX_NAME_LENGTH = 128;
const MAX_ACCESS_ENTRIES = 128;
const MAX_ENTRY_LENGTH = 256;

export interface ExtensionManifestFacts {
  readonly name: string;
  readonly version: string;
  readonly access: BrowserExtensionAccess;
  /** Path of the toolbar popup page inside the folder, when the manifest names one. */
  readonly popupPage: string | undefined;
  readonly optionsPage: string | undefined;
}

export type ExtensionManifestDecision =
  | { readonly kind: "valid"; readonly facts: ExtensionManifestFacts }
  | {
      readonly kind: "refused";
      readonly reason: Extract<BrowserExtensionRefusalReason, "extension-unsupported" | "invalid">;
      readonly message: string;
    };

/**
 * What a manifest says, or why the host will not install it.
 *
 * Only Manifest V3 is accepted, because that is what the desktop app's Browser
 * can load. An extension that needs native messaging cannot work there, so it is
 * refused up front instead of installing and failing inside itself. What the
 * extension asks for is gathered from every place a manifest asks: API
 * permissions, host permissions, and the pages its content scripts run on.
 */
export function readExtensionManifest(manifest: unknown): ExtensionManifestDecision {
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    return invalid("The folder's manifest.json is not a manifest.");
  }
  const record = manifest as Record<string, unknown>;
  if (record.manifest_version !== 3) {
    return {
      kind: "refused",
      reason: "extension-unsupported",
      message: "Only Manifest V3 extensions can be installed.",
    };
  }
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (name === "" || name.length > MAX_NAME_LENGTH || name.startsWith("__MSG_")) {
    return invalid("The manifest needs a plain name.");
  }
  const version = typeof record.version === "string" ? record.version.trim() : "";
  if (!VERSION_PATTERN.test(version)) return invalid("The manifest needs a version like 1.2.3.");
  const permissions = [
    ...stringList(record.permissions),
    ...stringList(record.optional_permissions),
  ];
  if (permissions.includes("nativeMessaging")) {
    return {
      kind: "refused",
      reason: "extension-unsupported",
      message: "Extensions that need native messaging do not work in Octant.",
    };
  }
  const contentScriptMatches = Array.isArray(record.content_scripts)
    ? record.content_scripts.flatMap((script: unknown) =>
        typeof script === "object" && script !== null
          ? stringList((script as Record<string, unknown>).matches)
          : [],
      )
    : [];
  const hostPatterns = unique([
    ...stringList(record.host_permissions),
    ...stringList(record.optional_host_permissions),
    ...contentScriptMatches,
  ]);
  const uniquePermissions = unique(permissions);
  if (uniquePermissions.length > MAX_ACCESS_ENTRIES || hostPatterns.length > 256) {
    return invalid("The manifest asks for more than Octant will list.");
  }
  const action =
    typeof record.action === "object" ? (record.action as Record<string, unknown>) : {};
  const optionsUi =
    typeof record.options_ui === "object" ? (record.options_ui as Record<string, unknown>) : {};
  return {
    kind: "valid",
    facts: {
      name,
      version,
      access: { permissions: uniquePermissions, hostPatterns },
      popupPage: pagePath(action.default_popup),
      optionsPage: pagePath(record.options_page) ?? pagePath(optionsUi.page),
    },
  };
}

/** What the update asks for that the installed version did not. */
export function addedExtensionAccess(
  installed: BrowserExtensionAccess,
  next: BrowserExtensionAccess,
): BrowserExtensionAccess {
  return {
    permissions: next.permissions.filter((entry) => !installed.permissions.includes(entry)),
    hostPatterns: next.hostPatterns.filter((entry) => !installed.hostPatterns.includes(entry)),
  };
}

/** Whether a version asks for any permission or site pattern the installed one did not. */
export function extensionAccessWidened(
  installed: BrowserExtensionAccess,
  next: BrowserExtensionAccess,
): boolean {
  const added = addedExtensionAccess(installed, next);
  return added.permissions.length > 0 || added.hostPatterns.length > 0;
}

const PERMISSION_WORDS: Readonly<Record<string, string>> = {
  activeTab: "Use the page you are on when you click it",
  alarms: "Run things on a schedule",
  clipboardRead: "Read your clipboard",
  clipboardWrite: "Write to your clipboard",
  contextMenus: "Add items to right-click menus",
  cookies: "Read and change cookies",
  downloads: "Manage downloads",
  history: "Read your browsing history",
  notifications: "Show notifications",
  scripting: "Run scripts in pages",
  storage: "Store its own settings",
  tabs: "See the address and title of your tabs",
  webNavigation: "See how pages navigate",
  webRequest: "See and change the requests pages make",
  declarativeNetRequest: "Block or change requests pages make",
};

/**
 * The same access in plain words, for the confirmation a person reads before
 * enabling. A pattern that covers every site says so first, because that is the
 * line that matters most.
 */
export function describeExtensionAccess(access: BrowserExtensionAccess): ReadonlyArray<string> {
  const lines: string[] = [];
  const everywhere = access.hostPatterns.some(
    (pattern) =>
      pattern === "<all_urls>" ||
      pattern === "*://*/*" ||
      pattern === "http://*/*" ||
      pattern === "https://*/*",
  );
  if (everywhere) lines.push("Read and change every website you open in this profile");
  else {
    for (const pattern of access.hostPatterns) lines.push(`Read and change ${pattern}`);
  }
  for (const permission of access.permissions) {
    lines.push(PERMISSION_WORDS[permission] ?? `Use the “${permission}” permission`);
  }
  return lines;
}

type StoredExtensionEvent =
  | {
      readonly eventName: "browser.extension-installed@1" | "browser.extension-updated@1";
      readonly payload: {
        readonly extensionId: BrowserExtensionId;
        readonly name: string;
        readonly version: string;
        readonly contentHash: string;
        readonly permissions: ReadonlyArray<string>;
        readonly hostPatterns: ReadonlyArray<string>;
        readonly hasPopup: boolean;
        readonly hasOptionsPage: boolean;
      };
    }
  | {
      readonly eventName: "browser.extension-enabled@1" | "browser.extension-disabled@1";
      readonly payload: {
        readonly extensionId: BrowserExtensionId;
        readonly profile: StoredBrowserProfile;
      };
    }
  | {
      readonly eventName: "browser.extension-removed@1";
      readonly payload: { readonly extensionId: BrowserExtensionId };
    };

export type BrowserExtensionEvent = StoredExtensionEvent;

interface MutableExtension {
  summary: Omit<BrowserExtensionSummary, "enabledIn" | "needsConfirmation" | "addedAccess">;
  enabled: Map<string, StoredBrowserProfile>;
  pending: Map<string, StoredBrowserProfile>;
  added: BrowserExtensionAccess | undefined;
}

/**
 * The installed extensions and where each runs, rebuilt from the journal's
 * events in order. Nothing else holds this state, so a restart and a replay
 * agree by construction.
 *
 * An update that asks for more than the installed version took the extension out
 * of every profile it ran in and parked those profiles as needing confirmation;
 * one that asks for the same or less leaves it where it was. Enabling a profile
 * again is the confirmation.
 */
export function reduceBrowserExtensions(
  events: ReadonlyArray<BrowserExtensionEvent>,
): ReadonlyArray<BrowserExtensionSummary> {
  const extensions = new Map<string, MutableExtension>();
  for (const event of events) {
    const id = String(event.payload.extensionId);
    if (event.eventName === "browser.extension-removed@1") {
      extensions.delete(id);
      continue;
    }
    if (
      event.eventName === "browser.extension-installed@1" ||
      event.eventName === "browser.extension-updated@1"
    ) {
      const { payload } = event;
      const access: BrowserExtensionAccess = {
        permissions: payload.permissions,
        hostPatterns: payload.hostPatterns,
      };
      const summary = {
        id: payload.extensionId,
        name: payload.name,
        version: payload.version,
        contentHash: payload.contentHash,
        access,
        hasPopup: payload.hasPopup,
        hasOptionsPage: payload.hasOptionsPage,
      };
      const previous = extensions.get(id);
      if (previous === undefined || event.eventName === "browser.extension-installed@1") {
        extensions.set(id, { summary, enabled: new Map(), pending: new Map(), added: undefined });
        continue;
      }
      if (extensionAccessWidened(previous.summary.access, access)) {
        const added = addedExtensionAccess(previous.summary.access, access);
        for (const [key, profile] of previous.enabled) previous.pending.set(key, profile);
        previous.enabled.clear();
        previous.added = mergeAdded(previous.added, added);
      }
      previous.summary = summary;
      continue;
    }
    const extension = extensions.get(id);
    if (extension === undefined) continue;
    if (!("profile" in event.payload)) continue;
    const profile = event.payload.profile;
    const key = browserProfileKey(profile);
    if (event.eventName === "browser.extension-enabled@1") {
      extension.enabled.set(key, profile);
      extension.pending.delete(key);
      if (extension.pending.size === 0) extension.added = undefined;
    } else {
      extension.enabled.delete(key);
      extension.pending.delete(key);
      if (extension.pending.size === 0) extension.added = undefined;
    }
  }
  return [...extensions.values()].map((extension) => ({
    ...extension.summary,
    enabledIn: [...extension.enabled.values()],
    needsConfirmation: [...extension.pending.values()],
    ...(extension.added === undefined ? {} : { addedAccess: extension.added }),
  }));
}

/** The extensions that run in one profile. */
export function browserExtensionsEnabledIn(
  extensions: ReadonlyArray<BrowserExtensionSummary>,
  profile: StoredBrowserProfile,
): ReadonlyArray<BrowserExtensionSummary> {
  const key = browserProfileKey(profile);
  return extensions.filter((extension) =>
    extension.enabledIn.some((entry) => browserProfileKey(entry) === key),
  );
}

function mergeAdded(
  current: BrowserExtensionAccess | undefined,
  added: BrowserExtensionAccess,
): BrowserExtensionAccess {
  if (current === undefined) return added;
  return {
    permissions: unique([...current.permissions, ...added.permissions]),
    hostPatterns: unique([...current.hostPatterns, ...added.hostPatterns]),
  };
}

function stringList(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.trim() !== "" && entry.length <= MAX_ENTRY_LENGTH,
  );
}

function unique(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(values.map((value) => value.trim()))];
}

/** A page inside the extension's own folder; anything that leaves it is not a page. */
function pagePath(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "" || value.length > 512) return undefined;
  if (value.startsWith("/") || value.includes("\\") || value.split("/").includes("..")) {
    return undefined;
  }
  return value;
}

function invalid(message: string): ExtensionManifestDecision {
  return { kind: "refused", reason: "invalid", message };
}
