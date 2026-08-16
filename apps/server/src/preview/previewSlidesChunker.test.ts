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
  computeSlidesBounds,
  parseSlides,
  produceSlidesChunks,
  DEFAULT_SLIDES_BUDGET,
} from "./previewSlidesChunker";
import { buildPptxFixture } from "./previewTestFixtures";

const root = mkdtempSync(join(tmpdir(), "preview-slides-"));
const filePath = join(root, "deck.pptx");
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

describe("parseSlides", () => {
  it("extracts title and body bullets per slide in order", () => {
    const bytes = buildPptxFixture([
      { title: "Intro", bullets: ["first", "second"] },
      { title: "Demo", bullets: ["step one"] },
    ]);
    const parsed = parseSlides(bytes, { maxSlides: 100, maxSlideTextBytes: 4096 });
    expect(parsed?.slides).toEqual(["Intro\nfirst\nsecond", "Demo\nstep one"]);
    expect(parsed?.truncated).toBe(false);
  });

  it("returns undefined for a malformed container", () => {
    const parsed = parseSlides(Buffer.from("not a zip"), {
      maxSlides: 100,
      maxSlideTextBytes: 4096,
    });
    expect(parsed).toBeUndefined();
  });
});

describe("computeSlidesBounds", () => {
  it("reports the slide count", () => {
    const bytes = buildPptxFixture([
      { title: "A", bullets: [] },
      { title: "B", bullets: [] },
    ]);
    expect(computeSlidesBounds(bytes).slides).toBe(2);
  });
});

describe("produceSlidesChunks", () => {
  it("emits one chunk per slide with the slide number", () => {
    writeFileSync(
      filePath,
      buildPptxFixture([
        { title: "Intro", bullets: ["first"] },
        { title: "Demo", bullets: ["step one"] },
      ]),
    );
    const chunks = [
      ...produceSlidesChunks({
        filePath,
        targetId,
        chunkId,
        sourceVersion: versionOfFile(),
        budget: DEFAULT_SLIDES_BUDGET,
      }),
    ];
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.descriptor).toEqual({ kind: "slides", slide: 1 });
    expect(chunks[0]?.payload).toEqual({ kind: "slides", slideText: "Intro\nfirst" });
    expect(chunks.at(-1)?.isFinal).toBe(true);
  });

  it("yields nothing for a malformed deck", () => {
    writeFileSync(filePath, Buffer.from("not a zip"));
    const chunks = [
      ...produceSlidesChunks({
        filePath,
        targetId,
        chunkId,
        sourceVersion: versionOfFile(),
        budget: DEFAULT_SLIDES_BUDGET,
      }),
    ];
    expect(chunks).toHaveLength(0);
  });
});
