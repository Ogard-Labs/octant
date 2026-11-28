import { isSafeShareFileName, isShareUuid, SHARE_MANIFEST_FILE_NAME } from "./shareManifest";
import type {
  ShareStagingFileStat,
  ShareStagingFolderEntry,
  ShareStagingFs,
} from "./shareValidation";

export interface OctantShareNativeModule {
  readonly isSupported: () => unknown;
  readonly listShareFolders: () => Promise<unknown>;
  readonly statFile: (folder: string, fileName: string) => Promise<unknown>;
  readonly readTextFile: (folder: string, fileName: string) => Promise<unknown>;
  readonly readBinaryFileBase64: (folder: string, fileName: string) => Promise<unknown>;
  readonly deleteShareFolder: (folder: string) => Promise<unknown>;
  readonly deleteAllShares: () => Promise<unknown>;
}

const MISSING_STAT: ShareStagingFileStat = {
  exists: false,
  isRegularFile: false,
  isSymbolicLink: false,
  sizeBytes: 0,
};

function decodeBase64(encoded: string): Uint8Array | undefined {
  try {
    const binary = globalThis.atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return undefined;
  }
}

function parseFolderEntry(raw: unknown): ShareStagingFolderEntry | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const entry = raw as Record<string, unknown>;
  if (
    typeof entry.name !== "string" ||
    typeof entry.isDirectory !== "boolean" ||
    typeof entry.isSymbolicLink !== "boolean"
  ) {
    return undefined;
  }
  return {
    name: entry.name,
    isDirectory: entry.isDirectory,
    isSymbolicLink: entry.isSymbolicLink,
  };
}

function parseStat(raw: unknown): ShareStagingFileStat {
  if (typeof raw !== "object" || raw === null) return MISSING_STAT;
  const entry = raw as Record<string, unknown>;
  if (
    typeof entry.exists !== "boolean" ||
    typeof entry.isRegularFile !== "boolean" ||
    typeof entry.isSymbolicLink !== "boolean" ||
    typeof entry.sizeBytes !== "number" ||
    !Number.isSafeInteger(entry.sizeBytes) ||
    entry.sizeBytes < 0
  ) {
    return MISSING_STAT;
  }
  return {
    exists: entry.exists,
    isRegularFile: entry.isRegularFile,
    isSymbolicLink: entry.isSymbolicLink,
    sizeBytes: entry.sizeBytes,
  };
}

function isReadableFileName(fileName: string): boolean {
  return fileName === SHARE_MANIFEST_FILE_NAME || isSafeShareFileName(fileName);
}

export function createUnavailableShareStagingFs(): ShareStagingFs {
  return {
    available: false,
    listShareFolders: async () => [],
    statFile: async () => MISSING_STAT,
    readTextFile: async () => undefined,
    readBinaryFile: async () => undefined,
    deleteShareFolder: async () => undefined,
    deleteAllShares: async () => undefined,
  };
}

export function createNativeShareStagingFs(
  native: OctantShareNativeModule | null | undefined,
): ShareStagingFs {
  let supported = false;
  if (native !== null && native !== undefined) {
    try {
      supported = native.isSupported() === true;
    } catch {
      supported = false;
    }
  }
  if (!supported || native === null || native === undefined) {
    return createUnavailableShareStagingFs();
  }
  return {
    available: true,
    listShareFolders: async () => {
      try {
        const raw = await native.listShareFolders();
        if (!Array.isArray(raw)) return [];
        const entries: ShareStagingFolderEntry[] = [];
        for (const item of raw) {
          const parsed = parseFolderEntry(item);
          if (parsed !== undefined) entries.push(parsed);
        }
        return entries;
      } catch {
        return [];
      }
    },
    statFile: async (folder, fileName) => {
      if (!isShareUuid(folder) || !isReadableFileName(fileName)) return MISSING_STAT;
      try {
        return parseStat(await native.statFile(folder, fileName));
      } catch {
        return MISSING_STAT;
      }
    },
    readTextFile: async (folder, fileName) => {
      if (!isShareUuid(folder) || !isReadableFileName(fileName)) return undefined;
      try {
        const value = await native.readTextFile(folder, fileName);
        return typeof value === "string" ? value : undefined;
      } catch {
        return undefined;
      }
    },
    readBinaryFile: async (folder, fileName) => {
      if (!isShareUuid(folder) || !isSafeShareFileName(fileName)) return undefined;
      try {
        const value = await native.readBinaryFileBase64(folder, fileName);
        return typeof value === "string" ? decodeBase64(value) : undefined;
      } catch {
        return undefined;
      }
    },
    deleteShareFolder: async (folder) => {
      if (folder.length === 0 || folder.includes("/") || folder.includes("\\")) return;
      try {
        await native.deleteShareFolder(folder);
      } catch {
        // Best-effort cleanup; next sweep retries.
      }
    },
    deleteAllShares: async () => {
      try {
        await native.deleteAllShares();
      } catch {
        // Best-effort cleanup; next sweep retries.
      }
    },
  };
}
