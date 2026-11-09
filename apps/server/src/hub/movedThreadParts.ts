// The bulk parts a moved thread carries beside its conversation, in every
// mode: the images it generated, the Browser captures it kept, and the
// Canvases it owns with every version. (A Chat thread's attachments and the
// inputs its turns admitted travel with the turns that hold them, on the Chat
// side.) Each one is a manifest part with its own size and digest, so it
// crosses the same chunked, resumable transfer as the conversation.
//
// The source reads each part once. One whose bytes cannot be read is named in
// the receipt rather than failing the whole move, because the person is about
// to shut the computer down and the rest of the thread should still go. The
// destination re-homes every part under the new thread with ids derived from
// the move and the part, so a finish asked again after a stop records each
// part once.

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BrowserRecordingFacts,
  CanvasVersion,
  decodeBrowserCaptureId,
  decodeImageArtifactId,
  ProviderInstanceId,
  ProviderModelId,
  UtcTimestamp,
  type BrowserCapture,
  type ImageJob,
  type MovedThreadReference,
  type ThreadMovePartKind,
  type ThreadMovePartLeftBehind,
  type ThreadMoveSize,
} from "@octant/contracts";
import { Schema } from "effect";
import type { PackedPart } from "./threadMoveService";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const PartId = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64));

/** What the conversation part says about the bulk parts beside it. */
export const MovedThreadParts = Schema.Struct({
  generatedImages: Schema.Array(
    Schema.Struct({
      profileInstanceId: ProviderInstanceId,
      modelId: ProviderModelId,
      promptHash: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)),
      createdAt: UtcTimestamp,
      updatedAt: UtcTimestamp,
      images: Schema.Array(
        Schema.Struct({
          partId: PartId,
          /** The image's id on the source, which a carried design's assets may name. */
          sourceImageId: Schema.UUID,
        }).annotations(strict),
      ).pipe(Schema.minItems(1)),
    }).annotations(strict),
  ),
  browserCaptures: Schema.Array(
    Schema.Struct({
      partId: PartId,
      /** The capture's id on the source, which a carried design's assets may name. */
      sourceCaptureId: Schema.UUID,
      origin: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2048)),
      url: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4096)),
      title: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024))),
      capturedAt: UtcTimestamp,
      recording: Schema.optional(BrowserRecordingFacts),
    }).annotations(strict),
  ),
  canvases: Schema.Array(
    Schema.Struct({ partId: PartId, carriesOutsideContent: Schema.Boolean }).annotations(strict),
  ),
}).annotations(strict);
export type MovedThreadParts = typeof MovedThreadParts.Type;

/** A Canvas part: every version the Canvas holds, oldest first. */
const MovedCanvas = Schema.Struct({
  versions: Schema.Array(CanvasVersion).pipe(Schema.minItems(1)),
}).annotations(strict);
const encodeMovedCanvas = Schema.encodeSync(MovedCanvas);
const decodeMovedCanvas = Schema.decodeUnknownSync(MovedCanvas);

/** A Canvas the thread owns, as the source reads it. */
export interface OwnedCanvas {
  readonly title: string;
  readonly versions: ReadonlyArray<CanvasVersion>;
  /** The Canvas recorded a writer marked with outside content. */
  readonly carriesOutsideContent: boolean;
}

/** Where the source reads the bulk parts a thread owns. */
export interface ThreadPartsSource {
  /** The thread's image jobs; only completed ones carry images. */
  readonly generatedImages: (threadId: string) => ReadonlyArray<ImageJob>;
  readonly readGeneratedImage: (
    job: ImageJob,
    attachmentId: ImageJob["artifacts"][number]["attachmentId"],
  ) => Promise<Uint8Array | undefined>;
  /** The thread's retained captures, newest first. */
  readonly browserCaptures: (threadId: string) => ReadonlyArray<BrowserCapture>;
  readonly readBrowserCapture: (capture: BrowserCapture) => Promise<Uint8Array | undefined>;
  /** Every Canvas whose provenance names the thread: the ones its erase would remove. */
  readonly canvases: (thread: MovedThreadReference) => ReadonlyArray<OwnedCanvas>;
}

