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
import { GeneratedImageStore, sniffGeneratedImageMediaType } from "./generatedImageStore";

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
