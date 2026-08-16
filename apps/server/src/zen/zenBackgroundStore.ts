import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  MAX_ZEN_BACKGROUND_BYTES,
  ZEN_BACKGROUND_MEDIA_TYPES,
  decodeZenBackgroundAssetId,
  decodeWindowId,
  decodeZenSpaceId,
  type WindowId,
  type ZenBackgroundAssetId,
  type ZenBackgroundMediaType,
  type ZenSpaceId,
} from "@octant/contracts";
import {
  extractZenBackgroundStillFrame,
  inspectZenBackgroundMedia,
  sniffZenBackgroundMedia,
  validateZenBackgroundDimensions,
  ZenBackgroundMediaError,
  MAX_ZEN_BACKGROUND_HEIGHT,
  MAX_ZEN_BACKGROUND_PIXELS,
  MAX_ZEN_BACKGROUND_WIDTH,
} from "@octant/contracts/zen-background-media";

export { MAX_ZEN_BACKGROUND_BYTES, ZEN_BACKGROUND_MEDIA_TYPES };
export { MAX_ZEN_BACKGROUND_HEIGHT, MAX_ZEN_BACKGROUND_PIXELS, MAX_ZEN_BACKGROUND_WIDTH };

export class ZenBackgroundStoreError extends Error {
  override readonly name = "ZenBackgroundStoreError";
  constructor(
    readonly reason: "invalid" | "too-large" | "unavailable",
    message: string,
  ) {
    super(message);
  }
}

export interface ZenBackgroundMetadata {
  readonly assetId: ZenBackgroundAssetId;
  readonly stillAssetId?: ZenBackgroundAssetId;
  readonly displayName: string;
  readonly mediaType: ZenBackgroundMediaType;
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly uploadedAt: string;
}

interface Sidecar extends ZenBackgroundMetadata {
  readonly digest: string;
  readonly ownerWindowId: WindowId;
  readonly spaceId: ZenSpaceId;
}

export class ZenBackgroundStore {
  readonly #dataDirectory: string;
  readonly #directory: string;

  constructor(options: { readonly dataDirectory: string }) {
    this.#dataDirectory = options.dataDirectory;
    this.#directory = join(options.dataDirectory, "zen-backgrounds");
  }

