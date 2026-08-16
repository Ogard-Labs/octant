import type { PreviewKind } from "@octant/contracts/previews";
import { readWorkZip } from "../work/workZipPort";

export interface PreviewSniffBudget {
  readonly maxSniffBytes: number;
  readonly maxByteSize: number;
}

export type PreviewSniffResult =
  | { readonly ok: true; readonly kind: PreviewKind; readonly mediaType: string }
  | { readonly ok: false; readonly code: "too-large" };

/**
 * Sniff the normalized preview kind from file content (magic numbers and
 * structural text markers) rather than trusting the extension or the
 * client-provided media type. The server always inspects content under a
 * bounded read; the caller passes the leading bytes (up to
 * `maxSniffBytes`) and the declared media type as a hint only.
 *
 * Office OOXML containers (xlsx/docx/pptx) are recognized by inspecting
 * the `[Content_Types].xml` part inside the ZIP rather than trusting the
 * extension, so a renamed or forged container is classified by its actual
 * declared parts. Legacy OLE2 Office containers remain `unsupported`
 * because their parsers are not part of this slice; the host surfaces an
 * `unsupported` outcome so the renderer can offer metadata and external
 * handoff.
 */
export function sniffPreviewKind(
  bytes: Uint8Array,
  fileName: string,
  declaredMediaType: string,
  budget: PreviewSniffBudget,
): PreviewSniffResult {
  if (bytes.byteLength > budget.maxByteSize) {
    return { ok: false, code: "too-large" };
  }

  // PDF
  if (startsWith(bytes, "%PDF-")) {
    return { ok: true, kind: "pdf", mediaType: "application/pdf" };
  }

  // Images
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { ok: true, kind: "image", mediaType: "image/png" };
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { ok: true, kind: "image", mediaType: "image/jpeg" };
  }
  if (startsWith(bytes, "GIF87a") || startsWith(bytes, "GIF89a")) {
    return { ok: true, kind: "image", mediaType: "image/gif" };
  }
  if (startsWith(bytes, "RIFF") && bytes.length >= 12 && startsWith(bytes, "WEBP", 8)) {
    return { ok: true, kind: "image", mediaType: "image/webp" };
  }

  // Office OOXML containers: a ZIP whose `[Content_Types].xml` declares
  // the spreadsheet, wordprocessing, or presentation main part. The
  // content-type inspection runs under the ZIP port's bounded entry/total
  // budgets; a malformed or non-OOXML ZIP falls back to `unsupported` so
  // the renderer offers metadata and external handoff instead of a
  // misleading format viewer.
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    const ooxml = classifyOoxml(bytes);
    if (ooxml !== null) {
      return { ok: true, kind: ooxml.kind, mediaType: ooxml.mediaType };
    }
    return { ok: true, kind: "unsupported", mediaType: declaredMediaType };
  }
  // Legacy OLE2 Office containers (old .doc/.xls/.ppt) have no native
  // parser in this slice; surface as unsupported with the declared media
  // type preserved for the external-handoff affordance.
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return { ok: true, kind: "unsupported", mediaType: declaredMediaType };
  }

  // Text-structural sniffing: only attempt when the leading bytes are
  // valid UTF-8 with no NUL bytes (a cheap binary/text discriminator).
  // Use a fatal UTF-8 decode so invalid byte sequences surface as
  // unsupported instead of silently becoming replacement characters.
  if (!hasNul(bytes)) {
    const sniffBytes = bytes.slice(0, budget.maxSniffBytes);
    let text: string;
    try {
      text = Buffer.from(sniffBytes).toString("utf-8");
      if (!isValidUtf8(sniffBytes)) throw new Error("invalid utf-8");
    } catch {
      return { ok: true, kind: "unsupported", mediaType: declaredMediaType };
    }
    const lowerName = fileName.toLowerCase();
    const mediaType = declaredMediaType || "text/plain";
    const isMarkdownByName =
      lowerName.endsWith(".md") || lowerName.endsWith(".markdown") || mediaType === "text/markdown";

    // Markdown: an agreeing extension or declared media type is sufficient
    // once the bytes are safe text — do not require heading/list markers,
    // which would misclassify valid Markdown prose as plain text.
    if (isMarkdownByName) {
      return { ok: true, kind: "markdown", mediaType: "text/markdown" };
    }

    // Table: delimiter-aware CSV/TSV detection that respects quoted
    // fields and tab separators, so valid table sources resolve to the
    // table renderer instead of falling through to plain text.
    const table = looksLikeTable(text, lowerName, mediaType);
    if (table) {
      return { ok: true, kind: "table", mediaType: table };
    }

    // Default text branch for utf-8 content.
    return {
      ok: true,
      kind: "text",
      mediaType: mediaType === "text/plain" ? mediaType : "text/plain",
    };
  }

  return { ok: true, kind: "unsupported", mediaType: declaredMediaType };
}

