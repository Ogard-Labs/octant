import { createHash } from "node:crypto";
import {
  CANVAS_SCHEMA_VERSION,
  type CanvasBlock,
  type CanvasDefinition,
  type CanvasSourceManifestEntry,
  type CanvasSourceVersion,
} from "@octant/contracts/canvas";
import type { UtcTimestamp } from "@octant/contracts/events";
import type { CanvasRefreshRequest } from "@octant/contracts/canvas-refresh";
import type { CanvasRefreshSourceOutcome, CanvasServiceDependencies } from "./canvasService";

/**
 * Authoritative Work artifact state consulted for "artifact" sources. The
 * server-owned projection is journal-derived, so the observed content hash is
 * authoritative rather than renderer-supplied.
 */
export interface CanvasRefreshArtifactState {
  readonly displayName: string;
  readonly relativePath: string;
  readonly contentSha256: string;
  readonly deleted: boolean;
}

/** Authoritative Work thread state consulted for "thread" sources. */
export interface CanvasRefreshThreadState {
  readonly title: string;
  readonly updatedAt: string;
  readonly lifecycle: string;
}

/** Authoritative evidence state consulted for "evidence" sources. */
export interface CanvasRefreshEvidenceState {
  readonly label: string;
  readonly contentSha256: string;
}

/**
 * The host identity of the object containment resolved, captured while it was
 * resolving it. The read that follows proves it read *that* object rather than
 * whatever now answers to the same name, which is the only thing that closes
 * the window between the containment decision and the bytes.
 */
export interface CanvasRefreshFileIdentity {
  readonly device: string;
  readonly inode: string;
  /**
   * The size the object had when containment resolved it. It only classifies an
   * already-oversized source; the read is bounded by the open handle, never by
   * this number.
   */
  readonly byteLength: number;
}

/** A confined, readable backing file for "file"/"attachment"/"image"/"preview" sources. */
export interface CanvasRefreshResolvedFile {
  readonly absolutePath: string;
  readonly displayName: string;
  readonly relativePath: string;
  readonly identity: CanvasRefreshFileIdentity;
  readonly expectedDigest?: string;
  readonly expectedByteLength?: number;
}

/**
 * What one bounded read of a resolved file observed. Size and digest are one
 * fact pair taken from a single handle, so no source can be measured as one
 * object and digested as another.
 */
export type CanvasRefreshFileContent =
  | { readonly kind: "content"; readonly byteLength: number; readonly contentSha256: string }
  | { readonly kind: "oversized" }
  | { readonly kind: "unreadable" };

/**
 * Narrow server-state ports for the production Canvas refresh resolver. Every
 * port is optional: an absent port fails the source kind closed with a typed
 * non-ready outcome instead of guessing. The resolver never accepts content or
 * hashes from the renderer; all ready outcomes are derived from these ports.
 */
export interface CanvasRefreshSourceResolverDependencies {
  readonly clock: () => UtcTimestamp;
  readonly artifactState?: (
    projectId: string,
    opaqueRef: string,
  ) => CanvasRefreshArtifactState | undefined;
  readonly threadState?: (
    projectId: string,
    threadId: string,
    mode: CanvasRefreshRequest["mode"],
  ) => CanvasRefreshThreadState | undefined;
  readonly fileState?: {
    readonly resolve: (
      projectId: string,
      opaqueRef: string,
      request: CanvasRefreshRequest,
    ) => CanvasRefreshResolvedFile | undefined | Promise<CanvasRefreshResolvedFile | undefined>;
    /**
     * Size and digest of the resolved object, both derived from one
     * identity-verified handle. The resolver never hands out a path for a
     * second lookup: a resolved name can be made to mean something else the
     * moment after containment approved it.
     */
    readonly read: (file: CanvasRefreshResolvedFile) => Promise<CanvasRefreshFileContent>;
  };
  readonly evidenceState?: (
    projectId: string,
    opaqueRef: string,
  ) => CanvasRefreshEvidenceState | undefined;
  /** Provider liveness gate for provider-backed sources ("thread"). */
  readonly providerObserved?: (providerInstanceId: string, modelId: string) => boolean;
}

type ResolvedSource =
  | {
      readonly status: "ready";
      readonly observedVersion: CanvasSourceVersion;
      readonly block: CanvasBlock;
    }
  | {
      readonly status:
        | "missing"
        | "revoked"
        | "offline"
        | "unauthorized"
        | "interrupted"
        | "oversized"
        | "failed";
      readonly message: string;
    };

