import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACCOUNT_REF_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SECRETISH = /(?:lin_api_|bearer\s+[A-Za-z0-9._-]{20,}|access_token|refresh_token|token=)/i;

export const MAX_LINEAR_ACCOUNTS = 16;
export const LEGACY_PENDING_ACCOUNT_REF = "legacy";

export interface LinearAccountIndexEntry {
  readonly accountRef: string;
  readonly viewerId?: string;
  readonly workspaceId?: string;
  readonly login: string;
  readonly displayName?: string;
  readonly workspace?: string;
  readonly source: "oauth" | "personal-api-key";
  readonly scopes: ReadonlyArray<string>;
  readonly vaultId: string;
  readonly reconnectRequired: boolean;
}

export interface LinearAccountIndex {
  readonly version: 1;
  readonly accounts: ReadonlyArray<LinearAccountIndexEntry>;
  readonly legacyRef?: string;
}

export type LinearAccountIndexReadResult =
  | { readonly kind: "ok"; readonly index: LinearAccountIndex }
  | { readonly kind: "absent" }
  | { readonly kind: "damaged"; readonly reason: string };

export type LinearAccountIndexWriteResult =
  | { readonly kind: "written" }
  | { readonly kind: "failed"; readonly reason: string };

export interface LinearAccountIndexStore {
  readonly read: () => LinearAccountIndexReadResult;
  readonly write: (index: LinearAccountIndex) => LinearAccountIndexWriteResult;
}

/**
 * Deterministic, credential-free account identifier derived from the Linear
 * viewer and workspace ids. Survives reconnecting the same account without
 * exposing raw ids or allowing slot reuse across accounts.
 */
export function computeLinearAccountRef(viewerId: string, workspaceId: string): string {
  return createHash("sha256")
    .update(JSON.stringify(["linear", viewerId, workspaceId]))
    .digest("hex")
    .slice(0, 32);
}

export function createMemoryLinearAccountIndexStore(
  initial: LinearAccountIndexReadResult = { kind: "absent" },
  options: { readonly failWrites?: () => boolean } = {},
): LinearAccountIndexStore {
  let current: LinearAccountIndexReadResult = initial;
  return {
    read: () => current,
    write: (index) => {
      if (options.failWrites?.() === true) {
        return { kind: "failed", reason: "Could not save the Linear accounts index." };
      }
      const validated = decodeLinearAccountIndex(index);
      if (validated === undefined) {
        return { kind: "failed", reason: "The Linear accounts index is invalid." };
      }
      current = { kind: "ok", index: validated };
      return { kind: "written" };
    },
  };
}

/**
 * Host-local index of connected Linear accounts (`integrations/linear-accounts.json`).
 * Secrets never live here — only opaque vault ids, reconnect state, and
 * display labels. Writes are atomic with `0600` permissions and fail closed:
 * a write failure is returned to the caller so any newly stored secret can be
 * deleted. A damaged file is never silently ignored or overwritten on read.
 */
export function createFileLinearAccountIndexStore(filePath: string): LinearAccountIndexStore {
  return {
    read: () => readIndexFile(filePath),
    write: (index) => writeIndexFile(filePath, index),
  };
}

function readIndexFile(filePath: string): LinearAccountIndexReadResult {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    if (isEnoent(error)) return { kind: "absent" };
    return { kind: "damaged", reason: "The Linear accounts index could not be read." };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: "damaged", reason: "The Linear accounts index is damaged." };
  }
  const decoded = decodeLinearAccountIndex(raw);
  if (decoded === undefined) {
    return { kind: "damaged", reason: "The Linear accounts index is damaged." };
  }
  return { kind: "ok", index: decoded };
}

