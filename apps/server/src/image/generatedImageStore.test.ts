import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decodeImageArtifactId,
  decodeImageGenerationScopeId,
  MAX_GENERATED_IMAGE_BYTES,
  type ImageArtifactId,
  type ImageGenerationScopeId,
} from "@octant/contracts";
import {
  GeneratedImageInvalid,
  GeneratedImageStore,
  readGeneratedImageDimensions,
  sniffGeneratedImageMediaType,
} from "./generatedImageStore";

/** 1×1 PNG. Magic-number valid, small enough for every size bound. */
export const MINIMAL_PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

let root: string;
let store: GeneratedImageStore;

const makeScopeId = (n: number): ImageGenerationScopeId => {
  const hex = n.toString(16).padStart(12, "0");
  return decodeImageGenerationScopeId(`a0000000-0000-4000-8000-${hex}`);
};

const makeAttachmentId = (n: number): ImageArtifactId => {
  const hex = n.toString(16).padStart(12, "0");
  return decodeImageArtifactId(`a1000000-0000-4000-8000-${hex}`);
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "octant-generated-image-"));
  store = new GeneratedImageStore(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("generated image sniffing", () => {
  it("recognizes PNG magic and rejects unstructured bytes", () => {
    expect(sniffGeneratedImageMediaType(MINIMAL_PNG)).toBe("image/png");
    expect(sniffGeneratedImageMediaType(new Uint8Array([1, 2, 3, 4]))).toBeUndefined();
  });
});

describe("generated image dimensions", () => {
  it("reads the dimensions each format declares", () => {
    expect(readGeneratedImageDimensions(MINIMAL_PNG, "image/png")).toEqual({ width: 1, height: 1 });
    const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xf0, 0x00, 0, 0]);
    expect(readGeneratedImageDimensions(gif, "image/gif")).toEqual({ width: 320, height: 240 });
    const jpeg = Uint8Array.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0xe0,
      0x02, 0x80, 0x01, 0x01, 0x11, 0x00,
    ]);
    expect(readGeneratedImageDimensions(jpeg, "image/jpeg")).toEqual({ width: 640, height: 480 });
    const webp = new Uint8Array(30);
    webp.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], 0);
    webp.set([0x56, 0x50, 0x38, 0x58], 12);
    webp.set([0xff, 0x01, 0x00, 0xff, 0x00, 0x00], 24);
    expect(readGeneratedImageDimensions(webp, "image/webp")).toEqual({ width: 512, height: 256 });
  });

  it("returns nothing for a header it cannot read, so a reader miss never rejects an image", () => {
    expect(readGeneratedImageDimensions(Uint8Array.from([0xff, 0xd8, 0xff]), "image/jpeg")).toBe(
      undefined,
    );
  });

  it("refuses to stage an image that declares dimensions beyond the bound", async () => {
    const bomb = Uint8Array.from(MINIMAL_PNG);
    new DataView(bomb.buffer).setUint32(16, 30_000);
    new DataView(bomb.buffer).setUint32(20, 30_000);
    await expect(
      store.stage({
        scopeId: makeScopeId(9),
        attachmentId: makeAttachmentId(9),
        displayName: "bomb.png",
        bytes: bomb,
      }),
    ).rejects.toBeInstanceOf(GeneratedImageInvalid);
    expect(await store.hasTemporaryFiles()).toBe(false);
  });
});

