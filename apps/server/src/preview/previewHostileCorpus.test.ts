import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writeWorkZip } from "../work/workZipPort";
import { parseDocument } from "./previewDocumentChunker";
import {
  MAX_PREVIEW_CHUNK_TEXT_BYTES,
  MAX_PREVIEW_DOCUMENT_BLOCKS,
  MAX_PREVIEW_PDF_PAGES,
  MAX_PREVIEW_SLIDES,
  MAX_PREVIEW_TABLE_COLUMNS,
  MAX_PREVIEW_TABLE_ROWS,
  MAX_PREVIEW_WORKBOOK_COLUMNS,
  MAX_PREVIEW_WORKBOOK_ROWS,
  MAX_PREVIEW_WORKBOOK_WORKSHEETS,
} from "./previewFormatBudget";
import { parsePdf } from "./previewPdfChunker";
import { parseSlides } from "./previewSlidesChunker";
import { inferTableDelimiter, parseTable } from "./previewTableChunker";
import { parseWorkbook } from "./previewWorkbookChunker";
import {
  buildDocxFixture,
  buildPdfFixture,
  buildPptxFixture,
  buildXlsxFixture,
} from "./previewTestFixtures";
import { sniffPreviewKind } from "./previewSniffer";

const textEncoder = new TextEncoder();
const sniffBudget = { maxSniffBytes: 4096, maxByteSize: 16 * 1024 * 1024 };
const MAX_EXTERNAL_FILES = 128;
const MAX_EXTERNAL_FILE_BYTES = 16 * 1024 * 1024;

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function forgeCentralUncompressedSize(bytes: Uint8Array, size: number): Uint8Array {
  const copy = Uint8Array.from(bytes);
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  for (let i = copy.byteLength - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) !== 0x06054b50) continue;
    const centralOffset = view.getUint32(i + 16, true);
    view.setUint32(centralOffset + 24, size, true);
    return copy;
  }
  throw new Error("fixture is missing an end-of-central-directory record");
}

function collectFiles(root: string, maxFiles: number): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    if (files.length >= maxFiles) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (files.length >= maxFiles) break;
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(root);
  return files;
}

function inspectStructuredBytes(
  bytes: Uint8Array,
  kind: "pdf" | "table" | "workbook" | "document" | "slides",
  mediaType: string,
): void {
  switch (kind) {
    case "pdf":
      parsePdf(bytes, {
        maxPages: MAX_PREVIEW_PDF_PAGES,
        maxPageTextBytes: MAX_PREVIEW_CHUNK_TEXT_BYTES,
      });
      return;
    case "table": {
      const text = Buffer.from(bytes).toString("utf-8");
      const delimiter =
        mediaType === "text/tab-separated-values" ? "\t" : (inferTableDelimiter(text) ?? ",");
      parseTable(text, delimiter, {
        maxRows: MAX_PREVIEW_TABLE_ROWS,
        maxColumns: MAX_PREVIEW_TABLE_COLUMNS,
      });
      return;
    }
    case "workbook":
      parseWorkbook(bytes, {
        maxRows: MAX_PREVIEW_WORKBOOK_ROWS,
        maxColumns: MAX_PREVIEW_WORKBOOK_COLUMNS,
        maxWorksheets: MAX_PREVIEW_WORKBOOK_WORKSHEETS,
      });
      return;
    case "document":
      parseDocument(bytes, {
        maxBlocks: MAX_PREVIEW_DOCUMENT_BLOCKS,
        maxBlockTextBytes: MAX_PREVIEW_CHUNK_TEXT_BYTES,
      });
      return;
    case "slides":
      parseSlides(bytes, {
        maxSlides: MAX_PREVIEW_SLIDES,
        maxSlideTextBytes: MAX_PREVIEW_CHUNK_TEXT_BYTES,
      });
      return;
  }
}

