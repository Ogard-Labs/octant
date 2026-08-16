import { readFileSync } from "node:fs";
import { Schema } from "effect";
import {
  PreviewChunkSequence,
  decodePreviewChunk,
  type PreviewChunk,
  type PreviewChunkId,
  type PreviewContentBounds,
  type PreviewSourceVersion,
  type PreviewTargetId,
} from "@octant/contracts/previews";
import { readWorkZip } from "../work/workZipPort";
import {
  computePreviewSourceVersionFromBytes,
  samePreviewSourceVersion,
} from "./previewSourceVersion";
import { MAX_PREVIEW_CHUNK_TEXT_BYTES, MAX_PREVIEW_DOCUMENT_BLOCKS } from "./previewFormatBudget";

const decodeSequence = Schema.decodeUnknownSync(PreviewChunkSequence);
const textDecoder = new TextDecoder("utf-8", { fatal: false });

export interface DocumentChunkBudget {
  readonly maxBlocks: number;
  readonly maxBlockTextBytes: number;
  readonly maxRenderBytes?: number;
}

export interface ProduceDocumentChunksInput {
  readonly filePath: string;
  readonly targetId: PreviewTargetId;
  readonly chunkId: PreviewChunkId;
  readonly sourceVersion: PreviewSourceVersion;
  readonly budget: DocumentChunkBudget;
}

export interface ParsedDocument {
  /** Paragraph-level text blocks in document order. */
  readonly blocks: readonly string[];
  /** True when the block or render-text ceiling truncated the parse. */
  readonly truncated: boolean;
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Parse a DOCX byte container into paragraph-level text blocks. Each
 * `<w:p>` paragraph becomes one block; nested `<w:t>` text runs are
 * concatenated in document order. Tables, headers/footers, comments, and
 * tracked-change markup are not structurally decoded — their text runs
 * inside `word/document.xml` are still extracted, but layout, fonts, and
 * fields are not preserved. A malformed container returns `undefined`.
 */
export function parseDocument(
  bytes: Uint8Array,
  budget: Pick<DocumentChunkBudget, "maxBlocks" | "maxBlockTextBytes">,
): ParsedDocument | undefined {
  let entries: Map<string, Uint8Array>;
  try {
    entries = readWorkZip(bytes);
  } catch {
    return undefined;
  }
  const document = entries.get("word/document.xml");
  if (document === undefined) return undefined;
  const xml = textDecoder.decode(document);
  const bodyMatch = /<w:body[^>]*>([\s\S]*?)<\/w:body>/.exec(xml);
  const bodyContent = bodyMatch !== null ? (bodyMatch[1] ?? "") : xml;
  const blocks: string[] = [];
  let truncated = false;
  // Split on paragraph open tags; the first element is the prologue before
  // the first paragraph and is discarded.
  const paragraphs = bodyContent.split(/<w:p[\s>]/);
  for (const paragraph of paragraphs) {
    if (paragraph === undefined || paragraph.length === 0) continue;
    const runRegex = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
    let match = runRegex.exec(paragraph);
    const parts: string[] = [];
    while (match !== null) {
      parts.push(unescapeXml(match[1] ?? ""));
      match = runRegex.exec(paragraph);
    }
    const text = parts.join("");
    if (Buffer.byteLength(text, "utf-8") > budget.maxBlockTextBytes) {
      blocks.push(sliceUtf8AtByteBudget(text, budget.maxBlockTextBytes));
      truncated = true;
    } else {
      blocks.push(text);
    }
    if (blocks.length >= budget.maxBlocks) {
      truncated = true;
      break;
    }
  }
  return { blocks, truncated };
}

/**
 * Compute manifest bounds for a DOCX source: the paragraph block count
 * (capped at the budget ceiling). Returns empty bounds when the container
 * is malformed.
 */
export function computeDocumentBounds(bytes: Uint8Array): PreviewContentBounds {
  const parsed = parseDocument(bytes, {
    maxBlocks: MAX_PREVIEW_DOCUMENT_BLOCKS,
    maxBlockTextBytes: MAX_PREVIEW_CHUNK_TEXT_BYTES,
  });
  if (parsed === undefined) return {};
  return { blocks: parsed.blocks.length };
}

/**
 * Produce bounded document (DOCX) preview chunks. Each paragraph block
 * becomes one chunk carrying its 0-based `blockIndex` so the viewer can
 * render a structural document view and attach block-range selections.
 * The generator recomputes the source version from the bytes it reads and
 * aborts when the file changed since the caller recorded the version. A
 * missing or malformed file yields no chunks.
 */
export function* produceDocumentChunks(input: ProduceDocumentChunksInput): Generator<PreviewChunk> {
  let bytes: Buffer;
  try {
    bytes = readFileSync(input.filePath);
  } catch {
    return;
  }

  const current = computePreviewSourceVersionFromBytes(bytes);
  if (!samePreviewSourceVersion(current, input.sourceVersion)) return;

  const parsed = parseDocument(bytes, {
    maxBlocks: input.budget.maxBlocks,
    maxBlockTextBytes: input.budget.maxBlockTextBytes,
  });
  if (parsed === undefined) return;

  const renderCap = input.budget.maxRenderBytes;
  let renderedBytes = 0;
  let sequence = 0;
  for (let blockIndex = 0; blockIndex < parsed.blocks.length; blockIndex += 1) {
    const text = parsed.blocks[blockIndex];
    if (text === undefined) continue;
    const blockBytes = Buffer.byteLength(text, "utf-8");
    if (renderCap !== undefined && renderedBytes + blockBytes > renderCap) {
      // Emit a final marker for the truncation point; the manifest's
      // limited fidelity signals the stream is truncated.
      const chunk = decodePreviewChunk({
        chunkId: input.chunkId,
        targetId: input.targetId,
        sourceVersion: input.sourceVersion,
        kind: "document",
        sequence: decodeSequence(sequence),
        descriptor: { kind: "document", blockIndex },
        payload: { kind: "document", text: "" },
        isFinal: true,
      });
      yield chunk;
      return;
    }
    renderedBytes += blockBytes;
    const isFinal = blockIndex === parsed.blocks.length - 1 && !parsed.truncated;
    const chunk = decodePreviewChunk({
      chunkId: input.chunkId,
      targetId: input.targetId,
      sourceVersion: input.sourceVersion,
      kind: "document",
      sequence: decodeSequence(sequence),
      descriptor: { kind: "document", blockIndex },
      payload: { kind: "document", text },
      isFinal,
    });
    yield chunk;
    sequence += 1;
  }
}

function sliceUtf8AtByteBudget(text: string, budget: number): string {
  let total = 0;
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === undefined) break;
    const charBytes = Buffer.byteLength(char, "utf-8");
    if (total + charBytes > budget) break;
    total += charBytes;
    i += 1;
  }
  return text.slice(0, i);
}

export const DEFAULT_DOCUMENT_BUDGET: DocumentChunkBudget = {
  maxBlocks: MAX_PREVIEW_DOCUMENT_BLOCKS,
  maxBlockTextBytes: MAX_PREVIEW_CHUNK_TEXT_BYTES,
};