describe("path confinement", () => {
  it("rejects forged scope ids before deriving managed paths", async () => {
    await expect(
      store.stage({
        scopeId: "../../../escape" as ImageGenerationScopeId,
        attachmentId: makeAttachmentId(1),
        displayName: "out.png",
        bytes: MINIMAL_PNG,
      }),
    ).rejects.toThrow();
  });

  it("rejects a symlinked attachment directory before staging outside the managed root", async () => {
    const scopeId = makeScopeId(1);
    const attachmentId = makeAttachmentId(1);
    const outside = await mkdtemp(join(tmpdir(), "octant-generated-image-escape-"));
    const scopeDir = join(root, "generated-images", scopeId);
    const attachmentDir = join(scopeDir, attachmentId);
    try {
      await mkdir(scopeDir, { recursive: true });
      await symlink(outside, attachmentDir, "dir");
      await expect(
        store.stage({
          scopeId,
          attachmentId,
          displayName: "escape.png",
          bytes: MINIMAL_PNG,
        }),
      ).rejects.toThrow("managed attachment directory");
      await expect(access(join(outside, "staged.bin.tmp"))).rejects.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("stage, finalize, and recovery", () => {
  it("stages, hash-verifies finalize, and reads back the same PNG", async () => {
    const scopeId = makeScopeId(1);
    const attachmentId = makeAttachmentId(1);
    const staged = await store.stage({
      scopeId,
      attachmentId,
      displayName: "result.png",
      bytes: MINIMAL_PNG,
    });
    const finalized = await store.finalize(staged);
    expect(finalized.mime).toBe("image/png");
    expect(finalized.hash).toBe(staged.hash);
    expect(await store.read(finalized)).toEqual(MINIMAL_PNG);
  });

  it("rejects unstructured bytes before creating managed storage", async () => {
    const scopeId = makeScopeId(1);
    const attachmentId = makeAttachmentId(1);
    await expect(
      store.stage({
        scopeId,
        attachmentId,
        displayName: "junk.bin",
        bytes: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]),
      }),
    ).rejects.toMatchObject({ category: "invalid" });
    await expect(access(join(root, "generated-images", scopeId, attachmentId))).rejects.toThrow();
  });

  it("rejects images exceeding the maximum size", async () => {
    await expect(
      store.stage({
        scopeId: makeScopeId(1),
        attachmentId: makeAttachmentId(1),
        displayName: "huge.png",
        bytes: new Uint8Array(MAX_GENERATED_IMAGE_BYTES + 1),
      }),
    ).rejects.toMatchObject({ category: "too-large" });
  });

  it("sweeps a staged temp that never finalized", async () => {
    const scopeId = makeScopeId(1);
    const attachmentId = makeAttachmentId(1);
    await store.stage({
      scopeId,
      attachmentId,
      displayName: "partial.png",
      bytes: MINIMAL_PNG,
    });
    expect(await store.hasTemporaryFiles()).toBe(true);
    await store.recover();
    expect(await store.hasTemporaryFiles()).toBe(false);
    await expect(
      access(join(root, "generated-images", scopeId, attachmentId, "staged.bin.tmp")),
    ).rejects.toThrow();
  });

  it("keeps a finalized image that a projection still references", async () => {
    const scopeId = makeScopeId(1);
    const attachmentId = makeAttachmentId(1);
    const staged = await store.stage({
      scopeId,
      attachmentId,
      displayName: "kept.png",
      bytes: MINIMAL_PNG,
    });
    const finalized = await store.finalize(staged);
    await writeFile(
      join(root, "generated-images", scopeId, attachmentId, "staged.bin.tmp"),
      MINIMAL_PNG,
    );
    await store.recover({
      isFinalizedAttachmentReferenced: (candidateScope, candidateAttachment) =>
        String(candidateScope) === String(scopeId) &&
        String(candidateAttachment) === String(attachmentId),
    });
    expect(await store.read(finalized)).toEqual(MINIMAL_PNG);
    expect(await store.hasTemporaryFiles()).toBe(false);
  });

  it("removes a finalized image the projection no longer names", async () => {
    const scopeId = makeScopeId(1);
    const attachmentId = makeAttachmentId(1);
    const staged = await store.stage({
      scopeId,
      attachmentId,
      displayName: "orphan.png",
      bytes: MINIMAL_PNG,
    });
    await store.finalize(staged);
    await store.recover({
      isFinalizedAttachmentReferenced: () => false,
    });
    await expect(access(join(root, "generated-images", scopeId, attachmentId))).rejects.toThrow();
  });
});
