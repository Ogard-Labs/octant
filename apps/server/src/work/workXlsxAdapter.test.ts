import { describe, expect, it } from "vitest";
import { writeWorkZip, readWorkZip } from "./workZipPort";
import { WorkAdapterBudgetError } from "./workFormatAdapter";
import { xlsxAdapter } from "./workXlsxAdapter";

const textDecoder = new TextDecoder("utf-8");
const textEncoder = new TextEncoder();

const WORKSHEET_HEADER =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
const WORKSHEET_FOOTER = "</sheetData></worksheet>";

/**
 * Build a minimal XLSX byte container wrapping a single worksheet XML body so
 * decode can be exercised against Excel/Numbers-style stored-value cells.
 */
function xlsxFromWorksheetXml(worksheetXml: string): Uint8Array {
  return writeWorkZip([
    { name: "[Content_Types].xml", data: textEncoder.encode("<Types/>") },
    { name: "xl/worksheets/sheet1.xml", data: textEncoder.encode(worksheetXml) },
  ]);
}

/**
 * Build an XLSX byte container with a worksheet and an optional shared-strings
 * part so `t="s"` cell decoding can be exercised.
 */
function xlsxFromWorksheetAndSharedStrings(
  worksheetXml: string,
  sharedStringsXml: string,
): Uint8Array {
  return writeWorkZip([
    { name: "[Content_Types].xml", data: textEncoder.encode("<Types/>") },
    { name: "xl/worksheets/sheet1.xml", data: textEncoder.encode(worksheetXml) },
    { name: "xl/sharedStrings.xml", data: textEncoder.encode(sharedStringsXml) },
  ]);
}

