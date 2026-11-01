import {
  decodeCodeRelativePath,
  type CodeCheckoutIdentity,
  type CodeFileId,
  type CodeRelativePath,
  type CodeThread,
  type WindowId,
} from "@octant/contracts";
import { classifyFileMentionExtraFolderPath } from "@octant/domain";
import type { CodeFileRootResolution } from "./codeService";

/**
 * Where a file named in a Code Project lives. A file in an extra folder is
 * named by absolute path; the resolution then carries the folder as its root
 * and the path inside it, so every service that joins a root and a path keeps
 * working on a plain folder with no checkout.
 */
export interface CodeFolderRootResolution extends CodeFileRootResolution {
  /** Set when the request named a file in an extra folder: the path inside `rootPath`. */
  readonly relativePath?: CodeRelativePath;
}

/** The path inside the folder to join to `resolution.rootPath`. */
export function pathInResolvedRoot(
  resolution: CodeFolderRootResolution,
  named: CodeRelativePath,
): CodeRelativePath {
  return resolution.relativePath ?? named;
}

/**
 * Wrap a checkout's root authority so an absolute path inside one of the
 * Project's extra folders resolves to that folder. The checkout is still
 * resolved first, so a window, thread or checkout the main authority refuses
 * reaches no extra folder, and an absolute path outside every extra folder
 * stays refused.
 */
export function withProjectExtraFolders(options: {
  readonly resolve: (
    scopeId: WindowId,
    thread: CodeThread,
    checkout: CodeCheckoutIdentity,
    relativePath: CodeRelativePath,
  ) => CodeFileRootResolution | undefined | Promise<CodeFileRootResolution | undefined>;
  readonly extraFolders: (thread: CodeThread) => ReadonlyArray<string>;
  readonly probePath: CodeRelativePath;
  readonly fileId: (threadId: string, checkoutId: string, path: string) => CodeFileId;
  readonly statIdentity: (
    path: string,
  ) => Promise<{ readonly device: string; readonly inode: string }>;
}) {
  return async (
    scopeId: WindowId,
    thread: CodeThread,
    checkout: CodeCheckoutIdentity,
    named: CodeRelativePath,
  ): Promise<CodeFolderRootResolution | undefined> => {
    if (!String(named).startsWith("/")) {
      return options.resolve(scopeId, thread, checkout, named);
    }
    const placed = classifyFileMentionExtraFolderPath(String(named), options.extraFolders(thread));
    if (placed.kind !== "in-folder") return undefined;
    const main = await options.resolve(scopeId, thread, checkout, options.probePath);
    if (main === undefined) return undefined;
    let rootIdentity;
    try {
      rootIdentity = await options.statIdentity(placed.folder);
    } catch {
      return undefined;
    }
    return {
      fileId: options.fileId(thread.id, checkout.id, String(named)),
      rootPath: placed.folder,
      rootIdentity,
      relativePath: decodeCodeRelativePath(placed.path),
    };
  };
}
