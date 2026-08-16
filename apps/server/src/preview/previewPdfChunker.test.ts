import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decodePreviewChunkId,
  decodePreviewTargetId,
  type PreviewChunkId,
  type PreviewTargetId,
} from "@octant/contracts/previews";
import { computePreviewSourceVersion } from "./previewSourceVersion";
import {
  computePdfBounds,
  parsePdf,
  producePdfChunks,
  DEFAULT_PDF_BUDGET,
} from "./previewPdfChunker";
import { buildPdfFixture } from "./previewTestFixtures";

const root = mkdtempSync(join(tmpdir(), "preview-pdf-"));
const filePath = join(root, "doc.pdf");
const targetId = decodePreviewTargetId("11111111-1111-4111-8111-111111111111") as PreviewTargetId;
const chunkId = decodePreviewChunkId("22222222-2222-4222-8222-222222222222") as PreviewChunkId;

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function versionOfFile() {
  const v = computePreviewSourceVersion(filePath);
  if (!v.ok) throw new Error("source version unavailable");
  return v.sourceVersion;
}

describe("parsePdf", () => {
  it("extracts per-page text from uncompressed content streams", () => {
    const bytes = buildPdfFixture([["Hello World", "Second line"], ["Page two body"]]);
    const parsed = parsePdf(bytes, { maxPages: 100, maxPageTextBytes: 4096 });
    expect(parsed?.pages).toHaveLength(2);
    expect(parsed?.pages[0]).toContain("Hello World");
    expect(parsed?.pages[0]).toContain("Second line");
    expect(parsed?.pages[1]).toContain("Page two body");
  });

  it("returns undefined for a non-PDF input", () => {
    const parsed = parsePdf(Buffer.from("not a pdf"), {
      maxPages: 100,
      maxPageTextBytes: 4096,
    });
    expect(parsed).toBeUndefined();
  });

  it("honors PDF string escapes for parentheses", () => {
    const bytes = buildPdfFixture([["escaped (paren) text"]]);
    const parsed = parsePdf(bytes, { maxPages: 100, maxPageTextBytes: 4096 });
    expect(parsed?.pages[0]).toContain("escaped (paren) text");
  });
});

describe("computePdfBounds", () => {
  it("reports the page count", () => {
    const bytes = buildPdfFixture([["a"], ["b"], ["c"]]);
    expect(computePdfBounds(bytes).pages).toBe(3);
  });

  it("returns empty bounds for a non-PDF input", () => {
    expect(computePdfBounds(Buffer.from("not a pdf"))).toEqual({});
  });
});

describe("producePdfChunks", () => {
  it("emits one chunk per page with the page number and extracted text", () => {
    writeFileSync(filePath, buildPdfFixture([["Page one text"], ["Page two text"]]));
    const chunks = [
      ...producePdfChunks({
        filePath,
        targetId,
        chunkId,
        sourceVersion: versionOfFile(),
        budget: DEFAULT_PDF_BUDGET,
      }),
    ];
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.descriptor).toEqual({ kind: "pdf", page: 1 });
    expect(chunks[0]?.payload).toMatchObject({ kind: "pdf", pageText: "Page one text" });
    expect(chunks.at(-1)?.isFinal).toBe(true);
  });

  it("yields nothing for a non-PDF file", () => {
    writeFileSync(filePath, Buffer.from("not a pdf"));
    const chunks = [
      ...producePdfChunks({
        filePath,
        targetId,
        chunkId,
        sourceVersion: versionOfFile(),
        budget: DEFAULT_PDF_BUDGET,
      }),
    ];
    expect(chunks).toHaveLength(0);
  });
});
