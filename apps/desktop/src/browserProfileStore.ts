import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readdir, stat, mkdir, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  decodeProjectId,
  decodeBrowserAccountProfileId,
  decodeNamedBrowserProfiles,
  type NamedBrowserProfile,
  type BrowserAccountProfileCreateResult,
  type BrowserProfileClearScope,
  type ImportedCookie,
  type StoredBrowserProfile,
} from "@octant/contracts";
import { browserProfilePartition, storedBrowserProfileOfPartitionFolder } from "@octant/domain";

/** The part of an Electron session a stored profile's store needs. */
export interface BrowserProfileSessionPort {
  /** Electron's per-session extension host. Absent where the runtime has none. */
  readonly extensions?: {
    loadExtension(
      path: string,
      options?: { readonly allowFileAccess?: boolean },
    ): Promise<{ readonly id: string }>;
    removeExtension(id: string): void;
  };
  readonly cookies?: {
    set(details: {
      readonly url: string;
      readonly name: string;
      readonly value: string;
      readonly domain?: string;
      readonly path: string;
      readonly secure: boolean;
      readonly httpOnly: boolean;
      readonly expirationDate?: number;
      readonly sameSite: ImportedCookie["sameSite"];
    }): Promise<void>;
  };
  clearStorageData(options?: { readonly storages?: ReadonlyArray<string> }): Promise<void>;
  clearCache(): Promise<void>;
  flushStorageData?(): void;
}

export interface BrowserProfileStoreOptions {
  /** Electron's `Partitions` folder under the app's user data directory. */
  readonly partitionsDirectory: string;
  readonly sessionFor: (partition: string) => BrowserProfileSessionPort;
  /** Closes every page of a profile before its storage is touched. */
  readonly closeProfilePages: (profile: StoredBrowserProfile) => Promise<void>;
  /**
   * Called once per profile, the first time an extension is loaded into its
   * session, so the app can attach what extension pages and workers there need.
   */
  readonly onExtensionSession?: (profile: StoredBrowserProfile) => void;
}

export interface StoredBrowserProfileSize {
  readonly profile: StoredBrowserProfile;
  readonly sizeBytes: number;
  readonly label?: string;
}

export interface EnabledExtensionFolder {
  readonly id: string;
  readonly path: string;
  readonly contentHash: string;
}

export interface BrowserProfileStore {
  readonly createAccount: (label: string) => Promise<BrowserAccountProfileCreateResult>;
  readonly hasAccountProfile: (profileId: string) => boolean;
  readonly list: (includeSizes?: boolean) => Promise<ReadonlyArray<StoredBrowserProfileSize>>;
  readonly clear: (profile: StoredBrowserProfile, scope: BrowserProfileClearScope) => Promise<void>;
  /** Sets each cookie in the profile's own session and counts what the session kept. */
  readonly importCookies: (
    profile: StoredBrowserProfile,
    cookies: ReadonlyArray<ImportedCookie>,
  ) => Promise<{ readonly imported: number; readonly skipped: number }>;
  /**
   * Makes the extensions loaded in a profile's session exactly the ones given.
   * Only a stored profile's session is ever asked: a Private page has none, so no
   * extension can run there.
   */
  readonly syncExtensions: (
    profile: StoredBrowserProfile,
    wanted: ReadonlyArray<EnabledExtensionFolder>,
  ) => Promise<void>;
  /** The `chrome-extension://` address of a loaded extension's popup or options page. */
  readonly extensionPage: (
    profile: StoredBrowserProfile,
    extensionId: string,
    kind: "popup" | "options",
  ) => string | undefined;
  /**
   * Who a loaded extension is, from the address its pages and worker run at.
   * Absent when no extension of that address is loaded in the profile, so a
   * caller that is not an enabled extension of this profile learns nothing.
   */
  readonly extensionOfElectronId: (
    profile: StoredBrowserProfile,
    electronId: string,
  ) => LoadedExtensionIdentity | undefined;
  /**
   * Where a toolbar click on an extension with no popup page goes: the worker
   * scope that receives `chrome.action.onClicked`. Absent when the extension has
   * a popup page (the popup is what the click opens) or declares no action.
   */
  readonly extensionActionScope: (
    profile: StoredBrowserProfile,
    extensionId: string,
  ) => string | undefined;
}

export interface LoadedExtensionIdentity {
  /** Octant's id for the extension. */
  readonly extensionId: string;
  /** Whether its manifest asks for the `tabs` permission, which shows tab addresses and titles. */
  readonly seesTabAddresses: boolean;
}

interface LoadedExtension {
  readonly electronId: string;
  readonly path: string;
  readonly contentHash: string;
}