describe("preview hostile corpus and resource budgets", () => {
  const unsafeZip = writeWorkZip([{ name: "../outside.xml", data: textEncoder.encode("outside") }]);
  const duplicateZip = writeWorkZip([
    { name: "xl/workbook.xml", data: textEncoder.encode("first") },
    { name: "xl/workbook.xml", data: textEncoder.encode("second") },
  ]);
  const decompressionBomb = forgeCentralUncompressedSize(
    writeWorkZip([{ name: "xl/workbook.xml", data: textEncoder.encode("small") }]),
    32 * 1024 * 1024,
  );
  const malformedZip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00]);

  it.each([
    ["unsafe traversal entry", unsafeZip],
    ["duplicate entry", duplicateZip],
    ["decompression budget", decompressionBomb],
    ["truncated container", malformedZip],
  ])("classifies %s as unsupported without mutating bytes", (_name, bytes) => {
    const before = digest(bytes);
    let result: ReturnType<typeof sniffPreviewKind> | undefined;
    expect(() => {
      result = sniffPreviewKind(bytes, "hostile.xlsx", "application/octet-stream", sniffBudget);
    }).not.toThrow();
    expect(result?.ok).toBe(true);
    if (result?.ok) expect(result.kind).toBe("unsupported");
    expect(digest(bytes)).toBe(before);
  });

  it("rejects oversized corpus input before parsing", () => {
    const bytes = Buffer.alloc(sniffBudget.maxByteSize + 1, 0x41);
    expect(sniffPreviewKind(bytes, "hostile.bin", "application/octet-stream", sniffBudget)).toEqual(
      {
        ok: false,
        code: "too-large",
      },
    );
  });

  it("keeps every representative parser inside its configured structural budget", () => {
    const table = parseTable(
      Array.from({ length: 8 }, (_, index) => `${index},value`).join("\n"),
      ",",
      { maxRows: 3, maxColumns: 2 },
    );
    expect(table.rows).toHaveLength(3);
    expect(table.truncated).toBe(true);

    const workbook = parseWorkbook(
      buildXlsxFixture(Array.from({ length: 8 }, (_, index) => [`row-${index}`])),
      { maxRows: 3, maxColumns: 2, maxWorksheets: 1 },
    );
    expect(workbook?.worksheets[0]?.rows).toHaveLength(3);
    expect(workbook?.truncated).toBe(true);

    const document = parseDocument(
      buildDocxFixture(Array.from({ length: 8 }, (_, index) => `paragraph-${index}`)),
      { maxBlocks: 3, maxBlockTextBytes: 4096 },
    );
    expect(document?.blocks).toHaveLength(3);
    expect(document?.truncated).toBe(true);

    const slides = parseSlides(
      buildPptxFixture(
        Array.from({ length: 8 }, (_, index) => ({ title: `slide-${index}`, bullets: [] })),
      ),
      { maxSlides: 3, maxSlideTextBytes: 4096 },
    );
    expect(slides?.slides).toHaveLength(3);
    expect(slides?.truncated).toBe(true);

    const pdf = parsePdf(
      buildPdfFixture(Array.from({ length: 8 }, (_, index) => [`page-${index}`])),
      {
        maxPages: 3,
        maxPageTextBytes: 4096,
      },
    );
    expect(pdf?.pages).toHaveLength(3);
    expect(pdf?.truncated).toBe(true);
  });

  it("does not execute active PDF content or make network requests", () => {
    const bytes = Buffer.concat([
      Buffer.from(buildPdfFixture([["static text"]])),
      Buffer.from(
        "\n/OpenAction << /S /JavaScript /JS (fetch('https://example.invalid')) >> /URI (https://example.invalid)",
      ),
    ]);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const parsed = parsePdf(bytes, { maxPages: 10, maxPageTextBytes: 4096 });
      expect(parsed?.pages[0]).toContain("static text");
    } finally {
      fetchSpy.mockRestore();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  const externalCorpusRoot = process.env.OCTANT_PREVIEW_HOSTILE_CORPUS;
  const externalCorpus = externalCorpusRoot === undefined ? it.skip : it;
  externalCorpus(
    "scans an explicitly supplied hostile corpus without source mutation or network access",
    () => {
      const files = collectFiles(resolve(externalCorpusRoot!), MAX_EXTERNAL_FILES);
      expect(files.length).toBeGreaterThan(0);
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      let observed = 0;
      try {
        for (const path of files) {
          observed += 1;
          const size = statSync(path).size;
          if (size > MAX_EXTERNAL_FILE_BYTES) continue;
          const bytes = readFileSync(path);
          const before = digest(bytes);
          const sniffed = sniffPreviewKind(
            bytes,
            basename(path),
            "application/octet-stream",
            sniffBudget,
          );
          if (
            sniffed.ok &&
            (sniffed.kind === "pdf" ||
              sniffed.kind === "table" ||
              sniffed.kind === "workbook" ||
              sniffed.kind === "document" ||
              sniffed.kind === "slides")
          ) {
            inspectStructuredBytes(bytes, sniffed.kind, sniffed.mediaType);
          }
          expect(digest(readFileSync(path))).toBe(before);
        }
      } finally {
        fetchSpy.mockRestore();
      }
      expect(observed).toBe(files.length);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );
});
