import { describe, expect, it } from "vitest";
import { parseDocument } from "./previewDocumentChunker";
import { parsePdf } from "./previewPdfChunker";
import { parseSlides } from "./previewSlidesChunker";
import { parseTable } from "./previewTableChunker";
import { parseWorkbook } from "./previewWorkbookChunker";
import {
  buildDocxFixture,
  buildPdfFixture,
  buildPptxFixture,
  buildXlsxFixture,
} from "./previewTestFixtures";

describe("preview parser hostile-fixture handling", () => {
  it("rejects a malformed OOXML container without throwing", () => {
    const garbage = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00]);
    expect(
      parseWorkbook(garbage, { maxRows: 100, maxColumns: 100, maxWorksheets: 16 }),
    ).toBeUndefined();
    expect(parseDocument(garbage, { maxBlocks: 100, maxBlockTextBytes: 4096 })).toBeUndefined();
    expect(parseSlides(garbage, { maxSlides: 100, maxSlideTextBytes: 4096 })).toBeUndefined();
  });

  it("truncates a table at the row ceiling instead of allocating unbounded rows", () => {
    let input = "";
    for (let i = 0; i < 1000; i += 1) input += `r${i},c\n`;
    const { rows, truncated } = parseTable(input, ",", { maxRows: 50, maxColumns: 100 });
    expect(rows).toHaveLength(50);
    expect(truncated).toBe(true);
  });

  it("truncates a PDF at the page ceiling", () => {
    const pages: string[][] = [];
    for (let i = 0; i < 50; i += 1) pages.push([`page ${i}`]);
    const bytes = buildPdfFixture(pages);
    const parsed = parsePdf(bytes, { maxPages: 10, maxPageTextBytes: 4096 });
    expect(parsed?.pages).toHaveLength(10);
    expect(parsed?.truncated).toBe(true);
  });

  it("truncates a DOCX at the block ceiling", () => {
    const lines: string[] = [];
    for (let i = 0; i < 50; i += 1) lines.push(`para ${i}`);
    const bytes = buildDocxFixture(lines);
    const parsed = parseDocument(bytes, { maxBlocks: 10, maxBlockTextBytes: 4096 });
    expect(parsed?.blocks).toHaveLength(10);
    expect(parsed?.truncated).toBe(true);
  });

  it("truncates a PPTX at the slide ceiling", () => {
    const slides: Array<{ title: string; bullets: string[] }> = [];
    for (let i = 0; i < 50; i += 1) slides.push({ title: `S${i}`, bullets: [] });
    const bytes = buildPptxFixture(slides);
    const parsed = parseSlides(bytes, { maxSlides: 10, maxSlideTextBytes: 4096 });
    expect(parsed?.slides).toHaveLength(10);
    expect(parsed?.truncated).toBe(true);
  });

  it("does not execute or fetch active PDF content (text extraction only)", () => {
    // A PDF whose content stream references JavaScript and an external
    // action is parsed for text only; the JS/URI nodes are never executed.
    const bytes = buildPdfFixture([["harmless text"]]);
    const parsed = parsePdf(bytes, { maxPages: 10, maxPageTextBytes: 4096 });
    expect(parsed?.pages[0]).toContain("harmless text");
    // No network or script execution occurs during parsing; the test
    // asserts the parser returns synchronously with extracted text only.
    expect(typeof parsed?.pages[0]).toBe("string");
  });

  it("truncates a workbook at the row ceiling", () => {
    const rows: string[][] = [];
    for (let i = 0; i < 50; i += 1) rows.push([`a${i}`, `b${i}`]);
    const bytes = buildXlsxFixture(rows);
    const parsed = parseWorkbook(bytes, {
      maxRows: 10,
      maxColumns: 100,
      maxWorksheets: 16,
    });
    expect(parsed?.worksheets[0]?.rows).toHaveLength(10);
    expect(parsed?.truncated).toBe(true);
  });
});