function writeIndexFile(
  filePath: string,
  index: LinearAccountIndex,
): LinearAccountIndexWriteResult {
  const validated = decodeLinearAccountIndex(index);
  if (validated === undefined) {
    return { kind: "failed", reason: "The Linear accounts index is invalid." };
  }
  const tmpPath = `${filePath}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    writeFileSync(tmpPath, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmpPath, 0o600);
    renameSync(tmpPath, filePath);
    return { kind: "written" };
  } catch {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors when the temp file was never created.
    }
    return { kind: "failed", reason: "Could not save the Linear accounts index." };
  }
}

export function decodeLinearAccountIndex(value: unknown): LinearAccountIndex | undefined {
  if (!isRecord(value)) return undefined;
  if (value.version !== 1) return undefined;
  if (!Array.isArray(value.accounts) || value.accounts.length > MAX_LINEAR_ACCOUNTS) {
    return undefined;
  }
  let legacyRef: string | undefined;
  if (value.legacyRef !== undefined) {
    if (
      typeof value.legacyRef !== "string" ||
      !ACCOUNT_REF_PATTERN.test(value.legacyRef) ||
      SECRETISH.test(value.legacyRef)
    ) {
      return undefined;
    }
    legacyRef = value.legacyRef;
  }
  const seenRefs = new Set<string>();
  const seenVaultIds = new Set<string>();
  const accounts: LinearAccountIndexEntry[] = [];
  for (const item of value.accounts) {
    const entry = decodeAccountEntry(item);
    if (entry === undefined) return undefined;
    if (seenRefs.has(entry.accountRef) || seenVaultIds.has(entry.vaultId)) return undefined;
    seenRefs.add(entry.accountRef);
    seenVaultIds.add(entry.vaultId);
    accounts.push(entry);
  }
  return {
    version: 1,
    accounts,
    ...(legacyRef === undefined ? {} : { legacyRef }),
  };
}

function decodeAccountEntry(value: unknown): LinearAccountIndexEntry | undefined {
  if (!isRecord(value)) return undefined;
  const accountRef = readSafeIdentifier(value.accountRef);
  const login = readSafeLabel(value.login, 128);
  const source = value.source;
  const vaultId = typeof value.vaultId === "string" ? value.vaultId : undefined;
  const reconnectRequired = value.reconnectRequired;
  if (
    accountRef === undefined ||
    login === undefined ||
    (source !== "oauth" && source !== "personal-api-key") ||
    vaultId === undefined ||
    !UUID_PATTERN.test(vaultId) ||
    typeof reconnectRequired !== "boolean" ||
    !Array.isArray(value.scopes) ||
    value.scopes.length > 64
  ) {
    return undefined;
  }
  const scopes: string[] = [];
  for (const item of value.scopes) {
    const scope = readSafeLabel(item, 128);
    if (scope === undefined) return undefined;
    scopes.push(scope);
  }
  const viewerId = value.viewerId === undefined ? undefined : readSafeLabel(value.viewerId, 128);
  if (value.viewerId !== undefined && viewerId === undefined) return undefined;
  const workspaceId =
    value.workspaceId === undefined ? undefined : readSafeLabel(value.workspaceId, 128);
  if (value.workspaceId !== undefined && workspaceId === undefined) return undefined;
  const displayName =
    value.displayName === undefined ? undefined : readSafeLabel(value.displayName, 128);
  if (value.displayName !== undefined && displayName === undefined) return undefined;
  const workspace = value.workspace === undefined ? undefined : readSafeLabel(value.workspace, 128);
  if (value.workspace !== undefined && workspace === undefined) return undefined;
  return {
    accountRef,
    ...(viewerId === undefined ? {} : { viewerId }),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    login,
    ...(displayName === undefined ? {} : { displayName }),
    ...(workspace === undefined ? {} : { workspace }),
    source,
    scopes,
    vaultId,
    reconnectRequired,
  };
}

function readSafeIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!ACCOUNT_REF_PATTERN.test(value) || SECRETISH.test(value)) return undefined;
  return value;
}

function readSafeLabel(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > limit) return undefined;
  if (trimmed.includes("\0") || SECRETISH.test(trimmed)) return undefined;
  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
