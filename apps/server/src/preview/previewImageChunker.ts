import { readFileSync } from "node:fs";
import { Schema } from "effect";
import {
  PreviewChunkSequence,
  decodePreviewChunk,
  type PreviewChunk,
  type PreviewChunkId,
  type PreviewSourceVersion,
  type PreviewTargetId,
} from "@octant/contracts/previews";
import {
  computePreviewSourceVersionFromBytes,
  samePreviewSourceVersion,
} from "./previewSourceVersion";

const decodeSequence = Schema.decodeUnknownSync(PreviewChunkSequence);

export interface ProduceImageChunkInput {
  readonly filePath: string;
  readonly targetId: PreviewTargetId;
  readonly chunkId: PreviewChunkId;
  readonly sourceVersion: PreviewSourceVersion;
  readonly mediaType: string;
}

export type ProduceImageChunkResult =
  | { readonly ok: true; readonly chunk: PreviewChunk }
  | { readonly ok: false; readonly code: "unavailable" }
  | { readonly ok: false; readonly code: "stale" };

/**
 * Produce a single image preview chunk carrying a safe `data:image/...;base64`
 * URL. The renderer never receives a host path or a network-loadable URL; the
 * data URL is the only renderer-facing representation and is constrained by
 * the contract to the `data:image/...;base64,...` shape. The chunker
 * recomputes the source version from the bytes it reads and aborts when the
 * file changed since the caller recorded the version, so an image chunk is
 * never stamped with a stale content hash.
 */
export function produceImageChunk(input: ProduceImageChunkInput): ProduceImageChunkResult {
  let bytes: Buffer;
  try {
    bytes = readFileSync(input.filePath);
  } catch {
    return { ok: false, code: "unavailable" };
  }
  return produceImageChunkFromBytes({ ...input, bytes });
}

/**
 * Variant of `produceImageChunk` for callers that already hold the file bytes.
 * The stale guard recomputes the version from the supplied bytes and aborts
 * when they do not match the caller's recorded version.
 */
export function produceImageChunkFromBytes(
  input: Omit<ProduceImageChunkInput, "filePath"> & { readonly bytes: Uint8Array },
): ProduceImageChunkResult {
  const bytes = input.bytes;
  const current = computePreviewSourceVersionFromBytes(bytes);
  if (!samePreviewSourceVersion(current, input.sourceVersion)) {
    return { ok: false, code: "stale" };
  }
  const safeMediaType = normalizeImageMediaType(input.mediaType);
  const dataUrl = `data:${safeMediaType};base64,${Buffer.from(bytes).toString("base64")}`;
  const chunk = decodePreviewChunk({
    chunkId: input.chunkId,
    targetId: input.targetId,
    sourceVersion: input.sourceVersion,
    kind: "image",
    sequence: decodeSequence(0),
    descriptor: { kind: "image" },
    payload: { kind: "image", mediaType: safeMediaType, dataUrl },
    isFinal: true,
  });
  return { ok: true, chunk };
}

/**
 * Normalize a sniffed media type to an image media type accepted by the
 * contract's `data:image/...;base64,...` pattern. Non-image media types fall
 * back to `image/png` so a malformed sniff result can never produce a
 * renderer-facing network or local-resource load.
 */
function normalizeImageMediaType(mediaType: string): string {
  if (mediaType.startsWith("image/")) return mediaType;
  return "image/png";
}
