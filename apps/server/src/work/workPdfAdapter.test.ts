import { describe, expect, it } from "vitest";
import { workPdfAdapter } from "./workPdfAdapter";

const textDecoder = new TextDecoder("utf-8", { fatal: false });

describe("workPdfAdapter", () => {
  it("encode produces bytes starting with %PDF-1.4", () => {
    const bytes = workPdfAdapter.encode("Line one\nLine two");
    const header = textDecoder.decode(bytes.subarray(0, 8));
    expect(header).toBe("%PDF-1.4");
  });

  it("the generated PDF contains the xref table and trailer with /Root", () => {
    const bytes = workPdfAdapter.encode("Hello world");
    const text = textDecoder.decode(bytes);
    expect(text).toContain("xref");
    expect(text).toContain("trailer");
    expect(text).toContain("/Root 1 0 R");
    expect(text).toContain("startxref");
    expect(text).toContain("%%EOF");
  });

  it("the generated PDF contains a Catalog, Pages tree, Page, and Helvetica font", () => {
    const bytes = workPdfAdapter.encode("Body text\nSecond line");
    const text = textDecoder.decode(bytes);
    expect(text).toContain("/Type /Catalog");
    expect(text).toContain("/Type /Pages");
    expect(text).toContain("/Type /Page");
    expect(text).toContain("/Type /Font");
    expect(text).toContain("/BaseFont /Helvetica");
    expect(text).toContain("/Subtype /Type1");
  });

  it("escapes PDF string special characters in text content", () => {
    const bytes = workPdfAdapter.encode("line (with) parens \\backslash");
    const text = textDecoder.decode(bytes);
    expect(text).toContain("line \\(with\\) parens \\\\backslash");
  });

  it("paginates content across multiple pages after 50 lines", () => {
    const lines = Array.from({ length: 55 }, (_, i) => `line ${i}`);
    const bytes = workPdfAdapter.encode(lines.join("\n"));
    const text = textDecoder.decode(bytes);
    // Two pages => two Page objects and two content streams.
    const pageMatches = text.match(/\/Type \/Page\b/g) ?? [];
    expect(pageMatches.length).toBe(2);
    expect(text).toContain("/Count 2");
  });

  it("decode always returns undefined", () => {
    const bytes = workPdfAdapter.encode("anything");
    expect(workPdfAdapter.decode(bytes)).toBeUndefined();
  });

  it("convertTo(pdf, bytes) returns the same bytes", () => {
    const bytes = workPdfAdapter.encode("content");
    const result = workPdfAdapter.convertTo("pdf", bytes);
    expect(result).toBe(bytes);
  });

  it("convertTo(image, bytes) returns undefined", () => {
    const bytes = workPdfAdapter.encode("content");
    expect(workPdfAdapter.convertTo("image", bytes)).toBeUndefined();
  });

  it("reports canMutate true (rename/delete/revise), canRoundTrip false, canCreate true", () => {
    expect(workPdfAdapter.capabilities.canMutate).toBe(true);
    expect(workPdfAdapter.capabilities.canRoundTrip).toBe(false);
    expect(workPdfAdapter.capabilities.canCreate).toBe(true);
    expect(workPdfAdapter.capabilities.canExport).toBe(true);
    expect(workPdfAdapter.capabilities.canRead).toBe(true);
    expect(workPdfAdapter.capabilities.canVersion).toBe(true);
  });

  it("has empty exportFormats", () => {
    expect(workPdfAdapter.exportFormats).toEqual([]);
  });

  it("encode throws when line count exceeds the limit", () => {
    // 600000 newlines => 600001 lines, under 16 MiB input but over MAX_PDF_LINES.
    const content = "\n".repeat(600_000);
    expect(() => workPdfAdapter.encode(content)).toThrow();
  });

  it("rejects text that cannot be represented without silent loss", () => {
    expect(() => workPdfAdapter.encode("日本語")).toThrow("cannot be represented without loss");
  });

  it("encode preserves ASCII text (WinAnsi-safe)", () => {
    const bytes = workPdfAdapter.encode("Hello");
    const text = textDecoder.decode(bytes);
    expect(text).toContain("Hello");
  });

  it("encodes Latin-1 characters as single-byte WinAnsi (not UTF-8 mojibake)", () => {
    // `é` (U+00E9) is in the WinAnsi range. UTF-8 would emit 0xC3 0xA9 (two
    // bytes); WinAnsi/Latin-1 emits 0xE9 (one byte). The PDF font declares
    // /WinAnsiEncoding, so the single-byte form is correct.
    const bytes = workPdfAdapter.encode("café");
    let foundWinAnsiE9 = false;
    let foundUtf8Sequence = false;
    for (let i = 0; i < bytes.length; i += 1) {
      if (bytes[i] === 0xe9) foundWinAnsiE9 = true;
      if (i + 1 < bytes.length && bytes[i] === 0xc3 && bytes[i + 1] === 0xa9) {
        foundUtf8Sequence = true;
      }
    }
    expect(foundWinAnsiE9).toBe(true);
    expect(foundUtf8Sequence).toBe(false);
  });
});
