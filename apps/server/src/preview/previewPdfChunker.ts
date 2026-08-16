import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
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
import {
  computePreviewSourceVersionFromBytes,
  samePreviewSourceVersion,
} from "./previewSourceVersion";
import { MAX_PREVIEW_CHUNK_TEXT_BYTES, MAX_PREVIEW_PDF_PAGES } from "./previewFormatBudget";

const decodeSequence = Schema.decodeUnknownSync(PreviewChunkSequence);

export interface PdfChunkBudget {
  readonly maxPages: number;
  readonly maxPageTextBytes: number;
  readonly maxRenderBytes?: number;
}

export interface ProducePdfChunksInput {
  readonly filePath: string;
  readonly targetId: PreviewTargetId;
  readonly chunkId: PreviewChunkId;
  readonly sourceVersion: PreviewSourceVersion;
  readonly budget: PdfChunkBudget;
}

export interface ParsedPdf {
  /** Extracted text per page in page order. */
  readonly pages: readonly string[];
  /** True when the page or text ceiling truncated the parse. */
  readonly truncated: boolean;
}

interface PdfObject {
  readonly number: number;
  readonly dict: string;
  readonly stream: Uint8Array | undefined;
}

/**
 * Parse the cross-reference-free object table by scanning for
 * `N 0 obj ... endobj` markers. This avoids relying on the xref table,
 * which may be cross-reference-stream-encoded in modern PDFs. Each
 * object's dictionary text and optional stream bytes are captured. The
 * scan is bounded by the input byte length and stops after a generous
 * object count to avoid pathological loops on malformed input.
 */
function parsePdfObjects(bytes: Uint8Array): Map<number, PdfObject> {
  const objects = new Map<number, PdfObject>();
  // Operate on the raw byte buffer through a Latin-1 string view for
  // regex indexing; PDF structure is ASCII even when content streams are
  // binary, so object/dict markers are safe to find this way. Content
  // stream bytes are recovered as Latin-1 so binary bytes round-trip.
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  const re = /(\d+)\s+0\s+obj/g;
  let m: RegExpExecArray | null;
  let count = 0;
  while ((m = re.exec(view)) !== null && count < 200_000) {
    const number = Number.parseInt(m[1] ?? "0", 10);
    const start = m.index + m[0].length;
    const endIdx = view.indexOf("endobj", start);
    if (endIdx === -1) break;
    const body = view.slice(start, endIdx);
    let dict = body;
    let stream: Uint8Array | undefined;
    const streamIdx = body.indexOf("stream");
    if (streamIdx !== -1) {
      dict = body.slice(0, streamIdx);
      // The stream keyword is followed by either CR LF or LF before the
      // stream bytes begin (PDF spec: the keyword `stream` is followed by
      // CRLF or just LF, never CR alone).
      let dataStart = streamIdx + 6;
      if (body.charCodeAt(dataStart) === 0x0d) dataStart += 1;
      if (body.charCodeAt(dataStart) === 0x0a) dataStart += 1;
      const endStreamIdx = body.indexOf("endstream", dataStart);
      if (endStreamIdx !== -1) {
        // Trim the optional EOL before `endstream`.
        let dataEnd = endStreamIdx;
        if (body.charCodeAt(dataEnd - 1) === 0x0a) dataEnd -= 1;
        if (body.charCodeAt(dataEnd - 1) === 0x0d) dataEnd -= 1;
        stream = Buffer.from(body.slice(dataStart, dataEnd), "latin1");
      }
    }
    objects.set(number, { number, dict, stream });
    count += 1;
  }
  return objects;
}

/**
 * Resolve the ordered list of page object numbers from the PDF. Walks the
 * `/Pages` tree by following `Kids` arrays and `Count` entries, or falls
 * back to scanning for `/Type /Page` objects in ascending object-number
 * order when the tree is missing or unresolvable.
 */