function startsWith(bytes: Uint8Array, prefix: string | readonly number[], offset = 0): boolean {
  if (typeof prefix === "string") {
    for (let i = 0; i < prefix.length; i++) {
      if (bytes[offset + i] !== prefix.charCodeAt(i)) return false;
    }
    return true;
  }
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[offset + i] !== prefix[i]) return false;
  }
  return true;
}

function hasNul(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 4096);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

/**
 * Validate that the bytes are legal UTF-8 by re-encoding the decoded text
 * and comparing lengths. `Buffer.toString("utf-8")` silently substitutes
 * replacement characters for invalid sequences, so a round-trip check is
 * the cheapest fatal decoder available without native TextDecoder support.
 */
function isValidUtf8(bytes: Uint8Array): boolean {
  const text = Buffer.from(bytes).toString("utf-8");
  return Buffer.byteLength(text, "utf-8") === bytes.byteLength;
}

/**
 * Delimiter-aware table sniffing. Returns the resolved media type when the
 * leading lines form a consistent CSV or TSV grid (respecting quoted
 * fields), or `null` when the content is not tabular. The delimiter is
 * chosen from the extension/declared media type when it agrees with the
 * content, otherwise inferred from the first line.
 */
function looksLikeTable(text: string, lowerName: string, declaredMediaType: string): string | null {
  const lines = text
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .slice(0, 5);
  if (lines.length < 2) return null;

  const tsvByName =
    lowerName.endsWith(".tsv") ||
    lowerName.endsWith(".tab") ||
    declaredMediaType === "text/tab-separated-values";
  const csvByName = lowerName.endsWith(".csv") || declaredMediaType === "text/csv";

  const first = lines[0];
  if (first === undefined) return null;

  const delimiter = tsvByName ? "\t" : csvByName ? "," : inferDelimiter(first);
  if (delimiter === null) return null;

  const firstCols = countFields(first, delimiter);
  if (firstCols < 2) return null;
  const consistent = lines.every((line) => countFields(line, delimiter) === firstCols);
  if (!consistent) return null;

  return delimiter === "\t" ? "text/tab-separated-values" : "text/csv";
}

function inferDelimiter(line: string): string | null {
  const tabs = (line.match(/\t/g) || []).length;
  const commas = (line.match(/,/g) || []).length;
  if (tabs > 0 && tabs >= commas) return "\t";
  if (commas > 0) return ",";
  return null;
}

/**
 * Count delimiter-separated fields in a single line, respecting double-
 * quoted fields that may contain the delimiter. A quoted field that runs
 * to the end of the line without a closing quote is treated as one field.
 */
function countFields(line: string, delimiter: string): number {
  let count = 1;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === delimiter && !inQuotes) {
      count++;
    }
  }
  return count;
}

/**
 * Inspect a ZIP container's `[Content_Types].xml` to classify an OOXML
 * file as `workbook` (xlsx), `document` (docx), or `slides` (pptx). The
 * content-type tokens are the OPC override part names defined by the
 * Open Packaging Conventions; a ZIP without a recognized Office main
 * part (or a malformed/truncated container) returns `null` so the caller
 * surfaces `unsupported`. Classification never executes document content
 * — it only reads the declared part metadata.
 */
function classifyOoxml(
  bytes: Uint8Array,
): { readonly kind: "workbook" | "document" | "slides"; readonly mediaType: string } | null {
  let entries: Map<string, Uint8Array>;
  try {
    entries = readWorkZip(bytes);
  } catch {
    return null;
  }
  const contentTypes = entries.get("[Content_Types].xml");
  if (contentTypes === undefined) return null;
  const xml = new TextDecoder("utf-8", { fatal: false }).decode(contentTypes);
  if (xml.includes("spreadsheetml.sheet.main")) {
    return {
      kind: "workbook",
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    };
  }
  if (xml.includes("wordprocessingml.document.main")) {
    return {
      kind: "document",
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };
  }
  if (xml.includes("presentationml.presentation.main")) {
    return {
      kind: "slides",
      mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    };
  }
  return null;
}
