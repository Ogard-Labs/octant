import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  access,
  chmod,
  constants,
  lstat,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/**
 * The runtime sets `APPIMAGE` to the file it mounted. A package or an unpacked
 * archive does not, and that absence is the refusal — not a guess about the
 * filename.
 */
const PORTABLE_IMAGE_PATH_VARIABLE = "APPIMAGE";

/**
 * Variables the runtime sets for the mount it already made. Leaving them in
 * the relaunched process makes the new image believe it is still the old one.
 */
const RUNTIME_VARIABLES = ["APPIMAGE", "APPDIR", "ARGV0", "OWD"] as const;

/** Type-2 image magic at offset 8: `AI` plus the format version. */
const IMAGE_MAGIC_OFFSET = 8;
const IMAGE_MAGIC = [0x41, 0x49, 0x02] as const;

const STAGING_SUFFIX = ".octant-new";
const BACKUP_SUFFIX = ".octant-previous";
const FAILED_SUFFIX = ".octant-failed";

export type PortableImageLocation =
  | { readonly kind: "portable"; readonly path: string }
  | { readonly kind: "not-portable" }
  | { readonly kind: "not-writable"; readonly path: string };

export type PortableImageApplyResult =
  | { readonly kind: "relaunched" }
  | { readonly kind: "rolled-back" }
  | { readonly kind: "restore-failed" }
  | { readonly kind: "not-writable" }
  | { readonly kind: "not-portable" }
  | { readonly kind: "corrupt" };

export type PortableImageStat =
  | { readonly kind: "file" }
  | { readonly kind: "symlink" }
  | { readonly kind: "other" };

/**
 * The filesystem the replace talks to.
 *
 * Injected so a test can prove fsync happens before the rename, and so a
 * refusal can be forced without depending on the host's permission bits.
 */
