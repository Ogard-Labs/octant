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

export interface TextChunkBudget {
  readonly maxLinesPerChunk: number;
  readonly maxBytesPerChunk: number;
  /** Optional total render byte cap; when exceeded the stream truncates. */
  readonly maxRenderBytes?: number;
}

export interface ProduceTextChunksInput {
  readonly filePath: string;
  readonly targetId: PreviewTargetId;
  readonly chunkId: PreviewChunkId;
  readonly sourceVersion: PreviewSourceVersion;
  readonly kind: "text" | "markdown";
  readonly budget: TextChunkBudget;
}

const decodeSequence = Schema.decodeUnknownSync(PreviewChunkSequence);

/**
 * Produce bounded text or markdown preview chunks for a file. Lines are
 * paginated into chunks of at most `maxLinesPerChunk` lines and
 * `maxBytesPerChunk` bytes; a single line longer than the byte budget is
 * split across chunks so no chunk exceeds the bound. The final chunk
 * carries `isFinal: true`. When `maxRenderBytes` is set, the stream stops
 * at the cap — the manifest's `limited` fidelity tells the viewer the
 * stream is truncated, so the chunker does not need a separate flag.
 *
 * The generator recomputes the source version from the bytes it actually
 * reads and aborts (yielding nothing) when the file changed since the
 * caller recorded the version, so chunks are never stamped with a stale
 * content hash. A missing file also yields no chunks.
 */
export function* produceTextChunks(input: ProduceTextChunksInput): Generator<PreviewChunk> {
  let content: string;
  let bytes: Buffer;
  try {
    bytes = readFileSync(input.filePath);
    content = bytes.toString("utf-8");
  } catch {
    return;
  }

  yield* produceTextChunksFromBytes({ ...input, bytes, content });
}

/**
 * Variant of `produceTextChunks` for callers that already hold the file bytes
 * (e.g. the preview service, which reads once to sniff and check the source
 * version before chunking). The bytes and decoded UTF-8 content are supplied
 * by the caller so the generator never re-reads the file, avoiding a
 * read-read TOCTOU window. The stale-mid-stream guard still recomputes the
 * version from the supplied bytes and aborts when they do not match the
 * caller's recorded version.
 */
