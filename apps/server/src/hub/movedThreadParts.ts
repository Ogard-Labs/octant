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
  ProviderInstanceId,
  ProviderModelId,
  UtcTimestamp,
  type BrowserCapture,
  type ImageJob,
  type MovedThreadReference,
  type ThreadMovePartLeftBehind,
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
      images: Schema.Array(Schema.Struct({ partId: PartId }).annotations(strict)).pipe(
        Schema.minItems(1),
      ),
    }).annotations(strict),
  ),
  browserCaptures: Schema.Array(
    Schema.Struct({
      partId: PartId,
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
    readonly facts: Omit<MovedThreadParts["browserCaptures"][number], "partId">;
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
    const images: Array<{ readonly partId: string }> = [];
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
      images.push({ partId });
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
      const { partId, ...facts } = capture;
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
          source,
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
