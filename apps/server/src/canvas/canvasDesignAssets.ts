import {
  CANVAS_DESIGN_ASSET_MAX_BYTES,
  CANVAS_DESIGN_ASSETS_MAX_BYTES,
  type CanvasDesignAssetResolution,
  type CanvasDesignAssetUnavailableReason,
  type BrowserCaptureId,
  type CanvasDefinition,
  type CanvasDesignAsset,
  type CanvasDesignBlock,
  type CanvasProvenance,
  type ImageArtifactId,
} from "@octant/contracts";
import { createHash } from "node:crypto";
import { CANVAS_SHARE_IMAGES_MAX_BYTES } from "@octant/contracts/canvas-share";
import {
  canonicalizeWorkRelativePath,
  canvasShareImageKey,
  canvasShareImageSources,
  WorkConfinementRejected,
  type CanvasShareResolvedImage,
  type CanvasShareResolvedImages,
} from "@octant/domain";
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
   * A screenshot the Browser kept for `threadId` itself. Never called for
   * Chat, and never answers another thread's capture: a capture belongs to the
   * thread that took it, whatever Project the Canvas is in.
   */
  readonly browserCapture: (input: {
    readonly captureId: BrowserCaptureId;
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
 * Read one declared image under the authority of the Canvas version that
 * declares it: a generated image of its Project or its own thread, a capture
 * its own thread kept (never in Chat), or a file under the bound folder
 * (never in Chat, whose Project has no folder).
 */
async function readCanvasDesignAssetSource(
  source: CanvasDesignAsset["source"],
  provenance: Pick<CanvasProvenance, "mode" | "projectId" | "threadId">,
  ports: CanvasDesignAssetPorts,
  maximumBytes: number,
): Promise<CanvasDesignAssetRead> {
  if (source.kind === "generated-image") {
    return ports.generatedImage({
      imageId: source.imageId,
      projectId: provenance.projectId === null ? null : String(provenance.projectId),
      threadId: String(provenance.threadId),
      maximumBytes,
    });
  }
  if (source.kind === "browser-capture") {
    // Chat keeps no captures for a design: the Browser is a Work and Code tool.
    return provenance.mode === "chat"
      ? { status: "unavailable", reason: "refused" }
      : ports.browserCapture({
          captureId: source.captureId,
          threadId: String(provenance.threadId),
          maximumBytes,
        });
  }
  if (provenance.mode === "chat" || provenance.projectId === null) {
    // A Chat Project is virtual: it has no folder for a path to name.
    return { status: "unavailable", reason: "refused" };
  }
  return ports.projectFile({
    mode: provenance.mode,
    projectId: String(provenance.projectId),
    threadId: String(provenance.threadId),
    path: source.path,
    maximumBytes,
  });
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
    const read = await readCanvasDesignAssetSource(asset.source, provenance, ports, maximumBytes);
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
 * The images a share of this version carries: every image the document
 * displays, resolved under the version's own provenance exactly as a
 * reader's draw resolves it, and sniffed as raster images (maintainer
 * decision, 2026-11-22). An image that does not resolve, is not a raster
 * image, or would pass the share's budget is left out; its block then reads
 * as its description, or its frame draws a placeholder, in the share.
 */
export async function resolveCanvasShareImages(
  definition: Pick<CanvasDefinition, "blocks" | "provenance">,
  ports: CanvasDesignAssetPorts,
): Promise<CanvasShareResolvedImages> {
  const resolved = new Map<string, CanvasShareResolvedImage>();
  let spent = 0;
  for (const source of canvasShareImageSources(definition)) {
    const remaining = CANVAS_SHARE_IMAGES_MAX_BYTES - spent;
    if (remaining <= 0) break;
    const read = await readCanvasDesignAssetSource(
      source,
      definition.provenance,
      ports,
      Math.min(CANVAS_DESIGN_ASSET_MAX_BYTES, remaining),
    );
    if (read.status !== "read") continue;
    const mediaType = sniffGeneratedImageMediaType(read.bytes);
    if (mediaType === undefined || read.bytes.byteLength > remaining) continue;
    spent += read.bytes.byteLength;
    resolved.set(canvasShareImageKey(source), {
      mediaType,
      data: Buffer.from(read.bytes).toString("base64"),
      byteLength: read.bytes.byteLength,
      sha256: createHash("sha256").update(read.bytes).digest("hex"),
    });
  }
  return resolved;
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
  const prepared = await prepareCanvasDesignAssetFile(input);
  if (prepared.status === "unavailable") return prepared;
  const bytes = await prepared.read();
  return bytes === undefined
    ? { status: "unavailable", reason: "refused" }
    : { status: "read", bytes };
}

export async function prepareCanvasDesignAssetFile(input: {
  readonly filesystem: WorkFilesystemPort;
  readonly root: string;
  readonly path: string;
  readonly maximumBytes: number;
  readonly pathRefused?: (absolutePath: string) => boolean;
}): Promise<
  | Extract<CanvasDesignAssetRead, { status: "unavailable" }>
  | {
      readonly status: "ready";
      readonly size: number;
      readonly read: () => Promise<Uint8Array | undefined>;
    }
> {
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
  const pathRefused = (canonical: string) =>
    input.pathRefused?.(candidate) === true || input.pathRefused?.(canonical) === true;
  if (pathRefused(resolved.canonical)) return { status: "unavailable", reason: "refused" };
  if (resolved.stat.size > input.maximumBytes) {
    return { status: "unavailable", reason: "too-large" };
  }
  return {
    status: "ready",
    size: resolved.stat.size,
    read: async () => {
      if ((await input.filesystem.realpath(input.root).catch(() => undefined)) !== canonicalRoot)
        return undefined;
      const current = await resolveContainedWorkPath(input.filesystem, canonicalRoot, candidate);
      if (current?.canonical !== resolved.canonical || pathRefused(current.canonical))
        return undefined;
      return readConfinedWorkFile({
        filesystem: input.filesystem,
        canonicalPath: resolved.canonical,
        expected: resolved.stat,
        maximumBytes: resolved.stat.size,
        ...(resolved.stat.changedAt === undefined
          ? {}
          : { unchangedSince: resolved.stat.changedAt }),
      });
    },
  };
}
