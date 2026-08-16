import { access, lstat, mkdir, readdir, realpath, rm, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { decodeChatThreadId, type ChatThreadId } from "@octant/contracts";

const SCRATCH_DIR = "scratch";

class ManagedScratchDirectoryError extends Error {
  constructor(
    message: string,
    readonly unavailable = false,
  ) {
    super(message);
    this.name = "ManagedScratchDirectoryError";
  }
}

export class ChatScratchStore {
  private readonly root: string;

  constructor(dataDirectory: string) {
    this.root = join(dataDirectory, SCRATCH_DIR);
  }

  private getThreadDir(threadId: ChatThreadId): string {
    return join(this.root, threadId);
  }

  async acquire(threadId: ChatThreadId): Promise<string> {
    const chatThreadId = decodeChatThreadId(threadId);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await assertPlainDirectory(this.root);
    const threadDir = this.getThreadDir(chatThreadId);
    await ensurePlainDirectory(threadDir);
    await assertDirectoryWithinRoot(this.root, threadDir);
    await resetDirectoryEntries(threadDir);
    return threadDir;
  }

  async purge(threadId: ChatThreadId): Promise<void> {
    const chatThreadId = decodeChatThreadId(threadId);
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
    throw new ManagedScratchDirectoryError("managed scratch directory is unavailable.", true);
  }
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new ManagedScratchDirectoryError("managed scratch directory is not a plain directory.");
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
    throw new ManagedScratchDirectoryError("managed scratch directory escapes its storage root.");
  }
}

async function resetDirectoryEntries(path: string): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(path, entry.name);
    if (entry.isSymbolicLink()) {
      await unlink(entryPath);
    } else {
      await rm(entryPath, { recursive: true, force: true });
    }
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