/**
 * The persistent stores behind the Project and Personal Browser profiles.
 *
 * The store never reads a cookie. It lists what is on disk by folder name and
 * size, and clearing closes the profile's pages before it removes anything, so
 * no open page keeps a sign-in the person just removed.
 */
export function createBrowserProfileStore(
  options: BrowserProfileStoreOptions,
): BrowserProfileStore {
  const registryFile = join(options.partitionsDirectory, "octant-account-profiles.json");
  let accounts = readAccountProfiles(registryFile);
  let accountWrites = Promise.resolve();
  const partitionFor = (profile: StoredBrowserProfile): string => {
    if (
      profile.kind === "account" &&
      !accounts?.some((entry) => String(entry.profileId) === String(profile.profileId))
    )
      throw new Error("The named Browser profile is unavailable on this host.");
    return browserProfilePartition(profile, "");
  };
  // Electron keeps a loaded extension for the life of the app, per session.
  const loaded = new Map<string, Map<string, LoadedExtension>>();
  // One sync at a time per profile: a load that is still pending must finish
  // before a later change (a disable, a removal, a wider update) is applied, or
  // the later change would find nothing loaded and the revoked extension would
  // be recorded as running when the load ended.
  const queues = new Map<string, Promise<void>>();
  const attached = new Set<string>();
  const syncOne = async (
    profile: StoredBrowserProfile,
    wanted: ReadonlyArray<EnabledExtensionFolder>,
  ): Promise<void> => {
    const partition = partitionFor(profile);
    const host = options.sessionFor(partition).extensions;
    if (host === undefined) return;
    if (!attached.has(partition)) {
      attached.add(partition);
      options.onExtensionSession?.(profile);
    }
    const here = loaded.get(partition) ?? new Map<string, LoadedExtension>();
    loaded.set(partition, here);
    for (const [id, extension] of here) {
      const keep = wanted.some(
        (entry) => entry.id === id && entry.contentHash === extension.contentHash,
      );
      if (!keep) {
        host.removeExtension(extension.electronId);
        here.delete(id);
      }
    }
    for (const entry of wanted) {
      if (here.has(entry.id)) continue;
      try {
        const extension = await host.loadExtension(entry.path, { allowFileAccess: false });
        here.set(entry.id, {
          electronId: extension.id,
          path: entry.path,
          contentHash: entry.contentHash,
        });
      } catch {
        // An extension Electron cannot load fails inside itself, as the design
        // says; the rest of the profile's extensions still load.
      }
    }
  };
  return Object.freeze<BrowserProfileStore>({
    hasAccountProfile: (profileId) =>
      accounts?.some((entry) => String(entry.profileId) === profileId) === true,
    createAccount(label) {
      const work = accountWrites.then(async (): Promise<BrowserAccountProfileCreateResult> => {
        const name = label.trim();
        if (name.length === 0 || name.length > 80)
          return { status: "refused", reason: "invalid-label" };
        if (accounts === undefined) return { status: "refused", reason: "store-unavailable" };
        if (accounts.length >= 64) return { status: "refused", reason: "limit-reached" };
        const profile = {
          kind: "account" as const,
          profileId: decodeBrowserAccountProfileId(randomUUID()),
        };
        const next = [...accounts, { ...profile, label: name }];
        const temporary = `${registryFile}.${randomUUID()}.tmp`;
        try {
          await mkdir(options.partitionsDirectory, { recursive: true });
          await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: "wx" });
          await rename(temporary, registryFile);
        } catch {
          await unlink(temporary).catch(() => undefined);
          return { status: "refused", reason: "store-unavailable" };
        }
        accounts = next;
        return { status: "created", profile, label: name };
      });
      accountWrites = work.then(
        () => undefined,
        () => undefined,
      );
      return work;
    },
    syncExtensions(profile, wanted) {
      const partition = partitionFor(profile);
      const run = (queues.get(partition) ?? Promise.resolve()).then(() => syncOne(profile, wanted));
      queues.set(
        partition,
        run.catch(() => undefined),
      );
      return run;
    },
    extensionPage(profile, extensionId, kind) {
      const extension = loaded.get(partitionFor(profile))?.get(extensionId);
      if (extension === undefined) return undefined;
      const page = manifestPage(extension.path, kind);
      return page === undefined ? undefined : `chrome-extension://${extension.electronId}/${page}`;
    },
    extensionOfElectronId(profile, electronId) {
      for (const [extensionId, extension] of loaded.get(partitionFor(profile)) ?? []) {
        if (extension.electronId !== electronId) continue;
        return {
          extensionId,
          seesTabAddresses: manifestPermissions(extension.path).includes("tabs"),
        };
      }
      return undefined;
    },
    extensionActionScope(profile, extensionId) {
      const extension = loaded.get(partitionFor(profile))?.get(extensionId);
      if (extension === undefined) return undefined;
      const manifest = readManifest(extension.path);
      if (typeof manifest?.action !== "object" || manifest.action === null) return undefined;
      if (manifestPage(extension.path, "popup") !== undefined) return undefined;
      return `chrome-extension://${extension.electronId}/`;
    },
    async list(includeSizes = true) {
      if (accounts === undefined) throw new Error("Named Browser profiles could not be read.");
      const stored: StoredBrowserProfileSize[] = await Promise.all(
        accounts.map(async (entry) => ({
          profile: { kind: "account" as const, profileId: entry.profileId },
          label: entry.label,
          sizeBytes: includeSizes
            ? await directorySize(
                join(
                  options.partitionsDirectory,
                  browserProfilePartition(entry, "").slice("persist:".length),
                ),
              )
            : 0,
        })),
      );
      let folders: string[];
      try {
        folders = await readdir(options.partitionsDirectory);
      } catch {
        return stored;
      }
      for (const folder of folders) {
        const parsed = storedBrowserProfileOfPartitionFolder(folder);
        if (parsed === undefined || parsed.kind === "account") continue;
        const profile: StoredBrowserProfile =
          parsed.kind === "personal"
            ? { kind: "personal" }
            : { kind: "project", projectId: decodeProjectId(parsed.projectId) };
        stored.push({
          profile,
          sizeBytes: includeSizes
            ? await directorySize(join(options.partitionsDirectory, folder))
            : 0,
        });
      }
      return stored;
    },
    async clear(profile, scope) {
      await options.closeProfilePages(profile);
      const session = options.sessionFor(partitionFor(profile));
      await session.clearStorageData(scope === "cookies" ? { storages: ["cookies"] } : undefined);
      if (scope === "all") await session.clearCache();
      session.flushStorageData?.();
    },
    async importCookies(profile, cookies) {
      const session = options.sessionFor(partitionFor(profile));
      let imported = 0;
      let skipped = 0;
      for (const cookie of cookies) {
        try {
          await session.cookies?.set(cookieDetails(cookie));
          if (session.cookies === undefined) skipped += 1;
          else imported += 1;
        } catch {
          // The session refused this cookie. Which one, and why, is not
          // reported: the error can name the cookie, and a count is enough.
          skipped += 1;
        }
      }
      session.flushStorageData?.();
      return { imported, skipped };
    },
  });
}

