import { createHash } from "node:crypto";
import {
  AggregateId,
  CANVAS_DESIGN_ASSET_MAX_BYTES,
  CANVAS_DESIGN_ASSETS_MAX_BYTES,
  CANVAS_VERSION_IMAGES_AGGREGATE_TYPE,
  CANVAS_VERSION_IMAGES_RECORDED,
  CanvasVersionImagesRecorded,
  CorrelationId,
  EventActor,
  EventId,
  decodeCanvasVersionImagesRecorded,
  type CanvasVersion,
  type CanvasVersionImageDigest,
} from "@octant/contracts";
import { Schema } from "effect";
import { sniffGeneratedImageMediaType } from "../image/generatedImageStore";
import type { EventRegistry } from "../persistence/eventRegistry";
import type { Journal } from "../persistence/journal";
import type { CanvasDesignAssetPorts } from "./canvasDesignAssets";

const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeActor = Schema.decodeUnknownSync(EventActor);

/** The journal's largest replay page. */
const RECORD_PAGE = 1_000;

export function registerCanvasVersionImagesEvents(registry: EventRegistry): EventRegistry {
  return registry.register(CANVAS_VERSION_IMAGES_RECORDED, 1, CanvasVersionImagesRecorded);
}

export type CanvasVersionImageAssetPorts = Pick<CanvasDesignAssetPorts, "projectFile"> &
  Partial<Pick<CanvasDesignAssetPorts, "generatedImage" | "browserCapture">>;

export interface CanvasVersionImageStoreOptions {
  readonly journal: Pick<Journal, "append" | "replayAggregate">;
  readonly ports: CanvasVersionImageAssetPorts;
  /**
   * Authoritative check run immediately before appending so an in-flight
   * asynchronous recording can never recreate a purged Canvas's aggregate.
   */
  readonly canvasExists?: (canvasId: string) => boolean;
  readonly uuid: () => string;
  readonly actor: EventActor;
}

/**
 * Records SHA-256 digests of the Project image files each locally-authored
 * Canvas version declares, in a separate per-Canvas journal aggregate.
 *
 * No image bytes are ever journaled or copied. An older version or preview
 * miniature compares the live file's digest against this record and withholds
 * any image whose bytes changed. A version without a record (pre-existing,
 * carried-in, replica-adopted, or interrupted before recording finished) stays
 * unrecorded and its surface labels the live images instead.
 */
export class CanvasVersionImageStore {
  readonly #journal: Pick<Journal, "append" | "replayAggregate">;
  readonly #ports: CanvasVersionImageAssetPorts;
  readonly #canvasExists: ((canvasId: string) => boolean) | undefined;
  readonly #uuid: () => string;
  readonly #actor: EventActor;
  readonly #pending = new Map<string, Promise<void>>();
  readonly #appendTail = new Map<string, Promise<void>>();
  readonly #cache = new Map<
    string,
    { headVersion: number; readonly byVersion: Map<string, CanvasVersionImagesRecorded> }
  >();

  constructor(options: CanvasVersionImageStoreOptions) {
    this.#journal = options.journal;
    this.#ports = options.ports;
    this.#canvasExists = options.canvasExists;
    this.#uuid = options.uuid;
    this.#actor = decodeActor(options.actor);
  }

  /**
   * Read and hash every `project-file` asset declared by `version`'s designs
   * and append one `canvas.version-images-recorded@1` event. Appends nothing
   * when no design in the version declares a `project-file`, so Canvases
   * without Project images never write the new event.
   */
  record(version: CanvasVersion): Promise<void> {
    const designs = version.definition.blocks.filter(
      (
        block,
      ): block is Extract<CanvasVersion["definition"]["blocks"][number], { kind: "design" }> =>
        block.kind === "design" &&
        (block.assets ?? []).some((asset) => asset.source.kind === "project-file"),
    );
    if (designs.length === 0) return Promise.resolve();

    const canvasId = String(version.canvasId);
    const versionId = String(version.versionId);
    const key = `${canvasId}\u0000${versionId}`;
    const existing = this.#pending.get(key);
    if (existing !== undefined) return existing;

