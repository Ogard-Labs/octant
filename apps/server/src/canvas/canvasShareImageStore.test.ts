import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeCanvasStaticExportDocument } from "@octant/contracts";
import { CanvasShareImageStore } from "./canvasShareImageStore";

const snapshotId = "12121212-1212-4212-8212-121212121212";
const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const entry = {
  imageRef: "image-1",
  mediaType: "image/png",
  byteLength: bytes.byteLength,
  sha256,
} as const;

function snapshotDocument() {
  return decodeCanvasStaticExportDocument({
    schemaVersion: 18,
    kind: "canvas-static-export-document",
    exportId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    canvasId: "11111111-1111-4111-8111-111111111111",
    versionId: "22222222-2222-4222-8222-222222222222",
    sequence: 1,
    exportedAt: "2026-11-22T12:00:00.000Z",
    title: "Pitch",
    channel: "authenticated-snapshot",
    sharingEnabled: true,
    provenance: {
      hostId: "local",
      projectId: "33333333-3333-4333-8333-333333333333",
      mode: "work",
      threadId: "44444444-4444-4444-8444-444444444444",
      createdAt: "2026-11-22T11:00:00.000Z",
      providerLabel: "provider",
      modelLabel: "model",
      actorKind: "local-user",
    },
    sourceManifest: [],
    blocks: [
      { blockId: "cover", schemaVersion: 30, kind: "image", alt: "Cover", imageRef: "image-1" },
    ],
    images: [entry],
    threatModelId: "canvas-share-authenticated-snapshot-v1",
  });
}

let directory = "";
afterEach(() => {
  if (directory !== "") rmSync(directory, { recursive: true, force: true });
  directory = "";
});

describe("CanvasShareImageStore", () => {
  it("keeps each digest once, serves a snapshot exactly the bytes it kept, and drops an image whose bytes changed rather than show them", async () => {
    directory = mkdtempSync(join(tmpdir(), "octant-share-image-store-"));
    const store = new CanvasShareImageStore(directory);
    const resolved = {
      mediaType: "image/png" as const,
      data: bytes.toString("base64"),
      byteLength: bytes.byteLength,
      sha256,
    };
    // Two sources with the same bytes, kept twice as a replayed share would:
    // one verified copy, no failure.
    const twice = new Map([
      ["generated-image:x", resolved],
      ["project-file:logo-copy.png", resolved],
    ]);
    await store.keepResolved(snapshotId, twice);
    await store.keepResolved(snapshotId, twice);
    await store.keepOnly(snapshotId, [entry as never]);
    const served = await store.withBytes(snapshotId, snapshotDocument());
    expect(served.images).toEqual([{ ...entry, data: bytes.toString("base64") }]);

    // Someone rewrites the kept file: the reader gets the description, not other bytes.
    const scope = join(directory, "canvas-share-images", snapshotId);
    const [attachment] = readdirSync(scope);
    const folder = join(scope, attachment ?? "");
    const [file] = readdirSync(folder);
    writeFileSync(join(folder, file ?? ""), Buffer.from("not the shared image"));
    const tampered = await store.withBytes(snapshotId, snapshotDocument());
    expect(tampered.images).toBeUndefined();
    expect(tampered.blocks[0]).not.toHaveProperty("imageRef");
    expect(() => decodeCanvasStaticExportDocument(tampered)).not.toThrow();

    await store.forget(snapshotId);
    expect((await store.withBytes(snapshotId, snapshotDocument())).images).toBeUndefined();
  });

  it("removes what no recorded snapshot names, as after a host stopped before recording it", async () => {
    directory = mkdtempSync(join(tmpdir(), "octant-share-image-store-"));
    const store = new CanvasShareImageStore(directory);
    await store.keepResolved(
      snapshotId,
      new Map([
        [
          "generated-image:x",
          {
            mediaType: "image/png" as const,
            data: bytes.toString("base64"),
            byteLength: bytes.byteLength,
            sha256,
          },
        ],
      ]),
    );
    await store.reconcile(() => false);
    expect((await store.withBytes(snapshotId, snapshotDocument())).images).toBeUndefined();
  });
});
