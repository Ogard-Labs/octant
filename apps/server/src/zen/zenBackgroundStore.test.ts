import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeWindowId, decodeZenSpaceId } from "@octant/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZenBackgroundStore } from "./zenBackgroundStore";

const owner = decodeWindowId("00000000-0000-4000-8000-000000000101");
const otherOwner = decodeWindowId("00000000-0000-4000-8000-000000000102");
const spaceId = decodeZenSpaceId("00000000-0000-4000-8000-000000000103");

function png(width = 2, height = 2): Buffer {
  const value = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(value, 0);
  value.writeUInt32BE(13, 8);
  value.write("IHDR", 12);
  value.writeUInt32BE(width, 16);
  value.writeUInt32BE(height, 20);
  return value;
}

function gifAnimated(): Buffer {
  return Buffer.from(
    "4749463839610200010081000000ff00ff000000000000000021ff0b4e45545343415045322e30030100000021f904000a0000002c000000000200010000080500030008080021f904010a0002002c000000000200010081ffff000000ff00000000000008050003000808003b",
    "hex",
  );
}

let dataDirectory: string;
let store: ZenBackgroundStore;

beforeEach(async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), "octant-zen-background-"));
  store = new ZenBackgroundStore({ dataDirectory });
});

afterEach(async () => {
  await rm(dataDirectory, { recursive: true, force: true });
});