    const work = this.#recordDesigns(version, designs).finally(() => {
      if (this.#pending.get(key) === work) this.#pending.delete(key);
    });
    this.#pending.set(key, work);
    return work;
  }

  /**
   * Drops in-memory cached digest records for purged Canvases so erased
   * histories do not linger in memory until server restart.
   */
  evict(canvasIds: ReadonlyArray<string>): void {
    for (const canvasId of canvasIds) {
      this.#cache.delete(canvasId);
    }
  }

  /**
   * The recorded Project image digests for one version, or `undefined` when
   * none was recorded. Waits for any in-flight recording of this version so a
   * read right after commit sees its record rather than racing with it.
   */
  async recordForVersion(
    canvasId: string,
    versionId: string,
  ): Promise<CanvasVersionImagesRecorded | undefined> {
    const pending = this.#pending.get(`${canvasId}\u0000${versionId}`);
    if (pending !== undefined) await pending.catch(() => undefined);
    if (this.#canvasExists !== undefined && !this.#canvasExists(canvasId)) {
      this.#cache.delete(canvasId);
      return undefined;
    }
    try {
      const cached = this.#syncCanvasCache(canvasId);
      return cached.byVersion.get(versionId);
    } catch {
      return undefined;
    }
  }

  #syncCanvasCache(canvasId: string): {
    headVersion: number;
    readonly byVersion: Map<string, CanvasVersionImagesRecorded>;
  } {
    let entry = this.#cache.get(canvasId);
    if (entry === undefined) {
      entry = { headVersion: 0, byVersion: new Map() };
      this.#cache.set(canvasId, entry);
    }
    while (true) {
      const page = this.#journal.replayAggregate({
        aggregateType: CANVAS_VERSION_IMAGES_AGGREGATE_TYPE,
        aggregateId: canvasId,
        afterVersion: entry.headVersion,
        limit: RECORD_PAGE,
      });
      for (const event of page) {
        const decoded = decodeCanvasVersionImagesRecorded(event.payload);
        entry.byVersion.set(String(decoded.versionId), decoded);
        entry.headVersion = event.aggregateVersion;
      }
      if (page.length < RECORD_PAGE) return entry;
    }
  }

  /**
   * The recorded Project image digests for one design block in a version,
   * keyed by `assetId`, or `undefined` when the version has no record.
   */
  async forBlock(
    canvasId: string,
    versionId: string,
    blockId: string,
  ): Promise<ReadonlyMap<string, CanvasVersionImageDigest> | undefined> {
    const record = await this.recordForVersion(canvasId, versionId);
    if (record === undefined) return undefined;
    const byAsset = new Map<string, CanvasVersionImageDigest>();
    for (const entry of record.images) {
      if (String(entry.blockId) === blockId) {
        byAsset.set(String(entry.assetId), entry);
      }
    }
    return byAsset;
  }

  /** Wait until all in-flight recordings and journal appends have settled. */
  async whenIdle(): Promise<void> {
    while (this.#pending.size > 0 || this.#appendTail.size > 0) {
      await Promise.allSettled([...this.#pending.values(), ...this.#appendTail.values()]);
    }
  }

  async #recordDesigns(
    version: CanvasVersion,
    designs: ReadonlyArray<
      Extract<CanvasVersion["definition"]["blocks"][number], { kind: "design" }>
    >,
  ): Promise<void> {
    const provenance = version.definition.provenance;
    const createdAtMs = Date.parse(version.createdAt);
    const images: CanvasVersionImageDigest[] = [];

    try {
      for (const block of designs) {
        let spent = 0;
        for (const asset of block.assets ?? []) {
          const remaining = CANVAS_DESIGN_ASSETS_MAX_BYTES - spent;
          const maximumBytes = Math.min(CANVAS_DESIGN_ASSET_MAX_BYTES, remaining);

          // Account for non-Project images in the same declaration order and
          // shared 5 MiB design budget as `resolveCanvasDesignAssets` so mixed
          // designs never record a skipped Project image and evict a shown one.
          if (asset.source.kind === "generated-image") {
            if (maximumBytes > 0 && this.#ports.generatedImage !== undefined) {
              const read = await this.#ports.generatedImage({
                imageId: asset.source.imageId,
                projectId: provenance.projectId === null ? null : String(provenance.projectId),
                threadId: String(provenance.threadId),
                maximumBytes,
              });
              if (
                read.status === "read" &&
                read.bytes.byteLength <= maximumBytes &&
                sniffGeneratedImageMediaType(read.bytes) !== undefined
              ) {
                spent += read.bytes.byteLength;
              }
            }
            continue;
          }
          if (asset.source.kind === "browser-capture") {
            if (
              provenance.mode !== "chat" &&
              maximumBytes > 0 &&
              this.#ports.browserCapture !== undefined
            ) {
              const read = await this.#ports.browserCapture({
                captureId: asset.source.captureId,
                threadId: String(provenance.threadId),
                maximumBytes,
              });
              if (
                read.status === "read" &&
                read.bytes.byteLength <= maximumBytes &&
                sniffGeneratedImageMediaType(read.bytes) !== undefined
              ) {
                spent += read.bytes.byteLength;
              }
            }
            continue;
          }

          if (provenance.mode === "chat" || provenance.projectId === null || maximumBytes <= 0) {
            images.push({
              blockId: block.blockId,
              assetId: asset.assetId,
              status: "unavailable",
            });
            continue;
          }
          const read = await this.#ports.projectFile({
            mode: provenance.mode,
            projectId: String(provenance.projectId),
            threadId: String(provenance.threadId),
            path: asset.source.path,
            maximumBytes,
          });
          // A file or symlink replaced between commit and this read must not be
          // stamped as the original. Comparing in whole milliseconds matches
          // `createdAt`'s millisecond precision so a file written just before
          // commit in the same millisecond is kept while any later change is
          // rejected.
          const changedAfterCommit =
            read.status === "read" &&
            read.changedAt !== undefined &&
            (!Number.isFinite(createdAtMs) || read.changedAt / 1_000_000n > BigInt(createdAtMs));
          if (
            read.status !== "read" ||
            changedAfterCommit ||
            read.bytes.byteLength > maximumBytes ||
            sniffGeneratedImageMediaType(read.bytes) === undefined
          ) {
            images.push({
              blockId: block.blockId,
              assetId: asset.assetId,
              status: "unavailable",
            });
            continue;
          }
          spent += read.bytes.byteLength;
          images.push({
            blockId: block.blockId,
            assetId: asset.assetId,
            status: "recorded",
            sha256: createHash("sha256").update(read.bytes).digest("hex"),
          });
        }
      }
      if (images.length === 0) return;

      const canvasId = String(version.canvasId);
      const previous = this.#appendTail.get(canvasId) ?? Promise.resolve();
      const appendWork = previous
        .catch(() => undefined)
        .then(() => this.#appendRecord(version, images))
        .finally(() => {
          if (this.#appendTail.get(canvasId) === appendWork) this.#appendTail.delete(canvasId);
        });
      this.#appendTail.set(canvasId, appendWork);
      await appendWork;
    } catch {
      // A failed recording never undoes a committed version: leaving the
      // version unrecorded causes older-version reads to label it instead.
    }
  }

  #appendRecord(version: CanvasVersion, images: ReadonlyArray<CanvasVersionImageDigest>): void {
    const canvasId = String(version.canvasId);
    const versionId = String(version.versionId);
    // Do not recreate the aggregate if the Canvas was purged while async file reads ran.
    if (this.#canvasExists !== undefined && !this.#canvasExists(canvasId)) {
      this.#cache.delete(canvasId);
      return;
    }
    const cached = this.#syncCanvasCache(canvasId);
    if (cached.byVersion.has(versionId)) return;
    const headVersion = cached.headVersion;
    const payload = decodeCanvasVersionImagesRecorded({
      canvasId: version.canvasId,
      versionId: version.versionId,
      images,
    });
    this.#journal.append({
      aggregate: {
        aggregateType: CANVAS_VERSION_IMAGES_AGGREGATE_TYPE,
        aggregateId: decodeAggregateId(canvasId),
      },
      expectedVersion: headVersion,
      events: [
        {
          eventId: decodeEventId(this.#uuid()),
          eventName: CANVAS_VERSION_IMAGES_RECORDED,
          eventVersion: 1,
          correlationId: decodeCorrelationId(this.#uuid()),
          actor: this.#actor,
          occurredAt: version.createdAt,
          payload,
        },
      ],
    });
    cached.headVersion = headVersion + 1;
    cached.byVersion.set(versionId, payload);
  }
}
