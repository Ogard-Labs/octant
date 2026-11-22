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
const decodeDigest = Schema.decodeUnknownSync(Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)));

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
   * Keep the bytes of each image the snapshot names, from the images the host
   * resolved when it was made. An image whose bytes are not among them is not
   * kept, and the snapshot reads without it.
   */
  async keep(
    snapshotId: string,
    images: ReadonlyArray<CanvasShareImageEntry>,
    resolved: CanvasShareResolvedImages,
  ): Promise<void> {
    const bySha = new Map([...resolved.values()].map((image) => [image.sha256, image]));
    for (const image of images) {
      const source = bySha.get(image.sha256);
      if (source === undefined) continue;
      const staged = await this.#store.stage({
        scopeId: snapshotId,
        attachmentId: image.sha256,
        displayName: String(image.imageRef),
        bytes: Buffer.from(source.data, "base64"),
      });
      if (staged.hash !== image.sha256) {
        await this.#store.remove(snapshotId, image.sha256);
        continue;
      }
      await this.#store.finalize(staged);
    }
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
      const bytes = await this.#store
        .read({
          scopeId: snapshotId,
          attachmentId: image.sha256,
          displayName: String(image.imageRef),
          size: image.byteLength,
          hash: image.sha256,
          finalizedAt: "",
        })
        .catch(() => undefined);
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
