import { createHash } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";

/**
 * The file half of an attachment: bytes on disk under a managed root, staged
 * before they are finalized, hashed on every read.
 *
 * Chat and Code both hand a provider user-supplied files, and both need the
 * same guarantees — a plain directory that no symlink can redirect, a staged
 * file that never becomes an attachment until its digest matches, and a crash
 * recovery pass that removes half-written work. Only the identifiers differ,
 * so they are what this store takes as parameters. Everything a caller's
 * domain owns — records, references, purge policy — stays with the caller.
 */

export const MAX_MANAGED_ATTACHMENT_DISPLAY_NAME_LENGTH = 255;

export class ManagedAttachmentDirectoryError extends Error {
  constructor(
    message: string,
    readonly unavailable = false,
  ) {
    super(message);
    this.name = "ManagedAttachmentDirectoryError";
  }
}

export interface ManagedAttachmentStaged {
  readonly scopeId: string;
  readonly attachmentId: string;
  readonly displayName: string;
  readonly size: number;
  readonly hash: string;
  readonly stagedAt: string;
}

export interface ManagedAttachmentFinalized {
  readonly scopeId: string;
  readonly attachmentId: string;
  readonly displayName: string;
  readonly size: number;
  readonly hash: string;
  readonly finalizedAt: string;
}

export interface ManagedAttachmentStoreOptions {
  /** Directory under `dataDirectory` that holds one subdirectory per scope. */
  readonly scopesDirectory: string;
  readonly maxBytes: number;
  /** Validates an id at the boundary and at directory-name recovery. */
  readonly decodeScopeId: (value: unknown) => string;
  readonly decodeAttachmentId: (value: unknown) => string;
  readonly tooLarge: (byteLength: number) => Error;
  readonly empty: () => Error;
  readonly invalidDisplayName: (message: string) => Error;
}

export interface ManagedAttachmentRecoveryOptions {
  readonly isFinalizedAttachmentReferenced?: (scopeId: string, attachmentId: string) => boolean;
}

export type ManagedAttachmentQueueResult =
  | { readonly status: "ok" }
  | {
      readonly status: "refused";
      readonly reason:
        | "busy"
        | "already-queued"
        | "owner-conflict"
        | "unknown-owner"
        | "unavailable";
    };

export type QueuedAttachmentRelease<AttachmentId> =
  | { readonly disposition: "turn" | "draft" }
  | {
      readonly disposition: "removed";
      /** Read the current durable turn references before deleting any bytes. */
      readonly isTurnOwned: (attachmentId: AttachmentId) => boolean;
    };

interface QueuedAttachments {
  readonly scopeId: string;
  readonly references: ReadonlyArray<ManagedAttachmentFinalized>;
}

const STAGED_FILE = "staged.bin.tmp";
const FINALIZED_FILE = "finalized.bin";

export class ManagedAttachmentStore {
  readonly #root: string;
  readonly #options: ManagedAttachmentStoreOptions;
  readonly #queued = new Map<string, QueuedAttachments>();
  readonly #pins = new Map<string, string>();
  readonly #mutating = new Set<string>();
  readonly #queueOperations = new Set<string>();
  readonly #purging = new Set<string>();

  constructor(dataDirectory: string, options: ManagedAttachmentStoreOptions) {
    this.#root = join(dataDirectory, options.scopesDirectory);
    this.#options = options;
  }