export interface PortableImageFiles {
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  fsync(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  readPrefix(path: string, length: number): Promise<Uint8Array>;
  unlink(path: string): Promise<void>;
  lstat(path: string): Promise<PortableImageStat | undefined>;
  canWrite(directory: string): Promise<boolean>;
}

export interface PortableImageChild {
  once(event: "error" | "spawn", listener: (error?: unknown) => void): void;
  unref(): void;
}

export interface PortableImageSpawnOptions {
  readonly detached: true;
  readonly stdio: "ignore";
  readonly env: Readonly<Record<string, string>>;
}

export type PortableImageSpawn = (
  path: string,
  args: readonly string[],
  options: PortableImageSpawnOptions,
) => PortableImageChild;

export interface PortableImagePort {
  locate(): Promise<PortableImageLocation>;
  replaceAndRelaunch(bytes: Uint8Array, expectedSha256: string): Promise<PortableImageApplyResult>;
}

/** True when these bytes are a type-2 image, not a zip or an archive. */
export function isPortableImageBytes(bytes: Uint8Array): boolean {
  const first = bytes[IMAGE_MAGIC_OFFSET];
  const second = bytes[IMAGE_MAGIC_OFFSET + 1];
  const third = bytes[IMAGE_MAGIC_OFFSET + 2];
  return first === IMAGE_MAGIC[0] && second === IMAGE_MAGIC[1] && third === IMAGE_MAGIC[2];
}

/**
 * Where this process was launched from, if it is an image we can replace.
 *
 * A symlink is refused: renaming it would replace the link and leave the file
 * the next launch still runs. A relative path is refused for the same reason
 * a package install is — we will not invent a target.
 */
export async function readPortableImageLocation(
  env: Readonly<Record<string, string | undefined>>,
  files: PortableImageFiles,
): Promise<PortableImageLocation> {
  const raw = env[PORTABLE_IMAGE_PATH_VARIABLE]?.trim() ?? "";
  if (raw === "" || !isAbsolute(raw)) return { kind: "not-portable" };
  const path = resolve(raw);
  const current = await files.lstat(path);
  if (current === undefined || current.kind !== "file") return { kind: "not-portable" };
  let header: Uint8Array;
  try {
    header = await files.readPrefix(path, IMAGE_MAGIC_OFFSET + IMAGE_MAGIC.length);
  } catch {
    return { kind: "not-portable" };
  }
  if (!isPortableImageBytes(header)) return { kind: "not-portable" };
  if (!(await files.canWrite(dirname(path)))) return { kind: "not-writable", path };
  return { kind: "portable", path };
}

/**
 * Replace one image with bytes that already match the signed hash, then
 * relaunch it.
 *
 * The write lands beside the image, is flushed, and is hashed again before
 * the rename. The previous image is kept until relaunch succeeds. A failed
 * relaunch puts that previous image back; a failed restore says so rather
 * than claiming the old copy is running.
 */
export async function replacePortableImage(input: {
  readonly targetPath: string;
  readonly bytes: Uint8Array;
  readonly expectedSha256: string;
  readonly files: PortableImageFiles;
  readonly relaunch: (path: string) => Promise<void>;
}): Promise<PortableImageApplyResult> {
  if (!isAbsolute(input.targetPath)) return { kind: "not-portable" };
  const targetPath = resolve(input.targetPath);
  const staging = sibling(targetPath, STAGING_SUFFIX);
  const backup = sibling(targetPath, BACKUP_SUFFIX);
  if (staging === undefined || backup === undefined) return { kind: "not-portable" };
  if (!hashesMatch(input.bytes, input.expectedSha256) || !isPortableImageBytes(input.bytes)) {
    return { kind: "corrupt" };
  }

  const current = await input.files.lstat(targetPath);
  if (current === undefined || current.kind !== "file") return { kind: "not-portable" };
  const directory = dirname(targetPath);
  if (!(await input.files.canWrite(directory))) return { kind: "not-writable" };

  const staleBackup = await input.files.lstat(backup);
  if (staleBackup !== undefined) {
    try {
      await input.files.unlink(backup);
    } catch {
      return { kind: "not-writable" };
    }
  }

  try {
    await input.files.writeFile(staging, input.bytes);
    await input.files.chmod(staging, 0o755);
    await input.files.fsync(staging);
  } catch {
    await unlinkQuiet(input.files, staging);
    return { kind: "not-writable" };
  }

  let written: Uint8Array;
  try {
    written = await input.files.readFile(staging);
  } catch {
    await unlinkQuiet(input.files, staging);
    return { kind: "corrupt" };
  }
  if (!hashesMatch(written, input.expectedSha256) || !isPortableImageBytes(written)) {
    await unlinkQuiet(input.files, staging);
    return { kind: "corrupt" };
  }

  try {
    await input.files.rename(targetPath, backup);
  } catch {
    await unlinkQuiet(input.files, staging);
    return { kind: "not-writable" };
  }

  try {
    await input.files.rename(staging, targetPath);
  } catch {
    const restored = await restoreBackup(input.files, backup, targetPath);
    await unlinkQuiet(input.files, staging);
    return restored ? { kind: "rolled-back" } : { kind: "restore-failed" };
  }

  try {
    await input.files.fsync(directory);
  } catch {
    // The rename already published the new image. A directory flush that
    // fails is not a reason to undo a verified replace; relaunch failure
    // still has the backup.
  }

  try {
    await input.relaunch(targetPath);
  } catch {
    const restored = await restoreBackup(input.files, backup, targetPath);
    await unlinkQuiet(input.files, staging);
    return restored ? { kind: "rolled-back" } : { kind: "restore-failed" };
  }

  await unlinkQuiet(input.files, backup);
  return { kind: "relaunched" };
}

export function createNodePortableImageFiles(): PortableImageFiles {
  return {
    writeFile: async (path, bytes) => {
      const existing = await statKind(path);
      if (existing !== undefined) await unlink(path);
      await writeFile(path, bytes, { flag: "wx", mode: 0o644 });
    },
    chmod: (path, mode) => chmod(path, mode),
    fsync: async (path) => {
      const handle = await open(path, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    rename: (from, to) => rename(from, to),
    readFile: async (path) => new Uint8Array(await readFile(path)),
    readPrefix: async (path, length) => {
      const handle = await open(path, "r");
      try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, 0);
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },
    unlink: (path) => unlink(path),
    lstat: (path) => statKind(path),
    canWrite: async (directory) => {
      try {
        await access(directory, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Start the replaced image without inheriting the mount this process is in.
 *
 * Spawn failure rejects, which is what the replace uses to roll back. A
 * process that starts and later crashes is not a spawn failure; the backup
 * is removed only after the operating system has accepted the new image.
 */
export async function relaunchPortableImage(
  path: string,
  options: {
    readonly spawnImpl?: PortableImageSpawn;
    readonly env?: Readonly<Record<string, string | undefined>>;
  } = {},
): Promise<void> {
  const spawnImpl = options.spawnImpl ?? defaultSpawn;
  const env = relaunchEnvironment(options.env ?? process.env);
  await new Promise<void>((resolvePromise, reject) => {
    let settled = false;
    const child = spawnImpl(path, [], { detached: true, stdio: "ignore", env });
    child.once("error", (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error("Octant could not relaunch."));
    });
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolvePromise();
    });
  });
}

export function createPortableImagePort(options: {
  readonly quit: () => void;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly files?: PortableImageFiles;
  readonly relaunch?: (path: string) => Promise<void>;
}): PortableImagePort {
  const env = options.env ?? process.env;
  const files = options.files ?? createNodePortableImageFiles();
  const relaunch = options.relaunch ?? ((path: string) => relaunchPortableImage(path, { env }));
  return {
    locate: () => readPortableImageLocation(env, files),
    replaceAndRelaunch: async (bytes, expectedSha256) => {
      const location = await readPortableImageLocation(env, files);
      if (location.kind !== "portable") {
        return location.kind === "not-writable"
          ? { kind: "not-writable" }
          : { kind: "not-portable" };
      }
      const applied = await replacePortableImage({
        targetPath: location.path,
        bytes,
        expectedSha256,
        files,
        relaunch,
      });
      if (applied.kind === "relaunched") options.quit();
      return applied;
    },
  };
}

function defaultSpawn(
  path: string,
  args: readonly string[],
  options: PortableImageSpawnOptions,
): PortableImageChild {
  const child = spawn(path, [...args], options);
  return {
    once(event, listener) {
      if (event === "error") {
        child.once("error", (error: unknown) => listener(error));
        return;
      }
      child.once("spawn", () => listener());
    },
    unref() {
      child.unref();
    },
  };
}

function relaunchEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (RUNTIME_VARIABLES.some((name) => name === key)) continue;
    env[key] = value;
  }
  return env;
}

function sibling(targetPath: string, suffix: string): string | undefined {
  const directory = dirname(targetPath);
  const name = basename(targetPath);
  if (name === "" || name === "." || name === "..") return undefined;
  const next = join(directory, `.${name}${suffix}`);
  return dirname(next) === directory ? next : undefined;
}

function hashesMatch(bytes: Uint8Array, expectedHex: string): boolean {
  const actual = createHash("sha256").update(bytes).digest();
  let expected: Buffer;
  try {
    expected = Buffer.from(expectedHex, "hex");
  } catch {
    return false;
  }
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function statKind(path: string): Promise<PortableImageStat | undefined> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return { kind: "symlink" };
    if (stat.isFile()) return { kind: "file" };
    return { kind: "other" };
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function unlinkQuiet(files: PortableImageFiles, path: string): Promise<void> {
  try {
    await files.unlink(path);
  } catch {
    // A leftover staging file is not the running image. The caller already
    // decided the replace failed.
  }
}

async function restoreBackup(
  files: PortableImageFiles,
  backup: string,
  targetPath: string,
): Promise<boolean> {
  const aside = sibling(targetPath, FAILED_SUFFIX);
  if (aside === undefined) return false;
  try {
    const current = await files.lstat(targetPath);
    if (current !== undefined) await files.rename(targetPath, aside);
  } catch {
    try {
      await files.unlink(targetPath);
    } catch {
      return false;
    }
  }
  try {
    await files.rename(backup, targetPath);
  } catch {
    return false;
  }
  try {
    await files.fsync(dirname(targetPath));
  } catch {
    // The previous image is back at the path. The directory flush is
    // durability, not the rollback itself.
  }
  await unlinkQuiet(files, aside);
  return true;
}
