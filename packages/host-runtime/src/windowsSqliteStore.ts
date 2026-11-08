import { win32 } from "node:path";
import type { WindowsHostProfileNative, WindowsHostProfilePaths } from "./windowsHostProfile";

export interface WindowsSqliteStoreNative extends WindowsHostProfileNative {
  readonly openSqliteStore: (
    profile: string,
    scope: string,
    dataDirectory: string,
    kind: "main" | "usage-cache",
  ) => unknown;
}
export interface SqliteExtensionDatabase {
  readonly loadExtension: (path: string) => unknown;
}
export type WindowsSqliteStoreAdmission =
  | {
      readonly status: "ready";
      readonly databasePath: string;
      readonly initialize: (database: SqliteExtensionDatabase) => {
        readonly status: "ready" | "refused";
      };
    }
  | { readonly status: "refused" };
export interface WindowsSqliteStores {
  readonly main: () => WindowsSqliteStoreAdmission;
  readonly usageCache: () => WindowsSqliteStoreAdmission;
}
export function createWindowsSqliteStores(
  native: WindowsHostProfileNative,
  paths: WindowsHostProfilePaths,
): WindowsSqliteStores | undefined {
  if (!("openSqliteStore" in native) || typeof native.openSqliteStore !== "function")
    return undefined;
  const operation = native.openSqliteStore.bind(native);
  const admit = (kind: "main" | "usage-cache"): WindowsSqliteStoreAdmission => {
    try {
      const result: unknown = operation(paths.profile, paths.profileId, paths.dataDirectory, kind);
      if (
        typeof result !== "object" ||
        result === null ||
        !("status" in result) ||
        result.status !== "ready" ||
        !("dataDirectory" in result) ||
        result.dataDirectory !== paths.dataDirectory ||
        !("databasePath" in result) ||
        result.databasePath !==
          win32.join(
            paths.dataDirectory,
            kind === "main" ? "octant.sqlite3" : "local-usage-cache.sqlite3",
          ) ||
        !("extensionPath" in result) ||
        typeof result.extensionPath !== "string" ||
        !win32.isAbsolute(result.extensionPath) ||
        result.extensionPath.includes("\0") ||
        win32.normalize(result.extensionPath) !== result.extensionPath ||
        win32.basename(result.extensionPath) !== "octant-windows-host-owner.node"
      )
        return { status: "refused" };
      const extension = result.extensionPath;
      return {
        status: "ready",
        databasePath: result.databasePath,
        initialize: (database) => {
          try {
            database.loadExtension(extension);
            return { status: "ready" };
          } catch {
            return { status: "refused" };
          }
        },
      };
    } catch {
      return { status: "refused" };
    }
  };
  return Object.freeze({ main: () => admit("main"), usageCache: () => admit("usage-cache") });
}
