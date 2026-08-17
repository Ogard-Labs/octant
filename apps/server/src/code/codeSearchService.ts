import {
  MAX_CODE_FILE_LISTING_DEPTH,
  MAX_CODE_SEARCH_FILES,
  MAX_CODE_SEARCH_FILE_BYTES,
  MAX_CODE_SEARCH_MATCHES,
  MAX_CODE_SEARCH_PREVIEW_LENGTH,
  MAX_CODE_SEARCH_QUERY_LENGTH,
  decodeCodeRelativePath,
  decodeCodeSearch,
  type CodeCheckoutId,
  type CodeRelativePath,
  type CodeSearchMatch,
  type CodeSearchResult,
  type CodeSearchScope,
  type CodeThreadId,
} from "@octant/contracts";
import { classifyPathContainment } from "@octant/domain";
import {
  liveCodeDirectoryPort,
  liveCodeTestSourcePort,
  type CodeDirectoryPort,
  type CodeDirectoryStat,
  type CodeOpenFile,
  type CodeTestSourcePort,
} from "./codeDirectoryPort";
import {
  isAbsolutePosixPath,
  joinCodePath,
  readContainedDirectoryNames,
  resolveContainedPath,
} from "./codePathConfinement";
import { deriveCodeFileId } from "./codeFileIdentity";

/** The directories a search never descends into, for the listing's reasons. */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([".git", "node_modules"]);

/** How many names one directory read may cost, so a huge directory is bounded. */
const MAX_NAMES_PER_DIRECTORY = 4_000;

export interface CodeSearchRequest {
  readonly threadId: CodeThreadId;
  readonly checkoutId: CodeCheckoutId;
  /** Canonical host path of the checkout this thread is bound to. */
  readonly rootPath: string;
  readonly scope: CodeSearchScope;
  readonly query: string;
  readonly signal?: AbortSignal | undefined;
}

export interface CodeSearchServiceOptions {
  readonly directoryPort?: CodeDirectoryPort;
  readonly sourcePort?: CodeTestSourcePort;
  readonly clock?: () => string;
  readonly maxMatches?: number;
  /** Bounds every entry the walk resolves, directories included. */
  readonly maxFiles?: number;
  readonly maxDepth?: number;
  readonly maxFileBytes?: number;
}

/**
 * Bounded, read-only search of the repository bound to a Code thread.
 *
 * Every path runs the same confinement sequence the file listing uses, and
 * every directory is enumerated through the same identity-checked handle, so a
 * symlink planted inside the checkout can no more make a search read the host
 * than it can make the explorer list it. Content matching opens files through
 * the confined source port, which refuses a symlinked final component and
 * reports the identity of the handle rather than of the name.
 *
 * Both bounds are stated rather than hidden: the walk stops after a fixed
 * number of files or matches, and the result says it was truncated. Search is
 * the surface most likely to be run against a monorepo, and a quietly partial
 * answer there reads as "this repository does not contain that".
 *
 * Matching is plain and case-insensitive, not a regular expression. A pattern
 * language would put an untrusted expression in front of a walk of the user's
 * repository, and every backtracking pathology that comes with it, for a
 * quick-open box whose job is to find a name the user is already half typing.
 */
export class CodeSearchService {
  readonly #directory: CodeDirectoryPort;
  readonly #source: CodeTestSourcePort;
  readonly #clock: () => string;
  readonly #maxMatches: number;
  readonly #maxFiles: number;
  readonly #maxDepth: number;
  readonly #maxFileBytes: number;

  constructor(options: CodeSearchServiceOptions = {}) {
    this.#directory = options.directoryPort ?? liveCodeDirectoryPort;
    this.#source = options.sourcePort ?? liveCodeTestSourcePort;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#maxMatches = options.maxMatches ?? MAX_CODE_SEARCH_MATCHES;
    this.#maxFiles = options.maxFiles ?? MAX_CODE_SEARCH_FILES;
    this.#maxDepth = options.maxDepth ?? MAX_CODE_FILE_LISTING_DEPTH;
    this.#maxFileBytes = options.maxFileBytes ?? MAX_CODE_SEARCH_FILE_BYTES;
  }

  async search(request: CodeSearchRequest): Promise<CodeSearchResult> {
    const query = request.query.trim();
    if (query === "" || query.length > MAX_CODE_SEARCH_QUERY_LENGTH) {
      return failed("invalid", "Code search query is invalid.");
    }
    if (!isAbsolutePosixPath(request.rootPath)) {
      return failed("invalid", "Code checkout root is invalid.");
    }

    let root: { readonly canonical: string; readonly stat: CodeDirectoryStat };
    try {
      const canonical = await this.#directory.realpath(request.rootPath);
      const stat = await this.#directory.stat(canonical);
      if (!stat.isDirectory) return failed("unavailable", "Code checkout root is not a directory.");
      root = { canonical, stat };
    } catch {
      return failed("unavailable", "Code checkout root is unavailable.");
    }
    if (classifyPathContainment(root.canonical, root.canonical) === "escapes-root") {
      return failed("invalid", "Code checkout root is not a confinable directory.");
    }

    const state: SearchState = {
      canonicalRoot: root.canonical,
      needle: query.toLowerCase(),
      scope: request.scope,
      matches: [],
      entriesExamined: 0,
      truncated: false,
      visited: new Set([root.canonical]),
      threadId: request.threadId,
      checkoutId: request.checkoutId,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    };
    await this.#walk(state, root.canonical, root.stat, "", 0);

    try {
      return {
        status: "searched",
        search: decodeCodeSearch({
          kind: "code-search",
          threadId: request.threadId,
          checkoutId: request.checkoutId,
          scope: request.scope,
          query,
          matches: state.matches,
          truncated: state.truncated,
          observedAt: this.#clock(),
        }),
      };
    } catch {
      return failed("unavailable", "Code search result could not be encoded.");
    }
  }

