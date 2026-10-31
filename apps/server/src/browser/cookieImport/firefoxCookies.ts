import type { ImportedCookie } from "@octant/contracts";
import { openReadOnlySqlite } from "../../persistence/sqlitePort";
import { importedCookieFrom, MAX_IMPORTED_COOKIES } from "./importedCookie";

export type FirefoxCookieRead =
  | {
      readonly status: "read";
      readonly cookies: ReadonlyArray<ImportedCookie>;
      readonly skipped: number;
    }
  | { readonly status: "unreadable" };

/** Seconds from a stored expiry that newer versions keep in milliseconds. */
const MILLISECONDS_THRESHOLD = 100_000_000_000;

/**
 * Reads a copy of a Firefox cookie database. Its values are stored in the clear,
 * so no Keychain access is involved.
 */
export function readFirefoxCookies(input: {
  readonly databasePath: string;
  readonly nowSeconds: number;
}): FirefoxCookieRead {
  let database;
  try {
    database = openReadOnlySqlite(input.databasePath);
  } catch {
    return { status: "unreadable" };
  }
  try {
    const rows = database.all(
      `SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite, originAttributes FROM moz_cookies LIMIT ${MAX_IMPORTED_COOKIES}`,
    ) as ReadonlyArray<Record<string, unknown>>;
    const cookies: ImportedCookie[] = [];
    let skipped = 0;
    for (const row of rows) {
      const expiry = Number(row.expiry);
      const imported = importedCookieFrom(
        {
          host: String(row.host),
          name: String(row.name),
          value: String(row.value),
          path: String(row.path),
          expiresAtSeconds:
            !Number.isFinite(expiry) || expiry <= 0
              ? undefined
              : expiry > MILLISECONDS_THRESHOLD
                ? expiry / 1_000
                : expiry,
          secure: Number(row.isSecure) !== 0,
          httpOnly: Number(row.isHttpOnly) !== 0,
          sameSite: sameSiteOf(Number(row.sameSite)),
        },
        input.nowSeconds,
      );
      // A container tab's or a partitioned cookie is not the sign-in the person
      // uses in an ordinary tab.
      const attributes = String(row.originAttributes ?? "");
      const isOrdinary = !/userContextId=[1-9]|partitionKey=/.test(attributes);
      if (imported === undefined || !isOrdinary) skipped += 1;
      else cookies.push(imported);
    }
    return { status: "read", cookies, skipped };
  } catch {
    return { status: "unreadable" };
  } finally {
    database.close();
  }
}

function sameSiteOf(value: number): ImportedCookie["sameSite"] {
  if (value === 0) return "no_restriction";
  if (value === 1) return "lax";
  if (value === 2) return "strict";
  return "unspecified";
}
