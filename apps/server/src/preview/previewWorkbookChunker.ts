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
  type WorkbookCellValue,
} from "@octant/contracts/previews";
import { readWorkZip } from "../work/workZipPort";
import {
  computePreviewSourceVersionFromBytes,
  samePreviewSourceVersion,
} from "./previewSourceVersion";
import {
  DEFAULT_PREVIEW_ROWS_PER_CHUNK,
  MAX_PREVIEW_CHUNK_TEXT_BYTES,
  MAX_PREVIEW_WORKBOOK_COLUMNS,
  MAX_PREVIEW_WORKBOOK_ROWS,
  MAX_PREVIEW_WORKBOOK_WORKSHEETS,
} from "./previewFormatBudget";

const decodeSequence = Schema.decodeUnknownSync(PreviewChunkSequence);
const textDecoder = new TextDecoder("utf-8", { fatal: false });

export interface WorkbookChunkBudget {
  readonly maxRowsPerChunk: number;
  readonly maxRows: number;
  readonly maxColumns: number;
  readonly maxWorksheets: number;
  readonly maxRenderBytes?: number;
}

export interface ProduceWorkbookChunksInput {
  readonly filePath: string;
  readonly targetId: PreviewTargetId;
  readonly chunkId: PreviewChunkId;
  readonly sourceVersion: PreviewSourceVersion;
  readonly budget: WorkbookChunkBudget;
}

export interface WorkbookWorksheet {
  readonly name: string;
  readonly rows: WorkbookCellValue[][];
}

export interface ParsedWorkbook {
  readonly worksheets: readonly WorkbookWorksheet[];
  /** True when row, column, or worksheet ceilings truncated the parse. */
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

function parseSharedStringsXml(xml: string): string[] {
  const shared: string[] = [];
  const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let siMatch: RegExpExecArray | null;
  while ((siMatch = siRegex.exec(xml)) !== null) {
    const content = siMatch[1] ?? "";
    const parts: string[] = [];
    const tRegex = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let tMatch: RegExpExecArray | null;
    while ((tMatch = tRegex.exec(content)) !== null) {
      parts.push(unescapeXml(tMatch[1] ?? ""));
    }
    shared.push(parts.join(""));
  }
  return shared;
}

function parseCellRef(ref: string): { row: number; col: number } | undefined {
  const match = /^([A-Z]+)(\d+)$/.exec(ref);
  if (match === null) return undefined;
  const letters = match[1] ?? "";
  let col = 0;
  for (let i = 0; i < letters.length; i += 1) {
    col = col * 26 + (letters.charCodeAt(i) - 64);
  }
  const row = Number.parseInt(match[2] ?? "0", 10);
  if (!Number.isFinite(row) || row < 1) return undefined;
  return { row, col: col - 1 };
}

/**
 * Resolve the ordered list of worksheet part paths and display names from
 * `xl/workbook.xml` and its rels. Falls back to filename-sort ordering of
 * `xl/worksheets/sheetN.xml` parts when the workbook or rels part is
 * missing, so minimal containers (like the Work encoder's single-sheet
 * output) still decode.
 */
function resolveWorksheets(
  entries: Map<string, Uint8Array>,
): Array<{ readonly name: string; readonly path: string }> {
  const workbookData = entries.get("xl/workbook.xml");
  if (workbookData !== undefined) {
    const workbookXml = textDecoder.decode(workbookData);
    const sheetsMatch = /<sheets>([\s\S]*?)<\/sheets>/.exec(workbookXml);
    if (sheetsMatch !== null) {
      const sheetRegex = /<sheet\b[^>]*\bname="([^"]*)"[^>]*\br:id="([^"]*)"/g;
      const relsData = entries.get("xl/_rels/workbook.xml.rels");
      const relMap = new Map<string, string>();
      if (relsData !== undefined) {
        const relsXml = textDecoder.decode(relsData);
        const relRegex = /<Relationship\s+([^>]*)\/?\s*>/g;
        let relMatch: RegExpExecArray | null;
        while ((relMatch = relRegex.exec(relsXml)) !== null) {
          const attrs = relMatch[1] ?? "";
          const id = /(?:^|\s)Id="([^"]*)"/.exec(attrs)?.[1];
          const target = /(?:^|\s)Target="([^"]*)"/.exec(attrs)?.[1];
          if (id !== undefined && target !== undefined) relMap.set(id, target);
        }
      }
      const out: Array<{ name: string; path: string }> = [];
      let sheetMatch: RegExpExecArray | null;
      while ((sheetMatch = sheetRegex.exec(sheetsMatch[1] ?? "")) !== null) {
        const name = sheetMatch[1] ?? "";
        const rid = sheetMatch[2] ?? "";
        const target = relMap.get(rid);
        const path = target !== undefined ? normalizeWorksheetPath(target) : "";
        if (path !== "" && entries.has(path)) out.push({ name, path });
      }
      if (out.length > 0) return out;
    }
  }
  // Fallback: filename-sort sheet parts.
  const pattern = /^xl\/worksheets\/sheet(\d+)\.xml$/;
  const found: Array<{ name: string; path: string }> = [];
  for (const name of entries.keys()) {
    const match = pattern.exec(name);
    if (match) found.push({ name: `Sheet${match[1] ?? ""}`, path: name });
  }
  found.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  return found;
}

