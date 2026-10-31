import { readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  decodeProjectId,
  type BrowserProfileClearScope,
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
}

export interface StoredBrowserProfileSize {
  readonly profile: StoredBrowserProfile;
  readonly sizeBytes: number;
}

export interface EnabledExtensionFolder {
  readonly id: string;
  readonly path: string;
  readonly contentHash: string;
}

export interface BrowserProfileStore {
  readonly list: () => Promise<ReadonlyArray<StoredBrowserProfileSize>>;
  readonly clear: (profile: StoredBrowserProfile, scope: BrowserProfileClearScope) => Promise<void>;
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
  // Electron keeps a loaded extension for the life of the app, per session.
  const loaded = new Map<string, Map<string, LoadedExtension>>();
  return Object.freeze<BrowserProfileStore>({
    async syncExtensions(profile, wanted) {
      const partition = browserProfilePartition(profile, "");
      const host = options.sessionFor(partition).extensions;
      if (host === undefined) return;
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
    },
    extensionPage(profile, extensionId, kind) {
      const extension = loaded.get(browserProfilePartition(profile, ""))?.get(extensionId);
      if (extension === undefined) return undefined;
      const page = manifestPage(extension.path, kind);
      return page === undefined ? undefined : `chrome-extension://${extension.electronId}/${page}`;
    },
    async list() {
      let folders: string[];
      try {
        folders = await readdir(options.partitionsDirectory);
      } catch {
        return [];
      }
      const stored: StoredBrowserProfileSize[] = [];
      for (const folder of folders) {
        const parsed = storedBrowserProfileOfPartitionFolder(folder);
        if (parsed === undefined) continue;
        const profile: StoredBrowserProfile =
          parsed.kind === "personal"
            ? { kind: "personal" }
            : { kind: "project", projectId: decodeProjectId(parsed.projectId) };
        stored.push({
          profile,
          sizeBytes: await directorySize(join(options.partitionsDirectory, folder)),
        });
      }
      return stored;
    },
    async clear(profile, scope) {
      await options.closeProfilePages(profile);
      const session = options.sessionFor(browserProfilePartition(profile, ""));
      await session.clearStorageData(scope === "cookies" ? { storages: ["cookies"] } : undefined);
      if (scope === "all") await session.clearCache();
      session.flushStorageData?.();
    },
  });
}

/** The popup or options page the extension's manifest names, as a path inside its folder. */
function manifestPage(folder: string, kind: "popup" | "options"): string | undefined {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8"));
  } catch {
    return undefined;
  }
  if (typeof manifest !== "object" || manifest === null) return undefined;
  const record = manifest as Record<string, unknown>;
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
