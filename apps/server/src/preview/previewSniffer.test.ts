import { describe, expect, it } from "vitest";
import { sniffPreviewKind, type PreviewSniffBudget } from "./previewSniffer";
import { buildDocxFixture, buildPptxFixture, buildXlsxFixture } from "./previewTestFixtures";

const budget: PreviewSniffBudget = {
  maxSniffBytes: 4096,
  maxByteSize: 50 * 1024 * 1024,
};

describe("sniffPreviewKind", () => {
  it("sniffs a PDF from the %PDF- magic number", () => {
    const bytes = Buffer.from("%PDF-1.7\n...", "utf-8");
    expect(sniffPreviewKind(bytes, "report.pdf", "application/pdf", budget)).toEqual({
      ok: true,
      kind: "pdf",
      mediaType: "application/pdf",
    });
  });

  it("sniffs a PNG from the magic number regardless of extension", () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(sniffPreviewKind(bytes, "photo.gif", "image/gif", budget)).toEqual({
      ok: true,
      kind: "image",
      mediaType: "image/png",
    });
  });

  it("sniffs a JPEG from the SOI marker", () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(sniffPreviewKind(bytes, "img.jpg", "image/jpeg", budget)).toEqual({
      ok: true,
      kind: "image",
      mediaType: "image/jpeg",
    });
  });

  it("sniffs a GIF from the magic number", () => {
    const bytes = Buffer.from("GIF89a", "utf-8");
    expect(sniffPreviewKind(bytes, "anim.gif", "image/gif", budget)).toEqual({
      ok: true,
      kind: "image",
      mediaType: "image/gif",
    });
  });

  it("sniffs a CSV from comma-delimited text content", () => {
    const bytes = Buffer.from("name,age,city\nAda,36,London\nGrace,85,New York\n", "utf-8");
    expect(sniffPreviewKind(bytes, "data.csv", "text/csv", budget)).toEqual({
      ok: true,
      kind: "table",
      mediaType: "text/csv",
    });
  });

  it("sniffs Markdown from a heading marker when the extension agrees", () => {
    const bytes = Buffer.from("# Heading\n\nSome **bold** text.\n", "utf-8");
    expect(sniffPreviewKind(bytes, "readme.md", "text/markdown", budget)).toEqual({
      ok: true,
      kind: "markdown",
      mediaType: "text/markdown",
    });
  });

  it("sniffs plain text for utf-8 content with no structural markers", () => {
    const bytes = Buffer.from("just some plain text without structure", "utf-8");
    expect(sniffPreviewKind(bytes, "notes.txt", "text/plain", budget)).toEqual({
      ok: true,
      kind: "text",
      mediaType: "text/plain",
    });
  });

  it("returns unsupported for an Office OOXML zip container (no native parser here)", () => {
    // ZIP local file header signature followed by garbage: not a valid
    // OOXML container, so classification falls back to unsupported.
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, ...new Uint8Array(60)]);
    expect(
      sniffPreviewKind(bytes, "sheet.xlsx", "application/vnd.openxmlformats...", budget),
    ).toEqual({
      ok: true,
      kind: "unsupported",
      mediaType: "application/vnd.openxmlformats...",
    });
  });

  it("classifies an XLSX container as workbook via content-type inspection", () => {
    const bytes = buildXlsxFixture([["a", "b"]]);
    expect(sniffPreviewKind(bytes, "sheet.xlsx", "application/octet-stream", budget)).toEqual({
      ok: true,
      kind: "workbook",
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
  });

  it("classifies a DOCX container as document via content-type inspection", () => {
    const bytes = buildDocxFixture(["Hello"]);
    expect(sniffPreviewKind(bytes, "doc.docx", "application/octet-stream", budget)).toEqual({
      ok: true,
      kind: "document",
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
  });

  it("classifies a PPTX container as slides via content-type inspection", () => {
    const bytes = buildPptxFixture([{ title: "T", bullets: ["b"] }]);
    expect(sniffPreviewKind(bytes, "deck.pptx", "application/octet-stream", budget)).toEqual({
      ok: true,
      kind: "slides",
      mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
  });

  it("classifies by content, not extension, so a renamed xlsx is still a workbook", () => {
    const bytes = buildXlsxFixture([["a", "b"]]);
    const result = sniffPreviewKind(bytes, "report.pdf", "application/pdf", budget);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.kind).toBe("workbook");
  });

  it("rejects a file exceeding the max byte size budget", () => {
    const bytes = Buffer.from("hello");
    expect(sniffPreviewKind(bytes, "big.txt", "text/plain", { ...budget, maxByteSize: 3 })).toEqual(
      {
        ok: false,
        code: "too-large",
      },
    );
  });

  it("returns unsupported for unrecognized binary content", () => {
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
    expect(sniffPreviewKind(bytes, "blob.bin", "application/octet-stream", budget)).toEqual({
      ok: true,
      kind: "unsupported",
      mediaType: "application/octet-stream",
    });
  });

  it("returns unsupported for invalid UTF-8 bytes with no NUL (not text)", () => {
    // 0xFF 0xFE is not valid UTF-8 and not a recognized magic number.
    const bytes = Buffer.from([0xff, 0xfe, 0x41, 0x42, 0x43, 0x44]);
    expect(sniffPreviewKind(bytes, "weird.txt", "text/plain", budget)).toEqual({
      ok: true,
      kind: "unsupported",
      mediaType: "text/plain",
    });
  });

  it("classifies a .md file as markdown even without heading/list markers", () => {
    const bytes = Buffer.from("just plain prose inside a markdown file\n", "utf-8");
    expect(sniffPreviewKind(bytes, "readme.md", "text/markdown", budget)).toEqual({
      ok: true,
      kind: "markdown",
      mediaType: "text/markdown",
    });
  });

  it("recognizes a TSV file as a table", () => {
    const bytes = Buffer.from("name\tage\tcity\nAda\t36\tLondon\nGrace\t85\tNew York\n", "utf-8");
    expect(sniffPreviewKind(bytes, "data.tsv", "text/tab-separated-values", budget)).toEqual({
      ok: true,
      kind: "table",
      mediaType: "text/tab-separated-values",
    });
  });

  it("recognizes a CSV file with quoted commas as a table", () => {
    const bytes = Buffer.from('name,note\nAda,"hello, world"\nGrace,"bye, sky"\n', "utf-8");
    expect(sniffPreviewKind(bytes, "data.csv", "text/csv", budget)).toEqual({
      ok: true,
      kind: "table",
      mediaType: "text/csv",
    });
  });
});