  async #walk(
    state: SearchState,
    absolute: string,
    identity: CodeDirectoryStat,
    relative: string,
    depth: number,
  ): Promise<void> {
    if (depth > this.#maxDepth) {
      state.truncated = true;
      return;
    }
    if (this.#exhausted(state)) return;

    const names = await readContainedDirectoryNames(
      this.#directory,
      absolute,
      identity,
      MAX_NAMES_PER_DIRECTORY,
    );
    // An unreadable or no longer identical directory is simply not searched; it
    // is never a host error the renderer needs to see, and never a reason to
    // abandon the walk.
    if (names === undefined) return;
    if (names.length === MAX_NAMES_PER_DIRECTORY) state.truncated = true;

    for (const name of names) {
      if (this.#exhausted(state)) return;
      if (name === "." || name === "..") continue;
      if (SKIPPED_DIRECTORIES.has(name)) continue;

      const childRelative = relative === "" ? name : `${relative}/${name}`;
      let relativePath: CodeRelativePath;
      try {
        relativePath = decodeCodeRelativePath(childRelative);
      } catch {
        // A name Code's confined relative-path contract rejects is skipped
        // rather than normalized into something the open path would resolve
        // differently.
        continue;
      }

      // Every entry the walk enumerates costs the same budget: directories, and
      // names that never resolve at all. Confinement is itself filesystem work,
      // so charging only the entries that survive it lets a tree of dangling or
      // escaping symlinks buy unbounded resolutions for free. A wide tree of
      // empty directories is the same cost in a different shape, and that walk
      // is the unbounded cost this budget exists to stop.
      state.entriesExamined += 1;

      const resolved = await resolveContainedPath(
        this.#directory,
        state.canonicalRoot,
        joinCodePath(absolute, name),
      );
      if (resolved === undefined) continue;

      if (resolved.stat.isDirectory) {
        // A directory symlink can resolve into a subtree the walk is already
        // inside, which would otherwise repeat it until the budget is spent.
        if (state.visited.has(resolved.canonical)) continue;
        state.visited.add(resolved.canonical);
        await this.#walk(state, resolved.canonical, resolved.stat, childRelative, depth + 1);
        continue;
      }
      if (!resolved.stat.isFile) continue;

      const fileId = deriveCodeFileId(
        String(state.threadId),
        String(state.checkoutId),
        childRelative,
      );
      if (state.scope === "path") {
        if (childRelative.toLowerCase().includes(state.needle)) {
          state.matches.push({ scope: "path", fileId, path: relativePath });
        }
        continue;
      }

      if (resolved.stat.size > this.#maxFileBytes) {
        // A file too large to read is not silently reported as containing
        // nothing; the search says it did not see everything.
        state.truncated = true;
        continue;
      }
      await this.#matchContent(state, resolved.canonical, resolved.stat, relativePath, fileId);
    }
  }

  /**
   * Read one confined file and report the lines the query appears on.
   *
   * The bytes are read from a handle whose identity must equal the object
   * containment resolved, so a file swapped in after the proof is skipped
   * rather than read. Anything that is not valid UTF-8 is treated as binary and
   * not searched: reporting a byte offset inside a compiled artefact as a
   * "line" would be a match nobody can act on.
   */
  async #matchContent(
    state: SearchState,
    canonical: string,
    identity: CodeDirectoryStat,
    path: CodeRelativePath,
    fileId: ReturnType<typeof deriveCodeFileId>,
  ): Promise<void> {
    let file: CodeOpenFile;
    try {
      file = await this.#source.openFile(canonical);
    } catch {
      return;
    }
    let text: string;
    try {
      const opened = await file.stat();
      if (!opened.isFile) return;
      if (opened.device !== identity.device || opened.inode !== identity.inode) return;
      const bytes = await file.read(this.#maxFileBytes);
      if (bytes.byteLength >= this.#maxFileBytes) state.truncated = true;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return;
      }
    } catch {
      return;
    } finally {
      await file.close().catch(() => undefined);
    }

    const lines = text.split("\n");
    for (const [index, line] of lines.entries()) {
      if (this.#exhausted(state)) return;
      const column = line.toLowerCase().indexOf(state.needle);
      if (column === -1) continue;
      state.matches.push({
        scope: "content",
        fileId,
        path,
        line: index + 1,
        column: column + 1,
        preview: preview(line),
      });
    }
  }

  /** Whether the search has spent a budget, recording that it stopped early. */
  #exhausted(state: SearchState): boolean {
    if (state.signal?.aborted === true) return true;
    if (state.matches.length >= this.#maxMatches || state.entriesExamined >= this.#maxFiles) {
      state.truncated = true;
      return true;
    }
    return false;
  }
}

interface SearchState {
  readonly canonicalRoot: string;
  readonly needle: string;
  readonly scope: CodeSearchScope;
  readonly matches: CodeSearchMatch[];
  entriesExamined: number;
  truncated: boolean;
  readonly visited: Set<string>;
  readonly threadId: CodeThreadId;
  readonly checkoutId: CodeCheckoutId;
  readonly signal?: AbortSignal;
}

/** One line, clipped to the preview bound so a minified file stays bounded. */
function preview(line: string): string {
  const trimmed = line.trimEnd();
  return trimmed.length <= MAX_CODE_SEARCH_PREVIEW_LENGTH
    ? trimmed
    : `${trimmed.slice(0, MAX_CODE_SEARCH_PREVIEW_LENGTH - 1)}…`;
}

function failed(
  category: "invalid" | "unauthorized" | "unavailable" | "not-found",
  message: string,
): CodeSearchResult {
  return { status: "failed", failure: { category, message } };
}