/** Where the destination records each part under the new thread. Each one throws when it cannot. */
export interface ThreadPartsDestination {
  readonly carryGeneratedImage: (input: {
    readonly jobId: string;
    readonly mode: MovedThreadReference["mode"];
    readonly threadId: string;
    readonly profileInstanceId: ProviderInstanceId;
    readonly modelId: ProviderModelId;
    readonly promptHash: string;
    readonly createdAt: UtcTimestamp;
    readonly updatedAt: UtcTimestamp;
    readonly images: ReadonlyArray<{ readonly attachmentId: string; readonly bytes: Uint8Array }>;
  }) => Promise<void>;
  readonly carryBrowserCapture: (input: {
    readonly threadId: string;
    readonly captureId: string;
    readonly bytes: Uint8Array;
    readonly facts: Omit<MovedThreadParts["browserCaptures"][number], "partId" | "sourceCaptureId">;
  }) => Promise<void>;
  readonly carryCanvas: (input: {
    readonly canvasId: string;
    readonly versions: ReadonlyArray<{
      readonly versionId: string;
      readonly source: CanvasVersion;
    }>;
    /** The Project the thread moved into; none for a Chat thread in none. */
    readonly projectId: string | null;
    readonly threadId: string;
    readonly carriesOutsideContent: boolean;
  }) => void | Promise<void>;
}

export interface PackedThreadParts {
  readonly parts: ReadonlyArray<PackedPart>;
  /** Absent when the thread owns no bulk part, so the conversation part stays as it was. */
  readonly index?: MovedThreadParts;
  readonly partsLeftBehind: ReadonlyArray<ThreadMovePartLeftBehind>;
}

/** Writes each bulk part the thread owns into `folder`. */
export async function packThreadParts(
  thread: MovedThreadReference,
  folder: string,
  source: ThreadPartsSource,
): Promise<PackedThreadParts> {
  const parts: PackedPart[] = [];
  const partsLeftBehind: ThreadMovePartLeftBehind[] = [];
  const write = async (
    partId: string,
    kind: PackedPart["kind"],
    bytes: Uint8Array | string,
  ): Promise<void> => {
    const path = join(folder, `${partId}.part`);
    await writeFile(path, bytes, { mode: 0o600 });
    parts.push({ partId, kind, path });
  };

  const generatedImages: Array<MovedThreadParts["generatedImages"][number]> = [];
  for (const job of source.generatedImages(thread.threadId)) {
    if (job.status !== "completed") continue;
    const images: Array<MovedThreadParts["generatedImages"][number]["images"][number]> = [];
    for (const artifact of job.artifacts) {
      const bytes = await source
        .readGeneratedImage(job, artifact.attachmentId)
        .catch(() => undefined);
      if (bytes === undefined) {
        partsLeftBehind.push({ kind: "generated-image", name: "Generated image" });
        continue;
      }
      const partId = `image-${parts.length + 1}`;
      await write(partId, "generated-image", bytes);
      images.push({ partId, sourceImageId: String(artifact.attachmentId) });
    }
    if (images.length === 0) continue;
    generatedImages.push({
      profileInstanceId: job.profileInstanceId,
      modelId: job.modelId,
      promptHash: job.promptHash,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      images,
    });
  }

  const browserCaptures: Array<MovedThreadParts["browserCaptures"][number]> = [];
  // Oldest first, so the newest stay the newest where they land.
  for (const capture of [...source.browserCaptures(thread.threadId)].reverse()) {
    const bytes = await source.readBrowserCapture(capture).catch(() => undefined);
    if (bytes === undefined) {
      partsLeftBehind.push({ kind: "browser-capture", name: capture.title ?? capture.origin });
      continue;
    }
    const partId = `capture-${parts.length + 1}`;
    await write(partId, "browser-capture", bytes);
    browserCaptures.push({
      partId,
      sourceCaptureId: String(capture.captureId),
      origin: capture.origin,
      url: capture.url,
      ...(capture.title === undefined ? {} : { title: capture.title }),
      capturedAt: capture.capturedAt,
      ...(capture.recording === undefined ? {} : { recording: capture.recording }),
    });
  }

  const canvases: Array<MovedThreadParts["canvases"][number]> = [];
  for (const canvas of source.canvases(thread)) {
    const partId = `canvas-${parts.length + 1}`;
    await write(partId, "canvas", JSON.stringify(encodeMovedCanvas({ versions: canvas.versions })));
    canvases.push({ partId, carriesOutsideContent: canvas.carriesOutsideContent });
  }

  const index: MovedThreadParts = { generatedImages, browserCaptures, canvases };
  return parts.length === 0 ? { parts, partsLeftBehind } : { parts, index, partsLeftBehind };
}