  async stage(input: {
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly displayName: string;
    readonly ownerWindowId: WindowId;
    readonly spaceId: ZenSpaceId;
  }): Promise<ZenBackgroundMetadata> {
    await this.#ensureDirectory();
    if (input.bytes.byteLength === 0) throw invalid("Zen background must not be empty.");
    if (input.bytes.byteLength > MAX_ZEN_BACKGROUND_BYTES) throw tooLarge();
    let inspection;
    try {
      inspection = inspectZenBackgroundMedia(input.bytes);
      validateZenBackgroundDimensions(inspection.width, inspection.height);
    } catch (error) {
      if (error instanceof ZenBackgroundMediaError) throw invalid(error.message);
      throw error;
    }
    if (inspection.mediaType !== input.mediaType)
      throw invalid("Zen background format is invalid.");
    const displayName = input.displayName.trim();
    if (displayName.length === 0 || displayName.length > 200)
      throw invalid("Zen background name is invalid.");
    const metadata = await this.#writeAsset({
      bytes: input.bytes,
      mediaType: inspection.mediaType,
      displayName,
      ownerWindowId: input.ownerWindowId,
      spaceId: input.spaceId,
      width: inspection.width,
      height: inspection.height,
    });
    if (!inspection.animated) return metadata;
    try {
      const still = extractZenBackgroundStillFrame(input.bytes);
      const stillInspection = inspectZenBackgroundMedia(still.bytes);
      validateZenBackgroundDimensions(stillInspection.width, stillInspection.height);
      const stillMetadata = await this.#writeAsset({
        bytes: still.bytes,
        mediaType: still.mediaType,
        displayName: `${displayName} still`,
        ownerWindowId: input.ownerWindowId,
        spaceId: input.spaceId,
        width: stillInspection.width,
        height: stillInspection.height,
      });
      return { ...metadata, stillAssetId: stillMetadata.assetId };
    } catch (error) {
      await this.delete(metadata.assetId, input.ownerWindowId);
      if (error instanceof ZenBackgroundMediaError) throw invalid(error.message);
      throw error;
    }
  }

  async read(
    assetId: string,
    ownerWindowId: WindowId,
  ): Promise<{ readonly metadata: ZenBackgroundMetadata; readonly bytes: Uint8Array }> {
    await this.#ensureDirectory();
    const id = this.#id(assetId);
    const sidecar = await this.#sidecar(id);
    if (sidecar.ownerWindowId !== ownerWindowId) throw unavailable();
    const path = this.#path(id, "bin");
    if (!(await regularFile(path))) throw unavailable();
    const bytes = new Uint8Array(await readFile(path));
    if (
      bytes.byteLength !== sidecar.byteLength ||
      digest(bytes) !== sidecar.digest ||
      sniffZenBackgroundMedia(bytes) !== sidecar.mediaType
    ) {
      throw unavailable();
    }
    try {
      const actual = inspectZenBackgroundMedia(bytes);
      if (
        actual.mediaType !== sidecar.mediaType ||
        actual.width !== sidecar.width ||
        actual.height !== sidecar.height
      ) {
        throw unavailable();
      }
      validateZenBackgroundDimensions(actual.width, actual.height);
    } catch {
      throw unavailable();
    }
    return { metadata: publicMetadata(sidecar), bytes };
  }

  async delete(assetId: string, ownerWindowId: WindowId): Promise<void> {
    await this.#ensureDirectory();
    const id = this.#id(assetId);
    const sidecar = await this.#sidecar(id);
    if (sidecar.ownerWindowId !== ownerWindowId) throw unavailable();
    await rm(this.#path(id, "bin"), { force: true });
    await rm(this.#path(id, "json"), { force: true });
  }

  #id(value: string): ZenBackgroundAssetId {
    try {
      return decodeZenBackgroundAssetId(value);
    } catch {
      throw unavailable();
    }
  }

  #path(id: ZenBackgroundAssetId, extension: "bin" | "json"): string {
    return join(this.#directory, `${id}.${extension}`);
  }

  async #sidecar(id: ZenBackgroundAssetId): Promise<Sidecar> {
    const path = this.#path(id, "json");
    if (!(await regularFile(path))) throw unavailable();
    try {
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!isSidecar(value) || value.assetId !== id) throw unavailable();
      validateSidecar(value);
      return value;
    } catch (error) {
      if (error instanceof ZenBackgroundStoreError) throw error;
      throw unavailable();
    }
  }

  /** Node cannot make check-and-use operations fully TOCTOU-proof against a
   * local user who can write the host data root. Each lifecycle boundary
   * rejects symlinked roots/directories; data-root permissions are the limit. */
  async #ensureDirectory(): Promise<void> {
    if (!(await realDirectory(this.#dataDirectory))) throw unavailable();
    await mkdir(this.#directory, { recursive: true }).catch(() => {
      throw unavailable();
    });
    if (!(await realDirectory(this.#directory))) throw unavailable();
  }

  async #writeAsset(input: {
    readonly bytes: Uint8Array;
    readonly mediaType: ZenBackgroundMediaType;
    readonly displayName: string;
    readonly ownerWindowId: WindowId;
    readonly spaceId: ZenSpaceId;
    readonly width: number;
    readonly height: number;
  }): Promise<ZenBackgroundMetadata> {
    const assetId = decodeZenBackgroundAssetId(randomUUID());
    const metadata: ZenBackgroundMetadata = {
      assetId,
      displayName: input.displayName,
      mediaType: input.mediaType,
      byteLength: input.bytes.byteLength,
      width: input.width,
      height: input.height,
      uploadedAt: new Date().toISOString(),
    };
    const sidecar: Sidecar = {
      ...metadata,
      digest: digest(input.bytes),
      ownerWindowId: input.ownerWindowId,
      spaceId: input.spaceId,
    };
    await writeFile(this.#path(assetId, "bin"), input.bytes, { flag: "wx" });
    try {
      await writeFile(this.#path(assetId, "json"), JSON.stringify(sidecar), {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (error) {
      await rm(this.#path(assetId, "bin"), { force: true });
      throw error;
    }
    return metadata;
  }

  async reconcile(
    live: ReadonlyMap<string, { readonly ownerWindowId: WindowId; readonly spaceId: ZenSpaceId }>,
    scope?: { readonly ownerWindowId: WindowId; readonly spaceId: ZenSpaceId },
  ): Promise<void> {
    await this.#ensureDirectory();
    for (const entry of await readdir(this.#directory)) {
      const match = /^([0-9a-f-]{36})\.(?:bin|json)$/i.exec(entry);
      if (match === null) continue;
      let id: ZenBackgroundAssetId;
      try {
        id = this.#id(match[1]!);
      } catch {
        continue;
      }
      let sidecar: Sidecar;
      try {
        sidecar = await this.#sidecar(id);
      } catch {
        if (!live.has(String(id))) {
          await rm(this.#path(id, "bin"), { force: true });
          await rm(this.#path(id, "json"), { force: true });
        }
        continue;
      }
      if (
        scope !== undefined &&
        (sidecar.ownerWindowId !== scope.ownerWindowId || sidecar.spaceId !== scope.spaceId)
      ) {
        continue;
      }
      const expected = live.get(String(id));
      if (
        expected === undefined ||
        expected.ownerWindowId !== sidecar.ownerWindowId ||
        expected.spaceId !== sidecar.spaceId
      ) {
        await rm(this.#path(id, "bin"), { force: true });
        await rm(this.#path(id, "json"), { force: true });
      }
    }
  }
}

function publicMetadata(sidecar: Sidecar): ZenBackgroundMetadata {
  const {
    digest: _digest,
    ownerWindowId: _ownerWindowId,
    spaceId: _spaceId,
    ...metadata
  } = sidecar;
  return metadata;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function invalid(message: string): ZenBackgroundStoreError {
  return new ZenBackgroundStoreError("invalid", message);
}

function tooLarge(): ZenBackgroundStoreError {
  return new ZenBackgroundStoreError("too-large", "Zen background is too large.");
}

function unavailable(): ZenBackgroundStoreError {
  return new ZenBackgroundStoreError("unavailable", "Zen background is unavailable.");
}

async function regularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

async function realDirectory(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function isSidecar(value: unknown): value is Sidecar {
  if (typeof value !== "object" || value === null) return false;
  const sidecar = value as Record<string, unknown>;
  return (
    typeof sidecar.assetId === "string" &&
    typeof sidecar.displayName === "string" &&
    (ZEN_BACKGROUND_MEDIA_TYPES as readonly string[]).includes(String(sidecar.mediaType)) &&
    Number.isInteger(sidecar.byteLength) &&
    Number.isInteger(sidecar.width) &&
    Number.isInteger(sidecar.height) &&
    typeof sidecar.uploadedAt === "string" &&
    typeof sidecar.digest === "string" &&
    typeof sidecar.ownerWindowId === "string" &&
    typeof sidecar.spaceId === "string"
  );
}

function validateSidecar(sidecar: Sidecar): void {
  try {
    decodeZenBackgroundAssetId(sidecar.assetId);
    decodeWindowId(sidecar.ownerWindowId);
    decodeZenSpaceId(sidecar.spaceId);
  } catch {
    throw unavailable();
  }
  if (
    !/^[a-f0-9]{64}$/.test(sidecar.digest) ||
    !Number.isSafeInteger(sidecar.byteLength) ||
    sidecar.byteLength < 1 ||
    sidecar.byteLength > MAX_ZEN_BACKGROUND_BYTES ||
    !Number.isSafeInteger(sidecar.width) ||
    !Number.isSafeInteger(sidecar.height) ||
    Number.isNaN(Date.parse(sidecar.uploadedAt))
  ) {
    throw unavailable();
  }
  try {
    validateZenBackgroundDimensions(sidecar.width, sidecar.height);
  } catch {
    throw unavailable();
  }
}
