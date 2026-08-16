import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  link,
} from "node:fs/promises";
import { isAbsolute, join, normalize, resolve } from "node:path";

const RECEIPTS_DIRECTORY = "managed-worktree-receipts";
const RECEIPT_VERSION = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPOSITORY_ID_PATTERN = /^repo_[a-f0-9]{64}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RECEIPT_STATES = ["creating", "ready", "cleanup-pending", "removed"] as const;

export type ManagedWorktreeReceiptState = (typeof RECEIPT_STATES)[number];

export interface ManagedWorktreeSourceProvenance {
  readonly mode: "origin" | "local";
  readonly branch: string;
  readonly resolvedHead: string;
  readonly remoteName?: string;
  readonly fetchedAt?: string;
}

export interface CreateManagedWorktreeReceiptInput {
  readonly repositoryId: string;
  readonly threadId: string;
  readonly checkoutId: string;
  readonly canonicalRepositoryPath: string;
  readonly canonicalWorktreePath: string;
  readonly branchIntent: string;
  readonly refIntent: string;
  readonly expectedHead: string;
  readonly source?: ManagedWorktreeSourceProvenance;
}

export type ManagedWorktreeReceiptLookup = Omit<CreateManagedWorktreeReceiptInput, "expectedHead">;

export interface ManagedWorktreeReceipt extends CreateManagedWorktreeReceiptInput {
  readonly version: 1;
  readonly receiptId: string;
  readonly state: ManagedWorktreeReceiptState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ManagedWorktreeReceiptStoreOptions {
  readonly dataDirectory: string;
  readonly clock?: () => string;
  readonly uuid?: () => string;
}

const requiredReceiptFields = [
  "version",
  "receiptId",
  "repositoryId",
  "threadId",
  "checkoutId",
  "canonicalRepositoryPath",
  "canonicalWorktreePath",
  "branchIntent",
  "refIntent",
  "expectedHead",
  "state",
  "createdAt",
  "updatedAt",
] as const;

function invalidReceipt(): Error {
  return new Error("invalid managed worktree receipt");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isCanonicalPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4_096 &&
    !value.includes("\0") &&
    isAbsolute(value) &&
    resolve(value) === value &&
    normalize(value) === value
  );
}

function isIntent(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value.trim() === value &&
    !value.includes("\0")
  );
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) return false;
  const date = new Date(value);
  return Number.isSafeInteger(date.getTime()) && date.toISOString() === value;
}

function isState(value: unknown): value is ManagedWorktreeReceiptState {
  return typeof value === "string" && RECEIPT_STATES.includes(value as ManagedWorktreeReceiptState);
}

function isSource(value: unknown): value is ManagedWorktreeSourceProvenance {
  if (!isRecord(value)) return false;
  if (value.mode !== "origin" && value.mode !== "local") return false;
  if (!isIntent(value.branch, 512)) return false;
  if (
    typeof value.resolvedHead !== "string" ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.resolvedHead)
  ) {
    return false;
  }
  if (value.remoteName !== undefined && !isIntent(value.remoteName, 255)) return false;
  return value.fetchedAt === undefined || isTimestamp(value.fetchedAt);
}

function decodeReceipt(value: unknown): ManagedWorktreeReceipt {
  if (
    !isRecord(value) ||
    Object.keys(value).length < requiredReceiptFields.length ||
    Object.keys(value).length > requiredReceiptFields.length + 1 ||
    requiredReceiptFields.some((field) => !(field in value)) ||
    Object.keys(value).some(
      (field) =>
        !requiredReceiptFields.includes(field as (typeof requiredReceiptFields)[number]) &&
        field !== "source",
    ) ||
    value.version !== RECEIPT_VERSION ||
    !isUuid(value.receiptId) ||
    typeof value.repositoryId !== "string" ||
    !REPOSITORY_ID_PATTERN.test(value.repositoryId) ||
    !isUuid(value.threadId) ||
    !isUuid(value.checkoutId) ||
    !isCanonicalPath(value.canonicalRepositoryPath) ||
    !isCanonicalPath(value.canonicalWorktreePath) ||
    !isIntent(value.branchIntent, 255) ||
    !isIntent(value.refIntent, 512) ||
    typeof value.expectedHead !== "string" ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.expectedHead) ||
    !isState(value.state) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    (value.source !== undefined && !isSource(value.source))
  ) {
    throw invalidReceipt();
  }

  return {
    version: RECEIPT_VERSION,
    receiptId: value.receiptId,
    repositoryId: value.repositoryId,
    threadId: value.threadId,
    checkoutId: value.checkoutId,
    canonicalRepositoryPath: value.canonicalRepositoryPath,
    canonicalWorktreePath: value.canonicalWorktreePath,
    branchIntent: value.branchIntent,
    refIntent: value.refIntent,
    expectedHead: value.expectedHead,
    state: value.state,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.source === undefined
      ? {}
      : { source: value.source as ManagedWorktreeSourceProvenance }),
  };
}

function canTransition(
  current: ManagedWorktreeReceiptState,
  next: ManagedWorktreeReceiptState,
): boolean {
  return (
    current === next ||
    (current === "creating" && (next === "ready" || next === "cleanup-pending")) ||
    (current === "ready" && next === "cleanup-pending") ||
    (current === "cleanup-pending" && next === "removed")
  );
}