/**
 * The size of one kind of part a move would carry. `unknown` when the sizes
 * of that kind could not be read; the move still carries what it can.
 */
export type MeasuredPartKind =
  | { readonly status: "measured"; readonly kind: ThreadMovePartKind; readonly bytes: number }
  | { readonly status: "unknown"; readonly kind: ThreadMovePartKind };

/**
 * Sums the sizes of one kind of part, read by `sizes`. A kind the thread has
 * none of is left out; one whose sizes cannot be read is `unknown`.
 */
export function measurePartKind(
  kind: ThreadMovePartKind,
  sizes: () => ReadonlyArray<number>,
): ReadonlyArray<MeasuredPartKind> {
  let read: ReadonlyArray<number>;
  try {
    read = sizes();
  } catch {
    return [{ status: "unknown", kind }];
  }
  if (read.length === 0) return [];
  return [{ status: "measured", kind, bytes: read.reduce((total, bytes) => total + bytes, 0) }];
}

/**
 * The sizes of the bulk parts `packThreadParts` would write, read from what
 * the stores already record (each generated image's and capture's recorded
 * size) without reading, writing, or freezing anything. A Canvas records no
 * byte size, so its part is measured as the very text the pack writes, from
 * the versions the Canvas projection already holds in memory.
 */
export function measureThreadParts(
  thread: MovedThreadReference,
  source: ThreadPartsSource,
): ReadonlyArray<MeasuredPartKind> {
  return [
    ...measurePartKind("generated-image", () =>
      source
        .generatedImages(thread.threadId)
        .filter((job) => job.status === "completed")
        .flatMap((job) => job.artifacts.map((artifact) => artifact.size)),
    ),
    ...measurePartKind("browser-capture", () =>
      source.browserCaptures(thread.threadId).map((capture) => capture.size),
    ),
    ...measurePartKind("canvas", () =>
      source
        .canvases(thread)
        .map((canvas) =>
          Buffer.byteLength(JSON.stringify(encodeMovedCanvas({ versions: canvas.versions }))),
        ),
    ),
  ];
}

/** One thread's size from the sizes of the kinds of part it would carry. */
export function threadMoveSize(parts: ReadonlyArray<MeasuredPartKind>): ThreadMoveSize {
  const measured = parts.flatMap((part) =>
    part.status === "measured" ? [{ kind: part.kind, bytes: part.bytes }] : [],
  );
  const bytes = measured.reduce((total, part) => total + part.bytes, 0);
  const [firstUnknown, ...otherUnknown] = parts.flatMap((part) =>
    part.status === "unknown" ? [part.kind] : [],
  );
  return firstUnknown === undefined
    ? { status: "measured", bytes, parts: measured }
    : {
        status: "partly-measured",
        bytes,
        parts: measured,
        unknownParts: [firstUnknown, ...otherUnknown],
      };
}

/**
 * Records every bulk part under the new thread. `refused` means a part could
 * not be read back or recorded; the destination answers `transfer-failed`,
 * and the source keeps its thread.
 */