function normalizeWorksheetPath(target: string): string {
  if (target.startsWith("/xl/")) return target.slice(1);
  if (target.startsWith("xl/")) return target;
  if (target.startsWith("/")) return `xl${target}`;
  return `xl/${target}`;
}

/**
 * Decode a single worksheet XML part into a row grid of stored cell
 * values. Inline strings (`<t>`) are preferred; otherwise stored values
 * (`<v>`) are used for numbers and formula cached results, with `t="b"`
 * boolean cells as booleans and `t="s"` shared-string cells resolved
 * against the supplied shared-strings array. Cell coordinates (`r`
 * attributes) are honored so sparse worksheets preserve their layout with
 * empty-cell padding. Row and column ceilings truncate the grid safely.
 */
function decodeWorksheetXml(
  xml: string,
  sharedStrings: readonly string[],
  budget: Pick<WorkbookChunkBudget, "maxRows" | "maxColumns">,
): { readonly rows: WorkbookCellValue[][]; readonly truncated: boolean } {
  const rows: WorkbookCellValue[][] = [];
  let truncated = false;
  const rowRegex = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRegex.exec(xml)) !== null) {
    const rowAttrs = rowMatch[1] ?? "";
    const rowContent = rowMatch[2] ?? "";
    const cells: WorkbookCellValue[] = [];
    const cellRegex = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
      const cellAttrs = cellMatch[1] ?? "";
      const cellContent = cellMatch[2] ?? "";
      const rMatch = /\br="([A-Z]+\d+)"/.exec(cellAttrs);
      const ref = rMatch ? (rMatch[1] ?? "") : "";
      const refParsed = parseCellRef(ref);
      if (refParsed !== undefined) {
        if (refParsed.col >= budget.maxColumns) {
          truncated = true;
          break;
        }
        while (cells.length < refParsed.col) cells.push("");
      }
      const tMatch = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(cellContent);
      if (tMatch !== null) {
        cells.push(unescapeXml(tMatch[1] ?? ""));
        continue;
      }
      const vMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cellContent);
      if (vMatch !== null) {
        const raw = (vMatch[1] ?? "").trim();
        if (/\bt="s"/.test(cellAttrs)) {
          const index = Number.parseInt(raw, 10);
          cells.push(
            Number.isFinite(index) && index >= 0 && index < sharedStrings.length
              ? (sharedStrings[index] ?? "")
              : "",
          );
        } else if (/\bt="b"/.test(cellAttrs)) {
          cells.push(raw === "1");
        } else if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
          cells.push(Number(raw));
        } else {
          cells.push(raw);
        }
        continue;
      }
      cells.push("");
    }
    const rowRMatch = /\br="(\d+)"/.exec(rowAttrs);
    const rowIndex = rowRMatch ? Number.parseInt(rowRMatch[1] ?? "0", 10) - 1 : rows.length;
    if (Number.isFinite(rowIndex) && rowIndex >= 0) {
      if (rowIndex >= budget.maxRows) {
        truncated = true;
        break;
      }
      while (rows.length < rowIndex) rows.push([]);
      rows[rowIndex] = cells;
    } else {
      rows.push(cells);
    }
    if (rows.length >= budget.maxRows) {
      truncated = true;
      break;
    }
  }
  return { rows, truncated };
}

/**
 * Parse an XLSX byte container into ordered worksheets of stored cell
 * values. No formula execution, macro execution, external-data refresh, or
 * network access occurs: only stored cell values and cached formula
 * results are read. A malformed container returns `undefined` so the
 * caller surfaces a parse-failed outcome.
 */
export function parseWorkbook(
  bytes: Uint8Array,
  budget: Pick<WorkbookChunkBudget, "maxRows" | "maxColumns" | "maxWorksheets">,
): ParsedWorkbook | undefined {
  let entries: Map<string, Uint8Array>;
  try {
    entries = readWorkZip(bytes);
  } catch {
    return undefined;
  }
  const sharedStringsXml = entries.get("xl/sharedStrings.xml");
  const sharedStrings =
    sharedStringsXml !== undefined
      ? parseSharedStringsXml(textDecoder.decode(sharedStringsXml))
      : [];
  const allSheets = resolveWorksheets(entries);
  const sheetSpecs = allSheets.slice(0, budget.maxWorksheets);
  if (sheetSpecs.length === 0) return undefined;
  const worksheets: WorkbookWorksheet[] = [];
  let truncated = allSheets.length > sheetSpecs.length;
  for (const spec of sheetSpecs) {
    const data = entries.get(spec.path);
    if (data === undefined) continue;
    const decoded = decodeWorksheetXml(textDecoder.decode(data), sharedStrings, budget);
    worksheets.push({ name: spec.name, rows: decoded.rows });
    if (decoded.truncated) truncated = true;
  }
  return { worksheets, truncated };
}

