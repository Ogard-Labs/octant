import type { WorkbookCellValue } from "@octant/contracts/previews";
import { DEFAULT_DOCUMENT_BUDGET, parseDocument } from "../preview/previewDocumentChunker";
import { DEFAULT_PDF_BUDGET, parsePdf } from "../preview/previewPdfChunker";
import { sniffPreviewKind } from "../preview/previewSniffer";
import { DEFAULT_SLIDES_BUDGET, parseSlides } from "../preview/previewSlidesChunker";
import { DEFAULT_WORKBOOK_BUDGET, parseWorkbook } from "../preview/previewWorkbookChunker";

/** The office formats and PDFs `read` returns as text, named as the model sees them. */
export type NativeHarnessReadFormat = "pdf" | "docx" | "pptx" | "xlsx";

/** How far into a file the text-or-binary check looks, as the preview sniffer does. */
const SNIFF_BYTES = 4096;

export type NativeHarnessFileText =
  /** Read the bytes as UTF-8 text. */
  | { readonly kind: "text" }
  | {
      readonly kind: "extracted";
      readonly format: NativeHarnessReadFormat;
      readonly text: string;
      /** The preview parser's page, block, row, column or sheet limit cut the file. */
      readonly truncated: boolean;
      /** The file parsed but held no text, such as a scanned PDF. */
      readonly empty: boolean;
    }
  | { readonly kind: "binary"; readonly message: string };

const BINARY_MESSAGE =
  "This is a binary file, so it is not returned as text. read returns text files, images, PDFs, and Word (.docx), PowerPoint (.pptx) and Excel (.xlsx) files.";

/**
 * Recognizes a file by its content, with the same sniffer and parsers as
 * file previews, and returns a PDF or an Office file as text. A file the
 * sniffer cannot place is binary only when its first bytes hold a NUL, as
 * every archive, database, media file and executable does; text in another
 * encoding still reads as before, decoded leniently.
 */
export function nativeHarnessFileText(content: Buffer, path: string): NativeHarnessFileText {
  const sniffed = sniffPreviewKind(content, path, "", {
    maxSniffBytes: SNIFF_BYTES,
    maxByteSize: Number.POSITIVE_INFINITY,
  });
  if (!sniffed.ok) return { kind: "binary", message: BINARY_MESSAGE };
  switch (sniffed.kind) {
    case "pdf": {
      const parsed = parsePdf(content, DEFAULT_PDF_BUDGET);
      if (parsed === undefined) return unreadable("PDF");
      // The parser stops a page's text at its byte limit without saying so.
      const pageCut = parsed.pages.some(
        (page) => Buffer.byteLength(page, "utf8") >= DEFAULT_PDF_BUDGET.maxPageTextBytes,
      );
      return extracted(
        "pdf",
        parsed.pages.map((page, index) => `[Page ${index + 1}]\n${page.trim()}`),
        parsed.truncated || pageCut,
        parsed.pages.every((page) => page.trim().length === 0),
      );
    }
    case "document": {
      const parsed = parseDocument(content, DEFAULT_DOCUMENT_BUDGET);
      if (parsed === undefined) return unreadable("Word document");
      return {
        kind: "extracted",
        format: "docx",
        text: parsed.blocks.join("\n"),
        truncated: parsed.truncated,
        empty: parsed.blocks.every((block) => block.trim().length === 0),
      };
    }
    case "slides": {
      const parsed = parseSlides(content, DEFAULT_SLIDES_BUDGET);
      if (parsed === undefined) return unreadable("PowerPoint file");
      return extracted(
        "pptx",
        parsed.slides.map((slide, index) => `[Slide ${index + 1}]\n${slide.trim()}`),
        parsed.truncated,
        parsed.slides.every((slide) => slide.trim().length === 0),
      );
    }
    case "workbook": {
      const parsed = parseWorkbook(content, DEFAULT_WORKBOOK_BUDGET);
      if (parsed === undefined) return unreadable("Excel workbook");
      return extracted(
        "xlsx",
        parsed.worksheets.map((sheet) =>
          [`[Sheet: ${sheet.name}]`, ...sheet.rows.map((row) => row.map(cellText).join("\t"))].join(
            "\n",
          ),
        ),
        parsed.truncated,
        parsed.worksheets.every((sheet) => sheet.rows.length === 0),
      );
    }
    case "unsupported":
      return content.subarray(0, SNIFF_BYTES).includes(0)
        ? { kind: "binary", message: BINARY_MESSAGE }
        : { kind: "text" };
    case "text":
    case "markdown":
    case "table":
      return { kind: "text" };
    case "image":
      // read recognizes the images it returns before asking here.
      return { kind: "binary", message: BINARY_MESSAGE };
  }
}

function extracted(
  format: NativeHarnessReadFormat,
  sections: ReadonlyArray<string>,
  truncated: boolean,
  empty: boolean,
): NativeHarnessFileText {
  return { kind: "extracted", format, text: sections.join("\n\n"), truncated, empty };
}

function unreadable(name: string): NativeHarnessFileText {
  return {
    kind: "binary",
    message: `This looks like a ${name}, but its text could not be read; the file may be damaged or use a form the reader does not support.`,
  };
}

/** One cell per tab-separated column, kept on its row's line. */
function cellText(cell: WorkbookCellValue): string {
  return cell === null ? "" : String(cell).replace(/[\t\r\n]+/g, " ");
}
