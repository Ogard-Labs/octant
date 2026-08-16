import { readFileSync } from "node:fs";
import { Schema } from "effect";
import {
  PreviewChunkSequence,
  decodePreviewChunk,
  type PreviewChunk,
  type PreviewChunkId,
  type PreviewContentBounds,
  type PreviewDelimiter,
  type PreviewSourceVersion,
  type PreviewTargetId,
} from "@octant/contracts/previews";
import {
  computePreviewSourceVersionFromBytes,
  samePreviewSourceVersion,
} from "./previewSourceVersion";
import {
  DEFAULT_PREVIEW_ROWS_PER_CHUNK,
  MAX_PREVIEW_CHUNK_TEXT_BYTES,
  MAX_PREVIEW_TABLE_COLUMNS,
  MAX_PREVIEW_TABLE_ROWS,
} from "./previewFormatBudget";

const decodeSequence = Schema.decodeUnknownSync(PreviewChunkSequence);

export interface TableChunkBudget {
  readonly maxRowsPerChunk: number;
  readonly maxRows: number;
  readonly maxColumns: number;
  /** Optional total render byte cap; when exceeded the stream truncates. */
  readonly maxRenderBytes?: number;
}

export interface ProduceTableChunksInput {
  readonly filePath: string;
  readonly targetId: PreviewTargetId;
  readonly chunkId: PreviewChunkId;
  readonly sourceVersion: PreviewSourceVersion;
  readonly delimiter: PreviewDelimiter;
  readonly budget: TableChunkBudget;
}

/**
 * Infer the delimiter from the first non-empty line by counting candidate
 * separators. Used by the manifest producer to derive the table delimiter
 * from content when no explicit delimiter is known. Returns the chosen
 * delimiter or `null` when no recognized separator is present.
 */
