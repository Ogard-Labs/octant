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
  computeWorkbookBounds,
  parseWorkbook,
  produceWorkbookChunks,
  DEFAULT_WORKBOOK_BUDGET,
} from "./previewWorkbookChunker";
import { buildXlsxFixture } from "./previewTestFixtures";

const root = mkdtempSync(join(tmpdir(), "preview-workbook-"));
const filePath = join(root, "sheet.xlsx");
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

describe("parseWorkbook", () => {
  it("decodes inline-string cells into a worksheet grid", () => {
    const bytes = buildXlsxFixture([
      ["name", "age"],
      ["Ada", "36"],
    ]);
    const parsed = parseWorkbook(bytes, {
      maxRows: 100,
      maxColumns: 100,
      maxWorksheets: 16,
    });
    expect(parsed).toBeDefined();
    expect(parsed?.worksheets).toHaveLength(1);
    expect(parsed?.worksheets[0]?.name).toBe("Sheet1");
    expect(parsed?.worksheets[0]?.rows).toEqual([
      ["name", "age"],
      ["Ada", "36"],
    ]);
  });

  it("returns undefined for a malformed ZIP container", () => {
    const parsed = parseWorkbook(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]), {
      maxRows: 100,
      maxColumns: 100,
      maxWorksheets: 16,
    });
    expect(parsed).toBeUndefined();
  });
});

describe("computeWorkbookBounds", () => {
  it("reports worksheet, row, and column counts", () => {
    const bytes = buildXlsxFixture([
      ["a", "b", "c"],
      ["1", "2"],
    ]);
    const bounds = computeWorkbookBounds(bytes);
    expect(bounds.worksheets).toBe(1);
    expect(bounds.rows).toBe(2);
    expect(bounds.columns).toBe(3);
  });

  it("returns empty bounds for a malformed container", () => {
    const bounds = computeWorkbookBounds(Buffer.from("not a zip"));
    expect(bounds).toEqual({});
  });
});

describe("produceWorkbookChunks", () => {
  it("emits one chunk per row window with worksheet index and name", () => {
    const rows: string[][] = [];
    rows.push(["h1", "h2"]);
    for (let i = 0; i < 3; i += 1) rows.push([`r${i}a`, `r${i}b`]);
    writeFileSync(filePath, buildXlsxFixture(rows));
    const chunks = [
      ...produceWorkbookChunks({
        filePath,
        targetId,
        chunkId,
        sourceVersion: versionOfFile(),
        budget: { ...DEFAULT_WORKBOOK_BUDGET, maxRowsPerChunk: 2 },
      }),
    ];
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.descriptor).toMatchObject({
      kind: "workbook",
      worksheet: 1,
      startRow: 1,
      endRow: 2,
    });
    expect(chunks[0]?.payload).toMatchObject({ kind: "workbook", worksheetName: "Sheet1" });
    expect(chunks[0]?.isFinal).toBe(false);
    expect(chunks.at(-1)?.isFinal).toBe(true);
  });

  it("yields nothing for a malformed workbook", () => {
    writeFileSync(filePath, Buffer.from("not a zip"));
    const chunks = [
      ...produceWorkbookChunks({
        filePath,
        targetId,
        chunkId,
        sourceVersion: versionOfFile(),
        budget: DEFAULT_WORKBOOK_BUDGET,
      }),
    ];
    expect(chunks).toHaveLength(0);
  });
});
