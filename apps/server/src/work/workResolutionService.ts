import { createHash } from "node:crypto";
import { Schema } from "effect";
import { UtcTimestamp } from "@octant/contracts/events";
import { ContentSha256, type PreviewSourceVersion } from "@octant/contracts/previews";
import {
  canonicalizeWorkRelativePath,
  classifyPathContainment,
  classifySymlinkContainment,
  classifyWorkSourceAvailability,
  detectMovedRoot,
  detectRevokedRoot,
  WorkConfinementRejected,
} from "@octant/domain";
import { MAX_WORK_INPUT_BYTES } from "./workBudget";
import { readConfinedWorkFile } from "./workConfinedRead";
import type { WorkFileIdentity, WorkFilesystemPort, WorkFileStat } from "./workFilesystemPort";

const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);
const decodeSha256 = Schema.decodeUnknownSync(ContentSha256);

/**
 * Authoritative Work root binding state. The host supplies the current
 * canonical root, the canonical root recorded when the artifact reference was
 * minted, and the binding availability/superseded flags. The resolution
 * service fails closed when the root has moved, been revoked, or the candidate
 * path escapes the canonical root.
 */
export interface WorkRootBinding {
  readonly canonicalRoot: string;
  readonly knownCanonicalRoot: string;
  readonly availability: "available" | "unavailable" | "unverified";
  readonly bindingSuperseded: boolean;
}

export type WorkResolutionOutcome =
  | {
      readonly status: "resolved";
      readonly absolutePath: string;
      readonly relativePath: string;
      readonly currentSourceVersion: PreviewSourceVersion;
      /**
       * The object this resolution actually read, so a caller that reads the
       * same path later — after its own authority evaluation — can prove it is
       * reading that object rather than whatever answers to the name by then.
       * Host identity, never reported to a renderer.
       */
      readonly sourceIdentity: WorkFileIdentity;
    }
  | {
      readonly status: "resolved-for-create";
      readonly absolutePath: string;
      readonly relativePath: string;
    }
  | { readonly status: "revoked-root" }
  | { readonly status: "moved-root" }
  | { readonly status: "escapes-root" }
  | { readonly status: "symlink-escape" }
  | { readonly status: "unavailable" }
  | { readonly status: "stale"; readonly knownVersion: PreviewSourceVersion };

/**
 * Server-authoritative Work artifact resolution. Maps an opaque artifact
 * reference's confined relative path to a canonical absolute path inside the
 * bound Project root, re-running confinement authority (canonicalization,
 * symlink containment, moved-root, revoked-root, stale-source) before every
 * read and mutation. The service never returns a host path to the renderer;
 * callers consume the resolved absolute path only to perform confined
 * filesystem operations and produce sanitized mutation results.
 *
 * A resolved path is a fact about a moment, not a standing permission. A caller
 * that reads it later must carry `sourceIdentity` into `readConfinedWorkFile`
 * so the read proves it reached the object this resolution saw.
 */
export class WorkResolutionService {
  readonly #filesystem: WorkFilesystemPort;

  constructor(filesystem: WorkFilesystemPort) {
    this.#filesystem = filesystem;
  }

  async resolve(input: {
    readonly binding: WorkRootBinding;
    readonly relativePath: string;
    readonly knownVersion: PreviewSourceVersion;
  }): Promise<WorkResolutionOutcome> {
    const rootCheck = checkRoot(input.binding);
    if (rootCheck !== undefined) return rootCheck;

    let relativePath: string;
    try {
      relativePath = canonicalizeWorkRelativePath(input.relativePath);
    } catch (error) {
      if (error instanceof WorkConfinementRejected) return { status: "escapes-root" };
      throw error;
    }

    const absolutePath = joinPath(input.binding.canonicalRoot, relativePath);
    const contained = await this.#containExisting(input.binding, absolutePath);
    if (contained.status !== "ok") return { status: contained.status };
    if (!contained.isFile) return { status: "unavailable" };
    const resolvedStat = contained.stat;
    const canonicalAbsolute = contained.canonical;
    const bytes = await readConfinedWorkFile({
      filesystem: this.#filesystem,
      canonicalPath: canonicalAbsolute,
      expected: resolvedStat,
      maximumBytes: MAX_WORK_INPUT_BYTES,
    });
    if (bytes === undefined) return { status: "unavailable" };
    const currentSourceVersion = computeSourceVersion(bytes);
    const availability = classifyWorkSourceAvailability(currentSourceVersion, input.knownVersion);
    if (availability === "unavailable") return { status: "unavailable" };
    if (availability === "stale") return { status: "stale", knownVersion: input.knownVersion };
    return {
      status: "resolved",
      absolutePath: canonicalAbsolute,
      relativePath,
      currentSourceVersion,
      sourceIdentity: { device: resolvedStat.device, inode: resolvedStat.inode },
    };
  }

