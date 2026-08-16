import type { WorkArtifactFormat } from "@octant/contracts/work-artifacts";
import {
  WorkAdapterBudgetError,
  WorkAdapterUnsupportedInputError,
  type WorkFormatAdapter,
  registerWorkFormatAdapter,
} from "./workFormatAdapter";
import { MAX_WORK_OUTPUT_BYTES } from "./workBudget";

/**
 * PDF format adapter for Work generate-and-review artifacts. The agent
 * generates a valid minimal PDF 1.4 document from renderer-supplied text
 * content; the user reviews it beside the thread. PDF cannot be safely
 * round-tripped back to the original text, so `decode` returns `undefined`
 * and the renderer offers external-app handoff via the existing export
 * contract. Active content (PDF JavaScript, embedded fonts executing code)
 * is a non-goal; this encoder emits only static text with a standard
 * Helvetica font. External-app handoff is handled by the existing
 * `external-handoff` export contract.
 */

/**
 * Encode a string as Latin-1 (WinAnsi) single bytes. The PDF font declares
 * `/WinAnsiEncoding`, which maps code points 0x00-0xFF to single bytes. Using
 * `TextEncoder` (UTF-8) would emit multi-byte sequences for characters in the
 * 0x80-0xFF range (e.g., `é` U+00E9 becomes 0xC3 0xA9 in UTF-8 but must be 0xE9
 * in WinAnsi), producing mojibake. `escapePdfString` already restricts content
 * to the WinAnsi-safe range (0x20-0x7E, 0xA0-0xFF), so Latin-1 encoding is
 * correct for both the content stream and the ASCII PDF structure.
 */
function latin1Encode(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i += 1) {
    bytes[i] = value.charCodeAt(i) & 0xff;
  }
  return bytes;
}

/** Maximum text lines placed on a single PDF page before paginating. */
const LINES_PER_PAGE = 50;
/** Maximum total text lines before the encoder rejects the request as oversize. */
const MAX_PDF_LINES = 500_000;
/** Maximum page count before the encoder rejects the request as oversize. */
const MAX_PDF_PAGES = 10_000;
/** Line leading in points (vertical distance between text baselines). */
const LINE_LEADING = 14;
/** Left margin in points for body text. */
const LEFT_MARGIN = 50;
/** Top margin in points for the first text baseline (from page top). */
const TOP_MARGIN = 750;
/** Page width in points (US Letter). */
const PAGE_WIDTH = 612;
/** Page height in points (US Letter). */
const PAGE_HEIGHT = 792;

/**
 * Escape PDF string-literal special characters (`(`, `)`, `\`) so text content
 * is safe to embed inside a `(...)` string operand for the `Tj` operator.
 *
 * The font declares `WinAnsiEncoding`, which only covers code points 0-255
 * (Latin-1 range). Non-ASCII characters (e.g., CJK, accented Latin beyond
 * Latin-1) cannot be represented and would produce mojibake if emitted as raw
 * UTF-8 bytes. Reject characters outside the WinAnsi-safe range rather than
 * silently substituting document content.
 */
function escapePdfString(value: string): string {
  if (/[^\x20-\x7e\xa0-\xff]/.test(value)) {
    throw new WorkAdapterUnsupportedInputError(
      "PDF text contains characters that cannot be represented without loss.",
    );
  }
  return value.replace(/([\\()])/g, "\\$1");
}

/**
 * Encode a single PDF object body with its object number. Returns the raw
 * object bytes (without the `obj`/`endobj` wrapper) so the writer can track
 * byte offsets for the xref table.
 */
interface PdfObject {
  readonly number: number;
  readonly body: string;
}

/**
 * Build the content stream for a single page from its slice of text lines.
 * Uses the `BT`, `Tf`, `Td`, `TL`, `T*`, and `Tj` text operators with a
 * standard 12-point Helvetica font and 14-point leading.
 */
function buildContentStream(lines: readonly string[]): string {
  const escaped = lines.map(escapePdfString);
  const parts: string[] = [
    "BT",
    "/F1 12 Tf",
    `${LEFT_MARGIN} ${TOP_MARGIN} Td`,
    `${LINE_LEADING} TL`,
  ];
  if (escaped.length > 0) {
    parts.push(`(${escaped[0]}) Tj`);
    for (let i = 1; i < escaped.length; i += 1) {
      parts.push("T*");
      parts.push(`(${escaped[i]}) Tj`);
    }
  }
  parts.push("ET");
  return parts.join("\n");
}

/**
 * Generate a valid minimal PDF 1.4 document from text content. Each line of
 * the content becomes a text line on the page; a new page starts after
 * {@link LINES_PER_PAGE} lines. The document uses a standard Helvetica
 * Type 1 font with WinAnsiEncoding, a Catalog, a Pages tree, Page objects
 * with content streams, and an `xref` table with trailer. No external
 * library is used.
 */