/**
 * Compute manifest bounds for an XLSX source: worksheet count plus the
 * max row and column counts across worksheets (capped at the budget
 * ceilings). Returns empty bounds when the container is malformed.
 */
export function computeWorkbookBounds(bytes: Uint8Array): PreviewContentBounds {
  const parsed = parseWorkbook(bytes, {
    maxRows: MAX_PREVIEW_WORKBOOK_ROWS,
    maxColumns: MAX_PREVIEW_WORKBOOK_COLUMNS,
    maxWorksheets: MAX_PREVIEW_WORKBOOK_WORKSHEETS,
  });
  if (parsed === undefined) return {};
  let rows = 0;
  let columns = 0;
  for (const sheet of parsed.worksheets) {
    if (sheet.rows.length > rows) rows = sheet.rows.length;
    for (const row of sheet.rows) {
      if (row.length > columns) columns = row.length;
    }
  }
  return {
    worksheets: parsed.worksheets.length,
    rows,
    columns,
  };
}

/**
 * Produce bounded workbook (XLSX) preview chunks. Each worksheet is
 * paginated into row chunks of at most `maxRowsPerChunk` rows; the chunk
 * descriptor carries the 1-based worksheet index and row/column range so
 * the viewer can render worksheet tabs and range selections. The generator
 * recomputes the source version from the bytes it reads and aborts when
 * the file changed since the caller recorded the version. A missing or
 * malformed file yields no chunks.
 */
export function* produceWorkbookChunks(input: ProduceWorkbookChunksInput): Generator<PreviewChunk> {
  let bytes: Buffer;
  try {
    bytes = readFileSync(input.filePath);
  } catch {
    return;
  }

  const current = computePreviewSourceVersionFromBytes(bytes);
  if (!samePreviewSourceVersion(current, input.sourceVersion)) return;

  const parsed = parseWorkbook(bytes, {
    maxRows: input.budget.maxRows,
    maxColumns: input.budget.maxColumns,
    maxWorksheets: input.budget.maxWorksheets,
  });
  if (parsed === undefined) return;

  const renderCap = input.budget.maxRenderBytes;
  let renderedBytes = 0;
  let sequence = 0;
  let hitCap = false;

  for (let sheetIndex = 0; sheetIndex < parsed.worksheets.length && !hitCap; sheetIndex += 1) {
    const sheet = parsed.worksheets[sheetIndex];
    if (sheet === undefined) continue;
    const worksheetNumber = sheetIndex + 1;
    let rowIndex = 0;
    while (rowIndex < sheet.rows.length) {
      if (renderCap !== undefined && renderedBytes >= renderCap) {
        hitCap = true;
        break;
      }
      const startRow = rowIndex + 1;
      const startColumn = 1;
      const window: WorkbookCellValue[][] = [];
      let windowBytes = 0;
      let endColumn = startColumn;
      while (rowIndex < sheet.rows.length && window.length < input.budget.maxRowsPerChunk) {
        const row = sheet.rows[rowIndex];
        if (row === undefined) break;
        let rowBytes = 0;
        for (const cell of row) rowBytes += estimateCellBytes(cell);
        if (window.length > 0 && windowBytes + rowBytes > MAX_PREVIEW_CHUNK_TEXT_BYTES) break;
        if (renderCap !== undefined && renderedBytes + rowBytes > renderCap) {
          hitCap = true;
          break;
        }
        window.push(row);
        windowBytes += rowBytes;
        renderedBytes += rowBytes;
        if (row.length + 1 > endColumn) endColumn = row.length + 1;
        rowIndex += 1;
      }
      if (window.length === 0) {
        hitCap = true;
        break;
      }
      const endRow = startRow + window.length - 1;
      const isLastSheet = sheetIndex === parsed.worksheets.length - 1;
      const isFinal =
        (hitCap || (rowIndex >= sheet.rows.length && isLastSheet)) && !parsed.truncated;
      const chunk = decodePreviewChunk({
        chunkId: input.chunkId,
        targetId: input.targetId,
        sourceVersion: input.sourceVersion,
        kind: "workbook",
        sequence: decodeSequence(sequence),
        descriptor: {
          kind: "workbook",
          worksheet: worksheetNumber,
          startRow,
          endRow,
          startColumn,
          endColumn,
        },
        payload: { kind: "workbook", worksheetName: sheet.name, rows: window },
        isFinal,
      });
      yield chunk;
      sequence += 1;
      if (hitCap) break;
    }
  }
}

function estimateCellBytes(cell: WorkbookCellValue): number {
  if (cell === null) return 1;
  if (typeof cell === "number" || typeof cell === "boolean") return 8;
  return Buffer.byteLength(cell, "utf-8") + 1;
}

export const DEFAULT_WORKBOOK_BUDGET: WorkbookChunkBudget = {
  maxRowsPerChunk: DEFAULT_PREVIEW_ROWS_PER_CHUNK,
  maxRows: MAX_PREVIEW_WORKBOOK_ROWS,
  maxColumns: MAX_PREVIEW_WORKBOOK_COLUMNS,
  maxWorksheets: MAX_PREVIEW_WORKBOOK_WORKSHEETS,
};
