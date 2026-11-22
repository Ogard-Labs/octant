import {
  decodeCodeRelativePath,
  type CodeThreadView,
  type ImageGenerationSaveResult,
  type WindowId,
} from "@octant/contracts";
import { canonicalizeWorkRelativePath } from "@octant/domain";
import type { CodeFileRootAuthorityPort } from "../code/codeService";
import { isProtectedSecretPath } from "../process/secretGuard";
import { writeConfinedWorkFile } from "../work/workConfinedWrite";
import {
  liveWorkFilesystem,
  type WorkFileIdentity,
  type WorkFilesystemPort,
} from "../work/workFilesystemPort";
import { WorkResolutionService } from "../work/workResolutionService";

export async function saveGeneratedCodeImage(
  input: {
    readonly windowId: WindowId;
    readonly view: CodeThreadView;
    readonly relativePath: string;
    readonly bytes: Uint8Array;
  },
  roots: CodeFileRootAuthorityPort,
): Promise<ImageGenerationSaveResult> {
  const { thread, checkout } = input.view;
  if (thread.executionPolicy === "plan") {
    return { status: "refused", reason: "Plan mode cannot save images." };
  }
  let relativePath;
  try {
    relativePath = decodeCodeRelativePath(canonicalizeWorkRelativePath(input.relativePath));
  } catch {
    return { status: "refused", reason: "The save path is outside the checkout." };
  }
  const root = await roots.resolve(input.windowId, thread, checkout, relativePath);
  if (root?.current === undefined) {
    return { status: "refused", reason: "The Code checkout is unavailable." };
  }
  return await saveGeneratedImageUnder({
    root: root.rootPath,
    relativePath,
    bytes: input.bytes,
    current: root.current,
  });
}

/**
 * Writes a generated image as a new file under `root`, through the Work
 * confinement sequence: the path is resolved for create inside the root, then
 * written exclusively through the parent it proved, so a path that escapes
 * the root, a symlinked component, or an existing file is refused rather than
 * followed or overwritten. A person's Save and an agent's save both use it.
 */
export async function saveGeneratedImageUnder(
  input: {
    readonly root: string;
    readonly relativePath: string;
    readonly bytes: Uint8Array;
    readonly current?: () => boolean;
  },
  filesystem: WorkFilesystemPort = liveWorkFilesystem,
): Promise<ImageGenerationSaveResult> {
  try {
    const resolution = await new WorkResolutionService(filesystem).resolveForCreate({
      binding: {
        canonicalRoot: input.root,
        knownCanonicalRoot: input.root,
        availability: "available",
        bindingSuperseded: false,
      },
      relativePath: canonicalizeWorkRelativePath(input.relativePath),
    });
    if (resolution.status !== "resolved-for-create") {
      return { status: "refused", reason: "The save path is outside the Project." };
    }
    if (input.current?.() === false) {
      return { status: "refused", reason: "The save folder is unavailable." };
    }
    const written = await writeConfinedWorkFile({
      filesystem,
      canonicalPath: resolution.absolutePath,
      allowCreate: true,
      parent: {
        absolutePath: resolution.parentAbsolute,
        identity: resolution.parentIdentity,
        remaining: resolution.remaining,
      },
      bytes: input.bytes,
    });
    return written
      ? { status: "saved", relativePath: resolution.relativePath }
      : { status: "failed", reason: "The image could not be saved." };
  } catch {
    return { status: "failed", reason: "The image could not be saved." };
  }
}

export type ConfinedNewFileCheck =
  | {
      readonly status: "ok";
      readonly relativePath: string;
      readonly absolutePath: string;
      readonly rootIdentity: WorkFileIdentity;
      readonly parentAbsolute: string;
      readonly parentIdentity: WorkFileIdentity;
      readonly remaining: ReadonlyArray<string>;
    }
  | { readonly status: "refused"; readonly reason: string };

export type ConfinedNewFileWriteResult =
  | { readonly status: "saved"; readonly relativePath: string }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

