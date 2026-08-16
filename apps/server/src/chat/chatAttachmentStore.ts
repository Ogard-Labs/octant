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
import {
  decodeChatAttachmentId,
  decodeChatThreadId,
  type ChatAttachmentId,
  type ChatThreadId,
} from "@octant/contracts";

export const MAX_CHAT_ATTACHMENT_BYTES = 26_214_400;
export const MAX_CHAT_ATTACHMENT_DISPLAY_NAME_LENGTH = 255;

export class ChatAttachmentTooLarge extends Error {
  readonly category = "too-large" as const;

  constructor(readonly byteLength: number) {
    super(
      `Attachment is too large (${byteLength} bytes). The maximum size is ${MAX_CHAT_ATTACHMENT_BYTES} bytes.`,
    );
    this.name = "ChatAttachmentTooLarge";
  }
}

export class ChatAttachmentInvalidDisplayName extends Error {
  readonly category = "invalid" as const;

  constructor(message: string) {
    super(message);
    this.name = "ChatAttachmentInvalidDisplayName";
  }
}

export class ChatAttachmentEmpty extends Error {
  readonly category = "invalid" as const;

  constructor() {
    super("Attachment must not be empty.");
    this.name = "ChatAttachmentEmpty";
  }
}

export interface ChatAttachmentStaged {
  readonly chatThreadId: ChatThreadId;
  readonly chatAttachmentId: ChatAttachmentId;
  readonly displayName: string;
  readonly size: number;
  readonly hash: string;
  readonly stagedAt: string;
}

export interface ChatAttachmentFinalized {
  readonly chatThreadId: ChatThreadId;
  readonly chatAttachmentId: ChatAttachmentId;
  readonly displayName: string;
  readonly size: number;
  readonly hash: string;
  readonly finalizedAt: string;
}

export interface ChatAttachmentRecoveryOptions {
  readonly isFinalizedAttachmentReferenced?: (
    threadId: ChatThreadId,
    attachmentId: ChatAttachmentId,
  ) => boolean;
}

const THREADS_DIR = "threads";
const STAGED_FILE = "staged.bin.tmp";
const FINALIZED_FILE = "finalized.bin";

class ManagedAttachmentDirectoryError extends Error {
  constructor(
    message: string,
    readonly unavailable = false,
  ) {
    super(message);
    this.name = "ManagedAttachmentDirectoryError";
  }
}

const computeHash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export function sanitizeChatAttachmentDisplayName(name: string): string {
  const normalized = name
    .normalize("NFC")
    .trim()
    .replaceAll(/[/\\]/g, "_")
    .replaceAll(/\.\./g, "_");
  const leaf = basename(normalized);
  const bounded = (leaf.length > 0 ? leaf : normalized).slice(
    0,
    MAX_CHAT_ATTACHMENT_DISPLAY_NAME_LENGTH,
  );
  if (!bounded) {
    throw new ChatAttachmentInvalidDisplayName("Attachment display name must not be empty.");
  }
  return bounded;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("Attachment staging was aborted.");
  }
}

function decodeThreadIdAtBoundary(threadId: unknown): ChatThreadId {
  return decodeChatThreadId(threadId);
}

function decodeAttachmentIdAtBoundary(attachmentId: unknown): ChatAttachmentId {
  return decodeChatAttachmentId(attachmentId);
}

export class ChatAttachmentStore {
  private readonly root: string;

  constructor(dataDirectory: string) {
    this.root = join(dataDirectory, THREADS_DIR);
  }

  private getAttachmentDir(threadId: ChatThreadId, attachmentId: ChatAttachmentId): string {
    return join(this.root, threadId, attachmentId);
  }

  private getThreadDir(threadId: ChatThreadId): string {
    return join(this.root, threadId);
  }

