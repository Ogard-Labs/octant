import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CANVAS_SCHEMA_VERSION,
  decodeBrowserCapture,
  decodeCanvasVersion,
  decodeImageJob,
  type MovedThreadReference,
} from "@octant/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  packThreadParts,
  rehomeThreadParts,
  type ThreadPartsDestination,
  type ThreadPartsSource,
} from "./movedThreadParts";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const now = "2026-11-08T10:00:00.000Z";
const sourceThread: MovedThreadReference = {
  mode: "chat",
  threadId: "10000000-0000-4000-8000-000000000001",
};
const arrivedThread: MovedThreadReference = {
  mode: "chat",
  threadId: "20000000-0000-4000-8000-000000000001",
};
const moveId = "30000000-0000-4000-8000-000000000001";
const digest = "a".repeat(64);

const job = decodeImageJob({
  id: "40000000-0000-4000-8000-000000000001",
  status: "completed",
  threadKind: "chat-thread",
  scopeId: sourceThread.threadId,
  profileInstanceId: "40000000-0000-4000-8000-000000000002",
  modelId: "gpt-image-2",
  promptHash: digest,
  artifacts: ["40000000-0000-4000-8000-000000000003", "40000000-0000-4000-8000-000000000004"].map(
    (attachmentId) => ({
      attachmentId,
      hash: digest,
      size: 4,
      mime: "image/png",
      evidence: {
        profileInstanceId: "40000000-0000-4000-8000-000000000002",
        modelId: "gpt-image-2",
        promptHash: digest,
        jobId: "40000000-0000-4000-8000-000000000001",
      },
    }),
  ),
  version: 3,
  createdAt: now,
  updatedAt: now,
});

const capture = (n: number, title: string) =>
  decodeBrowserCapture({
    captureId: `50000000-0000-4000-8000-00000000000${n}`,
    threadId: sourceThread.threadId,
    origin: "https://example.com",
    url: `https://example.com/${n}`,
    title,
    hash: digest,
    size: 4,
    mime: "image/png",
    capturedAt: now,
    profile: { kind: "personal" },
  });

const canvasVersion = decodeCanvasVersion({
  schemaVersion: CANVAS_SCHEMA_VERSION,
  canvasId: "60000000-0000-4000-8000-000000000001",
  versionId: "60000000-0000-4000-8000-000000000002",
  sequence: 1,
  definition: {
    schemaVersion: CANVAS_SCHEMA_VERSION,
    title: "Trip plan",
    provenance: {
      mode: "chat",
      hostId: "local",
      projectId: null,
      threadId: sourceThread.threadId,
      actor: { kind: "local-user", actorId: "60000000-0000-4000-8000-000000000003" },
      providerInstanceId: "60000000-0000-4000-8000-000000000004",
      modelId: "model-a",
      createdAt: now,
    },
    sourceManifest: [],
    blocks: [],
  },
  createdBy: { kind: "local-user", actorId: "60000000-0000-4000-8000-000000000003" },
  createdAt: now,
});

const source: ThreadPartsSource = {
  generatedImages: () => [job],
  // The second image's file is gone on the source.
  readGeneratedImage: async (_job, attachmentId) =>
    String(attachmentId).endsWith("3") ? Uint8Array.from([1, 2, 3, 4]) : undefined,
  // Newest first, as the capture service lists them.
  browserCaptures: () => [capture(2, "Newer"), capture(1, "Older")],
  readBrowserCapture: async (read) => Uint8Array.from([Number(read.url.at(-1))]),
  canvases: () => [{ title: "Trip plan", versions: [canvasVersion], carriesOutsideContent: true }],
};

function recordingDestination() {
  const images: Array<Parameters<ThreadPartsDestination["carryGeneratedImage"]>[0]> = [];
  const captures: Array<Parameters<ThreadPartsDestination["carryBrowserCapture"]>[0]> = [];
  const canvases: Array<Parameters<ThreadPartsDestination["carryCanvas"]>[0]> = [];
  const destination: ThreadPartsDestination = {
    carryGeneratedImage: async (input) => {
      images.push(input);
    },
    carryBrowserCapture: async (input) => {
      captures.push(input);
    },
    carryCanvas: (input) => {
      canvases.push(input);
    },
  };
  return { destination, images, captures, canvases };
}