/**
 * Checks whether a new file can be created under `root` without leaving it,
 * following an escaping symlink, touching a protected secret path, or
 * overwriting an existing entry. Used both before asking for confirmation and
 * again at write time.
 */
export async function checkConfinedNewFileUnder(
  input: {
    readonly root: string;
    readonly relativePath: string;
    readonly expectedRootIdentity?: WorkFileIdentity;
  },
  filesystem: WorkFilesystemPort = liveWorkFilesystem,
): Promise<ConfinedNewFileCheck> {
  let rootIdentity: WorkFileIdentity;
  try {
    const canonicalRoot = await filesystem.realpath(input.root);
    const rootStat = await filesystem.lstat(canonicalRoot);
    if (canonicalRoot !== input.root || !rootStat.isDirectory) {
      return { status: "refused", reason: "The save folder is unavailable." };
    }
    rootIdentity = { device: rootStat.device, inode: rootStat.inode };
    if (
      input.expectedRootIdentity !== undefined &&
      (rootIdentity.device !== input.expectedRootIdentity.device ||
        rootIdentity.inode !== input.expectedRootIdentity.inode)
    ) {
      return { status: "refused", reason: "The save folder changed." };
    }
  } catch {
    return { status: "refused", reason: "The save folder is unavailable." };
  }
  let relativePath: string;
  try {
    relativePath = canonicalizeWorkRelativePath(input.relativePath);
  } catch {
    return { status: "refused", reason: "The save path is outside the folder." };
  }
  const resolution = await new WorkResolutionService(filesystem).resolveForCreate({
    binding: {
      canonicalRoot: input.root,
      knownCanonicalRoot: input.root,
      availability: "available",
      bindingSuperseded: false,
    },
    relativePath,
  });
  if (resolution.status !== "resolved-for-create") {
    return { status: "refused", reason: "The save path is outside the folder." };
  }
  if (isProtectedSecretPath(resolution.absolutePath)) {
    return { status: "refused", reason: "The save path is protected." };
  }
  if (resolution.remaining.length === 1) {
    try {
      await filesystem.lstat(resolution.absolutePath);
      return { status: "refused", reason: "That file already exists. Choose a new path." };
    } catch (error) {
      if (!isMissingFileError(error)) {
        return { status: "refused", reason: "The save path is unavailable." };
      }
    }
  }
  return {
    status: "ok",
    relativePath: resolution.relativePath,
    absolutePath: resolution.absolutePath,
    rootIdentity,
    parentAbsolute: resolution.parentAbsolute,
    parentIdentity: resolution.parentIdentity,
    remaining: resolution.remaining,
  };
}

/**
 * Writes a new file under `root` through the same confined, exclusive-create
 * path as `saveGeneratedImageUnder`, also refusing protected secret paths,
 * replaced roots, and existing files with neutral failure reasons.
 */
export async function writeConfinedNewFileUnder(
  input: {
    readonly root: string;
    readonly relativePath: string;
    readonly bytes: Uint8Array;
    readonly expectedRootIdentity?: WorkFileIdentity;
    readonly current?: () => boolean;
  },
  filesystem: WorkFilesystemPort = liveWorkFilesystem,
): Promise<ConfinedNewFileWriteResult> {
  try {
    const check = await checkConfinedNewFileUnder(input, filesystem);
    if (check.status !== "ok") return check;
    if (input.current?.() === false) {
      return { status: "refused", reason: "The save folder is unavailable." };
    }
    const written = await writeConfinedWorkFile({
      filesystem,
      canonicalPath: check.absolutePath,
      allowCreate: true,
      parent: {
        absolutePath: check.parentAbsolute,
        identity: check.parentIdentity,
        remaining: check.remaining,
      },
      bytes: input.bytes,
    });
    return written
      ? { status: "saved", relativePath: check.relativePath }
      : { status: "failed", reason: "The file could not be saved." };
  } catch {
    return { status: "failed", reason: "The file could not be saved." };
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