export function inferTableDelimiter(text: string): PreviewDelimiter | null {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const tabs = (firstLine.match(/\t/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  const semis = (firstLine.match(/;/g) || []).length;
  const pipes = (firstLine.match(/\|/g) || []).length;
  if (tabs >= commas && tabs >= semis && tabs >= pipes && tabs > 0) return "\t";
  if (commas >= semis && commas >= pipes && commas > 0) return ",";
  if (semis >= pipes && semis > 0) return ";";
  if (pipes > 0) return "|";
  return null;
}

/**
 * Parse CSV/TSV text into a grid of string fields. Handles double-quoted
 * fields with embedded delimiters, doubled-quote escapes (`""`), and
 * embedded newlines so a quoted field can span multiple physical lines.
 * The grid is bounded against `maxRows` and `maxColumns`; a source
 * exceeding either ceiling stops emitting rows so the caller can mark the
 * preview limited-fidelity.
 */
export function parseTable(
  input: string,
  delimiter: string,
  budget: Pick<TableChunkBudget, "maxRows" | "maxColumns">,
): { readonly rows: string[][]; readonly truncated: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let truncated = false;
  let i = 0;
  const pushRow = () => {
    rows.push(row);
    row = [];
    if (rows.length >= budget.maxRows) {
      truncated = true;
      return true;
    }
    return false;
  };
  while (i < input.length) {
    const ch = input[i];
    if (ch === undefined) break;
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = "";
      i += 1;
      if (row.length >= budget.maxColumns) {
        // Truncate the remaining fields on this line at the column ceiling.
        // Advance to the next line break so the row count stays accurate.
        while (i < input.length && input[i] !== "\n") i += 1;
        if (pushRow()) {
          field = "";
          inQuotes = false;
          break;
        }
        field = "";
        i += 1;
        continue;
      }
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      field = "";
      if (pushRow()) {
        inQuotes = false;
        break;
      }
      i += 1;
      continue;
    }
    if (ch === "\r") {
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (!truncated && (field.length > 0 || row.length > 0 || inQuotes)) {
    row.push(field);
    pushRow();
  }
  return { rows, truncated };
}

/**
 * Compute manifest bounds for a table source from its bytes. Returns the
 * row and column counts (capped at the budget ceilings) without emitting
 * chunk payloads. The delimiter is inferred from the content when not
 * supplied.
 */
export function computeTableBounds(
  bytes: Uint8Array,
  delimiter: PreviewDelimiter,
): PreviewContentBounds {
  const text = Buffer.from(bytes).toString("utf-8");
  const { rows } = parseTable(text, delimiter, {
    maxRows: MAX_PREVIEW_TABLE_ROWS,
    maxColumns: MAX_PREVIEW_TABLE_COLUMNS,
  });
  let columns = 0;
  for (const row of rows) {
    if (row.length > columns) columns = row.length;
  }
  const bounds: Record<string, number> = { rows: rows.length, columns };
  return bounds;
}

/**
 * Produce bounded table (CSV/TSV) preview chunks. Rows are paginated into
 * chunks of at most `maxRowsPerChunk` rows; each chunk payload carries the
 * delimiter so the viewer can render the grid honestly and the user can
 * correct detection. The generator recomputes the source version from the
 * bytes it reads and aborts (yielding nothing) when the file changed since
 * the caller recorded the version, so chunks are never stamped with a
 * stale content hash. A missing file also yields no chunks.
 */
export function* produceTableChunks(input: ProduceTableChunksInput): Generator<PreviewChunk> {
  let bytes: Buffer;
  let content: string;
  try {
    bytes = readFileSync(input.filePath);
    content = bytes.toString("utf-8");
  } catch {
    return;
  }

  const current = computePreviewSourceVersionFromBytes(bytes);
  if (!samePreviewSourceVersion(current, input.sourceVersion)) return;

  const { rows, truncated } = parseTable(content, input.delimiter, {
    maxRows: input.budget.maxRows,
    maxColumns: input.budget.maxColumns,
  });

  const renderCap = input.budget.maxRenderBytes;
  let renderedBytes = 0;
  let sequence = 0;
  let rowIndex = 0;
  let hitCap = false;

  while (rowIndex < rows.length) {
    if (renderCap !== undefined && renderedBytes >= renderCap) {
      hitCap = true;
      break;
    }
    const startRow = rowIndex + 1;
    const window: string[][] = [];
    let windowBytes = 0;
    while (rowIndex < rows.length && window.length < input.budget.maxRowsPerChunk) {
      const row = rows[rowIndex];
      if (row === undefined) break;
      let rowBytes = 0;
      for (const cell of row) rowBytes += Buffer.byteLength(cell, "utf-8") + 1;
      if (window.length > 0 && windowBytes + rowBytes > MAX_PREVIEW_CHUNK_TEXT_BYTES) break;
      if (renderCap !== undefined && renderedBytes + rowBytes > renderCap) {
        hitCap = true;
        break;
      }
      window.push(row);
      windowBytes += rowBytes;
      renderedBytes += rowBytes;
      rowIndex += 1;
    }
    if (window.length === 0) {
      hitCap = true;
      break;
    }
    const endRow = startRow + window.length - 1;
    const isFinal = hitCap || (rowIndex >= rows.length && !truncated);
    const chunk = decodePreviewChunk({
      chunkId: input.chunkId,
      targetId: input.targetId,
      sourceVersion: input.sourceVersion,
      kind: "table",
      sequence: decodeSequence(sequence),
      descriptor: { kind: "table", startRow, endRow },
      payload: { kind: "table", rows: window, delimiter: input.delimiter },
      isFinal,
    });
    yield chunk;
    sequence += 1;
    if (hitCap) break;
  }

  // Empty file: a single final empty chunk so the viewer can settle.
  if (sequence === 0) {
    const chunk = decodePreviewChunk({
      chunkId: input.chunkId,
      targetId: input.targetId,
      sourceVersion: input.sourceVersion,
      kind: "table",
      sequence: decodeSequence(0),
      descriptor: { kind: "table", startRow: 1, endRow: 1 },
      payload: { kind: "table", rows: [], delimiter: input.delimiter },
      isFinal: true,
    });
    yield chunk;
  }
}

export const DEFAULT_TABLE_BUDGET: TableChunkBudget = {
  maxRowsPerChunk: DEFAULT_PREVIEW_ROWS_PER_CHUNK,
  maxRows: MAX_PREVIEW_TABLE_ROWS,
  maxColumns: MAX_PREVIEW_TABLE_COLUMNS,
};
