import {
  MAX_CODE_FILE_LISTING_DEPTH,
  MAX_CODE_FILE_LISTING_ENTRIES,
  decodeCodeFileListing,
  decodeCodeRelativePath,
  type CodeCheckoutId,
  type CodeFileListing,
  type CodeFileListingEntry,
  type CodeFileListingResult,
  type CodeRelativePath,
  type CodeThreadId,
} from "@octant/contracts";
import { classifyPathContainment } from "@octant/domain";
import {
  liveCodeDirectoryPort,
  type CodeDirectoryPort,
  type CodeDirectoryStat,
  type CodeOpenDirectory,
} from "./codeDirectoryPort";
import { isAbsolutePosixPath, joinCodePath, resolveContainedPath } from "./codePathConfinement";
import { deriveCodeFileId } from "./codeFileIdentity";
import { MAX_EDITABLE_CODE_FILE_BYTES } from "./codeFileService";

/**
 * Directory names a source listing never descends into. `.git` is Octant's own
 * observation surface and not user-editable source; `node_modules` is a
 * dependency cache large enough to consume the whole entry budget before any
 * project file is reached. Skipping them is what makes a bounded listing
 * useful rather than merely truncated.
 */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([".git", "node_modules"]);

export interface CodeFileListingRequest {
  readonly threadId: CodeThreadId;
  readonly checkoutId: CodeCheckoutId;
  /** Canonical host path of the checkout this thread is bound to. */
  readonly rootPath: string;
  /** Subdirectory to list, relative to the checkout root. Absent lists the root. */
  readonly directory?: CodeRelativePath | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface CodeFileListingServiceOptions {
  readonly directoryPort?: CodeDirectoryPort;
  readonly clock?: () => string;
  readonly maxEntries?: number;
  readonly maxDepth?: number;
}

/**
 * Bounded, read-only listing of the repository bound to a Code thread.
 *
 * Every path this service touches runs the same confinement sequence the Work
 * research source port uses — canonicalize the relative path, realpath the
 * root, reject a symlink whose target escapes, realpath the candidate, then
 * re-check containment — so a symlink planted inside the checkout can never
 * make the explorer enumerate the rest of the host.
 *
 * Confinement proves a fact about a path, and a path can be made to mean
 * something else the moment after it is proved, so every enumeration goes
 * through an open directory handle that refuses a symlinked final component and
 * must report the same object containment resolved. Names are read from that
 * handle under the remaining entry budget, so neither a host directory raced in
 * nor a very large in-repo directory is ever materialized whole.
 *
 * The result never carries a host absolute path. Entries are relative to the
 * checkout root, which is the only location identity the renderer is entitled
 * to and the only one the save path accepts.
 */
export class CodeFileListingService {
  readonly #directory: CodeDirectoryPort;
  readonly #clock: () => string;
  readonly #maxEntries: number;
  readonly #maxDepth: number;

  constructor(options: CodeFileListingServiceOptions = {}) {
    this.#directory = options.directoryPort ?? liveCodeDirectoryPort;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#maxEntries = options.maxEntries ?? MAX_CODE_FILE_LISTING_ENTRIES;
    this.#maxDepth = options.maxDepth ?? MAX_CODE_FILE_LISTING_DEPTH;
  }

  async list(request: CodeFileListingRequest): Promise<CodeFileListingResult> {
    if (!isAbsolutePosixPath(request.rootPath)) {
      return failed("invalid", "Code checkout root is invalid.");
    }

    let root: ResolvedDirectory;
    try {
      const canonical = await this.#directory.realpath(request.rootPath);
      const stat = await this.#directory.stat(canonical);
      if (!stat.isDirectory) {
        return failed("unavailable", "Code checkout root is not a directory.");
      }
      root = { canonical, stat };
    } catch {
      return failed("unavailable", "Code checkout root is unavailable.");
    }
    const canonicalRoot = root.canonical;
    if (classifyPathContainment(canonicalRoot, canonicalRoot) === "escapes-root") {
      // A filesystem-root binding would classify every path as contained.
      return failed("invalid", "Code checkout root is not a confinable directory.");
    }

    const start =
      request.directory === undefined
        ? root
        : await this.#resolveContainedDirectory(
            canonicalRoot,
            joinCodePath(canonicalRoot, String(request.directory)),
          );
    if (start === undefined) {
      return failed("not-found", "Code directory is unavailable inside this checkout.");
    }