function encodePdf(content: string): Uint8Array {
  // Count newlines before materializing the split array. A newline-heavy
  // request under the 16 MiB input limit can contain millions of `\n`
  // characters; content.split("\n") would allocate all of them as strings
  // before the MAX_PDF_LINES guard runs. Scan the raw count first and reject
  // early so the mutation service's try/catch surfaces this as `oversize`.
  let lineCount = content.length === 0 ? 0 : 1;
  for (let i = 0; i < content.length && lineCount <= MAX_PDF_LINES; i += 1) {
    if (content.charCodeAt(i) === 0x0a) lineCount += 1;
  }
  if (lineCount > MAX_PDF_LINES) {
    throw new WorkAdapterBudgetError(
      `pdf line count exceeds limit: ${lineCount} > ${MAX_PDF_LINES}`,
    );
  }
  const lines = content.length === 0 ? [] : content.split("\n");
  const pageCount = Math.max(1, Math.ceil(lines.length / LINES_PER_PAGE));

  // Preflight: a newline-heavy request can stay within the 16 MiB input limit
  // but create hundreds of thousands of page objects before
  // validateWorkOutputBudget runs. Reject early so the mutation service's
  // try/catch surfaces this as `oversize`.
  if (pageCount > MAX_PDF_PAGES) {
    throw new WorkAdapterBudgetError(
      `pdf page count exceeds limit: ${pageCount} > ${MAX_PDF_PAGES}`,
    );
  }

  const objects: PdfObject[] = [];

  // Object 1: Catalog
  objects.push({ number: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" });

  // Object 2: Pages tree
  const pageRefs = Array.from({ length: pageCount }, (_, i) => `${3 + i * 2} 0 R`);
  objects.push({
    number: 2,
    body: `<< /Type /Pages /Count ${pageCount} /Kids [${pageRefs.join(" ")}] >>`,
  });

  // Font object number is the last object (after all pages and content streams).
  const fontObjectNumber = 3 + pageCount * 2;

  // Page objects and content stream objects (interleaved: page, content, page, content, ...)
  let accumulatedStreamBytes = 0;
  for (let page = 0; page < pageCount; page += 1) {
    const pageObjectNumber = 3 + page * 2;
    const contentObjectNumber = 4 + page * 2;
    const startLine = page * LINES_PER_PAGE;
    const pageLines = lines.slice(startLine, startLine + LINES_PER_PAGE);
    const stream = buildContentStream(pageLines);
    const streamBytes = latin1Encode(stream);

    // Track accumulated content-stream size and reject if it exceeds the
    // output budget before we finish building all objects.
    accumulatedStreamBytes += streamBytes.byteLength;
    if (accumulatedStreamBytes > MAX_WORK_OUTPUT_BYTES) {
      throw new WorkAdapterBudgetError(
        `pdf content streams exceed output budget: ${accumulatedStreamBytes} > ${MAX_WORK_OUTPUT_BYTES}`,
      );
    }

    // Page object
    objects.push({
      number: pageObjectNumber,
      body: [
        "<< /Type /Page",
        `  /Parent 2 0 R`,
        `  /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}]`,
        `  /Resources << /Font << /F1 ${fontObjectNumber} 0 R >> >>`,
        `  /Contents ${contentObjectNumber} 0 R`,
        ">>",
      ].join("\n"),
    });

    // Content stream object
    objects.push({
      number: contentObjectNumber,
      body: [`<< /Length ${streamBytes.byteLength} >>`, "stream", stream, "endstream"].join("\n"),
    });
  }

  // Font object: Helvetica, Type 1, standard encoding
  objects.push({
    number: fontObjectNumber,
    body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  });

  // Assemble the PDF byte stream with correct xref offsets.
  const header = "%PDF-1.4\n";
  const chunks: Uint8Array[] = [latin1Encode(header)];
  const offsets = new Map<number, number>();
  let offset = header.length;

  for (const obj of objects) {
    offsets.set(obj.number, offset);
    const objText = `${obj.number} 0 obj\n${obj.body}\nendobj\n`;
    const objBytes = latin1Encode(objText);
    chunks.push(objBytes);
    offset += objBytes.byteLength;
  }

  // xref table
  const xrefStart = offset;
  const xrefLines: string[] = [`xref`, `0 ${objects.length + 1}`, `0000000000 65535 f `];
  for (let n = 1; n <= objects.length; n += 1) {
    const objOffset = offsets.get(n)!;
    xrefLines.push(`${objOffset.toString().padStart(10, "0")} 00000 n `);
  }
  const xrefText = xrefLines.join("\n") + "\n";
  const xrefBytes = latin1Encode(xrefText);
  chunks.push(xrefBytes);

  // trailer
  const trailer = [
    "trailer",
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    "startxref",
    `${xrefStart}`,
    "%%EOF",
  ].join("\n");
  chunks.push(latin1Encode(trailer + "\n"));

  // Concatenate all chunks into a single Uint8Array.
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const result = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) {
    result.set(chunk, pos);
    pos += chunk.byteLength;
  }
  return result;
}

/**
 * PDF format adapter. PDF can be generated (`canCreate`) and exported
 * same-format (`canExport`) but not round-trip edited (`canMutate` and
 * `canRoundTrip` are false). There are no derived export formats because
 * PDF→image rasterization is a non-goal.
 */
const pdfAdapter: WorkFormatAdapter = {
  format: "pdf" as WorkArtifactFormat,
  encode: encodePdf,
  decode: () => undefined,
  capabilities: {
    canRead: true,
    canCreate: true,
    // canMutate allows rename/delete and full-content revise (replace the PDF
    // entirely). canRoundTrip is false because PDF cannot be safely decoded
    // back to the original text for structural edits; same-format transform is
    // denied by the authority check's canRoundTrip gate.
    canMutate: true,
    canRoundTrip: false,
    canExport: true,
    canVersion: true,
  },
  exportFormats: [],
  convertTo: (targetFormat, sourceBytes) => (targetFormat === "pdf" ? sourceBytes : undefined),
};

registerWorkFormatAdapter(pdfAdapter);

export { pdfAdapter as workPdfAdapter };
