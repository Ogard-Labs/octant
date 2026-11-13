/**
 * Fixed, secret-free sentences for the startup failures an operator can act
 * on. The raw error text is never forwarded: it can carry paths, SQL, or
 * credentials, so only the error code selects one of these phrases.
 */
const REASON_BY_CODE: Readonly<Record<string, string>> = {
  OCTANT_WINDOWS_ARTIFACTS: "native Windows runtime artifacts are unavailable or incompatible",
  OCTANT_WINDOWS_OWNER: "native Windows profile ownership could not be acquired",
  OCTANT_WINDOWS_STORAGE: "native Windows host storage could not be composed",
  OCTANT_WINDOWS_BROKER: "the Windows credential broker could not start",
  OCTANT_WINDOWS_IMPORTS: "a Windows server runtime dependency could not be loaded",
  OCTANT_WINDOWS_PERSISTENCE: "native Windows persistence could not initialize",
  OCTANT_WINDOWS_SERVER: "the Windows server services could not initialize",
  OCTANT_WINDOWS_RECEIPT: "native Windows readiness projections could not be published",
  OCTANT_WINDOWS_READY: "the Windows server could not complete its scoped lifecycle",

  EACCES: "a file or directory Octant needs is not accessible by this user",
  EPERM: "a file or directory Octant needs is not accessible by this user",
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

/** The fixed failure every unclassified startup error reports, with its reason when known. */
export const UNCLASSIFIED_STARTUP_FAILURE = "Octant could not start the local server.";

/**
 * The one line a refused start prints. The desktop reads `category` and
 * `recovery` from it to choose what its recovery screen offers, so both stay
 * fixed vocabulary and never carry raw error text.
 */
export function startupFailedOutput(category: string, message: string, recovery?: string): string {
  return JSON.stringify({
    product: "Octant",
    status: "failed",
    category,
    message,
    ...(recovery === undefined ? {} : { recovery }),
  });
}

function codeOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("code" in value)) return undefined;
  return typeof value.code === "string" ? value.code : undefined;
}

function causeOf(value: unknown): unknown {
  return typeof value === "object" && value !== null && "cause" in value ? value.cause : undefined;
}