function resolvePageOrder(objects: Map<number, PdfObject>): number[] {
  // Find the Catalog via the trailer `/Root N 0 R`.
  const ordered: number[] = [];
  const visited = new Set<number>();
  let rootNumber: number | undefined;
  for (const [number, obj] of objects) {
    if (/\/Type\s*\/Catalog/.test(obj.dict)) {
      rootNumber = number;
      break;
    }
  }
  if (rootNumber === undefined) {
    // Fallback: collect /Type /Page objects in ascending order.
    for (const [number, obj] of objects) {
      if (/\/Type\s*\/Page\b/.test(obj.dict) && !/\/Type\s*\/Pages/.test(obj.dict)) {
        ordered.push(number);
      }
    }
    ordered.sort((a, b) => a - b);
    return ordered;
  }
  const catalog = objects.get(rootNumber);
  const pagesRef = catalog && /\/Pages\s+(\d+)\s+0\s+R/.exec(catalog.dict);
  if (pagesRef === null || pagesRef === undefined) return ordered;
  const pagesRoot = Number.parseInt(pagesRef[1] ?? "0", 10);
  collectPages(objects, pagesRoot, visited, ordered);
  return ordered;
}

function collectPages(
  objects: Map<number, PdfObject>,
  nodeNumber: number,
  visited: Set<number>,
  out: number[],
): void {
  if (visited.has(nodeNumber)) return;
  visited.add(nodeNumber);
  const node = objects.get(nodeNumber);
  if (node === undefined) return;
  if (/\/Type\s*\/Pages/.test(node.dict)) {
    const kidsMatch = /\/Kids\s*\[([^\]]*)\]/.exec(node.dict);
    if (kidsMatch !== null) {
      const kidRegex = /(\d+)\s+0\s+R/g;
      let km: RegExpExecArray | null;
      while ((km = kidRegex.exec(kidsMatch[1] ?? "")) !== null) {
        collectPages(objects, Number.parseInt(km[1] ?? "0", 10), visited, out);
      }
    }
    return;
  }
  // Leaf page.
  out.push(nodeNumber);
}

/**
 * Decode a content stream bytes, decompressing FlateDecode streams with
 * zlib. Uncompressed streams and unrecognized filters return the raw
 * bytes; a failed inflate returns `undefined` so the caller skips the
 * page rather than emitting garbage.
 */
function decodeContentStream(obj: PdfObject): Uint8Array | undefined {
  if (obj.stream === undefined) return undefined;
  if (/\/FlateDecode/.test(obj.dict)) {
    try {
      return inflateSync(obj.stream, { maxOutputLength: 16 * 1024 * 1024 });
    } catch {
      return undefined;
    }
  }
  return obj.stream;
}

/**
 * Extract text from a PDF content stream. Handles `(...)` Tj string
 * operators, `[...] TJ` array operators, and inserts line breaks on `T*`
 * and `Td`/`TD` positioning operators. PDF string escapes (`\(`, `\)`,
 * `\\`, octal `\nnn`) and nested balanced parens are honored. The
 * extracted text is bounded at `maxPageTextBytes`.
 */
