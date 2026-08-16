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
  computeTableBounds,
  inferTableDelimiter,
  parseTable,
  produceTableChunks,
  DEFAULT_TABLE_BUDGET,
} from "./previewTableChunker";

const root = mkdtempSync(join(tmpdir(), "preview-table-"));
const filePath = join(root, "data.csv");
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

describe("parseTable", () => {
  it("parses comma-delimited rows respecting quoted fields", () => {
    const { rows, truncated } = parseTable('a,b\n"c,d",e\n', ",", {
      maxRows: 100,
      maxColumns: 100,
    });
    expect(truncated).toBe(false);
    expect(rows).toEqual([
      ["a", "b"],
      ["c,d", "e"],
    ]);
  });

  it("parses tab-delimited rows", () => {
    const { rows } = parseTable("a\tb\tc\n1\t2\t3\n", "\t", {
      maxRows: 100,
      maxColumns: 100,
    });
    expect(rows).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("truncates at the row ceiling and reports truncation", () => {
    let input = "";
    for (let i = 0; i < 10; i += 1) input += `r${i}\n`;
    const { rows, truncated } = parseTable(input, ",", { maxRows: 3, maxColumns: 100 });
    expect(rows).toHaveLength(3);
    expect(truncated).toBe(true);
  });

  it("handles doubled-quote escapes inside quoted fields", () => {
    const { rows } = parseTable('"she said ""hi"""\n', ",", {
      maxRows: 100,
      maxColumns: 100,
    });
    expect(rows).toEqual([['she said "hi"']]);
  });
});

describe("inferTableDelimiter", () => {
  it("infers comma from the first line", () => {
    expect(inferTableDelimiter("a,b,c\n1,2,3")).toBe(",");
  });
  it("infers tab when tabs dominate", () => {
    expect(inferTableDelimiter("a\tb\tc\n1\t2\t3")).toBe("\t");
  });
  it("returns null when no recognized delimiter is present", () => {
    expect(inferTableDelimiter("just one field")).toBeNull();
  });
});

describe("computeTableBounds", () => {
  it("reports row and max column counts", () => {
    writeFileSync(filePath, "a,b,c\n1,2,3\n4,5\n");
    const bytes = Buffer.from("a,b,c\n1,2,3\n4,5\n");
    const bounds = computeTableBounds(bytes, ",");
    expect(bounds.rows).toBe(3);
    expect(bounds.columns).toBe(3);
  });
});

describe("produceTableChunks", () => {
  it("paginates rows into bounded chunks and marks the final chunk", () => {
    writeFileSync(filePath, "name,age\nAda,36\nGrace,85\nAlan,41\n");
    const chunks = [
      ...produceTableChunks({
        filePath,
        targetId,
        chunkId,
        sourceVersion: versionOfFile(),
        delimiter: ",",
        budget: { ...DEFAULT_TABLE_BUDGET, maxRowsPerChunk: 2 },
      }),
    ];
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.payload).toEqual({
      kind: "table",
      rows: [
        ["name", "age"],
        ["Ada", "36"],
      ],
      delimiter: ",",
    });
    expect(chunks[0]?.descriptor).toEqual({ kind: "table", startRow: 1, endRow: 2 });
    expect(chunks[0]?.isFinal).toBe(false);
    expect(chunks[1]?.isFinal).toBe(true);
    expect(chunks[1]?.payload).toMatchObject({
      rows: [
        ["Grace", "85"],
        ["Alan", "41"],
      ],
    });
  });

  it("yields nothing when the file changed since the version was recorded", () => {
    writeFileSync(filePath, "a,b\n1,2\n");
    const staleVersion = versionOfFile();
    writeFileSync(filePath, "a,b\n9,9\n");
    const chunks = [
      ...produceTableChunks({
        filePath,
        targetId,
        chunkId,
        sourceVersion: staleVersion,
        delimiter: ",",
        budget: DEFAULT_TABLE_BUDGET,
      }),
    ];
    expect(chunks).toHaveLength(0);
  });

  it("yields a single final empty chunk for an empty file", () => {
    writeFileSync(filePath, "");
    const chunks = [
      ...produceTableChunks({
        filePath,
        targetId,
        chunkId,
        sourceVersion: versionOfFile(),
        delimiter: ",",
        budget: DEFAULT_TABLE_BUDGET,
      }),
    ];
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.isFinal).toBe(true);
    expect(chunks[0]?.payload).toMatchObject({ rows: [] });
  });
});