describe("workXlsxAdapter", () => {
  it("encode produces bytes starting with the ZIP magic 0x50 0x4b", () => {
    const bytes = xlsxAdapter.encode("a,b,c\n1,2,3");
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
  });

  it("encode produces a ZIP container with the worksheet and workbook parts", () => {
    const entries = readWorkZip(xlsxAdapter.encode("a,b,c\n1,2,3"));
    expect(entries.has("xl/worksheets/sheet1.xml")).toBe(true);
    expect(entries.has("xl/workbook.xml")).toBe(true);
  });

  it("round-trips a simple CSV through encode and decode", () => {
    const csv = "a,b,c\n1,2,3";
    expect(xlsxAdapter.decode(xlsxAdapter.encode(csv))).toBe(csv);
  });

  it("round-trips quoted fields with an embedded comma and newline", () => {
    const csv = '"hello, world","line\nbreak"';
    expect(xlsxAdapter.decode(xlsxAdapter.encode(csv))).toBe(csv);
  });

  it("decode returns undefined for a non-ZIP byte array", () => {
    expect(xlsxAdapter.decode(new Uint8Array([0x00, 0x01, 0x02, 0x03]))).toBeUndefined();
  });

  it("convertTo csv returns UTF-8 bytes decoding to the CSV text", () => {
    const bytes = xlsxAdapter.encode("a,b\n1,2");
    const csvBytes = xlsxAdapter.convertTo("csv", bytes);
    expect(csvBytes).not.toBeUndefined();
    if (csvBytes === undefined) return;
    expect(textDecoder.decode(csvBytes)).toBe("a,b\n1,2");
  });

  it("convertTo returns undefined for an unsupported target format", () => {
    const bytes = xlsxAdapter.encode("a,b\n1,2");
    expect(xlsxAdapter.convertTo("markdown", bytes)).toBeUndefined();
  });

  it("convertTo xlsx returns the same bytes unchanged", () => {
    const bytes = xlsxAdapter.encode("a,b\n1,2");
    expect(xlsxAdapter.convertTo("xlsx", bytes)).toBe(bytes);
  });

  it("reports honest capability flags and csv as a derived export format", () => {
    expect(xlsxAdapter.capabilities).toEqual({
      canRead: true,
      canCreate: true,
      canMutate: true,
      canRoundTrip: true,
      canExport: true,
      canVersion: true,
    });
    expect(xlsxAdapter.exportFormats).toEqual(["csv"]);
  });

  it("decodes a numeric <v> stored value cell to its CSV text", () => {
    const xml = `${WORKSHEET_HEADER}<row r="1"><c r="A1"><v>42</v></c></row>${WORKSHEET_FOOTER}`;
    expect(xlsxAdapter.decode(xlsxFromWorksheetXml(xml))).toBe("42");
  });

  it('decodes a boolean t="b" <v> stored value cell to TRUE/FALSE', () => {
    const xmlTrue = `${WORKSHEET_HEADER}<row r="1"><c r="A1" t="b"><v>1</v></c></row>${WORKSHEET_FOOTER}`;
    expect(xlsxAdapter.decode(xlsxFromWorksheetXml(xmlTrue))).toBe("TRUE");
    const xmlFalse = `${WORKSHEET_HEADER}<row r="1"><c r="A1" t="b"><v>0</v></c></row>${WORKSHEET_FOOTER}`;
    expect(xlsxAdapter.decode(xlsxFromWorksheetXml(xmlFalse))).toBe("FALSE");
  });

  it("still round-trips inline-string cells alongside stored-value cells", () => {
    const csv = "a,b,c\n1,2,3";
    expect(xlsxAdapter.decode(xlsxAdapter.encode(csv))).toBe(csv);
  });

  it("throws during encode when CSV cell expansion would exceed the output budget", () => {
    // A CSV well under the 16 MiB input budget but with many single-char cells.
    // Each cell expands to ~50+ bytes of XML, so ~400K cells overflow 16 MiB.
    const cellsPerRow = 1000;
    const rowCount = 400;
    const row = Array.from({ length: cellsPerRow }, () => "a").join(",");
    const csv = Array.from({ length: rowCount }, () => row).join("\n");
    // Sanity: the CSV itself is small relative to the 16 MiB input budget.
    expect(csv.length).toBeLessThan(16 * 1024 * 1024);
    expect(() => xlsxAdapter.encode(csv)).toThrow();
  });

  it("throws during encode when multibyte text byte size exceeds the output budget", () => {
    // Multibyte characters inflate the UTF-8 byte size beyond the JS char count.
    // Each 3-byte char cell expands with XML overhead, so ~400K cells overflow.
    const cellsPerRow = 1000;
    const rowCount = 400;
    const row = Array.from({ length: cellsPerRow }, () => "\u00e9").join(",");
    const csv = Array.from({ length: rowCount }, () => row).join("\n");
    expect(csv.length).toBeLessThan(16 * 1024 * 1024);
    expect(() => xlsxAdapter.encode(csv)).toThrow();
  });

  it('decodes t="s" shared-string cells using xl/sharedStrings.xml', () => {
    const sharedStringsXml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Hello</t></si><si><t>World</t></si></sst>';
    const xml = `${WORKSHEET_HEADER}<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>${WORKSHEET_FOOTER}`;
    expect(xlsxAdapter.decode(xlsxFromWorksheetAndSharedStrings(xml, sharedStringsXml))).toBe(
      "Hello,World",
    );
  });

  it('decodes t="s" cells to empty strings when sharedStrings.xml is missing', () => {
    const xml = `${WORKSHEET_HEADER}<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>${WORKSHEET_FOOTER}`;
    expect(xlsxAdapter.decode(xlsxFromWorksheetXml(xml))).toBe(",");
  });

  it('decodes t="s" cells to empty strings when the index is out of bounds', () => {
    const sharedStringsXml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Only</t></si></sst>';
    const xml = `${WORKSHEET_HEADER}<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>5</v></c></row>${WORKSHEET_FOOTER}`;
    expect(xlsxAdapter.decode(xlsxFromWorksheetAndSharedStrings(xml, sharedStringsXml))).toBe(
      "Only,",
    );
  });

  it("preserves column coordinates for sparse worksheets with missing cells", () => {
    const xml = `${WORKSHEET_HEADER}<row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c><c r="C1" t="inlineStr"><is><t>b</t></is></c></row>${WORKSHEET_FOOTER}`;
    expect(xlsxAdapter.decode(xlsxFromWorksheetXml(xml))).toBe("a,,b");
  });

  it("preserves row coordinates for sparse worksheets with missing rows", () => {
    const xml = `${WORKSHEET_HEADER}<row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>c</t></is></c></row>${WORKSHEET_FOOTER}`;
    expect(xlsxAdapter.decode(xlsxFromWorksheetXml(xml))).toBe("a\n\nc");
  });

  it("throws WorkAdapterBudgetError when decoding a worksheet with a very large row index", () => {
    // A sparse worksheet referencing row 2,000,000 would force the decoder to
    // pad `rows` with ~2M empty arrays before assignment, allocating an
    // unbounded in-memory grid and CSV string with no output budget. The
    // decoder must fail closed before padding.
    const xml = `${WORKSHEET_HEADER}<row r="2000000"><c r="A2000000" t="inlineStr"><is><t>x</t></is></c></row>${WORKSHEET_FOOTER}`;
    expect(() => xlsxAdapter.decode(xlsxFromWorksheetXml(xml))).toThrow(WorkAdapterBudgetError);
  });

  it("throws WorkAdapterBudgetError when decoding a cell with an enormous column index", () => {
    // A crafted worksheet with a cell `r` attribute carrying an absurdly large
    // column index (e.g. `ZZZZZZZZZZ1`) would force the per-cell padding loop
    // to pre-fill millions of empty cells before the total-cell budget check
    // runs, allocating an unbounded in-memory array. The decoder must fail
    // closed before the padding loop. `ZZZZZZZZZZ` decodes to a column index
    // far exceeding the 1,000,000 decode column ceiling.
    const xml = `${WORKSHEET_HEADER}<row r="1"><c r="ZZZZZZZZZZ1" t="inlineStr"><is><t>x</t></is></c></row>${WORKSHEET_FOOTER}`;
    expect(() => xlsxAdapter.decode(xlsxFromWorksheetXml(xml))).toThrow(WorkAdapterBudgetError);
  });

  it("throws WorkAdapterBudgetError when encoding a CSV with more than the cell limit", () => {
    // A single row with 1,000,001 comma-separated cells exceeds the
    // MAX_XLSX_DECODE_CELLS ceiling. `parseCsv` must fail closed during encode
    // before building the full in-memory grid, rather than allocating it and
    // relying on the later output-byte budget check.
    const cellCount = 1_000_001;
    const csv = `${Array.from({ length: cellCount }, () => "a").join(",")}\n`;
    expect(() => xlsxAdapter.encode(csv)).toThrow(WorkAdapterBudgetError);
  });

  it("throws WorkAdapterBudgetError when encoding a CSV with more than the row limit", () => {
    // 1,000,001 rows of a small CSV exceed the MAX_XLSX_DECODE_ROWS ceiling.
    // `parseCsv` must fail closed incrementally as rows are added rather than
    // materializing the entire grid first.
    const rowCount = 1_000_001;
    const csv = Array.from({ length: rowCount }, () => "a,b,c").join("\n");
    expect(() => xlsxAdapter.encode(csv)).toThrow(WorkAdapterBudgetError);
  });
});