export class ManagedWorktreeReceiptStore {
  readonly #root: string;
  readonly #clock: () => string;
  readonly #uuid: () => string;

  constructor(options: ManagedWorktreeReceiptStoreOptions) {
    this.#root = join(options.dataDirectory, RECEIPTS_DIRECTORY);
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#uuid = options.uuid ?? randomUUID;
  }

  async create(input: CreateManagedWorktreeReceiptInput): Promise<ManagedWorktreeReceipt> {
    const receiptId = this.#uuid();
    const timestamp = this.#clock();
    const receipt = decodeReceipt({
      version: RECEIPT_VERSION,
      receiptId,
      ...input,
      state: "creating",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await this.#ensureRoot();

    const temporaryPath = await this.#writeTemporary(receipt);
    try {
      await link(temporaryPath, this.#claimPath(receipt));
      await link(temporaryPath, this.#receiptPath(receipt.receiptId));
      await this.#syncRoot();
    } catch (error) {
      if (hasErrorCode(error, "EEXIST")) {
        throw new Error("managed worktree receipt already exists");
      }
      throw error;
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
    return receipt;
  }

  async load(receiptId: string): Promise<ManagedWorktreeReceipt | undefined> {
    if (!isUuid(receiptId)) throw invalidReceipt();
    const direct = await this.#readReceipt(this.#receiptPath(receiptId));
    if (direct !== undefined) {
      if (direct.receiptId !== receiptId) throw invalidReceipt();
      return direct;
    }
    let entries: string[];
    try {
      entries = await readdir(this.#root);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return undefined;
      throw error;
    }
    let claimed: ManagedWorktreeReceipt | undefined;
    for (const entry of entries) {
      if (!/^\.claim-[a-f0-9]{64}\.json$/.test(entry)) continue;
      const receipt = await this.#readReceipt(join(this.#root, entry));
      if (receipt?.receiptId !== receiptId) continue;
      if (claimed !== undefined) throw new Error("ambiguous managed worktree receipt");
      claimed = receipt;
    }
    return claimed;
  }

  async findActive(
    input: ManagedWorktreeReceiptLookup,
  ): Promise<ManagedWorktreeReceipt | undefined> {
    const claimed = await this.#readReceipt(this.#claimPath(input));
    if (claimed === undefined) return undefined;
    const receipt = (await this.load(claimed.receiptId)) ?? claimed;
    if (receipt !== undefined && !sameReceiptLookup(receipt, input)) {
      throw new Error("conflicting managed worktree receipt");
    }
    return receipt.state === "removed" ? undefined : receipt;
  }

  async transition(
    receiptId: string,
    state: ManagedWorktreeReceiptState,
  ): Promise<ManagedWorktreeReceipt> {
    const current = await this.load(receiptId);
    if (current === undefined || !canTransition(current.state, state)) {
      throw new Error("invalid managed worktree receipt transition");
    }
    if (current.state === state) return current;

    const next = decodeReceipt({ ...current, state, updatedAt: this.#clock() });
    await this.#ensureRoot();
    const temporaryPath = await this.#writeTemporary(next);
    try {
      await rename(temporaryPath, this.#receiptPath(receiptId));
      await this.#syncRoot();
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
    return next;
  }

  #receiptPath(receiptId: string): string {
    return join(this.#root, `${receiptId}.json`);
  }

  #claimPath(
    input: Pick<CreateManagedWorktreeReceiptInput, "repositoryId" | "canonicalWorktreePath">,
  ): string {
    const claim = createHash("sha256")
      .update("octant.managed-worktree-claim.v1\0")
      .update(input.repositoryId)
      .update("\0")
      .update(input.canonicalWorktreePath)
      .digest("hex");
    return join(this.#root, `.claim-${claim}.json`);
  }

  async #readReceipt(path: string): Promise<ManagedWorktreeReceipt | undefined> {
    let contents: string;
    try {
      contents = await readFile(path, "utf8");
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return undefined;
      throw error;
    }
    try {
      return decodeReceipt(JSON.parse(contents));
    } catch {
      throw invalidReceipt();
    }
  }

  async #ensureRoot(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.#root);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("managed worktree receipt directory is unavailable");
    }
    await chmod(this.#root, 0o700);
  }

  async #writeTemporary(receipt: ManagedWorktreeReceipt): Promise<string> {
    const path = join(this.#root, `.${receipt.receiptId}.${process.pid}.${randomUUID()}.tmp`);
    const handle = await open(path, "wx", 0o600);
    try {
      await chmod(path, 0o600);
      await handle.writeFile(`${JSON.stringify(receipt)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return path;
  }

  async #syncRoot(): Promise<void> {
    const handle = await open(this.#root, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

function sameReceiptLookup(
  receipt: ManagedWorktreeReceipt,
  input: ManagedWorktreeReceiptLookup,
): boolean {
  return (
    receipt.repositoryId === input.repositoryId &&
    receipt.threadId === input.threadId &&
    receipt.checkoutId === input.checkoutId &&
    receipt.canonicalRepositoryPath === input.canonicalRepositoryPath &&
    receipt.canonicalWorktreePath === input.canonicalWorktreePath &&
    receipt.branchIntent === input.branchIntent &&
    receipt.refIntent === input.refIntent
  );
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
