import { win32 } from "node:path";
import type { WindowsHostProfileNative, WindowsHostProfilePaths } from "./windowsHostProfile";

export interface WindowsSqliteStoreNative extends WindowsHostProfileNative {
  readonly openSqliteStore: (
    profile: string,
    scope: string,
    dataDirectory: string,
    kind: "main" | "usage-cache",
  ) => unknown;
  readonly closeSqliteStore: (lease: number) => unknown;
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
      readonly close: () => { readonly status: "closed" | "refused" };
    }
  | { readonly status: "refused" };
export interface WindowsSqliteStores {
  readonly main: () => WindowsSqliteStoreAdmission;
  readonly usageCache: () => WindowsSqliteStoreAdmission;
}
function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nativeStores(native: WindowsHostProfileNative): native is WindowsSqliteStoreNative {
  return (
    "openSqliteStore" in native &&
    typeof native.openSqliteStore === "function" &&
    "closeSqliteStore" in native &&
    typeof native.closeSqliteStore === "function"
  );
}
export function createWindowsSqliteStores(
  native: WindowsHostProfileNative,
  paths: WindowsHostProfilePaths,
): WindowsSqliteStores | undefined {
  if (!nativeStores(native)) return undefined;
  const admit = (kind: "main" | "usage-cache"): WindowsSqliteStoreAdmission => {
    let lease: number | undefined;
    try {
      const result = native.openSqliteStore(
        paths.profile,
        paths.profileId,
        paths.dataDirectory,
        kind,
      );
      if (
        !record(result) ||
        result.status !== "ready" ||
        typeof result.lease !== "number" ||
        !Number.isSafeInteger(result.lease) ||
        result.lease <= 0
      )
        return { status: "refused" };
      lease = result.lease;
      if (
        result.dataDirectory !== paths.dataDirectory ||
        result.databasePath !==
          win32.join(
            paths.dataDirectory,
            kind === "main" ? "octant.sqlite3" : "local-usage-cache.sqlite3",
          ) ||
        typeof result.extensionPath !== "string" ||
        !win32.isAbsolute(result.extensionPath) ||
        result.extensionPath.includes("\0") ||
        win32.normalize(result.extensionPath) !== result.extensionPath ||
        win32.basename(result.extensionPath) !== "octant-windows-host-owner.node"
      ) {
        native.closeSqliteStore(lease);
        return { status: "refused" };
      }
      const selected = lease;
      const extension = result.extensionPath;
      let closed = false;
      return {
        status: "ready",
        databasePath: result.databasePath,
        initialize: (database) => {
          if (closed) return { status: "refused" };
          try {
            database.loadExtension(extension);
            return { status: "ready" };
          } catch {
            return { status: "refused" };
          }
        },
        close: () => {
          if (closed) return { status: "closed" };
          try {
            const result = native.closeSqliteStore(selected);
            if (!record(result) || result.status !== "closed") return { status: "refused" };
            closed = true;
            return { status: "closed" };
          } catch {
            return { status: "refused" };
          }
        },
      };
    } catch {
      if (lease !== undefined) {
        try {
          native.closeSqliteStore(lease);
        } catch {
          /* Environment cleanup retains the final resource boundary. */
        }
      }
      return { status: "refused" };
    }
  };
  return Object.freeze({ main: () => admit("main"), usageCache: () => admit("usage-cache") });
}
