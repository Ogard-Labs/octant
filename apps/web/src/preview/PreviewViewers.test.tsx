import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { PdfViewer } from "./PdfViewer";
import { TableViewer } from "./TableViewer";
import { WorkbookViewer } from "./WorkbookViewer";
import { DocumentViewer } from "./DocumentViewer";
import { SlidesViewer } from "./SlidesViewer";
import { renderPreviewViewer } from "./PreviewRegistry";
import { buildChunk, buildManifest } from "./previewViewTestModel";

describe("PdfViewer", () => {
  it("renders extracted page text with page navigation", async () => {
    const user = userEvent.setup();
    const manifest = buildManifest({
      kind: "pdf",
      displayName: "report.pdf",
      bounds: { pages: 2 },
    });
    const chunks = [
      buildChunk({
        kind: "pdf",
        sequence: 0,
        descriptor: { kind: "pdf", page: 1 },
        payload: { kind: "pdf", pageText: "Page one body" },
      }),
      buildChunk({
        kind: "pdf",
        sequence: 1,
        descriptor: { kind: "pdf", page: 2 },
        payload: { kind: "pdf", pageText: "Page two body" },
        isFinal: true,
      }),
    ];
    render(<PdfViewer manifest={manifest} chunks={chunks} />);
    expect(screen.getByRole("document", { name: "Page 1 text" })).toHaveTextContent(
      "Page one body",
    );
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByRole("document", { name: "Page 2 text" })).toHaveTextContent(
      "Page two body",
    );
  });

  it("supports keyboard navigation between extracted pages", async () => {
    const user = userEvent.setup();
    const manifest = buildManifest({
      kind: "pdf",
      displayName: "report.pdf",
      bounds: { pages: 2 },
    });
    const chunks = [
      buildChunk({
        kind: "pdf",
        sequence: 0,
        descriptor: { kind: "pdf", page: 1 },
        payload: { kind: "pdf", pageText: "Page one body" },
      }),
      buildChunk({
        kind: "pdf",
        sequence: 1,
        descriptor: { kind: "pdf", page: 2 },
        payload: { kind: "pdf", pageText: "Page two body" },
        isFinal: true,
      }),
    ];
    render(<PdfViewer manifest={manifest} chunks={chunks} />);

    const page = screen.getByRole("document", { name: "Page 1 text" });
    page.focus();
    await user.keyboard("{ArrowRight}");

    expect(screen.getByRole("document", { name: "Page 2 text" })).toHaveFocus();
  });

  it("surfaces the limited-fidelity notice", () => {
    const manifest = buildManifest({
      kind: "pdf",
      displayName: "report.pdf",
      fidelity: { level: "limited", notice: "Text extraction only." },
    });
    render(<PdfViewer manifest={manifest} chunks={[]} />);
    expect(screen.getByText("Text extraction only.")).toBeInTheDocument();
  });

  it("renders an empty state when no pages were extracted", () => {
    const manifest = buildManifest({ kind: "pdf", displayName: "empty.pdf" });
    render(<PdfViewer manifest={manifest} chunks={[]} />);
    expect(screen.getByText("No pages extracted.")).toBeInTheDocument();
  });
});

describe("TableViewer", () => {
  it("renders the row grid with sticky-header column labels", () => {
    const manifest = buildManifest({
      kind: "table",
      displayName: "data.csv",
      bounds: { rows: 3, columns: 2 },
    });
    const chunks = [
      buildChunk({
        kind: "table",
        sequence: 0,
        descriptor: { kind: "table", startRow: 1, endRow: 3 },
        payload: {
          kind: "table",
          rows: [
            ["name", "age"],
            ["Ada", "36"],
            ["Grace", "85"],
          ],
          delimiter: ",",
        },
        isFinal: true,
      }),
    ];
    render(<TableViewer manifest={manifest} chunks={chunks} />);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "name" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Ada" })).toBeInTheDocument();
    expect(screen.getByText("CSV")).toBeInTheDocument();
  });

  it("renders an empty state when no rows were parsed", () => {
    const manifest = buildManifest({ kind: "table", displayName: "empty.csv" });
    render(<TableViewer manifest={manifest} chunks={[]} />);
    expect(screen.getByText("No rows parsed.")).toBeInTheDocument();
  });
});