function extractPageText(stream: Uint8Array, maxPageTextBytes: number): string {
  const view = Buffer.from(stream.buffer, stream.byteOffset, stream.byteLength).toString("latin1");
  let out = "";
  let i = 0;
  const pushText = (text: string) => {
    if (Buffer.byteLength(out, "utf-8") >= maxPageTextBytes) return;
    out += text;
  };
  while (i < view.length) {
    const ch = view[i];
    if (ch === undefined) break;
    // Line-break operators.
    if (view.startsWith("T*", i)) {
      pushText("\n");
      i += 2;
      continue;
    }
    if (view.startsWith("Td", i) || view.startsWith("TD", i)) {
      pushText("\n");
      i += 2;
      continue;
    }
    // String operand for Tj or within TJ array.
    if (ch === "(") {
      const { text, end } = readPdfString(view, i);
      pushText(text);
      i = end;
      continue;
    }
    // TJ array: [ (s1) -100 (s2) ... ] — extract strings, join with space
    // when a number separates them.
    if (ch === "[") {
      let j = i + 1;
      let arrayText = "";
      let sawNumber = false;
      while (j < view.length && view[j] !== "]") {
        const cj = view[j];
        if (cj === "(") {
          const { text, end } = readPdfString(view, j);
          if (sawNumber) arrayText += " ";
          arrayText += text;
          sawNumber = false;
          j = end;
          continue;
        }
        if (cj === " " || cj === "\n" || cj === "\r" || cj === "\t") {
          j += 1;
          continue;
        }
        // A number operand introduces a kerning gap; mark it so the next
        // string is joined with a space.
        sawNumber = true;
        j += 1;
      }
      pushText(arrayText);
      i = view[j] === "]" ? j + 1 : j;
      continue;
    }
    i += 1;
  }
  // Trim leading line breaks produced by the initial positioning operators
  // (the first `Td` sets the baseline and should not introduce a blank line).
  return sliceUtf8AtByteBudget(out.replace(/^[\n\r]+/, ""), maxPageTextBytes);
}

/**
 * Read a PDF literal string starting at `(` index `start`, honoring
 * backslash escapes and nested balanced parentheses. Returns the decoded
 * text and the index just past the closing `)`.
 */
function readPdfString(view: string, start: number): { text: string; end: number } {
  let i = start + 1;
  let depth = 1;
  let out = "";
  while (i < view.length && depth > 0) {
    const ch = view[i];
    if (ch === undefined) break;
    if (ch === "\\") {
      const next = view[i + 1] ?? "";
      if (next === "n") {
        out += "\n";
        i += 2;
        continue;
      }
      if (next === "r") {
        out += "\r";
        i += 2;
        continue;
      }
      if (next === "t") {
        out += "\t";
        i += 2;
        continue;
      }
      if (next === "b") {
        out += "\b";
        i += 2;
        continue;
      }
      if (next === "f") {
        out += "\f";
        i += 2;
        continue;
      }
      if (next === "(" || next === ")" || next === "\\") {
        out += next;
        i += 2;
        continue;
      }
      if (next >= "0" && next <= "7") {
        // Octal escape up to 3 digits.
        let octal = "";
        let k = i + 1;
        while (k < view.length && octal.length < 3) {
          const digit = view[k] ?? "";
          if (digit >= "0" && digit <= "7") {
            octal += digit;
            k += 1;
          } else {
            break;
          }
        }
        out += String.fromCharCode(Number.parseInt(octal, 8) & 0xff);
        i = k;
        continue;
      }
      // Backslash followed by EOL or unrecognized: drop the backslash.
      i += 1;
      continue;
    }
    if (ch === "(") {
      depth += 1;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        i += 1;
        break;
      }
      out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return { text: out, end: i };
}

/**
 * Parse a PDF byte buffer into per-page extracted text. Only text from
 * content-stream `Tj`/`TJ` operators is extracted; rendered page images,
 * forms with side effects, embedded files, JavaScript, and external
 * resources are never executed or fetched. A malformed or non-PDF input
 * returns `undefined`.
 */
export function parsePdf(
  bytes: Uint8Array,
  budget: Pick<PdfChunkBudget, "maxPages" | "maxPageTextBytes">,
): ParsedPdf | undefined {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  if (!view.startsWith("%PDF-")) return undefined;
  const objects = parsePdfObjects(bytes);
  const pageOrder = resolvePageOrder(objects);
  if (pageOrder.length === 0) return undefined;
  const pages: string[] = [];
  let truncated = false;
  for (const pageNumber of pageOrder) {
    if (pages.length >= budget.maxPages) {
      truncated = true;
      break;
    }
    const page = objects.get(pageNumber);
    if (page === undefined) {
      pages.push("");
      continue;
    }
    const contentsRef = /\/Contents\s+(\d+)\s+0\s+R/.exec(page.dict);
    const contentsArray = /\/Contents\s*\[([^\]]*)\]/.exec(page.dict);
    let text = "";
    if (contentsRef !== null) {
      const obj = objects.get(Number.parseInt(contentsRef[1] ?? "0", 10));
      if (obj !== undefined) {
        const stream = decodeContentStream(obj);
        if (stream !== undefined) text = extractPageText(stream, budget.maxPageTextBytes);
      }
    } else if (contentsArray !== null) {
      const refRegex = /(\d+)\s+0\s+R/g;
      let rm: RegExpExecArray | null;
      while ((rm = refRegex.exec(contentsArray[1] ?? "")) !== null) {
        const obj = objects.get(Number.parseInt(rm[1] ?? "0", 10));
        if (obj === undefined) continue;
        const stream = decodeContentStream(obj);
        if (stream !== undefined) text += extractPageText(stream, budget.maxPageTextBytes);
      }
    }
    pages.push(text);
  }
  return { pages, truncated };
}