describe("the bulk parts a moved thread carries", () => {
  it("re-homes every readable part under the new thread and names the unreadable one in the receipt", async () => {
    const folder = mkdtempSync(join(tmpdir(), "octant-moved-parts-"));
    folders.push(folder);
    const packed = await packThreadParts(sourceThread, folder, source);
    expect(packed.parts.map((part) => [part.partId, part.kind])).toEqual([
      ["image-1", "generated-image"],
      ["capture-2", "browser-capture"],
      ["capture-3", "browser-capture"],
      ["canvas-4", "canvas"],
    ]);
    expect(packed.partsLeftBehind).toEqual([{ kind: "generated-image", name: "Generated image" }]);

    const parts = new Map(packed.parts.map((part) => [part.partId, part.path]));
    const first = recordingDestination();
    const rehome = (destination: ThreadPartsDestination) =>
      rehomeThreadParts({
        index: packed.index,
        parts,
        moveId,
        thread: arrivedThread,
        projectId: null,
        destination,
      });
    expect(await rehome(first.destination)).toEqual({ status: "carried" });

    expect(first.images).toHaveLength(1);
    expect(first.images[0]).toMatchObject({
      threadId: arrivedThread.threadId,
      mode: "chat",
      promptHash: digest,
    });
    expect(first.images[0]?.images.map((image) => [...image.bytes])).toEqual([[1, 2, 3, 4]]);
    // Oldest first, so the newest stays newest; the source's Browser profile stays behind.
    expect(first.captures.map((carried) => [carried.facts.title, [...carried.bytes]])).toEqual([
      ["Older", [1]],
      ["Newer", [2]],
    ]);
    expect(first.captures[0]?.facts).not.toHaveProperty("profile");
    expect(first.canvases[0]).toMatchObject({
      threadId: arrivedThread.threadId,
      projectId: null,
      carriesOutsideContent: true,
    });
    expect(first.canvases[0]?.versions.map((version) => version.source.definition.title)).toEqual([
      "Trip plan",
    ]);

    // A finish asked again re-homes each part under the same ids, so nothing lands twice.
    const second = recordingDestination();
    await rehome(second.destination);
    expect(second.images[0]?.jobId).toBe(first.images[0]?.jobId);
    expect(second.captures.map((carried) => carried.captureId)).toEqual(
      first.captures.map((carried) => carried.captureId),
    );
    expect(second.canvases[0]?.canvasId).toBe(first.canvases[0]?.canvasId);
    expect(first.canvases[0]?.canvasId).not.toBe(String(canvasVersion.canvasId));
  });

  it("refuses the arrival when a part cannot be recorded, so the source keeps its thread", async () => {
    const folder = mkdtempSync(join(tmpdir(), "octant-moved-parts-"));
    folders.push(folder);
    const packed = await packThreadParts(sourceThread, folder, source);
    const failing = recordingDestination();
    expect(
      await rehomeThreadParts({
        index: packed.index,
        parts: new Map(packed.parts.map((part) => [part.partId, part.path])),
        moveId,
        thread: arrivedThread,
        projectId: null,
        destination: {
          ...failing.destination,
          carryBrowserCapture: async () => {
            throw new Error("The disk is full.");
          },
        },
      }),
    ).toEqual({ status: "refused" });
  });

  it("adds nothing to the conversation part of a thread that owns no bulk part", async () => {
    const folder = mkdtempSync(join(tmpdir(), "octant-moved-parts-"));
    folders.push(folder);
    const packed = await packThreadParts(sourceThread, folder, {
      ...source,
      generatedImages: () => [],
      browserCaptures: () => [],
      canvases: () => [],
    });
    expect(packed).toEqual({ parts: [], partsLeftBehind: [] });
  });
});
