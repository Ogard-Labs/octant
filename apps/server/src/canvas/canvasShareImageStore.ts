import { Schema } from "effect";
import {
  CANVAS_DESIGN_ASSET_MAX_BYTES,
  type CanvasShareImageEntry,
  type CanvasStaticExportDocument,
} from "@octant/contracts";
import { CanvasShareSnapshotId } from "@octant/contracts/canvas-share-snapshot";
import type { CanvasShareResolvedImages } from "@octant/domain";
import { ManagedAttachmentStore } from "../attachments/managedAttachmentStore";

const decodeSnapshotId = Schema.decodeUnknownSync(CanvasShareSnapshotId);
const decodeDigest = Schema.decodeUnknownSync(
  Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
);

/**
 * The image bytes a shared snapshot shows, kept apart from the journal: one
 * managed scope per snapshot, each image named by its SHA-256. The journaled
 * snapshot names its images by digest alone, so the journal never holds image
 * bytes, and a read checks the bytes against that digest, so a reader sees
 * exactly what was shared or nothing at all. Revoking the snapshot removes
 * them.
 */
export class CanvasShareImageStore {
  readonly #store: ManagedAttachmentStore;
  /**
   * The startup reconcile, which every keep waits for: it removes staged and
   * unnamed files, so a share kept while it ran could lose bytes it is about
   * to record.
   */
  #reconciling: Promise<void> = Promise.resolve();

  constructor(dataDirectory: string) {
    this.#store = new ManagedAttachmentStore(dataDirectory, {
      scopesDirectory: "canvas-share-images",
      maxBytes: CANVAS_DESIGN_ASSET_MAX_BYTES,
      decodeScopeId: (value) => String(decodeSnapshotId(value)),
      decodeAttachmentId: (value) => decodeDigest(value),
      tooLarge: (byteLength) =>
        new Error(`A shared image of ${String(byteLength)} bytes is over the image cap.`),
      empty: () => new Error("A shared image must not be empty."),
      invalidDisplayName: (message) => new Error(message),
    });
  }

  /**
   * Keep the bytes of every image the host resolved for a snapshot, once per
   * digest, before the snapshot is recorded: a snapshot is never journaled
   * naming bytes that are not yet kept. Keeping is idempotent, so a replayed
   * share or two sources with the same bytes keep one verified copy.
   */
  async keepResolved(snapshotId: string, resolved: CanvasShareResolvedImages): Promise<void> {
    await this.#reconciling;
    const byDigest = new Map([...resolved.values()].map((image) => [image.sha256, image]));
    for (const [sha256, image] of byDigest) {
      if (await this.#holds(snapshotId, sha256, image.byteLength)) continue;
      const staged = await this.#store.stage({
        scopeId: snapshotId,
        attachmentId: sha256,
        displayName: "shared-image",
        bytes: Buffer.from(image.data, "base64"),
      });
      if (staged.hash !== sha256) {
        await this.#store.remove(snapshotId, sha256);
        continue;
      }
      await this.#store.finalize(staged);
    }
  }

  /**
   * Remove whatever a snapshot kept beyond the images its record names: one
   * resolved but left out by the share's budget, or kept for a share that was
   * then refused.
   */
  async keepOnly(snapshotId: string, images: ReadonlyArray<CanvasShareImageEntry>): Promise<void> {
    const named = new Set(images.map((image) => image.sha256));
    for (const digest of this.#store.attachmentIdsInScope(snapshotId)) {
      if (!named.has(digest)) await this.#store.remove(snapshotId, digest);
    }
  }

  /**
   * Remove every kept image no recorded snapshot names, as after a host that
   * stopped between keeping a snapshot's images and recording it.
   */
  async reconcile(isNamed: (snapshotId: string, sha256: string) => boolean): Promise<void> {
    const previous = this.#reconciling;
    const run = previous.then(() =>
      this.#store.recover({ isFinalizedAttachmentReferenced: isNamed }),
    );
    // A failed reconcile leaves files behind but must not refuse every later share.
    this.#reconciling = run.catch(() => undefined);
    await run;
  }

  async #holds(snapshotId: string, sha256: string, byteLength: number): Promise<boolean> {
    if (!this.#store.attachmentIdsInScope(snapshotId).has(sha256)) return false;
    return this.#read(snapshotId, sha256, byteLength)
      .then(() => true)
      .catch(() => false);
  }

  #read(snapshotId: string, sha256: string, byteLength: number): Promise<Uint8Array> {
    return this.#store.read({
      scopeId: snapshotId,
      attachmentId: sha256,
      displayName: "shared-image",
      size: byteLength,
      hash: sha256,
      finalizedAt: "",
    });
  }

  /**
   * The snapshot's document with each image's bytes added from the store. An
   * image whose bytes are gone or no longer match its digest is dropped with
   * every reference to it, so its block reads as its description and its
   * frame draws a placeholder rather than showing other bytes.
   */
  async withBytes(
    snapshotId: string,
    document: CanvasStaticExportDocument,
  ): Promise<CanvasStaticExportDocument> {
    const images = document.images ?? [];
    if (images.length === 0) return document;
    const kept: CanvasShareImageEntry[] = [];
    for (const image of images) {
      const bytes = await this.#read(snapshotId, image.sha256, image.byteLength).catch(
        () => undefined,
      );
      if (bytes !== undefined) kept.push({ ...image, data: Buffer.from(bytes).toString("base64") });
    }
    if (kept.length === images.length) return { ...document, images: kept };
    const present = new Set(kept.map((image) => String(image.imageRef)));
    const blocks = document.blocks.map((block) => {
      if (block.kind === "image" && block.imageRef !== undefined && !present.has(block.imageRef)) {
        const { imageRef: _imageRef, ...rest } = block;
        return rest;
      }
      if (block.kind === "design" && block.assets !== undefined) {
        const assets = block.assets.filter((asset) => present.has(String(asset.imageRef)));
        const { assets: _assets, ...rest } = block;
        return assets.length === 0 ? rest : { ...rest, assets };
      }
      return block;
    });
    const { images: _images, ...rest } = document;
    return { ...rest, blocks, ...(kept.length === 0 ? {} : { images: kept }) };
  }

  /** Remove every image a snapshot kept, once nobody can read it. */
  async forget(snapshotId: string): Promise<void> {
    await this.#store.purgeScope(snapshotId);
  }
}
