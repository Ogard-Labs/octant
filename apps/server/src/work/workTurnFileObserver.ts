import {
  MAX_WORK_TURN_WRITTEN_PATHS,
  type WorkTurnWrittenFiles,
} from "@octant/contracts/work-turns";
import { canonicalizeWorkRelativePath, WorkConfinementRejected } from "@octant/domain";
import { liveWorkFileWatchPort, type WorkFileWatchPort } from "./workFileWatchPort";

/**
 * Entries whose churn is never the work. These are the same names the folder
 * listing refuses to show, so a turn is never recorded as having written a file
 * the panel does not display.
 */
function isHiddenName(name: string): boolean {
  return name.startsWith(".");
}

export interface WorkTurnObservation {
  /** Stop watching and report what changed while the turn ran. */
  finish(): WorkTurnWrittenFiles | undefined;
}

export interface WorkTurnFileObserverOptions {
  readonly watchPort?: WorkFileWatchPort;
  readonly maxPaths?: number;
}

/**
 * What changed in a Work Project's bound folder while one turn ran.
 *
 * Work runs the provider inside the bound folder under a project-root-confined
 * posture and the provider writes with its own tools, so the host is never told
 * what a turn wrote — the mutation service is not on that path. Watching is the
 * only way the host can know, and watching observes rather than attributes: a
 * file another process touched during the turn is recorded the same as one the
 * provider wrote. That is why nothing here says "created" or "the assistant",
 * and why the record's own vocabulary is "changed while this ran".
 *
 * Every name arrives from the filesystem and is therefore untrusted. A name the
 * confined relative-path contract refuses is dropped and marks the record
 * truncated rather than being normalized into a path a later read would resolve
 * somewhere else. Nothing here reads a file, resolves a name to a host path, or
 * widens what any client may fetch: the record carries identity only, and every
 * surface acting on it re-reads through the listing, which applies its own
 * confinement every time.
 *
 * A watcher the host drops mid-turn marks the record truncated. The changes
 * made while nothing was watching are already lost, and reporting the paths
 * seen before the drop as though they were all of them would be a lie the
 * surface could not detect.
 */
export class WorkTurnFileObserver {
  readonly #watchPort: WorkFileWatchPort;
  readonly #maxPaths: number;

  constructor(options: WorkTurnFileObserverOptions = {}) {
    this.#watchPort = options.watchPort ?? liveWorkFileWatchPort;
    this.#maxPaths = options.maxPaths ?? MAX_WORK_TURN_WRITTEN_PATHS;
  }

  /**
   * Start watching `canonicalRoot`. The caller finishes the observation when
   * the turn settles; an observation that never finishes only holds one
   * subscription, which the host releases when the process does.
   */
  observe(canonicalRoot: string): WorkTurnObservation {
    const observed = new Set<string>();
    let truncated = false;
    let finished = false;

    const subscription = this.#watchPort.watch(
      canonicalRoot,
      (relativePath) => {
        if (finished) return;
        if (relativePath === undefined) {
          truncated = true;
          return;
        }
        const accepted = acceptedPath(relativePath);
        if (accepted === "ignored") return;
        if (accepted === undefined) {
          truncated = true;
          return;
        }
        if (observed.size >= this.#maxPaths && !observed.has(accepted)) {
          truncated = true;
          return;
        }
        observed.add(accepted);
      },
      () => {
        truncated = true;
      },
    );

    return {
      finish: () => {
        if (finished) return undefined;
        finished = true;
        subscription.close();
        if (observed.size === 0 && !truncated) return undefined;
        return {
          paths: [...observed].sort().slice(0, this.#maxPaths),
          truncated,
        };
      },
    };
  }
}

/**
 * Decide what one host-reported name means to the record.
 *
 * `"ignored"` is a name no Work surface shows, `undefined` is a name the
 * confined relative-path contract refuses — which marks the record truncated
 * rather than being normalized — and a string is the path as a later read may
 * ask for it.
 */
function acceptedPath(relativePath: string): string | "ignored" | undefined {
  const normalized = relativePath.replace(/\/+$/, "");
  if (normalized === "") return "ignored";
  const segments = normalized.split("/");
  // Traversal is refused before the hidden check, not by it. `..` starts with a
  // dot, so testing for hidden names first would quietly discard an escape
  // attempt as ordinary platform churn instead of marking the record
  // incomplete — the one outcome that must never look like nothing happened.
  if (segments.some((segment) => segment === "." || segment === "..")) return undefined;
  if (segments.some((segment) => isHiddenName(segment))) return "ignored";
  try {
    return canonicalizeWorkRelativePath(normalized);
  } catch (error) {
    if (error instanceof WorkConfinementRejected) return undefined;
    return undefined;
  }
}