  sanitizeDisplayName(name: string): string {
    return sanitizeManagedAttachmentDisplayName(name, this.#options.invalidDisplayName);
  }

  stage(input: {
    readonly scopeId: string;
    readonly attachmentId: string;
    readonly displayName: string;
    readonly bytes: Uint8Array;
    readonly signal?: AbortSignal;
  }): Promise<ManagedAttachmentStaged> {
    return this.#mutate(input.scopeId, input.attachmentId, () => this.#stage(input));
  }

  async #stage(input: {
    readonly scopeId: string;
    readonly attachmentId: string;
    readonly displayName: string;
    readonly bytes: Uint8Array;
    readonly signal?: AbortSignal;
  }): Promise<ManagedAttachmentStaged> {
    const scopeId = this.#options.decodeScopeId(input.scopeId);
    const attachmentId = this.#options.decodeAttachmentId(input.attachmentId);
    const displayName = this.sanitizeDisplayName(input.displayName);
    assertNotAborted(input.signal);

    if (input.bytes.length === 0) throw this.#options.empty();
    if (input.bytes.length > this.#options.maxBytes) {
      throw this.#options.tooLarge(input.bytes.length);
    }

    const hash = computeHash(input.bytes);
    const dir = await this.#ensureAttachmentDir(scopeId, attachmentId);
    const finalizedPath = join(dir, FINALIZED_FILE);
    if (await exists(finalizedPath)) {
      throw new Error(`Attachment already finalized: ${attachmentId}`);
    }

    assertNotAborted(input.signal);

    const stagedPath = join(dir, STAGED_FILE);
    let stagedHandle: Awaited<ReturnType<typeof open>> | undefined;
    let ownsTempArtifact = false;
    try {
      stagedHandle = await open(stagedPath, "wx", 0o600);
      ownsTempArtifact = true;
      assertNotAborted(input.signal);
      const { bytesWritten } = await stagedHandle.write(input.bytes);
      if (bytesWritten !== input.bytes.length) {
        throw new Error(`Incomplete attachment write for ${attachmentId}`);
      }
      assertNotAborted(input.signal);
      await stagedHandle.close();
      stagedHandle = undefined;
    } catch (error) {
      if (stagedHandle !== undefined) {
        await stagedHandle.close().catch(() => undefined);
      }
      if (ownsTempArtifact) {
        await rm(stagedPath, { force: true });
      }
      throw error;
    }

    return {
      scopeId,
      attachmentId,
      displayName,
      size: input.bytes.length,
      hash,
      stagedAt: new Date().toISOString(),
    };
  }

  finalize(staged: ManagedAttachmentStaged): Promise<ManagedAttachmentFinalized> {
    return this.#mutate(staged.scopeId, staged.attachmentId, () => this.#finalize(staged));
  }

  async #finalize(staged: ManagedAttachmentStaged): Promise<ManagedAttachmentFinalized> {
    const scopeId = this.#options.decodeScopeId(staged.scopeId);
    const attachmentId = this.#options.decodeAttachmentId(staged.attachmentId);
    const displayName = this.sanitizeDisplayName(staged.displayName);
    const dir = await this.#requireAttachmentDir(scopeId, attachmentId);
    const stagedPath = join(dir, STAGED_FILE);
    const finalizedPath = join(dir, FINALIZED_FILE);

    if (await exists(finalizedPath)) {
      const existingBytes = await readFile(finalizedPath);
      const existingHash = computeHash(existingBytes);
      if (existingHash === staged.hash && existingBytes.length === staged.size) {
        return {
          scopeId,
          attachmentId,
          displayName,
          size: staged.size,
          hash: staged.hash,
          finalizedAt: new Date().toISOString(),
        };
      }
      throw new Error(`Finalized attachment corrupt: hash/size mismatch for ${attachmentId}`);
    }

    try {
      await access(stagedPath);
    } catch {
      throw new Error(`Staged attachment not found: ${attachmentId}`);
    }

    const stagedBytes = await readFile(stagedPath);
    if (computeHash(stagedBytes) !== staged.hash) {
      throw new Error(`Staged attachment corrupt: hash mismatch for ${attachmentId}`);
    }
    if (stagedBytes.length !== staged.size) {
      throw new Error(`Staged attachment corrupt: size mismatch for ${attachmentId}`);
    }

    await rename(stagedPath, finalizedPath);
    await chmod(finalizedPath, 0o600);

    return {
      scopeId,
      attachmentId,
      displayName,
      size: staged.size,
      hash: staged.hash,
      finalizedAt: new Date().toISOString(),
    };
  }

  async read(finalized: ManagedAttachmentFinalized): Promise<Uint8Array> {
    const scopeId = this.#options.decodeScopeId(finalized.scopeId);
    const attachmentId = this.#options.decodeAttachmentId(finalized.attachmentId);
    const dir = await this.#requireAttachmentDir(scopeId, attachmentId);
    const finalizedPath = join(dir, FINALIZED_FILE);

    let bytes: Buffer;
    try {
      bytes = await readFile(finalizedPath);
    } catch {
      throw new Error(`Attachment not found: ${attachmentId}`);
    }

    const attachmentBytes = new Uint8Array(bytes);
    if (computeHash(attachmentBytes) !== finalized.hash) {
      throw new Error(`Attachment corrupt: hash mismatch for ${attachmentId}`);
    }
    if (attachmentBytes.length !== finalized.size) {
      throw new Error(`Attachment corrupt: size mismatch for ${attachmentId}`);
    }
    return attachmentBytes;
  }

  remove(scopeId: string, attachmentId: string): Promise<void> {
    return this.#mutate(scopeId, attachmentId, () => this.#remove(scopeId, attachmentId));
  }

  async #remove(scopeId: string, attachmentId: string): Promise<void> {
    const decodedScopeId = this.#options.decodeScopeId(scopeId);
    const decodedAttachmentId = this.#options.decodeAttachmentId(attachmentId);
    let attachmentDir: string;
    try {
      attachmentDir = await this.#validateAttachmentDir(decodedScopeId, decodedAttachmentId);
    } catch (error) {
      if (error instanceof ManagedAttachmentDirectoryError && error.unavailable) return;
      throw error;
    }
    await rm(attachmentDir, { recursive: true, force: true });
  }

  async recover(options: ManagedAttachmentRecoveryOptions = {}): Promise<void> {
    for await (const entry of this.#managedAttachments()) {
      const finalizedPath = join(entry.path, FINALIZED_FILE);
      const stagedPath = join(entry.path, STAGED_FILE);
      try {
        await access(finalizedPath);
        if (
          !this.isQueued(entry.scopeId, entry.attachmentId) &&
          options.isFinalizedAttachmentReferenced?.(entry.scopeId, entry.attachmentId) === false
        ) {
          await this.remove(entry.scopeId, entry.attachmentId);
          continue;
        }
      } catch {
        // A missing finalized file is handled by staged-file cleanup below.
      }

      try {
        await access(stagedPath);
      } catch {
        continue;
      }
      await rm(stagedPath, { force: true });
    }
  }

  async hasTemporaryFiles(): Promise<boolean> {
    for await (const entry of this.#managedAttachments()) {
      if (await exists(join(entry.path, STAGED_FILE))) return true;
    }
    return false;
  }

  async purgeScope(scopeId: string): Promise<void> {
    const decoded = this.#options.decodeScopeId(scopeId);
    if (
      this.#purging.has(decoded) ||
      [...this.#mutating].some((key) => key.startsWith(`${decoded}/`))
    ) {
      throw new Error("Attachment storage is busy.");
    }
    if ([...this.#queued.values()].some((item) => item.scopeId === decoded)) {
      throw new Error("Attachments belong to a queued message.");
    }
    this.#purging.add(decoded);
    try {
      await this.#purgeScope(decoded);
    } finally {
      this.#purging.delete(decoded);
    }
  }

  async #purgeScope(scopeId: string): Promise<void> {
    const decodedScopeId = this.#options.decodeScopeId(scopeId);
    const scopeDir = join(this.#root, decodedScopeId);
    try {
      await access(scopeDir);
    } catch {
      return;
    }
    await assertPlainDirectory(this.#root);
    await assertPlainDirectory(scopeDir);
    await rm(scopeDir, { recursive: true, force: true });
  }

  /** Pins are rebuilt from the queue's private payload before recovery or routing. */
  pinQueued(
    scopeId: string,
    ownerId: string,
    references: ReadonlyArray<ManagedAttachmentFinalized>,
  ): ManagedAttachmentQueueResult {
    const scope = this.#options.decodeScopeId(scopeId);
    const owner = `${scope}/${ownerId}`;
    const ids = references.map((reference) =>
      this.#options.decodeAttachmentId(reference.attachmentId),
    );
    if (
      ownerId.length === 0 ||
      new Set(ids).size !== ids.length ||
      references.some((ref) => ref.scopeId !== scope)
    ) {
      return { status: "refused", reason: "owner-conflict" };
    }
    if (this.#queueOperations.has(owner)) return { status: "refused", reason: "busy" };
    const existing = this.#queued.get(owner);
    if (existing !== undefined) {
      const same =
        existing.references.length === references.length &&
        existing.references.every((ref, index) => {
          const candidate = references[index];
          return (
            candidate !== undefined &&
            ref.scopeId === candidate.scopeId &&
            ref.attachmentId === candidate.attachmentId &&
            ref.displayName === candidate.displayName &&
            ref.size === candidate.size &&
            ref.hash === candidate.hash &&
            ref.finalizedAt === candidate.finalizedAt
          );
        });
      return same ? { status: "ok" } : { status: "refused", reason: "owner-conflict" };
    }
    if (this.#purging.has(scope) || ids.some((id) => this.#mutating.has(`${scope}/${id}`))) {
      return { status: "refused", reason: "busy" };
    }
    if (ids.some((id) => this.#pins.has(`${scope}/${id}`))) {
      return { status: "refused", reason: "already-queued" };
    }
    this.#queued.set(owner, { scopeId: scope, references: references.map((ref) => ({ ...ref })) });
    for (const id of ids) this.#pins.set(`${scope}/${id}`, owner);
    return { status: "ok" };
  }

  isQueued(scopeId: string, attachmentId: string): boolean {
    return this.#pins.has(`${scopeId}/${attachmentId}`);
  }

  async verifyQueued(scopeId: string, ownerId: string): Promise<ManagedAttachmentQueueResult> {
    const owner = `${scopeId}/${ownerId}`;
    const queued = this.#queued.get(owner);
    if (queued === undefined) return { status: "refused", reason: "unknown-owner" };
    if (this.#queueOperations.has(owner)) return { status: "refused", reason: "busy" };
    this.#queueOperations.add(owner);
    try {
      for (const reference of queued.references) await this.read(reference);
      return { status: "ok" };
    } catch {
      return { status: "refused", reason: "unavailable" };
    } finally {
      this.#queueOperations.delete(owner);
    }
  }

  async releaseQueued(
    scopeId: string,
    ownerId: string,
    options: QueuedAttachmentRelease<string>,
  ): Promise<ManagedAttachmentQueueResult> {
    const owner = `${scopeId}/${ownerId}`;
    const queued = this.#queued.get(owner);
    // Retrying cleanup must neither add a reference nor remove a later owner's bytes.
    if (queued === undefined) return { status: "ok" };
    if (this.#queueOperations.has(owner)) return { status: "refused", reason: "busy" };
    this.#queueOperations.add(owner);
    try {
      if (options.disposition === "removed") {
        for (const ref of queued.references) {
          if (!options.isTurnOwned(ref.attachmentId)) await this.#remove(scopeId, ref.attachmentId);
        }
      }
      for (const ref of queued.references) this.#pins.delete(`${scopeId}/${ref.attachmentId}`);
      this.#queued.delete(owner);
      return { status: "ok" };
    } catch {
      return { status: "refused", reason: "unavailable" };
    } finally {
      this.#queueOperations.delete(owner);
    }
  }

  async #mutate<T>(scopeId: string, attachmentId: string, operation: () => Promise<T>): Promise<T> {
    const scope = this.#options.decodeScopeId(scopeId);
    const id = this.#options.decodeAttachmentId(attachmentId);
    const key = `${scope}/${id}`;
    if (this.isQueued(scope, id)) throw new Error("Attachment belongs to a queued message.");
    if (this.#purging.has(scope) || this.#mutating.has(key))
      throw new Error("Attachment storage is busy.");
    this.#mutating.add(key);
    try {
      return await operation();
    } finally {
      this.#mutating.delete(key);
    }
  }

  async *#managedAttachments(): AsyncGenerator<{
    readonly scopeId: string;
    readonly attachmentId: string;
    readonly path: string;
  }> {
    try {
      await access(this.#root);
    } catch {
      return;
    }
    await assertPlainDirectory(this.#root);

    const scopeDirs = await readdir(this.#root, { withFileTypes: true });
    for (const scopeDir of scopeDirs) {
      if (!scopeDir.isDirectory()) continue;
      const scopeDirName = String(scopeDir.name);
      const scopeId = this.#decodedOrUndefined(this.#options.decodeScopeId, scopeDirName);
      if (scopeId === undefined) continue;

      const attachmentsDir = join(this.#root, scopeDirName);
      let attachmentEntries;
      try {
        attachmentEntries = await readdir(attachmentsDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const attachmentDir of attachmentEntries) {
        if (!attachmentDir.isDirectory()) continue;
        const attachmentDirName = String(attachmentDir.name);
        const attachmentId = this.#decodedOrUndefined(
          this.#options.decodeAttachmentId,
          attachmentDirName,
        );
        if (attachmentId === undefined) continue;
        yield {
          scopeId,
          attachmentId,
          path: join(attachmentsDir, attachmentDirName),
        };
      }
    }
  }

  #decodedOrUndefined(decode: (value: unknown) => string, name: string): string | undefined {
    try {
      return decode(name);
    } catch {
      return undefined;
    }
  }

  async #requireAttachmentDir(scopeId: string, attachmentId: string): Promise<string> {
    try {
      return await this.#validateAttachmentDir(scopeId, attachmentId);
    } catch (error) {
      if (error instanceof ManagedAttachmentDirectoryError && error.unavailable) {
        throw new Error(`Attachment not found: ${attachmentId}`);
      }
      throw error;
    }
  }

  async #ensureAttachmentDir(scopeId: string, attachmentId: string): Promise<string> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    await assertPlainDirectory(this.#root);
    await ensurePlainDirectory(join(this.#root, scopeId));
    const attachmentDir = join(this.#root, scopeId, attachmentId);
    await ensurePlainDirectory(attachmentDir);
    await assertDirectoryWithinRoot(this.#root, attachmentDir);
    return attachmentDir;
  }

  async #validateAttachmentDir(scopeId: string, attachmentId: string): Promise<string> {
    await assertPlainDirectory(this.#root);
    await assertPlainDirectory(join(this.#root, scopeId));
    const attachmentDir = join(this.#root, scopeId, attachmentId);
    await assertPlainDirectory(attachmentDir);
    await assertDirectoryWithinRoot(this.#root, attachmentDir);
    return attachmentDir;
  }
}

/**
 * A display name is metadata, never a path. It is folded to one bounded
 * segment so nothing a user types can steer where the bytes land.
 */
export function sanitizeManagedAttachmentDisplayName(
  name: string,
  invalidDisplayName: (message: string) => Error,
): string {
  const normalized = name
    .normalize("NFC")
    .trim()
    .replaceAll(/[/\\]/g, "_")
    .replaceAll(/\.\./g, "_");
  const leaf = basename(normalized);
  const bounded = (leaf.length > 0 ? leaf : normalized).slice(
    0,
    MAX_MANAGED_ATTACHMENT_DISPLAY_NAME_LENGTH,
  );
  if (!bounded) throw invalidDisplayName("Attachment display name must not be empty.");
  return bounded;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("Attachment staging was aborted.");
  }
}

function computeHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function ensurePlainDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) throw error;
  }
  await assertPlainDirectory(path);
}

async function assertPlainDirectory(path: string): Promise<void> {
  let status: Awaited<ReturnType<typeof lstat>>;
  try {
    status = await lstat(path);
  } catch {
    throw new ManagedAttachmentDirectoryError("managed attachment directory is unavailable.", true);
  }
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new ManagedAttachmentDirectoryError(
      "managed attachment directory is not a plain directory.",
    );
  }
}

async function assertDirectoryWithinRoot(root: string, candidate: string): Promise<void> {
  const [resolvedRoot, resolvedCandidate] = await Promise.all([
    realpath(root),
    realpath(candidate),
  ]);
  const relativePath = relative(resolvedRoot, resolvedCandidate);
  if (
    relativePath.length === 0 ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new ManagedAttachmentDirectoryError(
      "managed attachment directory escapes its storage root.",
    );
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