export function* produceTextChunksFromBytes(
  input: Omit<ProduceTextChunksInput, "filePath"> & {
    readonly bytes: Uint8Array;
    readonly content: string;
  },
): Generator<PreviewChunk> {
  const bytes = input.bytes;
  const content = input.content;

  // Stale-mid-stream guard: recompute the version from the bytes just read
  // and abort when they do not match the caller's recorded version.
  const current = computePreviewSourceVersionFromBytes(bytes);
  if (!samePreviewSourceVersion(current, input.sourceVersion)) return;

  const lines = content.split("\n");
  // A trailing newline produces a canonical empty final element; drop it
  // so it does not become a spurious extra line.
  if (lines.length > 0 && lines.at(-1) === "") lines.pop();

  const renderCap = input.budget.maxRenderBytes;
  let renderedBytes = 0;
  let sequence = 0;
  let lineIndex = 0;
  let hitCap = false;

  while (lineIndex < lines.length) {
    // Stop when the total render cap is reached; the manifest's limited
    // fidelity signals truncation to the viewer.
    if (renderCap !== undefined && renderedBytes >= renderCap) {
      hitCap = true;
      break;
    }

    const window: string[] = [];
    let bytesInChunk = 0;
    const startLine = lineIndex + 1;
    let splitWithoutAdvance = false;
    while (
      lineIndex < lines.length &&
      window.length < input.budget.maxLinesPerChunk &&
      bytesInChunk <= input.budget.maxBytesPerChunk
    ) {
      let line = lines[lineIndex];
      if (line === undefined) break;
      let lineBytes = Buffer.byteLength(line, "utf-8") + 1; // +1 for newline

      // Long-line splitting: if a single line exceeds the byte budget,
      // slice it at a UTF-8 character boundary so every chunk respects the
      // bound. The remainder stays at the same line index for the next
      // chunk, so we break out of the inner loop without advancing.
      if (lineBytes > input.budget.maxBytesPerChunk && window.length === 0) {
        const cut = sliceUtf8AtByteBudget(line, input.budget.maxBytesPerChunk - 1);
        const remainder = line.slice(cut.length);
        lines[lineIndex] = remainder;
        line = cut;
        lineBytes = Buffer.byteLength(line, "utf-8") + 1;
        window.push(line);
        bytesInChunk += lineBytes;
        renderedBytes += lineBytes;
        // Do not advance lineIndex — the remainder is still at this index.
        splitWithoutAdvance = true;
        break;
      }

      if (window.length > 0 && bytesInChunk + lineBytes > input.budget.maxBytesPerChunk) break;

      // Render cap check before committing the line.
      if (renderCap !== undefined && renderedBytes + lineBytes > renderCap) {
        hitCap = true;
        break;
      }

      window.push(line);
      bytesInChunk += lineBytes;
      renderedBytes += lineBytes;
      lineIndex++;
    }

    if (window.length === 0) {
      // Could not fit even a sliced fragment (e.g. the render cap was
      // reached before adding any line to this window). Emit a final
      // empty marker so the viewer can settle; the manifest's limited
      // fidelity signals truncation.
      if (sequence > 0) {
        const marker = decodePreviewChunk({
          chunkId: input.chunkId,
          targetId: input.targetId,
          sourceVersion: input.sourceVersion,
          kind: input.kind,
          sequence: decodeSequence(sequence),
          descriptor: { kind: input.kind, startLine: lineIndex + 1, endLine: lineIndex + 1 },
          payload: { kind: input.kind, text: "", encoding: "utf-8" },
          isFinal: true,
        });
        yield marker;
      }
      hitCap = true;
      break;
    }

    if (hitCap) {
      // Emit the partial window accumulated before the cap was hit.
    }

    const endLine = splitWithoutAdvance ? startLine : lineIndex;
    const text =
      window.join("\n") + (lineIndex < lines.length || content.endsWith("\n") ? "\n" : "");
    // The final chunk we emit is `isFinal: true` whether we consumed the
    // whole file or stopped at the render cap. The manifest's `limited`
    // fidelity is what tells the viewer the stream is truncated.
    const isFinal = hitCap || lineIndex >= lines.length;
    const chunk = decodePreviewChunk({
      chunkId: input.chunkId,
      targetId: input.targetId,
      sourceVersion: input.sourceVersion,
      kind: input.kind,
      sequence: decodeSequence(sequence),
      descriptor: { kind: input.kind, startLine, endLine },
      payload: { kind: input.kind, text, encoding: "utf-8" },
      isFinal,
    });
    yield chunk;
    sequence++;
    if (hitCap) break;
  }

  // Empty file: a single final empty chunk so the viewer can settle.
  if (lines.length === 0) {
    const chunk = decodePreviewChunk({
      chunkId: input.chunkId,
      targetId: input.targetId,
      sourceVersion: input.sourceVersion,
      kind: input.kind,
      sequence: decodeSequence(0),
      descriptor: { kind: input.kind, startLine: 1, endLine: 1 },
      payload: { kind: input.kind, text: "", encoding: "utf-8" },
      isFinal: true,
    });
    yield chunk;
  }
}

/**
 * Slice a string at the largest UTF-8-safe prefix whose byte length is
 * <= `budget`. Avoids splitting a multi-byte character in half.
 */
function sliceUtf8AtByteBudget(text: string, budget: number): string {
  let total = 0;
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === undefined) break;
    const charBytes = Buffer.byteLength(char, "utf-8");
    if (total + charBytes > budget) break;
    total += charBytes;
    i++;
  }
  return text.slice(0, i);
}