  private async ensureAttachmentDir(
    threadId: ChatThreadId,
    attachmentId: ChatAttachmentId,
  ): Promise<string> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await assertPlainDirectory(this.root);
    const threadDir = this.getThreadDir(threadId);
    await ensurePlainDirectory(threadDir);
    const attachmentDir = this.getAttachmentDir(threadId, attachmentId);
    await ensurePlainDirectory(attachmentDir);
    await assertDirectoryWithinRoot(this.root, attachmentDir);
    return attachmentDir;
  }

  private async validateAttachmentDir(
    threadId: ChatThreadId,
    attachmentId: ChatAttachmentId,
  ): Promise<string> {
    await assertPlainDirectory(this.root);
    await assertPlainDirectory(this.getThreadDir(threadId));
    const attachmentDir = this.getAttachmentDir(threadId, attachmentId);
    await assertPlainDirectory(attachmentDir);
    await assertDirectoryWithinRoot(this.root, attachmentDir);
    return attachmentDir;
  }

  async stage(input: {
    readonly chatThreadId: ChatThreadId;
    readonly chatAttachmentId: ChatAttachmentId;
    readonly displayName: string;
    readonly bytes: Uint8Array;
    readonly signal?: AbortSignal;
  }): Promise<ChatAttachmentStaged> {
    const chatThreadId = decodeThreadIdAtBoundary(input.chatThreadId);
    const chatAttachmentId = decodeAttachmentIdAtBoundary(input.chatAttachmentId);
    const displayName = sanitizeChatAttachmentDisplayName(input.displayName);
    assertNotAborted(input.signal);

    if (input.bytes.length === 0) {
      throw new ChatAttachmentEmpty();
    }

    if (input.bytes.length > MAX_CHAT_ATTACHMENT_BYTES) {
      throw new ChatAttachmentTooLarge(input.bytes.length);
    }

    const hash = computeHash(input.bytes);
    const dir = await this.ensureAttachmentDir(chatThreadId, chatAttachmentId);
    const finalizedPath = join(dir, FINALIZED_FILE);
    if (await exists(finalizedPath)) {
      throw new Error(`Attachment already finalized: ${chatAttachmentId}`);
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
        throw new Error(`Incomplete attachment write for ${chatAttachmentId}`);
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
      chatThreadId,
      chatAttachmentId,
      displayName,
      size: input.bytes.length,
      hash,
      stagedAt: new Date().toISOString(),
    };
  }

  async finalize(staged: ChatAttachmentStaged): Promise<ChatAttachmentFinalized> {
    const chatThreadId = decodeThreadIdAtBoundary(staged.chatThreadId);
    const chatAttachmentId = decodeAttachmentIdAtBoundary(staged.chatAttachmentId);
    const displayName = sanitizeChatAttachmentDisplayName(staged.displayName);
    let dir: string;
    try {
      dir = await this.validateAttachmentDir(chatThreadId, chatAttachmentId);
    } catch (error) {
      if (error instanceof ManagedAttachmentDirectoryError && error.unavailable) {
        throw new Error(`Attachment not found: ${chatAttachmentId}`);
      }
      throw error;
    }
    const stagedPath = join(dir, STAGED_FILE);
    const finalizedPath = join(dir, FINALIZED_FILE);

    if (await exists(finalizedPath)) {
      const existingBytes = await readFile(finalizedPath);
      const existingHash = computeHash(existingBytes);

      if (existingHash === staged.hash && existingBytes.length === staged.size) {
        return {
          chatThreadId,
          chatAttachmentId,
          displayName,
          size: staged.size,
          hash: staged.hash,
          finalizedAt: new Date().toISOString(),
        };
      }

      throw new Error(`Finalized attachment corrupt: hash/size mismatch for ${chatAttachmentId}`);
    }

    try {
      await access(stagedPath);
    } catch {
      throw new Error(`Staged attachment not found: ${chatAttachmentId}`);
    }

    const stagedBytes = await readFile(stagedPath);
    const actualHash = computeHash(stagedBytes);

    if (actualHash !== staged.hash) {
      throw new Error(`Staged attachment corrupt: hash mismatch for ${chatAttachmentId}`);
    }

    if (stagedBytes.length !== staged.size) {
      throw new Error(`Staged attachment corrupt: size mismatch for ${chatAttachmentId}`);
    }

    await rename(stagedPath, finalizedPath);
    await chmod(finalizedPath, 0o600);

    return {
      chatThreadId,
      chatAttachmentId,
      displayName,
      size: staged.size,
      hash: staged.hash,
      finalizedAt: new Date().toISOString(),
    };
  }

  async read(finalized: ChatAttachmentFinalized): Promise<Uint8Array> {
    const chatThreadId = decodeThreadIdAtBoundary(finalized.chatThreadId);
    const chatAttachmentId = decodeAttachmentIdAtBoundary(finalized.chatAttachmentId);
    let dir: string;
    try {
      dir = await this.validateAttachmentDir(chatThreadId, chatAttachmentId);
    } catch (error) {
      if (error instanceof ManagedAttachmentDirectoryError && error.unavailable) {
        throw new Error(`Attachment not found: ${chatAttachmentId}`);
      }
      throw error;
    }
    const finalizedPath = join(dir, FINALIZED_FILE);

    let bytes: Buffer;
    try {
      bytes = await readFile(finalizedPath);
    } catch {
      throw new Error(`Attachment not found: ${chatAttachmentId}`);
    }

    const attachmentBytes = new Uint8Array(bytes);
    const actualHash = computeHash(attachmentBytes);
    if (actualHash !== finalized.hash) {
      throw new Error(`Attachment corrupt: hash mismatch for ${chatAttachmentId}`);
    }

    if (attachmentBytes.length !== finalized.size) {
      throw new Error(`Attachment corrupt: size mismatch for ${chatAttachmentId}`);
    }

    return attachmentBytes;
  }

  async remove(threadId: ChatThreadId, attachmentId: ChatAttachmentId): Promise<void> {
    const decodedThreadId = decodeThreadIdAtBoundary(threadId);
    const decodedAttachmentId = decodeAttachmentIdAtBoundary(attachmentId);
    let attachmentDir: string;
    try {
      attachmentDir = await this.validateAttachmentDir(decodedThreadId, decodedAttachmentId);
    } catch (error) {
      if (error instanceof ManagedAttachmentDirectoryError && error.unavailable) {
        return;
      }
      throw error;
    }
    await rm(attachmentDir, { recursive: true, force: true });
  }

  async recover(options: ChatAttachmentRecoveryOptions = {}): Promise<void> {
    try {
      await access(this.root);
    } catch {
      return;
    }
    await assertPlainDirectory(this.root);

    const threadDirs = await readdir(this.root, { withFileTypes: true });

    for (const threadDir of threadDirs) {
      if (!threadDir.isDirectory()) {
        continue;
      }

      const threadDirName = String(threadDir.name);
      if (!isDecodedThreadDirectoryName(threadDirName)) {
        continue;
      }

      const attachmentsDir = join(this.root, threadDirName);
      let attachmentEntries;
      try {
        attachmentEntries = await readdir(attachmentsDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const attDir of attachmentEntries) {
        if (!attDir.isDirectory()) {
          continue;
        }

        const attachmentDirName = String(attDir.name);
        if (!isDecodedAttachmentDirectoryName(attachmentDirName)) {
          continue;
        }

        const attPath = join(attachmentsDir, attachmentDirName);
        const stagedPath = join(attPath, STAGED_FILE);
        const finalizedPath = join(attPath, FINALIZED_FILE);
        const threadId = decodeThreadIdAtBoundary(threadDirName);
        const attachmentId = decodeAttachmentIdAtBoundary(attachmentDirName);

        try {
          await access(finalizedPath);
          if (options.isFinalizedAttachmentReferenced?.(threadId, attachmentId) === false) {
            await this.remove(threadId, attachmentId);
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
  }

  async hasTemporaryFiles(): Promise<boolean> {
    try {
      await access(this.root);
    } catch {
      return false;
    }
    await assertPlainDirectory(this.root);

    const threadDirs = await readdir(this.root, { withFileTypes: true });
    for (const threadDir of threadDirs) {
      if (!threadDir.isDirectory()) {
        continue;
      }

      const threadDirName = String(threadDir.name);
      if (!isDecodedThreadDirectoryName(threadDirName)) {
        continue;
      }

      const attachmentsDir = join(this.root, threadDirName);
      let attachmentEntries;
      try {
        attachmentEntries = await readdir(attachmentsDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const attDir of attachmentEntries) {
        if (!attDir.isDirectory()) {
          continue;
        }

        const attachmentDirName = String(attDir.name);
        if (!isDecodedAttachmentDirectoryName(attachmentDirName)) {
          continue;
        }

        if (await exists(join(attachmentsDir, attachmentDirName, STAGED_FILE))) {
          return true;
        }
      }
    }

    return false;
  }

  async purgeThread(threadId: ChatThreadId): Promise<void> {
    const chatThreadId = decodeThreadIdAtBoundary(threadId);
    const threadDir = this.getThreadDir(chatThreadId);

    try {
      await access(threadDir);
    } catch {
      return;
    }

    await assertPlainDirectory(this.root);
    await assertPlainDirectory(threadDir);

    await rm(threadDir, { recursive: true, force: true });
  }
}

function isDecodedThreadDirectoryName(name: string): boolean {
  try {
    decodeChatThreadId(name);
    return true;
  } catch {
    return false;
  }
}

function isDecodedAttachmentDirectoryName(name: string): boolean {
  try {
    decodeChatAttachmentId(name);
    return true;
  } catch {
    return false;
  }
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