  async resolveForCreate(input: {
    readonly binding: WorkRootBinding;
    readonly relativePath: string;
  }): Promise<WorkResolutionOutcome> {
    const rootCheck = checkRoot(input.binding);
    if (rootCheck !== undefined) return rootCheck;

    let relativePath: string;
    try {
      relativePath = canonicalizeWorkRelativePath(input.relativePath);
    } catch (error) {
      if (error instanceof WorkConfinementRejected) return { status: "escapes-root" };
      throw error;
    }
    const parts = relativePath.split("/");
    let depth = parts.length - 1;
    while (true) {
      const parentParts = parts.slice(0, depth);
      const parentAbsolute =
        parentParts.length === 0
          ? input.binding.canonicalRoot
          : joinPath(input.binding.canonicalRoot, parentParts.join("/"));
      const contained = await this.#containExisting(input.binding, parentAbsolute);
      if (contained.status === "ok") {
        if (!contained.isDirectory) return { status: "unavailable" };
        const missing = parts.slice(depth);
        return {
          status: "resolved-for-create",
          absolutePath: missing.reduce(
            (path, segment) => joinPath(path, segment),
            contained.canonical,
          ),
          relativePath,
        };
      }
      if (contained.status !== "unavailable") return { status: contained.status };
      if (depth === 0) {
        return {
          status: "resolved-for-create",
          absolutePath: joinPath(input.binding.canonicalRoot, relativePath),
          relativePath,
        };
      }
      depth -= 1;
    }
  }

  /**
   * The same symlink-then-realpath sequence `resolve` uses, for a path that
   * already exists. Create uses this on parent directories so `O_NOFOLLOW` on
   * the final name cannot write through an ancestor that escaped the root.
   */
  async #containExisting(
    binding: WorkRootBinding,
    absolutePath: string,
  ): Promise<
    | {
        readonly status: "ok";
        readonly canonical: string;
        readonly isDirectory: boolean;
        readonly isFile: boolean;
        readonly stat: WorkFileStat;
      }
    | { readonly status: "symlink-escape" | "escapes-root" | "unavailable" }
  > {
    let stat: WorkFileStat;
    try {
      stat = await this.#filesystem.lstat(absolutePath);
    } catch {
      return { status: "unavailable" };
    }

    if (stat.isSymbolicLink) {
      let target: string;
      try {
        target = await this.#filesystem.readlink(absolutePath);
      } catch {
        return { status: "unavailable" };
      }
      let resolvedTarget: string;
      try {
        // A `readlink` result is relative to the link's own parent, not to the
        // server process's working directory. Canonicalizing it raw resolved a
        // legitimate `notes/latest.md -> releases/v1.md` somewhere else
        // entirely, so an artifact safely inside the root was refused as an
        // escape. Containment still decides; the join only asks the question
        // about the right path.
        resolvedTarget = await this.#filesystem.realpath(
          target.startsWith("/") ? target : joinPath(parentPath(absolutePath), target),
        );
      } catch {
        return { status: "symlink-escape" };
      }
      if (classifySymlinkContainment(binding.canonicalRoot, resolvedTarget) === "escapes-root") {
        return { status: "symlink-escape" };
      }
    }

    let canonicalAbsolute: string;
    try {
      canonicalAbsolute = await this.#filesystem.realpath(absolutePath);
    } catch {
      return { status: "unavailable" };
    }
    if (classifyPathContainment(binding.canonicalRoot, canonicalAbsolute) === "escapes-root") {
      return { status: "escapes-root" };
    }

    let resolvedStat: WorkFileStat;
    try {
      resolvedStat = await this.#filesystem.stat(canonicalAbsolute);
    } catch {
      return { status: "unavailable" };
    }
    return {
      status: "ok",
      canonical: canonicalAbsolute,
      isDirectory: resolvedStat.isDirectory,
      isFile: resolvedStat.isFile,
      stat: resolvedStat,
    };
  }
}

function checkRoot(binding: WorkRootBinding): WorkResolutionOutcome | undefined {
  const revocation = detectRevokedRoot({
    availability: binding.availability,
    bindingSuperseded: binding.bindingSuperseded,
  });
  if (revocation.status === "revoked") return { status: "revoked-root" };
  if (
    detectMovedRoot(
      { canonicalRoot: binding.canonicalRoot },
      { canonicalRoot: binding.knownCanonicalRoot },
    )
  ) {
    return { status: "moved-root" };
  }
  return undefined;
}

function parentPath(absolutePath: string): string {
  const index = absolutePath.lastIndexOf("/");
  return index <= 0 ? "/" : absolutePath.slice(0, index);
}

function joinPath(root: string, relativePath: string): string {
  return root.endsWith("/") ? `${root}${relativePath}` : `${root}/${relativePath}`;
}

function computeSourceVersion(bytes: Uint8Array): PreviewSourceVersion {
  const contentSha256 = decodeSha256(createHash("sha256").update(bytes).digest("hex"));
  return {
    contentSha256,
    byteSize: bytes.byteLength,
    observedAt: decodeTimestamp(new Date().toISOString()),
  };
}
