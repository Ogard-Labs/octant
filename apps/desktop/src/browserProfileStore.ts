import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  decodeProjectId,
  type BrowserProfileClearScope,
  type ImportedCookie,
  type StoredBrowserProfile,
} from "@octant/contracts";
import { browserProfilePartition, storedBrowserProfileOfPartitionFolder } from "@octant/domain";

/** The part of an Electron session a stored profile's store needs. */
export interface BrowserProfileSessionPort {
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
}

export interface StoredBrowserProfileSize {
  readonly profile: StoredBrowserProfile;
  readonly sizeBytes: number;
}

export interface BrowserProfileStore {
  readonly list: () => Promise<ReadonlyArray<StoredBrowserProfileSize>>;
  readonly clear: (profile: StoredBrowserProfile, scope: BrowserProfileClearScope) => Promise<void>;
  /** Sets each cookie in the profile's own session and counts what the session kept. */
  readonly importCookies: (
    profile: StoredBrowserProfile,
    cookies: ReadonlyArray<ImportedCookie>,
  ) => Promise<{ readonly imported: number; readonly skipped: number }>;
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
    async importCookies(profile, cookies) {
      const session = options.sessionFor(browserProfilePartition(profile, ""));
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
