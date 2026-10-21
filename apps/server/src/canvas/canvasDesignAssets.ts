import {
  CANVAS_DESIGN_ASSET_MAX_BYTES,
  CANVAS_DESIGN_ASSETS_MAX_BYTES,
  type CanvasDesignAssetResolution,
  type CanvasDesignAssetUnavailableReason,
  type CanvasDesignBlock,
  type CanvasProvenance,
  type ImageArtifactId,
} from "@octant/contracts";
import { canonicalizeWorkRelativePath, WorkConfinementRejected } from "@octant/domain";
import { sniffGeneratedImageMediaType } from "../image/generatedImageStore";
import { readConfinedWorkFile } from "../work/workConfinedRead";
import type { WorkFilesystemPort } from "../work/workFilesystemPort";
import { joinWorkPath, resolveContainedWorkPath } from "../work/workPathConfinement";

/**
 * What one source read produced: the bytes, or why there are none. A port
 * never throws for an expected refusal; it answers with one of these.
 */
export type CanvasDesignAssetRead =
  | { readonly status: "read"; readonly bytes: Uint8Array }
  | { readonly status: "unavailable"; readonly reason: "missing" | "refused" | "too-large" };

/**
 * The host reads a design's assets through. Each port re-derives authority
 * from durable host state on every call, from the Canvas version's own
 * provenance, and refuses rather than guesses: a host that cannot name a
 * thread's folder, or the Project an image was made in, reads nothing.
 */
export interface CanvasDesignAssetPorts {
  /**
   * A completed generated image, only when it was made in a thread of
   * `projectId`, or, for a Canvas owned by its thread (`projectId` null), in
   * `threadId` itself.
   */
  readonly generatedImage: (input: {
    readonly imageId: ImageArtifactId;
    readonly projectId: string | null;
    readonly threadId: string;
    readonly maximumBytes: number;
  }) => Promise<CanvasDesignAssetRead>;
  /**
   * A file under the folder a Work thread is bound to, or the checkout a Code
   * thread is bound to. Never called for Chat.
   */
  readonly projectFile: (input: {
    readonly mode: "work" | "code";
    readonly projectId: string;
    readonly threadId: string;
    readonly path: string;
    readonly maximumBytes: number;
  }) => Promise<CanvasDesignAssetRead>;
}

/**
 * Resolve every asset a design declares, under the authority of the Canvas
 * version that holds it.
 *
 * Nothing is cached: a reader asks again each time it draws the design, and
 * each ask runs the same authority checks, so a grant revoked a moment ago is
 * refused now. Assets resolve in declaration order and share one budget, so
 * the response stays bounded however many images are declared.
 *
 * Only raster images are admitted, read from the bytes rather than the name.
 * SVG is refused although a browser draws it inert in an image context: an
 * SVG file is markup, which content sniffing cannot tell apart from any other
 * XML or HTML text, and a design that wants vector art can already write it
 * inline, where the markup policy reads it.
 */
export async function resolveCanvasDesignAssets(
  block: Pick<CanvasDesignBlock, "assets">,
  provenance: Pick<CanvasProvenance, "mode" | "projectId" | "threadId">,
  ports: CanvasDesignAssetPorts,
): Promise<ReadonlyArray<CanvasDesignAssetResolution>> {
  const resolutions: CanvasDesignAssetResolution[] = [];
  let spent = 0;
  for (const asset of block.assets ?? []) {
    const unavailable = (reason: CanvasDesignAssetUnavailableReason) => {
      resolutions.push({ assetId: asset.assetId, status: "unavailable", reason });
    };
    const remaining = CANVAS_DESIGN_ASSETS_MAX_BYTES - spent;
    const maximumBytes = Math.min(CANVAS_DESIGN_ASSET_MAX_BYTES, remaining);
    let read: CanvasDesignAssetRead;
    if (asset.source.kind === "generated-image") {
      read = await ports.generatedImage({
        imageId: asset.source.imageId,
        projectId: provenance.projectId === null ? null : String(provenance.projectId),
        threadId: String(provenance.threadId),
        maximumBytes,
      });
    } else if (provenance.mode === "chat" || provenance.projectId === null) {
      // A Chat Project is virtual: it has no folder for a path to name.
      read = { status: "unavailable", reason: "refused" };
    } else {
      read = await ports.projectFile({
        mode: provenance.mode,
        projectId: String(provenance.projectId),
        threadId: String(provenance.threadId),
        path: asset.source.path,
        maximumBytes,
      });
    }
    if (read.status === "unavailable") {
      // Past the design's remaining budget but within the image's own is the
      // design's fault, not the image's.
      unavailable(
        read.reason === "too-large" && maximumBytes < CANVAS_DESIGN_ASSET_MAX_BYTES
          ? "design-budget"
          : read.reason,
      );
      continue;
    }
    if (read.bytes.byteLength > maximumBytes) {
      unavailable(maximumBytes < CANVAS_DESIGN_ASSET_MAX_BYTES ? "design-budget" : "too-large");
      continue;
    }
    const mediaType = sniffGeneratedImageMediaType(read.bytes);
    if (mediaType === undefined) {
      unavailable("not-an-image");
      continue;
    }
    spent += read.bytes.byteLength;
    resolutions.push({
      assetId: asset.assetId,
      status: "resolved",
      mediaType,
      data: Buffer.from(read.bytes).toString("base64"),
    });
  }
  return resolutions;
}

/**
 * Read one file under a bound folder through the Work confinement sequence:
 * the path is canonicalized (no absolute path, `..`, or backslash), resolved
 * with symlinks followed only while they stay inside the root, and read from
 * one handle that must be the object that resolution saw, capped at
 * `maximumBytes`.
 */
export async function readCanvasDesignAssetFile(input: {
  readonly filesystem: WorkFilesystemPort;
  readonly root: string;
  readonly path: string;
  readonly maximumBytes: number;
}): Promise<CanvasDesignAssetRead> {
  let relative: string;
  try {
    relative = canonicalizeWorkRelativePath(input.path);
  } catch (error) {
    if (error instanceof WorkConfinementRejected) {
      return { status: "unavailable", reason: "refused" };
    }
    throw error;
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = await input.filesystem.realpath(input.root);
  } catch {
    return { status: "unavailable", reason: "missing" };
  }
  const candidate = joinWorkPath(canonicalRoot, relative);
  try {
    await input.filesystem.lstat(candidate);
  } catch {
    return { status: "unavailable", reason: "missing" };
  }
  const resolved = await resolveContainedWorkPath(input.filesystem, canonicalRoot, candidate);
  if (resolved === undefined || !resolved.stat.isFile) {
    return { status: "unavailable", reason: "refused" };
  }
  if (resolved.stat.size > input.maximumBytes) {
    return { status: "unavailable", reason: "too-large" };
  }
  const bytes = await readConfinedWorkFile({
    filesystem: input.filesystem,
    canonicalPath: resolved.canonical,
    expected: resolved.stat,
    maximumBytes: input.maximumBytes,
  });
  return bytes === undefined
    ? { status: "unavailable", reason: "refused" }
    : { status: "read", bytes };
}
