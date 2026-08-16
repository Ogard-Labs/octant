import { lstat, mkdir, realpath, rm, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { decodeRootlessTurnId, type RootlessTurnId } from "@octant/contracts";

const SCRATCH_DIRECTORY = "rootless-scratch";

export class RootlessScratchStore {
  readonly #root: string;

  constructor(dataDirectory: string) {
    this.#root = join(dataDirectory, SCRATCH_DIRECTORY);
  }

  async acquire(input: RootlessTurnId): Promise<string> {
    const turnId = decodeRootlessTurnId(input);
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    await assertPlainDirectory(this.#root);
    const scratch = join(this.#root, turnId);
    await removeOwnedEntry(scratch);
    await mkdir(scratch, { mode: 0o700 });
    await assertWithin(this.#root, scratch);
    return scratch;
  }

  async purge(input: RootlessTurnId): Promise<void> {
    const turnId = decodeRootlessTurnId(input);
    await assertPlainDirectory(this.#root).catch((error) => {
      if (hasCode(error, "ENOENT")) return;
      throw error;
    });
    await removeOwnedEntry(join(this.#root, turnId));
  }
}

async function removeOwnedEntry(path: string): Promise<void> {
  let status: Awaited<ReturnType<typeof lstat>>;
  try {
    status = await lstat(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
  if (status.isSymbolicLink()) {
    await unlink(path);
    return;
  }
  await rm(path, { recursive: true, force: true });
}

async function assertPlainDirectory(path: string): Promise<void> {
  const status = await lstat(path);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error("Rootless scratch storage is not a plain directory.");
  }
}

async function assertWithin(root: string, candidate: string): Promise<void> {
  const [resolvedRoot, resolvedCandidate] = await Promise.all([
    realpath(root),
    realpath(candidate),
  ]);
  const path = relative(resolvedRoot, resolvedCandidate);
  if (path.length === 0 || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error("Rootless scratch directory escapes managed storage.");
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
