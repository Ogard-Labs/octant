import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PreviewHostId, PreviewTargetId, PreviewTargetKind } from "@octant/contracts/previews";

/**
 * A registered preview target. The `opaqueRef` is the renderer-facing
 * path-free token; `relativePath` is the server-private mapping to a path
 * inside `projectRoot`. The two never cross the wire together.
 */
export interface PreviewTargetRecord {
  readonly targetId: PreviewTargetId;
  readonly kind: PreviewTargetKind;
  readonly opaqueRef: string;
  readonly relativePath: string;
}

export type PreviewTargetResolutionFailure =
  | { readonly ok: false; readonly code: "not-found" }
  | { readonly ok: false; readonly code: "unavailable" }
  | { readonly ok: false; readonly code: "containment-violation" };

export type PreviewTargetResolution =
  | { readonly ok: true; readonly absolutePath: string }
  | PreviewTargetResolutionFailure;

/**
 * Narrower resolution result for `resolveConfinedPath`, which never
 * returns `not-found` (that code is registry-only). Callers that map a
 * relative path to a confined absolute path can treat the failure set as
 * `unavailable | containment-violation`.
 */
export type ConfinedPathResolution =
  | { readonly ok: true; readonly absolutePath: string }
  | { readonly ok: false; readonly code: "unavailable" }
  | { readonly ok: false; readonly code: "containment-violation" };

export interface PreviewTargetRegistryOptions {
  readonly projectRoot: string;
  readonly hostId: PreviewHostId;
  readonly records: ReadonlyArray<PreviewTargetRecord>;
}

/**
 * Server-side registry that resolves an opaque preview target id to a
 * canonical absolute path confined to the authoritative project root.
 *
 * Containment is enforced by canonicalizing the project root and the
 * nearest existing ancestor of the candidate path (resolving symlinks),
 * then requiring the candidate to lie within the root. A symlink that
 * escapes the root is rejected even when the link itself lives inside it.
 */
export class PreviewTargetRegistry {
  readonly #projectRoot: string;
  readonly #byId: Map<PreviewTargetId, PreviewTargetRecord>;

  constructor(options: PreviewTargetRegistryOptions) {
    this.#projectRoot = resolve(options.projectRoot);
    this.#byId = new Map(options.records.map((r) => [r.targetId, r]));
  }

  resolve(targetId: PreviewTargetId): PreviewTargetResolution {
    const record = this.#byId.get(targetId);
    if (record === undefined) return { ok: false, code: "not-found" };
    return resolveConfinedPath(this.#projectRoot, record.relativePath);
  }
}

/**
 * Resolve a relative path against the project root and verify it stays
 * confined after symlink canonicalization. Returns the canonical absolute
 * path on success, or a typed failure code.
 */
export function resolveConfinedPath(
  projectRoot: string,
  relativePath: string,
): ConfinedPathResolution {
  if (!isAbsolute(projectRoot)) return { ok: false, code: "containment-violation" };
  const root = resolve(projectRoot);
  const candidate = resolve(root, relativePath);
  if (!candidate.startsWith(root + sep) && candidate !== root) {
    return { ok: false, code: "containment-violation" };
  }
  try {
    const canonicalRoot = realpathSync(root);
    // Walk up to the nearest existing ancestor so symlink resolution works
    // even when the leaf does not yet exist.
    let nearest = candidate;
    while (true) {
      try {
        lstatSync(nearest);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          return { ok: false, code: "containment-violation" };
        }
        const parent = dirname(nearest);
        if (parent === nearest) return { ok: false, code: "containment-violation" };
        nearest = parent;
      }
    }
    const canonicalNearest = realpathSync(nearest);
    if (!isWithin(canonicalRoot, canonicalNearest)) {
      return { ok: false, code: "containment-violation" };
    }
    // Reattach the (possibly non-existent) tail below the nearest ancestor.
    const tail = nearest === candidate ? "" : candidate.slice(nearest.length + sep.length);
    const absolutePath = tail === "" ? canonicalNearest : join(canonicalNearest, tail);
    // If the leaf itself does not exist, the source is unavailable rather
    // than confined. Distinguish from containment so callers can surface a
    // stale/missing state instead of an authority denial.
    if (absolutePath !== canonicalNearest) {
      try {
        lstatSync(absolutePath);
      } catch {
        return { ok: false, code: "unavailable" };
      }
    }
    return { ok: true, absolutePath };
  } catch {
    return { ok: false, code: "containment-violation" };
  }
}

function isWithin(root: string, candidate: string): boolean {
  const confined = relative(root, candidate);
  return (
    confined === "" ||
    (confined !== ".." && !confined.startsWith(`..${sep}`) && !isAbsolute(confined))
  );
}
