/**
 * Fixed, secret-free sentences for the startup failures an operator can act
 * on. The raw error text is never forwarded: it can carry paths, SQL, or
 * credentials, so only the error code selects one of these phrases.
 */
const REASON_BY_CODE: Readonly<Record<string, string>> = {
  EACCES: "the data directory is not writable by this user",
  EPERM: "the data directory is not writable by this user",
  EROFS: "the data directory is on a read-only filesystem",
  ENOSPC: "the disk is full",
  ENAMETOOLONG: "the data directory path is too long",
  EADDRINUSE: "the server port is already in use",
  ERR_DLOPEN_FAILED: "a native module could not be loaded",
  SQLITE_CANTOPEN: "the database file cannot be opened",
  SQLITE_READONLY: "the database is read-only",
  SQLITE_FULL: "the disk is full",
  SQLITE_IOERR: "the database hit a disk I/O error",
  SQLITE_CORRUPT: "the database file is corrupt",
  SQLITE_NOTADB: "the database file is not an Octant database",
  SQLITE_PERM: "the database file is not accessible by this user",
};

export function startupFailureReason(error: unknown): string | undefined {
  // The code may sit on the error or one level down on its cause.
  for (const candidate of [error, causeOf(error)]) {
    const code = codeOf(candidate);
    if (code === undefined) continue;
    const exact = REASON_BY_CODE[code];
    if (exact !== undefined) return exact;
    const family = REASON_BY_CODE[code.replace(/^(SQLITE_[A-Z]+)_.*$/, "$1")];
    if (family !== undefined) return family;
  }
  return undefined;
}

/** Adds the reason after the colon of a fixed message that ends in a period. */
export function withStartupFailureReason(message: string, error: unknown): string {
  const reason = startupFailureReason(error);
  if (reason === undefined) return message;
  return `${message.replace(/\.$/, "")}: ${reason}.`;
}

function codeOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("code" in value)) return undefined;
  return typeof value.code === "string" ? value.code : undefined;
}

function causeOf(value: unknown): unknown {
  return typeof value === "object" && value !== null && "cause" in value ? value.cause : undefined;
}
