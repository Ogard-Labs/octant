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
  computeDocumentBounds,
  parseDocument,
  produceDocumentChunks,
  DEFAULT_DOCUMENT_BUDGET,
} from "./previewDocumentChunker";
import { buildDocxFixture } from "./previewTestFixtures";

const root = mkdtempSync(join(tmpdir(), "preview-document-"));
const filePath = join(root, "doc.docx");
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

describe("parseDocument", () => {
  it("extracts paragraph blocks in document order", () => {
    const bytes = buildDocxFixture(["Title", "First paragraph.", "Second paragraph."]);
    const parsed = parseDocument(bytes, {
      maxBlocks: 100,
      maxBlockTextBytes: 4096,
    });
    expect(parsed?.blocks).toEqual(["Title", "First paragraph.", "Second paragraph."]);
    expect(parsed?.truncated).toBe(false);
  });

  it("preserves empty paragraphs as empty blocks", () => {
    const bytes = buildDocxFixture(["a", "", "b"]);
    const parsed = parseDocument(bytes, { maxBlocks: 100, maxBlockTextBytes: 4096 });
    expect(parsed?.blocks).toEqual(["a", "", "b"]);
  });

  it("returns undefined for a malformed container", () => {
    const parsed = parseDocument(Buffer.from("not a zip"), {
      maxBlocks: 100,
      maxBlockTextBytes: 4096,
    });
    expect(parsed).toBeUndefined();
  });
});

describe("computeDocumentBounds", () => {
  it("reports the block count", () => {
    const bytes = buildDocxFixture(["one", "two", "three"]);
    expect(computeDocumentBounds(bytes).blocks).toBe(3);
  });
});

describe("produceDocumentChunks", () => {
  it("emits one chunk per block with the block index", () => {
    writeFileSync(filePath, buildDocxFixture(["one", "two", "three"]));
    const chunks = [
      ...produceDocumentChunks({
        filePath,
        targetId,
        chunkId,
        sourceVersion: versionOfFile(),
        budget: DEFAULT_DOCUMENT_BUDGET,
      }),
    ];
    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.descriptor).toEqual({ kind: "document", blockIndex: 0 });
    expect(chunks[0]?.payload).toEqual({ kind: "document", text: "one" });
    expect(chunks.at(-1)?.isFinal).toBe(true);
  });

  it("yields nothing for a malformed document", () => {
    writeFileSync(filePath, Buffer.from("not a zip"));
    const chunks = [
      ...produceDocumentChunks({
        filePath,
        targetId,
        chunkId,
        sourceVersion: versionOfFile(),
        budget: DEFAULT_DOCUMENT_BUDGET,
      }),
    ];
    expect(chunks).toHaveLength(0);
  });
});