const readyReferenceBlock = (
  kind: CanvasBlock["kind"],
  source: CanvasSourceManifestEntry,
  label: string,
  detail: string | undefined,
): CanvasBlock => {
  return {
    blockId: `ref:${source.kind}:${String(source.sourceId)}` as never,
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind,
    sourceId: source.sourceId,
    label,
    ...(detail === undefined ? {} : { detail }),
  } as CanvasBlock;
};

function digestOfThread(thread: CanvasRefreshThreadState): string {
  return createHash("sha256")
    .update(`${thread.title}\n${thread.updatedAt}\n${thread.lifecycle}`)
    .digest("hex");
}

/**
 * Production Canvas refresh source resolver. Reauthorizes every source against
 * authoritative server state and fails closed: revoked, offline, missing, or
 * changed sources never reach `ready`. A `ready` outcome is produced only when
 * the backing state is present and a regenerated definition can be rendered
 * from it, with the observed content hash taken from server-owned state.
 */
export function createCanvasRefreshSourceResolver(
  deps: CanvasRefreshSourceResolverDependencies,
): NonNullable<CanvasServiceDependencies["refreshSource"]> {
  const manifestCache = new Map<string, Promise<ReadonlyMap<string, ResolvedSource>>>();
  const resolveSource = async (
    source: CanvasSourceManifestEntry,
    request: CanvasRefreshRequest,
  ): Promise<ResolvedSource> => {
    if (source.hostId !== request.hostId) {
      return {
        status: "unauthorized",
        message: "Source host no longer matches the approved refresh recipe.",
      };
    }
    const projectId = String(source.projectId);
    const opaqueRef = String(source.opaqueRef);
    switch (source.kind) {
      case "artifact": {
        if (deps.artifactState === undefined) {
          return {
            status: "failed",
            message: "Artifact source refresh is not available for this source kind.",
          };
        }
        const artifact = deps.artifactState(projectId, opaqueRef);
        if (artifact === undefined) {
          return {
            status: "missing",
            message: "Artifact source is no longer present in this Project.",
          };
        }
        if (artifact.deleted) {
          return { status: "missing", message: "Artifact source was deleted." };
        }
        return {
          status: "ready",
          observedVersion: {
            contentSha256: artifact.contentSha256,
            observedAt: deps.clock(),
          },
          block: readyReferenceBlock(
            "artifact-reference",
            source,
            artifact.displayName,
            artifact.relativePath,
          ),
        };
      }
      case "file":
      case "attachment":
      case "image":
      case "preview": {
        if (deps.fileState === undefined) {
          return {
            status: "failed",
            message: "File source refresh is not available for this source kind.",
          };
        }
        const file = await deps.fileState.resolve(projectId, opaqueRef, request);
        if (file === undefined) {
          return {
            status: "missing",
            message: "File source is no longer present in this Project.",
          };
        }
        const content = await deps.fileState.read(file);
        if (content.kind === "oversized") {
          return {
            status: "oversized",
            message: "File source exceeds the Canvas refresh size budget.",
          };
        }
        if (content.kind === "unreadable") {
          return { status: "failed", message: "File source could not be read." };
        }
        if (
          file.expectedByteLength !== undefined &&
          content.byteLength !== file.expectedByteLength
        ) {
          return {
            status: "failed",
            message: "File source metadata no longer matches the projected content.",
          };
        }
        const contentSha256 = content.contentSha256;
        if (file.expectedDigest !== undefined && contentSha256 !== file.expectedDigest) {
          return {
            status: "failed",
            message: "File source digest no longer matches the projected content.",
          };
        }
        const block =
          source.kind === "image"
            ? ({
                blockId: `ref:${source.kind}:${String(source.sourceId)}` as never,
                schemaVersion: CANVAS_SCHEMA_VERSION,
                kind: "image",
                sourceId: source.sourceId,
                alt: file.displayName,
              } as CanvasBlock)
            : readyReferenceBlock(
                source.kind === "preview" ? "preview-reference" : "file-reference",
                source,
                file.displayName,
                file.relativePath,
              );
        return {
          status: "ready",
          observedVersion: { contentSha256, observedAt: deps.clock() },
          block,
        };
      }
      case "thread": {
        if (deps.threadState === undefined) {
          return {
            status: "failed",
            message: "Thread source refresh is not available for this source kind.",
          };
        }
        const thread = deps.threadState(projectId, opaqueRef, request.mode);
        if (thread === undefined) {
          return {
            status: "missing",
            message: "Thread source is no longer present in this Project.",
          };
        }
        if (thread.lifecycle === "deleted" || thread.lifecycle === "deleting") {
          return { status: "revoked", message: "Thread source is no longer active." };
        }
        return {
          status: "ready",
          observedVersion: {
            contentSha256: digestOfThread(thread),
            observedAt: deps.clock(),
          },
          block: readyReferenceBlock("source-reference", source, thread.title, undefined),
        };
      }
      case "evidence": {
        if (deps.evidenceState === undefined) {
          return {
            status: "failed",
            message: "Evidence source refresh is not available for this source kind.",
          };
        }
        const evidence = deps.evidenceState(projectId, opaqueRef);
        if (evidence === undefined) {
          return {
            status: "missing",
            message: "Evidence source is no longer present in this Project.",
          };
        }
        return {
          status: "ready",
          observedVersion: {
            contentSha256: evidence.contentSha256,
            observedAt: deps.clock(),
          },
          block: readyReferenceBlock("evidence-reference", source, evidence.label, undefined),
        };
      }
      case "browser": {
        return {
          status: "failed",
          message: "Browser source refresh is not available for this source kind.",
        };
      }
      default: {
        return {
          status: "failed",
          message: "Canvas source refresh is not available for this source kind.",
        };
      }
    }
  };

  return async (
    source,
    request,
    currentDefinition,
    isCancelled,
  ): Promise<CanvasRefreshSourceOutcome> => {
    const approvedSource = request.recipe.sourceManifest.find(
      (entry) => String(entry.sourceId) === String(source.sourceId),
    );
    // A caller may hand the resolver a source that is no longer the approved
    // manifest entry (for example, after a host or kind changed). Never resolve
    // an unapproved candidate: the signed recipe is the complete source scope.
    if (approvedSource === undefined || !sameCanvasSourceIdentity(source, approvedSource)) {
      return {
        sourceId: source.sourceId,
        status: "unauthorized",
        message: "Source is no longer part of the approved refresh manifest.",
      };
    }
    const requestKey = `${String(request.requestId)}:${JSON.stringify(request.recipe.sourceManifest)}`;
    let manifest = manifestCache.get(requestKey);
    if (manifest === undefined) {
      manifest = (async () => {
        if (
          deps.providerObserved !== undefined &&
          !deps.providerObserved(String(request.providerInstanceId), String(request.modelId))
        ) {
          return new Map(
            request.recipe.sourceManifest.map(
              (entry) =>
                [
                  String(entry.sourceId),
                  {
                    status: "offline",
                    message: "The provider for this Canvas refresh is offline or unauthorized.",
                  },
                ] as const,
            ),
          );
        }
        // Resolve sources serially. File-backed sources perform a bounded read
        // during digesting; parallelizing the manifest would multiply that
        // budget by every source and permit aggregate memory spikes.
        const entries: Array<readonly [string, ResolvedSource]> = [];
        for (const entry of request.recipe.sourceManifest) {
          if (isCancelled?.()) {
            for (const remaining of request.recipe.sourceManifest.slice(entries.length)) {
              entries.push([
                String(remaining.sourceId),
                {
                  status: "interrupted",
                  message: "Refresh cancelled before source resolution.",
                },
              ]);
            }
            break;
          }
          entries.push([String(entry.sourceId), await resolveSource(entry, request)]);
        }
        return new Map(entries);
      })();
      manifestCache.set(requestKey, manifest);
      void manifest.then(
        () => setTimeout(() => manifestCache.delete(requestKey), 60_000),
        () => setTimeout(() => manifestCache.delete(requestKey), 60_000),
      );
    }
    const resolvedManifest = await manifest;
    const resolved = resolvedManifest.get(String(source.sourceId));
    if (resolved === undefined) {
      return {
        sourceId: source.sourceId,
        status: "missing",
        message: "Source is no longer part of the approved refresh manifest.",
      };
    }
    if (resolved.status !== "ready") {
      return { sourceId: source.sourceId, status: resolved.status, message: resolved.message };
    }
    // Regenerate the full definition from every approved source. Each ready
    // resolver call renders the same canonical manifest against the same
    // authoritative state, so multi-source refreshes agree on one definition.
    // Blocks that do not reference an approved source are preserved; source
    // reference blocks are replaced by the freshly rendered block.
    const fresh = new Map<string, CanvasBlock>();
    for (const [sourceId, entryResolved] of resolvedManifest) {
      if (entryResolved.status !== "ready") {
        return {
          sourceId: source.sourceId,
          status: entryResolved.status === "interrupted" ? "interrupted" : "failed",
          message:
            entryResolved.status === "interrupted"
              ? entryResolved.message
              : `Another approved source (${sourceId}) is not refreshable.`,
        };
      }
      fresh.set(sourceId, entryResolved.block);
    }
    const blocks: CanvasBlock[] = [];
    const boundSourceIds = new Set<string>();
    const usedBlockIds = new Set<string>();
    for (const block of currentDefinition.blocks) {
      const blockSourceId = (block as { sourceId?: unknown }).sourceId;
      const replacement =
        blockSourceId === undefined ? undefined : fresh.get(String(blockSourceId));
      if (replacement !== undefined) {
        if (!preservesBlockSemantics(block, replacement)) {
          return {
            sourceId: source.sourceId,
            status: "incompatible",
            message: `Source ${String(blockSourceId)} changed but its ${block.kind} block cannot be regenerated safely.`,
          };
        }
        // Keep the existing block identity for every occurrence. A source can
        // legitimately appear in multiple blocks, each of which must retain a
        // distinct stable ID even though the regenerated payload is shared.
        blocks.push({ ...replacement, blockId: block.blockId });
        usedBlockIds.add(String(block.blockId));
        boundSourceIds.add(String(blockSourceId));
      } else {
        blocks.push(block);
        usedBlockIds.add(String(block.blockId));
      }
    }
    for (const [sourceId, block] of fresh) {
      if (!boundSourceIds.has(sourceId)) {
        const uniqueBlock = withUniqueBlockId(block, usedBlockIds);
        blocks.push(uniqueBlock);
        usedBlockIds.add(String(uniqueBlock.blockId));
      }
    }
    return {
      sourceId: source.sourceId,
      status: "ready",
      refreshedDefinition: {
        schemaVersion: CANVAS_SCHEMA_VERSION,
        title: currentDefinition.title,
        // Provenance and source manifest are rebuilt by the version policy from
        // the current immutable version; the resolver only supplies content.
        provenance: {
          mode: request.mode,
          hostId: request.hostId,
          projectId: source.projectId,
          threadId: request.originThreadId,
          actor: request.actor,
          providerInstanceId: request.providerInstanceId,
          modelId: request.modelId,
          // CanvasService applies one refresh timestamp when it appends the
          // version; keep resolver outputs comparable across source calls.
          createdAt: currentDefinition.provenance.createdAt,
        } as never,
        sourceManifest: [],
        blocks,
      } as CanvasDefinition,
      observedVersion: resolved.observedVersion,
    };
  };
}

