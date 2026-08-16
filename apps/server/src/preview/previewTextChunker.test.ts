import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ContentSha256,
  decodePreviewChunkId,
  decodePreviewTargetId,
  type PreviewChunkId,
  type PreviewTargetId,
} from "@octant/contracts/previews";
import { computePreviewSourceVersion } from "./previewSourceVersion";
import { produceTextChunks, type TextChunkBudget } from "./previewTextChunker";

const root = mkdtempSync(join(tmpdir(), "preview-chunker-"));
const filePath = join(root, "lines.txt");
const targetId = decodePreviewTargetId("11111111-1111-4111-8111-111111111111") as PreviewTargetId;
const chunkId = decodePreviewChunkId("22222222-2222-4222-8222-222222222222") as PreviewChunkId;

const budget: TextChunkBudget = { maxLinesPerChunk: 3, maxBytesPerChunk: 1024 };

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("produceTextChunks", () => {
  it("produces a single final chunk for a short file", () => {
    writeFileSync(filePath, "line one\nline two\n");
    const version = computePreviewSourceVersion(filePath);
    expect(version.ok).toBe(true);
    if (!version.ok) return;

    const chunks = [
      ...produceTextChunks({
        filePath,
        targetId,
        chunkId,
        sourceVersion: version.sourceVersion,
        kind: "text",
        budget,
      }),
    ];
    expect(chunks).toHaveLength(1);
    const first = chunks[0];
    if (!first) throw new Error("expected a chunk");
    expect(first.isFinal).toBe(true);
    expect(first.sequence).toBe(0);
    expect(first.payload.kind).toBe("text");
    expect((first.payload as { text: string }).text).toBe("line one\nline two\n");
    expect(first.descriptor.kind).toBe("text");
  });

  it("paginates a longer file into bounded line chunks with a final marker", () => {
    const content = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    writeFileSync(filePath, content);
    const version = computePreviewSourceVersion(filePath);
    expect(version.ok).toBe(true);
    if (!version.ok) return;

    const chunks = [
      ...produceTextChunks({
        filePath,
        targetId,
        chunkId,
        sourceVersion: version.sourceVersion,
        kind: "text",
        budget,
      }),
    ];
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.at(-1)?.isFinal).toBe(true);
    // Every non-final chunk must respect the line budget.
    for (const chunk of chunks) {
      if (!chunk.isFinal && chunk.descriptor.kind === "text") {
        const desc = chunk.descriptor;
        expect(desc.endLine - desc.startLine + 1).toBeLessThanOrEqual(budget.maxLinesPerChunk);
      }
    }
    // Sequences are contiguous starting at 0.
    expect(chunks.map((c) => c.sequence)).toEqual(chunks.map((_, i) => i));
  });

  it("produces markdown chunks when kind is markdown", () => {
    writeFileSync(filePath, "# Title\n\nbody\n");
    const version = computePreviewSourceVersion(filePath);
    expect(version.ok).toBe(true);
    if (!version.ok) return;

    const chunks = [
      ...produceTextChunks({
        filePath,
        targetId,
        chunkId,
        sourceVersion: version.sourceVersion,
        kind: "markdown",
        budget,
      }),
    ];
    const md = chunks[0];
    if (!md) throw new Error("expected a markdown chunk");
    expect(md.payload.kind).toBe("markdown");
    expect(md.kind).toBe("markdown");
  });

  it("returns no chunks for a missing file", () => {
    const chunks = [
      ...produceTextChunks({
        filePath: join(root, "missing.txt"),
        targetId,
        chunkId,
        sourceVersion: {
          contentSha256: "0".repeat(64) as ContentSha256,
          byteSize: 0,
          observedAt: "2026-07-22T00:00:00.000Z" as never,
        },
        kind: "text",
        budget,
      }),
    ];
    expect(chunks).toEqual([]);
  });

  it("aborts with a stale outcome when the file changed since the version was recorded", () => {
    writeFileSync(filePath, "original content\n");
    const version = computePreviewSourceVersion(filePath);
    expect(version.ok).toBe(true);
    if (!version.ok) return;
    // Mutate the file after the version is captured.
    writeFileSync(filePath, "mutated content\n");

    const chunks = [
      ...produceTextChunks({
        filePath,
        targetId,
        chunkId,
        sourceVersion: version.sourceVersion,
        kind: "text",
        budget,
      }),
    ];
    // No chunks should be emitted for a stale source; the caller surfaces
    // stale separately. The generator must not stamp old-version chunks.
    expect(chunks).toEqual([]);
  });

  it("splits a single line longer than maxBytesPerChunk instead of emitting an over-budget chunk", () => {
    // One line of 200 bytes, maxBytesPerChunk = 50. The chunker must not
    // emit a single 200-byte chunk; it must split the line across chunks
    // so every chunk respects the byte budget.
    writeFileSync(filePath, "x".repeat(200) + "\n");
    const version = computePreviewSourceVersion(filePath);
    expect(version.ok).toBe(true);
    if (!version.ok) return;

    const chunks = [
      ...produceTextChunks({
        filePath,
        targetId,
        chunkId,
        sourceVersion: version.sourceVersion,
        kind: "text",
        budget: { maxLinesPerChunk: 100, maxBytesPerChunk: 50 },
      }),
    ];
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const payload = chunk.payload as { text: string };
      expect(Buffer.byteLength(payload.text, "utf-8")).toBeLessThanOrEqual(50);
    }
    expect(chunks.at(-1)?.isFinal).toBe(true);
  });

  it("stops at the total render byte cap and marks the final chunk as truncated, not complete", () => {
    // 10 lines of 30 bytes each = 300 bytes. Render cap = 80 bytes.
    // The chunker must stop after ~2-3 lines and mark the final chunk as
    // truncated (isFinal true but fidelity-limited), not stream the whole
    // file as complete.
    const content =
      Array.from({ length: 10 }, (_, i) => `line ${i + 1} `.repeat(6).trim()).join("\n") + "\n";
    writeFileSync(filePath, content);
    const version = computePreviewSourceVersion(filePath);
    expect(version.ok).toBe(true);
    if (!version.ok) return;

    const chunks = [
      ...produceTextChunks({
        filePath,
        targetId,
        chunkId,
        sourceVersion: version.sourceVersion,
        kind: "text",
        budget: { maxLinesPerChunk: 100, maxBytesPerChunk: 50, maxRenderBytes: 80 },
      }),
    ];
    const totalBytes = chunks.reduce(
      (sum, c) => sum + Buffer.byteLength((c.payload as { text: string }).text, "utf-8"),
      0,
    );
    expect(totalBytes).toBeLessThanOrEqual(80 + 50); // cap + one chunk slack
    // The final chunk must signal truncation, not a complete stream.
    const last = chunks.at(-1);
    expect(last?.isFinal).toBe(true);
    if (last && last.descriptor.kind === "text") {
      // Truncation is signaled via a descriptor flag or the final chunk's
      // endLine being below the file's line count.
      expect((last.descriptor as { endLine: number }).endLine).toBeLessThan(10);
    }
  });
});