    const entries: CodeFileListingEntry[] = [];
    const truncated = await this.#walk({
      canonicalRoot,
      absolute: start.canonical,
      identity: start.stat,
      visited: new Set([start.canonical]),
      relative: request.directory === undefined ? "" : String(request.directory),
      depth: 0,
      entries,
      threadId: request.threadId,
      checkoutId: request.checkoutId,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });

    let listing: CodeFileListing;
    try {
      listing = decodeCodeFileListing({
        kind: "code-file-listing",
        threadId: request.threadId,
        checkoutId: request.checkoutId,
        ...(request.directory === undefined ? {} : { directory: request.directory }),
        entries,
        truncated,
        observedAt: this.#clock(),
      });
    } catch {
      return failed("unavailable", "Code file listing could not be encoded.");
    }
    return { status: "listed", listing };
  }

  async #walk(input: {
    readonly canonicalRoot: string;
    readonly absolute: string;
    /** The object containment resolved at `absolute`, for the handle to match. */
    readonly identity: CodeDirectoryStat;
    readonly relative: string;
    readonly depth: number;
    readonly entries: CodeFileListingEntry[];
    /**
     * Canonical directories already enumerated in this walk. A directory
     * symlink can resolve to a directory the walk is already inside, so
     * without this the same subtree repeats under `loop/loop/...` until the
     * depth or entry budget is spent, hiding the files that came after it.
     */
    readonly visited: Set<string>;
    readonly threadId: CodeThreadId;
    readonly checkoutId: CodeCheckoutId;
    readonly signal?: AbortSignal;
  }): Promise<boolean> {
    if (input.depth > this.#maxDepth) return true;
    if (isAborted(input.signal)) return true;

    const budget = this.#maxEntries - input.entries.length;
    if (budget <= 0) return true;

    // One name past the budget is read so the listing can tell that it is
    // incomplete; anything beyond that would be read only to be discarded.
    const names = await this.#readNames(input.absolute, input.identity, budget + 1);
    // An unreadable or no longer identical directory is simply not listed; it is
    // never a host error the renderer needs to see, and never a reason to
    // abandon the walk.
    if (names === undefined) return false;

    let truncated = names.length > budget;
    for (const name of names) {
      if (isAborted(input.signal)) return true;
      if (input.entries.length >= this.#maxEntries) return true;
      if (name === "." || name === "..") continue;

      const relative = input.relative === "" ? name : `${input.relative}/${name}`;
      let relativePath: CodeRelativePath;
      try {
        relativePath = decodeCodeRelativePath(relative);
      } catch {
        // A name Code's confined relative-path contract rejects (traversal,
        // backslash, non-NFC) is skipped rather than normalized into something
        // the save path would resolve differently.
        continue;
      }

      const absolute = joinCodePath(input.absolute, name);
      const resolved = await this.#resolveContained(input.canonicalRoot, absolute);
      if (resolved === undefined) continue;

      if (resolved.stat.isDirectory) {
        if (SKIPPED_DIRECTORIES.has(name)) continue;
        input.entries.push({ kind: "directory", path: relativePath });
        // The directory itself is listed either way; only its contents are
        // skipped when this canonical directory was already enumerated, which
        // is a repeat rather than a budget truncation.
        if (input.visited.has(resolved.canonical)) continue;
        input.visited.add(resolved.canonical);
        const childTruncated = await this.#walk({
          ...input,
          absolute: resolved.canonical,
          identity: resolved.stat,
          relative,
          depth: input.depth + 1,
        });
        truncated = truncated || childTruncated;
        continue;
      }
      if (!resolved.stat.isFile) continue;

      input.entries.push({
        kind: "file",
        fileId: deriveCodeFileId(String(input.threadId), String(input.checkoutId), relative),
        path: relativePath,
        byteLength: Math.max(0, Math.trunc(resolved.stat.size)),
        availability:
          resolved.stat.size > MAX_EDITABLE_CODE_FILE_BYTES
            ? { status: "read-only", reason: "oversized" }
            : { status: "available" },
      });
    }
    return truncated;
  }

  /**
   * Names of the one directory containment proved, read from a single handle.
   *
   * The handle refuses a symlinked final component, and the object it reports
   * must be the object containment resolved, so a directory swapped in after
   * that proof is refused rather than enumerated. `O_NOFOLLOW` alone would not
   * catch a swapped *ancestor*, which is why the device and inode equality —
   * not the open — is what closes that window.
   *
   * The port cannot make that guarantee absolute: enumerating and identifying
   * are two path resolutions, so a precisely timed swap can still be identified
   * as the resolved object while yielding another directory's names. Every name
   * is re-resolved against the canonical directory below, which is what keeps a
   * foreign entry out of the listing; the residual is that a name existing in
   * both directories is indistinguishable from one that only exists here.
   *
   * The read is capped at the caller's remaining budget, so a directory far
   * larger than the listing can report costs that budget rather than its own
   * size, and a port that ignores the cap is refused rather than trusted.
   */
  async #readNames(
    canonical: string,
    identity: CodeDirectoryStat,
    maximumNames: number,
  ): Promise<ReadonlyArray<string> | undefined> {
    let directory: CodeOpenDirectory;
    try {
      directory = await this.#directory.openDirectory(canonical);
    } catch {
      return undefined;
    }
    try {
      const opened = await directory.stat();
      if (!opened.isDirectory) return undefined;
      if (opened.device !== identity.device || opened.inode !== identity.inode) return undefined;
      const children = await directory.read(maximumNames);
      if (children.length > maximumNames) return undefined;
      return children.map((child) => child.name).sort(compareNames);
    } catch {
      return undefined;
    } finally {
      await directory.close().catch(() => undefined);
    }
  }

  /**
   * Resolve one candidate to a canonical path proven to be inside the root,
   * through the shared confinement sequence in `codePathConfinement`.
   */
  async #resolveContained(
    canonicalRoot: string,
    absolute: string,
  ): Promise<ResolvedDirectory | undefined> {
    return await resolveContainedPath(this.#directory, canonicalRoot, absolute);
  }

  async #resolveContainedDirectory(
    canonicalRoot: string,
    absolute: string,
  ): Promise<ResolvedDirectory | undefined> {
    const resolved = await this.#resolveContained(canonicalRoot, absolute);
    return resolved === undefined || !resolved.stat.isDirectory ? undefined : resolved;
  }
}

/** A path proven contained, with the identity of the object it resolved to. */
interface ResolvedDirectory {
  readonly canonical: string;
  readonly stat: CodeDirectoryStat;
}

function failed(
  category: "invalid" | "unauthorized" | "unavailable" | "not-found",
  message: string,
): CodeFileListingResult {
  return { status: "failed", failure: { category, message } };
}

/** Read through a call so the check is never narrowed away between awaits. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Directories before files at the same level, then case-insensitive by name. */
function compareNames(left: string, right: string): number {
  return left.localeCompare(right, "en", { sensitivity: "base" });
}