/**
 * Compute manifest bounds for a PDF source: the page count (capped at the
 * budget ceiling). Returns empty bounds when the input is not a PDF.
 */
export function computePdfBounds(bytes: Uint8Array): PreviewContentBounds {
  const parsed = parsePdf(bytes, {
    maxPages: MAX_PREVIEW_PDF_PAGES,
    maxPageTextBytes: MAX_PREVIEW_CHUNK_TEXT_BYTES,
  });
  if (parsed === undefined) return {};
  return { pages: parsed.pages.length };
}

/**
 * Produce bounded PDF preview chunks. Each page becomes one chunk
 * carrying its 1-based page number and extracted text. Active PDF
 * content (JavaScript, forms with side effects, embedded files, external
 * resources) is never executed; only static text from content-stream
 * operators is extracted. The generator recomputes the source version
 * from the bytes it reads and aborts when the file changed since the
 * caller recorded the version. A missing or non-PDF file yields no
 * chunks.
 */
export function* producePdfChunks(input: ProducePdfChunksInput): Generator<PreviewChunk> {
  let bytes: Buffer;
  try {
    bytes = readFileSync(input.filePath);
  } catch {
    return;
  }

  const current = computePreviewSourceVersionFromBytes(bytes);
  if (!samePreviewSourceVersion(current, input.sourceVersion)) return;

  const parsed = parsePdf(bytes, {
    maxPages: input.budget.maxPages,
    maxPageTextBytes: input.budget.maxPageTextBytes,
  });
  if (parsed === undefined) return;

  const renderCap = input.budget.maxRenderBytes;
  let renderedBytes = 0;
  let sequence = 0;
  for (let pageIndex = 0; pageIndex < parsed.pages.length; pageIndex += 1) {
    const pageText = parsed.pages[pageIndex];
    if (pageText === undefined) continue;
    const pageNumber = pageIndex + 1;
    const pageBytes = Buffer.byteLength(pageText, "utf-8");
    if (renderCap !== undefined && renderedBytes + pageBytes > renderCap) {
      const chunk = decodePreviewChunk({
        chunkId: input.chunkId,
        targetId: input.targetId,
        sourceVersion: input.sourceVersion,
        kind: "pdf",
        sequence: decodeSequence(sequence),
        descriptor: { kind: "pdf", page: pageNumber },
        payload: { kind: "pdf", pageText: "" },
        isFinal: true,
      });
      yield chunk;
      return;
    }
    renderedBytes += pageBytes;
    const isFinal = pageIndex === parsed.pages.length - 1 && !parsed.truncated;
    const chunk = decodePreviewChunk({
      chunkId: input.chunkId,
      targetId: input.targetId,
      sourceVersion: input.sourceVersion,
      kind: "pdf",
      sequence: decodeSequence(sequence),
      descriptor: { kind: "pdf", page: pageNumber },
      payload: { kind: "pdf", pageText },
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

export const DEFAULT_PDF_BUDGET: PdfChunkBudget = {
  maxPages: MAX_PREVIEW_PDF_PAGES,
  maxPageTextBytes: MAX_PREVIEW_CHUNK_TEXT_BYTES,
};
