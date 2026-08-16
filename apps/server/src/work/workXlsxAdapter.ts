import type { WorkArtifactFormat } from "@octant/contracts/work-artifacts";
import { MAX_WORK_OUTPUT_BYTES } from "./workBudget";
import {
  WorkAdapterBudgetError,
  registerWorkFormatAdapter,
  type WorkFormatAdapter,
} from "./workFormatAdapter";
import { readWorkZip, writeWorkZip } from "./workZipPort";

/**
 * XLSX (OOXML spreadsheet) format adapter for Work. Materializes a valid
 * minimal `.xlsx` ZIP container from renderer-supplied CSV content using the
 * dependency-free OPC ZIP port, and decodes stored cell values back into CSV
 * for round-trip read. Formula execution, charts, styles, and embedded objects
 * are out of scope: the domain policy already classifies xlsx as inherently
 * limited fidelity, and XLSX -> CSV is advertised as a lossy derived export.
 *
 * The adapter is a pure byte transform: it performs no filesystem, network, or
 * authority work. It self-registers into the format-adapter registry at module
 * load so the mutation service resolves xlsx create/revise/transform/export.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: false });

/**
 * Decode bounds for XLSX worksheets. A worksheet with a very large `r` row
 * index (e.g. `r="1048576"`) can force the decoder to pad `rows` with enormous
 * in-memory grids and CSV strings, with no output budget unlike encode. These
 * ceilings bound the decoded grid size and fail closed as
 * `WorkAdapterBudgetError` before allocation. They are deliberately smaller
 * than `MAX_WORK_OUTPUT_BYTES` because row/cell counts amplify memory far
 * beyond raw byte size.
 */
const MAX_XLSX_DECODE_ROWS = 1_000_000;
const MAX_XLSX_DECODE_CELLS = 1_000_000;
const MAX_XLSX_DECODE_COLUMNS = 1_000_000;

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;

const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const WORKBOOK_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;