export async function rehomeThreadParts(input: {
  readonly index: MovedThreadParts | undefined;
  readonly parts: ReadonlyMap<string, string>;
  readonly moveId: string;
  readonly thread: MovedThreadReference;
  readonly projectId: string | null;
  readonly destination: ThreadPartsDestination;
}): Promise<{ readonly status: "carried" } | { readonly status: "refused" }> {
  const { index, destination, thread } = input;
  if (index === undefined) return { status: "carried" };
  const bytesOf = async (partId: string): Promise<Uint8Array> => {
    const path = input.parts.get(partId);
    if (path === undefined) throw new Error(`The part ${partId} did not arrive.`);
    return new Uint8Array(await readFile(path));
  };
  const idFor = (...names: ReadonlyArray<string>) => movedPartUuid(input.moveId, ...names);
  // What each carried image and capture is called here, so a carried design
  // that names one by its source id can be pointed at the copy that arrived.
  const arrivedIds = {
    images: new Map(
      index.generatedImages.flatMap((job) =>
        job.images.map((image) => [image.sourceImageId, idFor(image.partId)] as const),
      ),
    ),
    captures: new Map(
      index.browserCaptures.map(
        (capture) => [capture.sourceCaptureId, idFor(capture.partId)] as const,
      ),
    ),
  };
  try {
    for (const job of index.generatedImages) {
      const first = job.images[0]?.partId ?? "";
      await destination.carryGeneratedImage({
        jobId: idFor(first, "job"),
        mode: thread.mode,
        threadId: thread.threadId,
        profileInstanceId: job.profileInstanceId,
        modelId: job.modelId,
        promptHash: job.promptHash,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        images: await Promise.all(
          job.images.map(async (image) => ({
            attachmentId: idFor(image.partId),
            bytes: await bytesOf(image.partId),
          })),
        ),
      });
    }
    for (const capture of index.browserCaptures) {
      const { partId, sourceCaptureId: _sourceId, ...facts } = capture;
      await destination.carryBrowserCapture({
        threadId: thread.threadId,
        captureId: idFor(partId),
        bytes: await bytesOf(partId),
        facts,
      });
    }
    for (const canvas of index.canvases) {
      const moved = decodeMovedCanvas(
        JSON.parse(new TextDecoder().decode(await bytesOf(canvas.partId))),
      );
      await destination.carryCanvas({
        canvasId: idFor(canvas.partId),
        versions: moved.versions.map((source, position) => ({
          versionId: idFor(canvas.partId, `version-${position + 1}`),
          source: rehomeDesignAssets(source, arrivedIds),
        })),
        projectId: input.projectId,
        threadId: thread.threadId,
        carriesOutsideContent: canvas.carriesOutsideContent,
      });
    }
  } catch {
    return { status: "refused" };
  }
  return { status: "carried" };
}

/**
 * Points each design asset that names a carried generated image or Browser
 * capture at the id that part was recorded under here. Design assets are
 * resolved against this computer's own stores each time the design is drawn,
 * so without this a moved design loses images whose bytes did arrive. Only
 * those references change: an asset naming something that did not travel
 * stays as it was (the receipt names what stayed), and the source manifest,
 * provenance, and every other block keep what they recorded on the source.
 * A version with nothing to rewrite is returned as it is.
 */
export function rehomeDesignAssets(
  version: CanvasVersion,
  arrived: {
    readonly images: ReadonlyMap<string, string>;
    readonly captures: ReadonlyMap<string, string>;
  },
): CanvasVersion {
  let changed = false;
  const blocks = version.definition.blocks.map((block) => {
    if (block.kind !== "design" || block.assets === undefined) return block;
    let blockChanged = false;
    const assets = block.assets.map((asset) => {
      const source = asset.source;
      if (source.kind === "generated-image") {
        const imageId = arrived.images.get(String(source.imageId));
        if (imageId === undefined) return asset;
        blockChanged = true;
        return { ...asset, source: { kind: source.kind, imageId: decodeImageArtifactId(imageId) } };
      }
      if (source.kind === "browser-capture") {
        const captureId = arrived.captures.get(String(source.captureId));
        if (captureId === undefined) return asset;
        blockChanged = true;
        return {
          ...asset,
          source: { kind: source.kind, captureId: decodeBrowserCaptureId(captureId) },
        };
      }
      return asset;
    });
    if (!blockChanged) return block;
    changed = true;
    return { ...block, assets };
  });
  return changed ? { ...version, definition: { ...version.definition, blocks } } : version;
}

/**
 * An id for something a part becomes on the destination, the same every time
 * the same move re-homes the same part, in the UUID shape every store expects.
 */
export function movedPartUuid(moveId: string, ...names: ReadonlyArray<string>): string {
  const hex = createHash("sha256")
    .update(["octant.thread-move.part", moveId, ...names].join("\u0000"))
    .digest("hex");
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
