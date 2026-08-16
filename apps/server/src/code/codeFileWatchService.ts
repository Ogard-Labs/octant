import {
  MAX_CODE_FILE_CHANGE_PATHS,
  decodeCodeFileChangeNotice,
  decodeCodeRelativePath,
  type CodeCheckoutId,
  type CodeFileChangeNotice,
  type CodeThreadId,
} from "@octant/contracts";
import { classifyPathContainment } from "@octant/domain";
import { liveCodeDirectoryPort, type CodeDirectoryPort } from "./codeDirectoryPort";
import { isAbsolutePosixPath } from "./codePathConfinement";
import { liveCodeFileWatchPort, type CodeFileWatchPort } from "./codeFileWatchPort";

/**
 * Directory names whose churn is never a source change. These are the same
 * names the listing refuses to descend into, so the explorer is never asked to
 * refresh for a tree it does not show. `.git` matters most: every commit,
 * stage, and status write touches it, and reporting those would make the
 * watcher noisiest exactly when the agent is working.
 */
const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([".git", "node_modules"]);

/** How long the service waits for a burst of changes to settle before reporting. */
const DEFAULT_QUIET_PERIOD_MS = 250;

export interface CodeFileWatchRequest {
  readonly threadId: CodeThreadId;
  readonly checkoutId: CodeCheckoutId;
  /** Canonical host path of the checkout this thread is bound to. */
  readonly rootPath: string;
  readonly signal?: AbortSignal | undefined;
}

export interface CodeFileWatchServiceOptions {
  readonly watchPort?: CodeFileWatchPort;
  readonly directoryPort?: CodeDirectoryPort;
  readonly clock?: () => string;
  readonly quietPeriodMs?: number;
  readonly maxPaths?: number;
}

/**
 * Live notice that files under a Code thread's checkout changed.
 *
 * The service reports identity and nothing else. It never reads a changed
 * file, never resolves a reported name back to a host path, and never widens
 * what a client may fetch: a renderer acts on a notice by refetching through
 * the listing and open routes, which apply their own confinement every time.
 * That is what keeps a hostile name arriving from the filesystem — a symlink
 * planted mid-turn, a name that escapes the root — harmless here; the worst it
 * can do is be dropped, and a dropped name marks the notice truncated so the
 * surface refreshes wholesale rather than silently going stale.
 *
 * Bursts are coalesced over a quiet period because an agent's edit, a package
 * install, and a branch switch all arrive as many events for one user-visible
 * change. One notice per settled burst is what the explorer can act on; a
 * notice per inotify event would be a refresh storm.
 */
export class CodeFileWatchService {
  readonly #watchPort: CodeFileWatchPort;
  readonly #directory: CodeDirectoryPort;
  readonly #clock: () => string;
  readonly #quietPeriodMs: number;
  readonly #maxPaths: number;

  constructor(options: CodeFileWatchServiceOptions = {}) {
    this.#watchPort = options.watchPort ?? liveCodeFileWatchPort;
    this.#directory = options.directoryPort ?? liveCodeDirectoryPort;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#quietPeriodMs = options.quietPeriodMs ?? DEFAULT_QUIET_PERIOD_MS;
    this.#maxPaths = options.maxPaths ?? MAX_CODE_FILE_CHANGE_PATHS;
  }

  async *watch(request: CodeFileWatchRequest): AsyncGenerator<CodeFileChangeNotice> {
    const canonicalRoot = await this.#canonicalRoot(request.rootPath);
    if (canonicalRoot === undefined) return;

    let pending = new Set<string>();
    let truncated = false;
    let live = true;
    let wake: (() => void) | undefined;
    const signal = (): void => {
      const resume = wake;
      wake = undefined;
      resume?.();
    };

    const subscription = this.#watchPort.watch(
      canonicalRoot,
      (relativePath) => {
        if (relativePath === undefined) {
          // A change the host could not name still happened. Saying so is the
          // only honest report; guessing a path would be worse than a refresh.
          truncated = true;
        } else {
          const accepted = acceptedPath(relativePath);
          if (accepted === "ignored") return;
          if (accepted === undefined) truncated = true;
          else pending.add(accepted);
        }
        signal();
      },
      () => {
        // A watcher the host dropped cannot be trusted to report the next
        // change, so the stream ends and the client reconnects rather than
        // holding a subscription that silently observes nothing.
        live = false;
        signal();
      },
    );

    const abort = (): void => {
      live = false;
      signal();
    };
    request.signal?.addEventListener("abort", abort);

    try {
      while (live && !isAborted(request.signal)) {
        if (pending.size === 0 && !truncated) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          continue;
        }
        await this.#settle(request.signal);
        if (!live || isAborted(request.signal)) break;

        const observed = [...pending].sort();
        const overflowed = truncated || observed.length > this.#maxPaths;
        pending = new Set();
        truncated = false;

        let notice: CodeFileChangeNotice;
        try {
          notice = decodeCodeFileChangeNotice({
            kind: "code-file-change",
            threadId: request.threadId,
            checkoutId: request.checkoutId,
            paths: observed.slice(0, this.#maxPaths),
            truncated: overflowed,
            observedAt: this.#clock(),
          });
        } catch {
          // A notice that cannot be encoded is dropped rather than sent
          // half-formed; the next change reports the surface as stale again.
          continue;
        }
        yield notice;
      }
    } finally {
      request.signal?.removeEventListener("abort", abort);
      subscription.close();
    }
  }

  /**
   * Prove the root before subscribing, through the same sequence the listing
   * uses: canonicalize, confirm a directory, and refuse a binding that is its
   * own filesystem root, which would classify every path as contained.
   */
  async #canonicalRoot(rootPath: string): Promise<string | undefined> {
    if (!isAbsolutePosixPath(rootPath)) return undefined;
    try {
      const canonical = await this.#directory.realpath(rootPath);
      const stat = await this.#directory.stat(canonical);
      if (!stat.isDirectory) return undefined;
      if (classifyPathContainment(canonical, canonical) === "escapes-root") return undefined;
      return canonical;
    } catch {
      return undefined;
    }
  }

  /** Wait out the quiet period, returning early when the caller goes away. */
  async #settle(signal: AbortSignal | undefined): Promise<void> {
    if (this.#quietPeriodMs <= 0) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, this.#quietPeriodMs);
      function onAbort(): void {
        clearTimeout(timer);
        resolve();
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/** Read through a call so the check is never narrowed away between awaits. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Decide what one host-reported name means to the notice.
 *
 * `"ignored"` is a name the explorer never shows, `undefined` is a name the
 * confined relative-path contract refuses — which marks the notice truncated
 * rather than being normalized into a path the open route would resolve
 * differently — and a string is the path as the renderer may ask for it.
 */
function acceptedPath(relativePath: string): string | "ignored" | undefined {
  const normalized = relativePath.replace(/\/+$/, "");
  if (normalized === "") return "ignored";
  const segments = normalized.split("/");
  if (segments.some((segment) => IGNORED_DIRECTORIES.has(segment))) return "ignored";
  try {
    return String(decodeCodeRelativePath(normalized));
  } catch {
    return undefined;
  }
}