const WORKBOOK_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`;

const WORKSHEET_HEADER =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData>';

const WORKSHEET_FOOTER = "</sheetData></worksheet>";

/**
 * Parse CSV text into a grid of cell values. Handles double-quoted fields with
 * embedded commas, doubled-quote escapes (`""`), and embedded newlines so a
 * quoted field can span multiple physical lines.
 *
 * The in-memory grid is bounded against the same `MAX_XLSX_DECODE_ROWS` and
 * `MAX_XLSX_DECODE_CELLS` ceilings used by decode: a CSV with millions of rows
 * or cells can allocate an enormous grid before `buildWorksheetXml` runs its
 * output-byte budget. The check runs incrementally after each row is added so
 * the allocation never happens, failing closed as `WorkAdapterBudgetError`.
 */
function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let totalCells = 0;
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
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
    if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      totalCells += row.length;
      rows.push(row);
      if (rows.length > MAX_XLSX_DECODE_ROWS) {
        throw new WorkAdapterBudgetError(
          `xlsx encode CSV has ${rows.length} rows exceeding row limit ${MAX_XLSX_DECODE_ROWS}`,
        );
      }
      if (totalCells > MAX_XLSX_DECODE_CELLS) {
        throw new WorkAdapterBudgetError(
          `xlsx encode CSV has ${totalCells} cells exceeding cell limit ${MAX_XLSX_DECODE_CELLS}`,
        );
      }
      row = [];
      field = "";
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
  if (field.length > 0 || row.length > 0 || inQuotes) {
    row.push(field);
    totalCells += row.length;
    rows.push(row);
    if (rows.length > MAX_XLSX_DECODE_ROWS) {
      throw new WorkAdapterBudgetError(
        `xlsx encode CSV has ${rows.length} rows exceeding row limit ${MAX_XLSX_DECODE_ROWS}`,
      );
    }
    if (totalCells > MAX_XLSX_DECODE_CELLS) {
      throw new WorkAdapterBudgetError(
        `xlsx encode CSV has ${totalCells} cells exceeding cell limit ${MAX_XLSX_DECODE_CELLS}`,
      );
    }
  }
  return rows;
}

/**
 * Convert a 0-based column index into spreadsheet column letters (A, B, ...,
 * Z, AA, AB, ...).
 */
function columnLetter(index: number): string {
  let n = index;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
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
 * Build the `xl/worksheets/sheet1.xml` part from a grid of cell values. Each
 * CSV line becomes one `<row>` (1-based `r` attribute) and each cell becomes an
 * inline-string `<c t="inlineStr">` with a cell reference like `A1`.
 *
 * The accumulated XML body is bounded against `MAX_WORK_OUTPUT_BYTES`: a CSV
 * payload under the input budget can still expand into unbounded XML when it
 * contains many tiny cells, so construction aborts before the ZIP is built. The
 * mutation service's `adapter.encode` try/catch surfaces this as `parse-failed`.
 */
function buildWorksheetXml(rows: ReadonlyArray<ReadonlyArray<string>>): string {
  let body = "";
  let bodyBytes = 0;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const cells = rows[rowIndex];
    if (cells === undefined) continue;
    const rowNumber = rowIndex + 1;
    const rowOpen = `<row r="${rowNumber}">`;
    body += rowOpen;
    bodyBytes += textEncoder.encode(rowOpen).byteLength;
    for (let colIndex = 0; colIndex < cells.length; colIndex += 1) {
      const ref = `${columnLetter(colIndex)}${rowNumber}`;
      const escaped = escapeXml(cells[colIndex] ?? "");
      const cellXml = `<c r="${ref}" t="inlineStr"><is><t>${escaped}</t></is></c>`;
      body += cellXml;
      bodyBytes += textEncoder.encode(cellXml).byteLength;
      if (bodyBytes > MAX_WORK_OUTPUT_BYTES) {
        throw new WorkAdapterBudgetError(
          `xlsx worksheet XML body exceeds ${MAX_WORK_OUTPUT_BYTES} bytes during encode`,
        );
      }
    }
    body += "</row>";
    bodyBytes += textEncoder.encode("</row>").byteLength;
  }
  return `${WORKSHEET_HEADER}${body}${WORKSHEET_FOOTER}`;
}

/**
 * Quote a CSV field when it contains a comma, double quote, or newline. Wraps
 * in double quotes and doubles internal quotes.
 */
function quoteCsvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Parse the `r` attribute on a `<row>` or `<c>` element to extract the
 * 1-based row number and 0-based column index. The reference format is column
 * letters followed by a row number (e.g. `A1`, `B12`, `AA3`). Returns
 * `undefined` when the attribute is missing or malformed.
 */
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
 * Parse `xl/sharedStrings.xml` into an ordered array of shared-string values.
 * Each `<si>` element may contain a `<t>` (rich text flattened here) or nested
 * `<r><t>` runs; the concatenated text is used. Returns an empty array when
 * the part is missing or malformed so shared-string cells decode to empty.
 */
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

/**
 * Decode a `xl/worksheets/sheet1.xml` part back into a CSV string by parsing
 * `<row>` and `<c>` elements. Inline strings (`<t>`) are preferred; otherwise
 * stored values (`<v>`) are used for numbers and formula cached results, with
 * `t="b"` boolean cells interpreted as `TRUE`/`FALSE` and `t="s"` shared-string
 * cells resolved against the supplied shared-strings array. Cell and row
 * coordinates (`r` attributes) are honored so sparse worksheets preserve their
 * column/row layout with empty-cell padding. Returns `undefined` when parsing
 * fails.
 */
function decodeWorksheetXml(xml: string, sharedStrings: readonly string[]): string | undefined {
  try {
    const rows: string[][] = [];
    const rowRegex = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
    let rowMatch: RegExpExecArray | null;
    while ((rowMatch = rowRegex.exec(xml)) !== null) {
      const rowAttrs = rowMatch[1] ?? "";
      const rowContent = rowMatch[2] ?? "";
      const cells: string[] = [];
      const cellRegex = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
      let cellMatch: RegExpExecArray | null;
      while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
        const cellAttrs = cellMatch[1] ?? "";
        const cellContent = cellMatch[2] ?? "";
        const rMatch = /\br="([A-Z]+\d+)"/.exec(cellAttrs);
        const ref = rMatch ? (rMatch[1] ?? "") : "";
        const refParsed = parseCellRef(ref);
        if (refParsed !== undefined) {
          if (refParsed.col >= MAX_XLSX_DECODE_COLUMNS) {
            throw new WorkAdapterBudgetError(
              `xlsx worksheet column index ${refParsed.col + 1} exceeds decode column limit ${MAX_XLSX_DECODE_COLUMNS}`,
            );
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
            if (Number.isFinite(index) && index >= 0 && index < sharedStrings.length) {
              cells.push(sharedStrings[index] ?? "");
            } else {
              cells.push("");
            }
          } else if (/\bt="b"/.test(cellAttrs)) {
            cells.push(raw === "1" ? "TRUE" : "FALSE");
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
        if (rowIndex >= MAX_XLSX_DECODE_ROWS) {
          throw new WorkAdapterBudgetError(
            `xlsx worksheet row index ${rowIndex + 1} exceeds decode row limit ${MAX_XLSX_DECODE_ROWS}`,
          );
        }
        while (rows.length < rowIndex) rows.push([]);
        rows[rowIndex] = cells;
      } else {
        rows.push(cells);
      }
    }
    if (rows.length > MAX_XLSX_DECODE_ROWS) {
      throw new WorkAdapterBudgetError(
        `xlsx worksheet has ${rows.length} rows exceeding decode row limit ${MAX_XLSX_DECODE_ROWS}`,
      );
    }
    let totalCells = 0;
    for (const rowCells of rows) {
      totalCells += rowCells.length;
      if (totalCells > MAX_XLSX_DECODE_CELLS) {
        throw new WorkAdapterBudgetError(
          `xlsx worksheet exceeds decode cell limit ${MAX_XLSX_DECODE_CELLS}`,
        );
      }
    }
    return rows.map((cells) => cells.map(quoteCsvField).join(",")).join("\n");
  } catch (error) {
    if (error instanceof WorkAdapterBudgetError) throw error;
    return undefined;
  }
}

const xlsxAdapter: WorkFormatAdapter = {
  format: "xlsx",
  encode(content: string): Uint8Array {
    const rows = parseCsv(content);
    const worksheetXml = buildWorksheetXml(rows);
    return writeWorkZip([
      { name: "[Content_Types].xml", data: textEncoder.encode(CONTENT_TYPES_XML) },
      { name: "_rels/.rels", data: textEncoder.encode(ROOT_RELS_XML) },
      { name: "xl/_rels/workbook.xml.rels", data: textEncoder.encode(WORKBOOK_RELS_XML) },
      { name: "xl/workbook.xml", data: textEncoder.encode(WORKBOOK_XML) },
      { name: "xl/worksheets/sheet1.xml", data: textEncoder.encode(worksheetXml) },
    ]);
  },
  decode(bytes: Uint8Array): string | undefined {
    try {
      const entries = readWorkZip(bytes);
      const worksheet = entries.get("xl/worksheets/sheet1.xml");
      if (worksheet === undefined) return undefined;
      const sharedStringsXml = entries.get("xl/sharedStrings.xml");
      const sharedStrings =
        sharedStringsXml !== undefined
          ? parseSharedStringsXml(textDecoder.decode(sharedStringsXml))
          : [];
      const xml = textDecoder.decode(worksheet);
      return decodeWorksheetXml(xml, sharedStrings);
    } catch (error) {
      if (error instanceof WorkAdapterBudgetError) throw error;
      return undefined;
    }
  },
  capabilities: {
    canRead: true,
    canCreate: true,
    canMutate: true,
    canRoundTrip: true,
    canExport: true,
    canVersion: true,
  },
  exportFormats: ["csv"],
  convertTo(targetFormat: WorkArtifactFormat, sourceBytes: Uint8Array): Uint8Array | undefined {
    if (targetFormat === "xlsx") return sourceBytes;
    if (targetFormat === "csv") {
      const csv = xlsxAdapter.decode(sourceBytes);
      if (csv === undefined) return undefined;
      return textEncoder.encode(csv);
    }
    return undefined;
  },
};

registerWorkFormatAdapter(xlsxAdapter);

export { xlsxAdapter };