function readManifest(folder: string): Record<string, unknown> | undefined {
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8"));
    return typeof manifest === "object" && manifest !== null && !Array.isArray(manifest)
      ? (manifest as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function manifestPermissions(folder: string): ReadonlyArray<string> {
  const permissions = readManifest(folder)?.permissions;
  return Array.isArray(permissions)
    ? permissions.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** The popup or options page the extension's manifest names, as a path inside its folder. */
function manifestPage(folder: string, kind: "popup" | "options"): string | undefined {
  const record = readManifest(folder);
  if (record === undefined) return undefined;
  const action =
    typeof record.action === "object" ? (record.action as Record<string, unknown>) : {};
  const ui =
    typeof record.options_ui === "object" ? (record.options_ui as Record<string, unknown>) : {};
  const page = kind === "popup" ? action.default_popup : (record.options_page ?? ui.page);
  return typeof page === "string" &&
    page !== "" &&
    !page.startsWith("/") &&
    !page.split("/").includes("..")
    ? page
    : undefined;
}

function cookieDetails(cookie: ImportedCookie) {
  const host = cookie.domain.startsWith(".") ? cookie.domain.slice(1) : cookie.domain;
  return {
    url: `${cookie.secure ? "https" : "http"}://${host}${cookie.path}`,
    name: cookie.name,
    value: cookie.value,
    // A host-only cookie names no domain, so the session keeps it host-only.
    ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    ...(cookie.expiresAt === undefined ? {} : { expirationDate: cookie.expiresAt }),
    sameSite: cookie.sameSite,
  };
}

async function directorySize(directory: string): Promise<number> {
  let total = 0;
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(directory, entry);
    try {
      const info = await stat(path);
      total += info.isDirectory() ? await directorySize(path) : info.size;
    } catch {
      // A file that vanished while sizing does not change the answer.
    }
  }
  return total;
}

/** Metadata only: native account stores and names never enter the journal or artifact sync. */
function readAccountProfiles(path: string): ReadonlyArray<NamedBrowserProfile> | undefined {
  try {
    const data = readFileSync(path);
    if (data.byteLength > 64 * 1024) return undefined;
    const profiles = decodeNamedBrowserProfiles(JSON.parse(data.toString("utf8")));
    return new Set(profiles.map((entry) => String(entry.profileId).toLowerCase())).size ===
      profiles.length
      ? profiles
      : undefined;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
      ? []
      : undefined;
  }
}
