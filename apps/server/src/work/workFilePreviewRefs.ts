import {
  decodePreviewOpaqueRef,
  decodePreviewTargetId,
  type PreviewHostId,
  type PreviewOpaqueRef,
  type PreviewTargetId,
} from "@octant/contracts/previews";
import type { ProjectId } from "@octant/contracts/projects";

export interface WorkFilePreviewTarget {
  readonly targetId: PreviewTargetId;
  readonly opaqueRef: PreviewOpaqueRef;
}

/**
 * How many files one Project may hold preview references for at once. A listing
 * is already bounded, so this only has to outlast a few listings of the same
 * folder; past it the oldest reference is forgotten and the next listing mints
 * it again.
 */
const MAX_REFS_PER_PROJECT = 4_000;

export interface WorkFilePreviewRefsOptions {
  readonly hostId: PreviewHostId;
  readonly uuid: () => string;
  readonly maxRefsPerProject?: number;
}

/**
 * The renderer-facing token for a file in a Work Project's bound folder, and
 * the server-private path it stands for.
 *
 * Preview targets are path-free by contract: the renderer holds a token and the
 * host holds the mapping, so a client can never name a path and have it opened.
 * Work needs that for ordinary files too, not only for recorded artifacts,
 * because the Files tool lists the whole folder.
 *
 * A token is minted when the listing observes a path and reused for as long as
 * that Project remembers it, so reopening the same file selects the tab it
 * already has rather than opening a second one. Forgetting a token is safe: the
 * next listing mints another, and a token the host does not recognise resolves
 * to nothing rather than to a guess.
 *
 * Nothing here decides authority. A resolved path is still confined to the
 * Project root by the preview service, and the preview route still requires the
 * window's active Project to be the one the target names.
 */
export class WorkFilePreviewRefs {
  /** The preview host these targets belong to, carried on every listing. */
  readonly hostId: PreviewHostId;
  readonly #uuid: () => string;
  readonly #maxPerProject: number;
  /** Project → relative path → target, so one path keeps one identity. */
  readonly #byPath = new Map<string, Map<string, WorkFilePreviewTarget>>();
  /** ref → { projectId, relativePath }, the only direction resolution needs. */
  readonly #byRef = new Map<
    string,
    { readonly projectId: string; readonly relativePath: string }
  >();

  constructor(options: WorkFilePreviewRefsOptions) {
    this.hostId = options.hostId;
    this.#uuid = options.uuid;
    this.#maxPerProject = options.maxRefsPerProject ?? MAX_REFS_PER_PROJECT;
  }

  /**
   * The target for this path, minted on first sight and stable after it.
   *
   * Stability is what makes reopening a file select the tab it already has:
   * preview tabs are the same surface when their target ids match, so a fresh
   * id per click would stack a second tab on every open.
   */
  mint(projectId: ProjectId, relativePath: string): WorkFilePreviewTarget {
    const project = String(projectId);
    let paths = this.#byPath.get(project);
    if (paths === undefined) {
      paths = new Map();
      this.#byPath.set(project, paths);
    }
    const existing = paths.get(relativePath);
    if (existing !== undefined) return existing;

    if (paths.size >= this.#maxPerProject) {
      // Insertion order is the eviction order: the oldest path this Project
      // remembers is the one least likely to be on screen.
      const oldest = paths.keys().next();
      if (!oldest.done) {
        const evicted = paths.get(oldest.value);
        paths.delete(oldest.value);
        if (evicted !== undefined) this.#byRef.delete(String(evicted.opaqueRef));
      }
    }
    const target: WorkFilePreviewTarget = {
      targetId: decodePreviewTargetId(this.#uuid()),
      opaqueRef: decodePreviewOpaqueRef(this.#uuid()),
    };
    paths.set(relativePath, target);
    this.#byRef.set(String(target.opaqueRef), { projectId: project, relativePath });
    return target;
  }

  /**
   * The path a token stands for, or `undefined` for a token this host does not
   * recognise or one minted for a different Project. The Project is part of the
   * lookup rather than a later comparison, so a token cannot be replayed
   * against another Project's folder.
   */
  resolve(projectId: ProjectId, ref: string): string | undefined {
    const record = this.#byRef.get(ref);
    if (record === undefined) return undefined;
    return record.projectId === String(projectId) ? record.relativePath : undefined;
  }
}
