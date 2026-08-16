/**
 * Shared resource budgets for the structured-document and data preview
 * parsers (PDF, CSV/TSV, XLSX, DOCX, PPTX). Each parser enforces its own
 * per-format ceilings on top of these shared limits so a crafted or
 * externally modified source cannot exhaust memory, decompression, or
 * output budgets before the manifest/chunk pipeline can reject it.
 *
 * The budgets are deliberately smaller than the file-size budget enforced
 * by `producePreviewManifest`: row, cell, page, slide, and block counts
 * amplify in-memory representation far beyond raw byte size, so a source
 * well under the byte budget can still expand into an unbounded grid or
 * text buffer during parsing.
 */

/**
 * Maximum rows emitted for a single table (CSV/TSV) source. A CSV under
 * the byte budget can still contain millions of tiny rows; bounding the
 * emitted row count keeps the preview bounded and lets the manifest's
 * `limited` fidelity signal truncation honestly.
 */
export const MAX_PREVIEW_TABLE_ROWS = 100_000;

/**
 * Maximum columns emitted for a single table row. A malformed or hostile
 * CSV can declare thousands of fields on one line; bounding the column
 * count prevents a single row from expanding into an enormous array.
 */
export const MAX_PREVIEW_TABLE_COLUMNS = 1_000;

/**
 * Maximum rows decoded from a single XLSX worksheet. Spreadsheet
 * worksheets can reference row indices up to 1,048,576; bounding the
 * decoded row count prevents sparse worksheets from allocating enormous
 * padded grids.
 */
export const MAX_PREVIEW_WORKBOOK_ROWS = 100_000;

/**
 * Maximum columns decoded from a single XLSX worksheet.
 */
export const MAX_PREVIEW_WORKBOOK_COLUMNS = 1_000;

/**
 * Maximum worksheets decoded from a single workbook. A crafted container
 * could declare thousands of sheet parts; bounding the count keeps the
 * worksheet tab set bounded.
 */
export const MAX_PREVIEW_WORKBOOK_WORKSHEETS = 256;

/**
 * Maximum pages extracted from a single PDF. A crafted PDF can declare
 * thousands of page objects; bounding the page count keeps the preview
 * bounded and the per-page text extraction honest.
 */
export const MAX_PREVIEW_PDF_PAGES = 10_000;

/**
 * Maximum slides decoded from a single PPTX presentation.
 */
export const MAX_PREVIEW_SLIDES = 10_000;

/**
 * Maximum document blocks (paragraphs) decoded from a single DOCX.
 */
export const MAX_PREVIEW_DOCUMENT_BLOCKS = 100_000;

/**
 * Maximum bytes of extracted text emitted for a single page, slide, or
 * document block. A crafted source can embed a single enormous text run;
 * bounding the emitted text keeps each chunk's payload bounded.
 */
export const MAX_PREVIEW_CHUNK_TEXT_BYTES = 256 * 1024;

/**
 * Default rows per chunk for table and workbook sources. Chunking keeps
 * each `PreviewChunk` payload bounded so the transport can page rows on
 * demand without materializing the whole grid.
 */
export const DEFAULT_PREVIEW_ROWS_PER_CHUNK = 500;
