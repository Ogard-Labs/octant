import { describe, expect, it } from "vitest";
import { readWorkZip } from "./workZipPort";
import { WorkAdapterBudgetError, getWorkFormatAdapter } from "./workFormatAdapter";
import { MAX_WORK_OUTPUT_BYTES } from "./workBudget";
import "./workDocxAdapter";

const textDecoder = new TextDecoder("utf-8", { fatal: false });

describe("workDocxAdapter", () => {
  const adapter = getWorkFormatAdapter("docx");

  it("is registered for the docx format", () => {
    expect(adapter).toBeDefined();
    expect(adapter?.format).toBe("docx");
  });

  it("encodes content into a ZIP container beginning with the PK local file header magic", () => {
    expect(adapter).toBeDefined();
    if (adapter === undefined) return;
    const bytes = adapter.encode("# Hello\nWorld");
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
  });

  it("produces a container with the required OOXML parts", () => {
    expect(adapter).toBeDefined();
    if (adapter === undefined) return;
    const entries = readWorkZip(adapter.encode("# Hello\nWorld"));
    expect(entries.has("word/document.xml")).toBe(true);
    expect(entries.has("[Content_Types].xml")).toBe(true);
    expect(entries.has("_rels/.rels")).toBe(true);
    expect(entries.has("word/_rels/document.xml.rels")).toBe(true);
  });

  it("round-trips multi-paragraph text through encode and decode", () => {
    expect(adapter).toBeDefined();
    if (adapter === undefined) return;
    const text = "# Hello\nWorld\nFinal line";
    expect(adapter.decode(adapter.encode(text))).toBe(text);
  });

  it("preserves intentional blank paragraphs through encode and decode", () => {
    expect(adapter).toBeDefined();
    if (adapter === undefined) return;
    const text = "Intro\n\nNext";
    expect(adapter.decode(adapter.encode(text))).toBe(text);
  });

  it("escapes XML special characters in the encoded document", () => {
    expect(adapter).toBeDefined();
    if (adapter === undefined) return;
    const text = "a & b < c > d \" e ' f";
    expect(adapter.decode(adapter.encode(text))).toBe(text);
  });

  it("returns undefined when decoding a non-ZIP byte array", () => {
    expect(adapter).toBeDefined();
    if (adapter === undefined) return;
    const notZip = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
    expect(adapter.decode(notZip)).toBeUndefined();
  });

  it("converts to markdown by decoding the document into UTF-8 bytes", () => {
    expect(adapter).toBeDefined();
    if (adapter === undefined) return;
    const text = "# Hello\nWorld";
    const markdown = adapter.convertTo("markdown", adapter.encode(text));
    expect(markdown).toBeDefined();
    if (markdown === undefined) return;
    expect(textDecoder.decode(markdown)).toBe(text);
  });

  it("returns undefined for an unsupported conversion target", () => {
    expect(adapter).toBeDefined();
    if (adapter === undefined) return;
    const bytes = adapter.encode("# Hello\nWorld");
    expect(adapter.convertTo("csv", bytes)).toBeUndefined();
  });

  it("returns the source bytes unchanged for a same-format docx conversion", () => {
    expect(adapter).toBeDefined();
    if (adapter === undefined) return;
    const bytes = adapter.encode("# Hello\nWorld");
    expect(adapter.convertTo("docx", bytes)).toBe(bytes);
  });

  it("reports honest capability flags and a markdown derived export format", () => {
    expect(adapter).toBeDefined();
    if (adapter === undefined) return;
    expect(adapter.capabilities).toEqual({
      canRead: true,
      canCreate: true,
      canMutate: true,
      canRoundTrip: true,
      canExport: true,
      canVersion: true,
    });
    expect(adapter.exportFormats).toEqual(["markdown"]);
  });

  it("rejects content whose XML-wrapped document.xml exceeds the output budget", () => {
    expect(adapter).toBeDefined();
    if (adapter === undefined) return;
    // A string of `<` characters passes the 16 MiB input budget (1 byte each)
    // but expands 4x to `&lt;` in the XML, pushing `word/document.xml` past
    // the 16 MiB uncompressed-entry ceiling even though the compressed ZIP
    // container would stay under budget. Use ~4.5 MiB so the escaped output
    // comfortably exceeds 16 MiB.
    const inputBytes = Math.floor(MAX_WORK_OUTPUT_BYTES / 3.5);
    const content = "<".repeat(inputBytes);
    expect(() => adapter.encode(content)).toThrow(WorkAdapterBudgetError);
  });
});
