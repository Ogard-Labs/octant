import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SidebarBackgroundStore,
  SidebarBackgroundTooLarge,
  SidebarBackgroundInvalidFormat,
} from "./backgroundStore";

// Minimal valid PNG: 8-byte signature + IHDR chunk (13 bytes data) with 2x2 dimensions.
function makePng(width = 2, height = 2, extraBytes = 0): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrLength = Buffer.from([0, 0, 0, 13]);
  const ihdrType = Buffer.from("IHDR");
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type (RGB)
  const ihdrCrc = Buffer.from([0, 0, 0, 0]); // crc placeholder
  const padding = Buffer.alloc(extraBytes);
  return Buffer.concat([sig, ihdrLength, ihdrType, ihdrData, ihdrCrc, padding]);
}

// Minimal WebP: RIFF....WEBPVP8 with dimensions.
function makeWebp(width = 2, height = 2): Buffer {
  const header = Buffer.alloc(30);
  header.write("RIFF", 0);
  header.writeUInt32LE(22, 4); // file size - 8
  header.write("WEBP", 8);
  header.write("VP8 ", 12);
  header.writeUInt32LE(10, 16); // chunk size
  // VP8 frame tag at 20-22 (keyframe: first byte bit 0 = 0)
  header.writeUInt8(0x00, 20);
  header.writeUInt8(0x00, 21);
  header.writeUInt8(0x00, 22);
  // VP8 start code at 23-25
  header.writeUInt8(0x9d, 23);
  header.writeUInt8(0x01, 24);
  header.writeUInt8(0x2a, 25);
  // Dimensions at 26-27 (width) and 28-29 (height), 14-bit LE
  header.writeUInt16LE(width, 26);
  header.writeUInt16LE(height, 28);
  return header;
}

let dataDir: string;
let store: SidebarBackgroundStore;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "octant-bg-"));
  store = new SidebarBackgroundStore({ dataDirectory: dataDir });
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("SidebarBackgroundStore", () => {
  it("stages and finalizes a valid PNG upload with decoded dimensions", async () => {
    const staged = await store.stage({
      bytes: makePng(1920, 1080, 64),
      mediaType: "image/png",
      displayName: "test.png",
    });
    expect(staged.byteLength).toBe(makePng(1920, 1080, 64).length);
    const finalized = await store.finalize(staged.id);
    expect(finalized.mediaType).toBe("image/png");
    expect(finalized.width).toBe(1920);
    expect(finalized.height).toBe(1080);
  });

  it("rejects oversized uploads", async () => {
    await expect(
      store.stage({
        bytes: makePng(2, 2, 8_388_609),
        mediaType: "image/png",
        displayName: "big.png",
      }),
    ).rejects.toThrow(SidebarBackgroundTooLarge);
  });

  it("rejects images exceeding max dimensions", async () => {
    await expect(
      store.stage({ bytes: makePng(4097, 1), mediaType: "image/png", displayName: "wide.png" }),
    ).rejects.toThrow(SidebarBackgroundInvalidFormat);
  });

  it("rejects empty uploads", async () => {
    await expect(
      store.stage({ bytes: Buffer.alloc(0), mediaType: "image/png", displayName: "empty.png" }),
    ).rejects.toThrow();
  });

  it("rejects unsupported media types", async () => {
    await expect(
      store.stage({ bytes: makePng(2, 2), mediaType: "image/gif", displayName: "gif.gif" }),
    ).rejects.toThrow(SidebarBackgroundInvalidFormat);
  });

  it("rejects magic-byte mismatch", async () => {
    const fakeBytes = Buffer.alloc(64, 0xff);
    await expect(
      store.stage({ bytes: fakeBytes, mediaType: "image/png", displayName: "fake.png" }),
    ).rejects.toThrow(SidebarBackgroundInvalidFormat);
  });

  it("rejects RIFF file that is not WebP", async () => {
    const riffNotWebp = Buffer.alloc(32, 0);
    riffNotWebp.write("RIFF", 0);
    riffNotWebp.write("WAVE", 8); // WAV, not WebP
    await expect(
      store.stage({ bytes: riffNotWebp, mediaType: "image/webp", displayName: "fake.webp" }),
    ).rejects.toThrow(SidebarBackgroundInvalidFormat);
  });

  it("accepts a valid WebP with full magic bytes", async () => {
    const staged = await store.stage({
      bytes: makeWebp(320, 240),
      mediaType: "image/webp",
      displayName: "real.webp",
    });
    expect(staged.mediaType).toBe("image/webp");
    const finalized = await store.finalize(staged.id);
    expect(finalized.width).toBe(320);
    expect(finalized.height).toBe(240);
  });

  it("list returns only contract fields (no internal hash)", async () => {
    const staged = await store.stage({
      bytes: makePng(2, 2),
      mediaType: "image/png",
      displayName: "a.png",
    });
    await store.finalize(staged.id);
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.displayName).toBe("a.png");
    expect(list[0]).not.toHaveProperty("hash");
  });

  it("reads finalized background bytes", async () => {
    const png = makePng(2, 2, 48);
    const staged = await store.stage({ bytes: png, mediaType: "image/png", displayName: "r.png" });
    await store.finalize(staged.id);
    const read = await store.read(staged.id);
    expect(read.byteLength).toBe(png.length);
  });

  it("rejects path traversal in id", async () => {
    await expect(store.metadata("../../../etc/passwd")).rejects.toThrow();
    await expect(store.read("../../secret")).rejects.toThrow();
    await expect(store.delete("../escape")).rejects.toThrow();
  });

  it("deletes a finalized background", async () => {
    const staged = await store.stage({
      bytes: makePng(2, 2),
      mediaType: "image/png",
      displayName: "d.png",
    });
    await store.finalize(staged.id);
    await store.delete(staged.id);
    await expect(store.read(staged.id)).rejects.toThrow();
  });
});