function preservesBlockSemantics(existing: CanvasBlock, replacement: CanvasBlock): boolean {
  if (
    existing.kind === "citation" ||
    existing.kind === "code-excerpt" ||
    existing.kind === "diff"
  ) {
    return replacement.kind === existing.kind;
  }
  if (
    isPotentiallySourceDerivedBlock(existing) &&
    (existing as { sourceId?: unknown }).sourceId !== undefined
  ) {
    return replacement.kind === existing.kind;
  }
  return existing.kind !== "image" || replacement.kind === "image";
}

function isPotentiallySourceDerivedBlock(block: CanvasBlock): boolean {
  return (
    block.kind === "chart" ||
    block.kind === "table" ||
    block.kind === "metric" ||
    block.kind === "summary" ||
    block.kind === "rich-text"
  );
}

function withUniqueBlockId(block: CanvasBlock, usedBlockIds: ReadonlySet<string>): CanvasBlock {
  const base = String(block.blockId);
  let candidate = base;
  let suffix = 1;
  while (usedBlockIds.has(candidate)) {
    const suffixText = `:${suffix}`;
    candidate = `${base.slice(0, Math.max(1, 128 - suffixText.length))}${suffixText}`;
    suffix += 1;
  }
  return candidate === base ? block : { ...block, blockId: candidate as never };
}

function sameCanvasSourceIdentity(
  left: CanvasSourceManifestEntry,
  right: CanvasSourceManifestEntry,
): boolean {
  return (
    String(left.sourceId) === String(right.sourceId) &&
    left.kind === right.kind &&
    left.hostId === right.hostId &&
    String(left.projectId) === String(right.projectId) &&
    left.opaqueRef === right.opaqueRef &&
    left.displayName === right.displayName
  );
}