describe("WorkbookViewer", () => {
  it("renders worksheet tabs and the active worksheet grid", async () => {
    const user = userEvent.setup();
    const manifest = buildManifest({
      kind: "workbook",
      displayName: "sheet.xlsx",
      bounds: { worksheets: 2, rows: 2, columns: 2 },
    });
    const chunks = [
      buildChunk({
        kind: "workbook",
        sequence: 0,
        descriptor: {
          kind: "workbook",
          worksheet: 1,
          startRow: 1,
          endRow: 2,
          startColumn: 1,
          endColumn: 2,
        },
        payload: {
          kind: "workbook",
          worksheetName: "First",
          rows: [
            ["a", "b"],
            ["1", "2"],
          ],
        },
      }),
      buildChunk({
        kind: "workbook",
        sequence: 1,
        descriptor: {
          kind: "workbook",
          worksheet: 2,
          startRow: 1,
          endRow: 2,
          startColumn: 1,
          endColumn: 1,
        },
        payload: { kind: "workbook", worksheetName: "Second", rows: [["x"], ["y"]] },
        isFinal: true,
      }),
    ];
    render(<WorkbookViewer manifest={manifest} chunks={chunks} />);
    expect(screen.getByRole("tab", { name: "First" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("columnheader", { name: "a" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "1" })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Second" }));
    expect(screen.getByRole("tab", { name: "Second" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("columnheader", { name: "x" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "y" })).toBeInTheDocument();
  });

  it("supports keyboard navigation between worksheet tabs and exposes a tab panel", async () => {
    const user = userEvent.setup();
    const manifest = buildManifest({
      kind: "workbook",
      displayName: "sheet.xlsx",
      bounds: { worksheets: 2, rows: 1, columns: 1 },
    });
    const chunks = [
      buildChunk({
        kind: "workbook",
        sequence: 0,
        descriptor: {
          kind: "workbook",
          worksheet: 1,
          startRow: 1,
          endRow: 1,
          startColumn: 1,
          endColumn: 1,
        },
        payload: { kind: "workbook", worksheetName: "First", rows: [["a"]] },
      }),
      buildChunk({
        kind: "workbook",
        sequence: 1,
        descriptor: {
          kind: "workbook",
          worksheet: 2,
          startRow: 1,
          endRow: 1,
          startColumn: 1,
          endColumn: 1,
        },
        payload: { kind: "workbook", worksheetName: "Second", rows: [["b"]] },
        isFinal: true,
      }),
    ];
    render(<WorkbookViewer manifest={manifest} chunks={chunks} />);

    const first = screen.getByRole("tab", { name: "First" });
    first.focus();
    await user.keyboard("{ArrowRight}");

    expect(screen.getByRole("tab", { name: "Second" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Second" })).toHaveFocus();
    expect(screen.getByRole("tabpanel", { name: "Second" })).toBeInTheDocument();
  });
});

describe("DocumentViewer", () => {
  it("renders paragraph blocks in document order", () => {
    const manifest = buildManifest({
      kind: "document",
      displayName: "doc.docx",
      bounds: { blocks: 2 },
    });
    const chunks = [
      buildChunk({
        kind: "document",
        sequence: 0,
        descriptor: { kind: "document", blockIndex: 0 },
        payload: { kind: "document", text: "Title" },
      }),
      buildChunk({
        kind: "document",
        sequence: 1,
        descriptor: { kind: "document", blockIndex: 1 },
        payload: { kind: "document", text: "Body paragraph." },
        isFinal: true,
      }),
    ];
    render(<DocumentViewer manifest={manifest} chunks={chunks} />);
    const blocks = screen.getAllByText(/Title|Body paragraph\./);
    expect(blocks).toHaveLength(2);
  });
});

describe("SlidesViewer", () => {
  it("renders slide title and body with slide navigation", async () => {
    const user = userEvent.setup();
    const manifest = buildManifest({
      kind: "slides",
      displayName: "deck.pptx",
      bounds: { slides: 2 },
    });
    const chunks = [
      buildChunk({
        kind: "slides",
        sequence: 0,
        descriptor: { kind: "slides", slide: 1 },
        payload: { kind: "slides", slideText: "Intro\nfirst bullet" },
      }),
      buildChunk({
        kind: "slides",
        sequence: 1,
        descriptor: { kind: "slides", slide: 2 },
        payload: { kind: "slides", slideText: "Demo\nstep one" },
        isFinal: true,
      }),
    ];
    render(<SlidesViewer manifest={manifest} chunks={chunks} />);
    expect(screen.getByRole("heading", { name: "Intro" })).toBeInTheDocument();
    expect(screen.getByText("first bullet")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next slide" }));
    expect(screen.getByRole("heading", { name: "Demo" })).toBeInTheDocument();
  });

  it("supports keyboard navigation between slides", async () => {
    const user = userEvent.setup();
    const manifest = buildManifest({
      kind: "slides",
      displayName: "deck.pptx",
      bounds: { slides: 2 },
    });
    const chunks = [
      buildChunk({
        kind: "slides",
        sequence: 0,
        descriptor: { kind: "slides", slide: 1 },
        payload: { kind: "slides", slideText: "Intro\nfirst bullet" },
      }),
      buildChunk({
        kind: "slides",
        sequence: 1,
        descriptor: { kind: "slides", slide: 2 },
        payload: { kind: "slides", slideText: "Demo\nstep one" },
        isFinal: true,
      }),
    ];
    render(<SlidesViewer manifest={manifest} chunks={chunks} />);

    const first = screen.getByRole("document", { name: "Slide 1 text" });
    first.focus();
    await user.keyboard("{ArrowRight}");

    expect(screen.getByRole("document", { name: "Slide 2 text" })).toHaveFocus();
  });
});

describe("renderPreviewViewer", () => {
  it("dispatches to the PDF viewer for pdf kind", () => {
    const manifest = buildManifest({ kind: "pdf", displayName: "report.pdf" });
    const chunks = [
      buildChunk({
        kind: "pdf",
        sequence: 0,
        descriptor: { kind: "pdf", page: 1 },
        payload: { kind: "pdf", pageText: "body" },
        isFinal: true,
      }),
    ];
    const { container } = render(<>{renderPreviewViewer({ manifest, chunks })}</>);
    expect(container.querySelector(".preview-pdf__page")).toBeInTheDocument();
  });

  it("renders an honest unsupported state for unknown kinds", () => {
    const manifest = buildManifest({ kind: "unsupported", displayName: "blob.bin" });
    const { container } = render(<>{renderPreviewViewer({ manifest, chunks: [] })}</>);
    expect(container.querySelector(".preview-empty")).toBeInTheDocument();
  });
});