describe("ZenBackgroundStore", () => {
  it("stores only sniffed local media and returns no ownership or digest metadata", async () => {
    const metadata = await store.stage({
      bytes: png(1920, 1080),
      mediaType: "image/png",
      displayName: "calm.png",
      ownerWindowId: owner,
      spaceId,
    });
    const result = await store.read(metadata.assetId, owner);

    expect(result.metadata).toMatchObject({ displayName: "calm.png", width: 1920, height: 1080 });
    expect(result.metadata).not.toHaveProperty("digest");
    expect(result.metadata).not.toHaveProperty("ownerWindowId");
    expect(result.bytes).toEqual(new Uint8Array(png(1920, 1080)));
  });

  it("fails closed for another authenticated window without disclosing the asset", async () => {
    const metadata = await store.stage({
      bytes: png(),
      mediaType: "image/png",
      displayName: "calm.png",
      ownerWindowId: owner,
      spaceId,
    });
    await expect(store.read(metadata.assetId, otherOwner)).rejects.toMatchObject({
      reason: "unavailable",
    });
  });

  it("fails closed when a stored binary is replaced with a symlink or corrupted", async () => {
    const metadata = await store.stage({
      bytes: png(),
      mediaType: "image/png",
      displayName: "calm.png",
      ownerWindowId: owner,
      spaceId,
    });
    const stored = join(dataDirectory, "zen-backgrounds", `${metadata.assetId}.bin`);
    await rm(stored);
    await symlink("/etc/hosts", stored);
    await expect(store.read(metadata.assetId, owner)).rejects.toMatchObject({
      reason: "unavailable",
    });

    await rm(stored);
    await writeFile(stored, "corrupt");
    await expect(store.read(metadata.assetId, owner)).rejects.toMatchObject({
      reason: "unavailable",
    });
  });

  it("fails closed when a sidecar lies about media, dimensions, or byte length", async () => {
    const metadata = await store.stage({
      bytes: png(20, 10),
      mediaType: "image/png",
      displayName: "calm.png",
      ownerWindowId: owner,
      spaceId,
    });
    const sidecarPath = join(dataDirectory, "zen-backgrounds", `${metadata.assetId}.json`);
    const sidecar = JSON.parse(await readFile(sidecarPath, "utf8")) as Record<string, unknown>;
    for (const patch of [
      { mediaType: "image/jpeg" },
      { width: 99 },
      { byteLength: 1 },
      { digest: "not-a-digest" },
      { ownerWindowId: "not-a-window" },
    ]) {
      await writeFile(sidecarPath, JSON.stringify({ ...sidecar, ...patch }));
      await expect(store.read(metadata.assetId, owner)).rejects.toMatchObject({
        reason: "unavailable",
      });
    }
  });

  it("rejects a symlinked data root before every lifecycle operation", async () => {
    const alias = `${dataDirectory}-alias`;
    await symlink(dataDirectory, alias);
    const unsafeStore = new ZenBackgroundStore({ dataDirectory: alias });
    await expect(
      unsafeStore.stage({
        bytes: png(),
        mediaType: "image/png",
        displayName: "calm.png",
        ownerWindowId: owner,
        spaceId,
      }),
    ).rejects.toMatchObject({ reason: "unavailable" });
    await rm(alias, { force: true });
  });

  it("reconciles only unreferenced assets and retains another live owner asset", async () => {
    const kept = await store.stage({
      bytes: png(),
      mediaType: "image/png",
      displayName: "kept.png",
      ownerWindowId: owner,
      spaceId,
    });
    const removed = await store.stage({
      bytes: png(),
      mediaType: "image/png",
      displayName: "removed.png",
      ownerWindowId: owner,
      spaceId,
    });
    const other = await store.stage({
      bytes: png(),
      mediaType: "image/png",
      displayName: "other.png",
      ownerWindowId: otherOwner,
      spaceId,
    });
    await store.reconcile(new Map([[String(kept.assetId), { ownerWindowId: owner, spaceId }]]), {
      ownerWindowId: owner,
      spaceId,
    });
    await expect(store.read(kept.assetId, owner)).resolves.toMatchObject({
      metadata: { assetId: kept.assetId },
    });
    await expect(store.read(removed.assetId, owner)).rejects.toMatchObject({
      reason: "unavailable",
    });
    await expect(store.read(other.assetId, otherOwner)).resolves.toMatchObject({
      metadata: { assetId: other.assetId },
    });
  });

  it("removes a corrupt orphan during restart reconciliation but keeps a live asset", async () => {
    const live = await store.stage({
      bytes: png(),
      mediaType: "image/png",
      displayName: "live.png",
      ownerWindowId: owner,
      spaceId,
    });
    const orphan = await store.stage({
      bytes: png(),
      mediaType: "image/png",
      displayName: "orphan.png",
      ownerWindowId: owner,
      spaceId,
    });
    const orphanSidecar = join(dataDirectory, "zen-backgrounds", `${orphan.assetId}.json`);
    await writeFile(orphanSidecar, "not-json");
    await store.reconcile(new Map([[String(live.assetId), { ownerWindowId: owner, spaceId }]]));
    await expect(store.read(live.assetId, owner)).resolves.toMatchObject({
      metadata: { assetId: live.assetId },
    });
    await expect(readFile(orphanSidecar)).rejects.toThrow();
    await expect(
      readFile(join(dataDirectory, "zen-backgrounds", `${orphan.assetId}.bin`)),
    ).rejects.toThrow();
  });

  it("stores an animated GIF with a separate still-frame asset", async () => {
    const metadata = await store.stage({
      bytes: gifAnimated(),
      mediaType: "image/gif",
      displayName: "loop.gif",
      ownerWindowId: owner,
      spaceId,
    });
    expect(metadata.mediaType).toBe("image/gif");
    expect(metadata.stillAssetId).toBeDefined();
    expect(metadata.stillAssetId).not.toBe(metadata.assetId);
    const animated = await store.read(metadata.assetId, owner);
    const still = await store.read(metadata.stillAssetId!, owner);
    expect(animated.metadata.mediaType).toBe("image/gif");
    expect(still.metadata.mediaType).toBe("image/gif");
    expect(still.bytes.byteLength).toBeLessThan(animated.bytes.byteLength);
  });

  it("rejects decompression-sized dimensions before writing an asset", async () => {
    await expect(
      store.stage({
        bytes: png(4096, 4096),
        mediaType: "image/png",
        displayName: "huge.png",
        ownerWindowId: owner,
        spaceId,
      }),
    ).rejects.toMatchObject({ reason: "invalid" });
  });
});
