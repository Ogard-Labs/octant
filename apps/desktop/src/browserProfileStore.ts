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

export interface BrowserProfileStore {
  readonly list: () => Promise<ReadonlyArray<StoredBrowserProfileSize>>;
  readonly clear: (profile: StoredBrowserProfile, scope: BrowserProfileClearScope) => Promise<void>;
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
  return Object.freeze<BrowserProfileStore>({
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
