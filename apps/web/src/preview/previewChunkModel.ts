import type { PreviewChunk, PreviewDelimiter, WorkbookCellValue } from "@octant/contracts/previews";

/**
 * Accumulated PDF view model: per-page extracted text in page order.
 */
export interface PdfViewModel {
  readonly pages: ReadonlyArray<string>;
}

/**
 * Accumulated table view model: the full row grid and detected delimiter.
 */
export interface TableViewModel {
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
  readonly delimiter: PreviewDelimiter;
}

/**
 * Accumulated workbook view model: ordered worksheets of cell grids.
 */
export interface WorkbookViewModel {
  readonly worksheets: ReadonlyArray<{
    readonly name: string;
    readonly rows: ReadonlyArray<ReadonlyArray<WorkbookCellValue>>;
  }>;
}

/**
 * Accumulated document view model: paragraph text blocks in order.
 */
export interface DocumentViewModel {
  readonly blocks: ReadonlyArray<string>;
}

/**
 * Accumulated slides view model: slide text in slide order.
 */
export interface SlidesViewModel {
  readonly slides: ReadonlyArray<string>;
}

/**
 * Build a PDF view model from chunks by indexing page text on the
 * `page` descriptor. Chunks arrive in sequence order but are placed by
 * page number so out-of-order or paginated delivery still renders
 * correctly.
 */
export function buildPdfViewModel(chunks: ReadonlyArray<PreviewChunk>): PdfViewModel {
  const pages = new Map<number, string>();
  let maxPage = 0;
  for (const chunk of chunks) {
    if (chunk.payload.kind !== "pdf") continue;
    if (chunk.descriptor.kind !== "pdf") continue;
    const page = chunk.descriptor.page;
    pages.set(page, chunk.payload.pageText);
    if (page > maxPage) maxPage = page;
  }
  const ordered: string[] = [];
  for (let p = 1; p <= maxPage; p += 1) ordered.push(pages.get(p) ?? "");
  return { pages: ordered };
}

/**
 * Build a table view model by concatenating chunk row windows in
 * sequence order. The delimiter is taken from the first chunk.
 */
export function buildTableViewModel(chunks: ReadonlyArray<PreviewChunk>): TableViewModel {
  const rows: string[][] = [];
  let delimiter: PreviewDelimiter = ",";
  for (const chunk of chunks) {
    if (chunk.payload.kind !== "table") continue;
    const chunkDelimiter = chunk.payload.delimiter as PreviewDelimiter;
    if (
      chunkDelimiter === "," ||
      chunkDelimiter === "\t" ||
      chunkDelimiter === ";" ||
      chunkDelimiter === "|"
    ) {
      delimiter = chunkDelimiter;
    }
    for (const row of chunk.payload.rows) rows.push([...row]);
  }
  return { rows, delimiter };
}

/**
 * Build a workbook view model by grouping chunk rows under their
 * worksheet index, preserving worksheet order and the worksheet name
 * from the first chunk of each worksheet.
 */
export function buildWorkbookViewModel(chunks: ReadonlyArray<PreviewChunk>): WorkbookViewModel {
  const worksheets = new Map<number, { name: string; rows: WorkbookCellValue[][] }>();
  for (const chunk of chunks) {
    if (chunk.payload.kind !== "workbook") continue;
    if (chunk.descriptor.kind !== "workbook") continue;
    const index = chunk.descriptor.worksheet;
    let entry = worksheets.get(index);
    if (entry === undefined) {
      entry = { name: chunk.payload.worksheetName, rows: [] };
      worksheets.set(index, entry);
    }
    for (const row of chunk.payload.rows) entry.rows.push([...row]);
  }
  const ordered = [...worksheets.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value);
  return { worksheets: ordered };
}

/**
 * Build a document view model by indexing paragraph blocks on the
 * `blockIndex` descriptor.
 */
export function buildDocumentViewModel(chunks: ReadonlyArray<PreviewChunk>): DocumentViewModel {
  const blocks = new Map<number, string>();
  let maxIndex = -1;
  for (const chunk of chunks) {
    if (chunk.payload.kind !== "document") continue;
    if (chunk.descriptor.kind !== "document") continue;
    const index = chunk.descriptor.blockIndex;
    blocks.set(index, chunk.payload.text);
    if (index > maxIndex) maxIndex = index;
  }
  const ordered: string[] = [];
  for (let i = 0; i <= maxIndex; i += 1) ordered.push(blocks.get(i) ?? "");
  return { blocks: ordered };
}

/**
 * Build a slides view model by indexing slide text on the `slide`
 * descriptor.
 */
export function buildSlidesViewModel(chunks: ReadonlyArray<PreviewChunk>): SlidesViewModel {
  const slides = new Map<number, string>();
  let maxSlide = 0;
  for (const chunk of chunks) {
    if (chunk.payload.kind !== "slides") continue;
    if (chunk.descriptor.kind !== "slides") continue;
    const slide = chunk.descriptor.slide;
    slides.set(slide, chunk.payload.slideText);
    if (slide > maxSlide) maxSlide = slide;
  }
  const ordered: string[] = [];
  for (let s = 1; s <= maxSlide; s += 1) ordered.push(slides.get(s) ?? "");
  return { slides: ordered };
}
