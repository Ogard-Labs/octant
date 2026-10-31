import { createDecipheriv, createHash, pbkdf2Sync, timingSafeEqual } from "node:crypto";
import type { ImportedCookie } from "@octant/contracts";
import { openReadOnlySqlite } from "../../persistence/sqlitePort";
import { importedCookieFrom, MAX_IMPORTED_COOKIES } from "./importedCookie";

// How a Chromium-family browser on macOS protects its cookie values: AES-128-CBC
// with a key stretched from the "<Browser> Safe Storage" Keychain password.
const KEY_SALT = "saltysalt";
const KEY_ITERATIONS = 1_003;
const KEY_LENGTH = 16;
const IV = Buffer.alloc(16, 0x20);
const ENCRYPTION_PREFIX = "v10";
// From database version 24 a decrypted value begins with the SHA-256 of its
// host, which is not part of the cookie.
const HOST_HASH_VERSION = 24;
const HOST_HASH_BYTES = 32;
const WEBKIT_EPOCH_OFFSET_SECONDS = 11_644_473_600;

export function deriveChromiumCookieKey(safeStoragePassword: string): Buffer {
  return pbkdf2Sync(safeStoragePassword, KEY_SALT, KEY_ITERATIONS, KEY_LENGTH, "sha1");
}

/**
 * The plain value of one cookie, or undefined when it cannot be trusted.
 *
 * AES-CBC alone cannot tell a wrong key from a right one: about one wrong key in
 * 256 still yields valid padding and garbage plaintext. So a value is accepted
 * only when it proves itself. In a database that prefixes values with the hash
 * of their host (`hostKey` given), the 32-byte prefix must equal SHA-256 of this
 * row's own `host_key`; in every database the rest must be valid UTF-8, which is
 * rejected rather than repaired with replacement characters.
 */
export function decryptChromiumCookieValue(
  encrypted: Uint8Array,
  key: Buffer,
  hostKey: string | undefined,
): string | undefined {
  const bytes = Buffer.from(encrypted);
  if (bytes.subarray(0, ENCRYPTION_PREFIX.length).toString("latin1") !== ENCRYPTION_PREFIX) {
    return undefined;
  }
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, IV);
    const decrypted = Buffer.concat([
      decipher.update(bytes.subarray(ENCRYPTION_PREFIX.length)),
      decipher.final(),
    ]);
    if (hostKey === undefined) return decodeStrictUtf8(decrypted);
    if (decrypted.length < HOST_HASH_BYTES) return undefined;
    const expected = createHash("sha256").update(hostKey).digest();
    if (!timingSafeEqual(decrypted.subarray(0, HOST_HASH_BYTES), expected)) return undefined;
    return decodeStrictUtf8(decrypted.subarray(HOST_HASH_BYTES));
  } catch {
    return undefined;
  }
}

function decodeStrictUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

interface ChromiumCookieRow {
  readonly host_key: unknown;
  readonly name: unknown;
  readonly value: unknown;
  readonly encrypted_value: unknown;
  readonly path: unknown;
  readonly expires_utc: unknown;
  readonly is_secure: unknown;
  readonly is_httponly: unknown;
  readonly has_expires: unknown;
  readonly samesite: unknown;
  readonly top_frame_site_key?: unknown;
}

export type ChromiumCookieRead =
  | {
      readonly status: "read";
      readonly cookies: ReadonlyArray<ImportedCookie>;
      readonly skipped: number;
    }
  | { readonly status: "needs-key"; readonly encrypted: number }
  | { readonly status: "unreadable" };

/**
 * Reads a copy of a Chromium-family cookie database.
 *
 * `key` is undefined until the caller has the browser's Safe Storage key; a
 * database with nothing encrypted needs none, so the caller learns whether it
 * must ask the person for Keychain access before it does.
 */
export function readChromiumCookies(input: {
  readonly databasePath: string;
  readonly key: Buffer | undefined;
  readonly nowSeconds: number;
}): ChromiumCookieRead {
  let database;
  try {
    database = openReadOnlySqlite(input.databasePath);
  } catch {
    return { status: "unreadable" };
  }
  try {
    const columns = database
      .all("PRAGMA table_info(cookies)")
      .map((row) => String(Reflect.get(row as object, "name")));
    if (!columns.includes("host_key") || !columns.includes("encrypted_value")) {
      return { status: "unreadable" };
    }
    const version = Number(
      Reflect.get(
        (database.all("SELECT value FROM meta WHERE key = 'version'")[0] ?? {}) as object,
        "value",
      ) ?? 0,
    );
    const partitioned = columns.includes("top_frame_site_key") ? ", top_frame_site_key" : "";
    const rows = database.all(
      `SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, has_expires, samesite${partitioned} FROM cookies LIMIT ${MAX_IMPORTED_COOKIES}`,
    ) as ReadonlyArray<ChromiumCookieRow>;
    const needsKey = rows.filter((row) => encryptedLength(row) > 0).length;
    if (needsKey > 0 && input.key === undefined)
      return { status: "needs-key", encrypted: needsKey };
    const cookies: ImportedCookie[] = [];
    let skipped = 0;
    let verified = 0;
    for (const row of rows) {
      const value = valueOf(row, input.key, version >= HOST_HASH_VERSION);
      if (value === undefined) {
        skipped += 1;
        continue;
      }
      if (encryptedLength(row) > 0) verified += 1;
      const imported = importedCookieFrom(
        {
          host: String(row.host_key),
          name: String(row.name),
          value,
          path: String(row.path),
          expiresAtSeconds:
            Number(row.has_expires) === 0 || Number(row.expires_utc) === 0
              ? undefined
              : Number(row.expires_utc) / 1_000_000 - WEBKIT_EPOCH_OFFSET_SECONDS,
          secure: Number(row.is_secure) !== 0,
          httpOnly: Number(row.is_httponly) !== 0,
          sameSite: sameSiteOf(Number(row.samesite)),
        },
        input.nowSeconds,
      );
      // A cookie partitioned by the top-level site belongs to that site's frames
      // alone, so it is not a sign-in the person can reuse.
      const isPartitioned =
        row.top_frame_site_key !== undefined && String(row.top_frame_site_key) !== "";
      if (imported === undefined || isPartitioned) skipped += 1;
      else cookies.push(imported);
    }
    // If not one encrypted value proved itself against its host, the key is stale
    // or wrong: importing nothing is right, and importing whatever survived by
    // chance is not.
    if (needsKey > 0 && verified === 0) return { status: "unreadable" };
    return { status: "read", cookies, skipped };
  } catch {
    return { status: "unreadable" };
  } finally {
    database.close();
  }
}

function encryptedLength(row: ChromiumCookieRow): number {
  const blob = row.encrypted_value;
  return blob instanceof Uint8Array ? blob.byteLength : 0;
}

function valueOf(row: ChromiumCookieRow, key: Buffer | undefined, hasHostHash: boolean) {
  const blob = row.encrypted_value;
  if (blob instanceof Uint8Array && blob.byteLength > 0) {
    return key === undefined
      ? undefined
      : decryptChromiumCookieValue(blob, key, hasHostHash ? String(row.host_key) : undefined);
  }
  return typeof row.value === "string" ? row.value : undefined;
}

function sameSiteOf(value: number): ImportedCookie["sameSite"] {
  if (value === 0) return "no_restriction";
  if (value === 1) return "lax";
  if (value === 2) return "strict";
  return "unspecified";
}
