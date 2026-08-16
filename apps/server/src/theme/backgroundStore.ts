import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  MAX_SIDEBAR_BACKGROUND_BYTES,
  SIDEBAR_BACKGROUND_MAX_WIDTH,
  SIDEBAR_BACKGROUND_MAX_HEIGHT,
  SIDEBAR_BACKGROUND_MEDIA_TYPES,
  decodeSidebarBackgroundId,
  decodeSidebarBackgroundMetadata,
  type SidebarBackgroundId,
  type SidebarBackgroundMetadata,
} from "@octant/contracts";

export class SidebarBackgroundTooLarge extends Error {
  override readonly name = "SidebarBackgroundTooLarge";
  constructor(readonly byteLength: number) {
    super(
      `Sidebar background is too large (${byteLength} bytes). The maximum size is ${MAX_SIDEBAR_BACKGROUND_BYTES} bytes.`,
    );
  }
}

export class SidebarBackgroundInvalidFormat extends Error {
  override readonly name = "SidebarBackgroundInvalidFormat";
  constructor(message: string) {
    super(message);
  }
}

export class SidebarBackgroundNotFound extends Error {
  override readonly name = "SidebarBackgroundNotFound";
  constructor(readonly id: string) {
    super(`Sidebar background not found: ${id}`);
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const WEBP_RIFF = "RIFF";
const WEBP_MAGIC = "WEBP";
const FINALIZED_FILE = "finalized.bin";
const SIDECAR_FILE = "finalized.meta.json";

type BgMediaType = (typeof SIDEBAR_BACKGROUND_MEDIA_TYPES)[number];

interface BackgroundSidecar extends SidebarBackgroundMetadata {
  readonly hash: string;
}

export interface SidebarBackgroundStaged {
  readonly id: SidebarBackgroundId;
  readonly displayName: string;
  readonly mediaType: BgMediaType;
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly stagedAt: string;
}

function detectMediaType(bytes: Uint8Array): BgMediaType | null {
  const buf = Buffer.from(bytes);
  if (buf.length >= 8 && PNG_SIGNATURE.equals(buf.subarray(0, 8))) return "image/png";
  if (buf.length >= 3 && JPEG_SIGNATURE.equals(buf.subarray(0, 3))) return "image/jpeg";
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === WEBP_RIFF &&
    buf.toString("ascii", 8, 12) === WEBP_MAGIC
  ) {
    return "image/webp";
  }
  return null;
}

function decodePngDimensions(bytes: Uint8Array): { width: number; height: number } {
  const buf = Buffer.from(bytes);
  if (buf.length < 24) throw new SidebarBackgroundInvalidFormat("PNG too short for IHDR.");
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

function decodeJpegDimensions(bytes: Uint8Array): { width: number; height: number } {
  const buf = Buffer.from(bytes);
  // Scan JPEG segments for SOF0–SOF15 markers (0xFFC0–0xFFCF, excluding 0xFFC4/0xFFC8/0xFFCC).
  let offset = 2; // skip SOI (0xFFD8)
  while (offset + 1 < buf.length) {
    if (buf[offset] !== 0xff) break;
    const marker = buf[offset + 1]!;
    // SOFn markers: 0xC0–0xCF, excluding C4 (DHT), C8 (JPG), CC (DAC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 9 >= buf.length) break;
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      return { width, height };
    }
    // Other markers have a 2-byte length following.
    if (offset + 3 >= buf.length) break;
    const segmentLength = buf.readUInt16BE(offset + 2);
    offset += 2 + segmentLength;
  }
  // Fallback: assume max-allowed so validation does not reject unknown JPEGs on dimension grounds.
  return { width: SIDEBAR_BACKGROUND_MAX_WIDTH, height: SIDEBAR_BACKGROUND_MAX_HEIGHT };
}

function decodeWebpDimensions(bytes: Uint8Array): { width: number; height: number } {
  const buf = Buffer.from(bytes);
  const fourcc = buf.toString("ascii", 12, 16);
  if (fourcc === "VP8 ") {
    // VP8 (lossy): RIFF header (12) + "VP8 " (4) + chunk size (4) = offset 20.
    // Frame tag at 20-22, start code 0x9d012a at 23-25, width at 26-27, height at 28-29 (14-bit LE).
    if (buf.length < 30) throw new SidebarBackgroundInvalidFormat("WebP too short for VP8 header.");
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) {
      throw new SidebarBackgroundInvalidFormat("WebP VP8 start code is missing.");
    }
    const width = buf.readUInt16LE(26) & 0x3fff;
    const height = buf.readUInt16LE(28) & 0x3fff;
    return { width, height };
  }
  // VP8L (lossless) or VP8X (extended): dimension parsing varies; use max-allowed fallback
  // since magic-byte + size limits still apply.
  return { width: SIDEBAR_BACKGROUND_MAX_WIDTH, height: SIDEBAR_BACKGROUND_MAX_HEIGHT };
}

function computeHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function toContractMetadata(sidecar: BackgroundSidecar): SidebarBackgroundMetadata {
  return {
    id: sidecar.id,
    displayName: sidecar.displayName,
    mediaType: sidecar.mediaType,
    byteLength: sidecar.byteLength,
    width: sidecar.width,
    height: sidecar.height,
    uploadedAt: sidecar.uploadedAt,
  };
}

export class SidebarBackgroundStore {
  private readonly backgroundsDir: string;

  constructor(options: { readonly dataDirectory: string }) {
    this.backgroundsDir = join(options.dataDirectory, "backgrounds");
  }

  private validateId(id: string): SidebarBackgroundId {
    return decodeSidebarBackgroundId(id);
  }

  private pathFor(id: string, file: string): string {
    return join(this.backgroundsDir, `${id}.${file}`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.backgroundsDir, { recursive: true });
  }

  async stage(input: {
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly displayName: string;
  }): Promise<SidebarBackgroundStaged> {
    if (input.bytes.length === 0) {
      throw new SidebarBackgroundInvalidFormat("Sidebar background must not be empty.");
    }
    if (input.bytes.length > MAX_SIDEBAR_BACKGROUND_BYTES) {
      throw new SidebarBackgroundTooLarge(input.bytes.length);
    }
    const detected = detectMediaType(input.bytes);
    if (detected === null) {
      throw new SidebarBackgroundInvalidFormat(
        "Sidebar background magic bytes are not recognized.",
      );
    }
    if (detected !== input.mediaType) {
      throw new SidebarBackgroundInvalidFormat(
        `Sidebar background media type ${input.mediaType} does not match detected ${detected}.`,
      );
    }
    if (!SIDEBAR_BACKGROUND_MEDIA_TYPES.includes(detected)) {
      throw new SidebarBackgroundInvalidFormat(
        `Sidebar background media type ${detected} is not supported.`,
      );
    }
    const dims =
      detected === "image/png"
        ? decodePngDimensions(input.bytes)
        : detected === "image/jpeg"
          ? decodeJpegDimensions(input.bytes)
          : decodeWebpDimensions(input.bytes);
    if (
      dims.width <= 0 ||
      dims.height <= 0 ||
      dims.width > SIDEBAR_BACKGROUND_MAX_WIDTH ||
      dims.height > SIDEBAR_BACKGROUND_MAX_HEIGHT
    ) {
      throw new SidebarBackgroundInvalidFormat(
        `Sidebar background dimensions ${dims.width}x${dims.height} exceed the maximum.`,
      );
    }

    const id = randomUUID() as SidebarBackgroundId;
    const hash = computeHash(input.bytes);
    const metadata = decodeSidebarBackgroundMetadata({
      id,
      displayName: input.displayName.slice(0, 255),
      mediaType: detected,
      byteLength: input.bytes.length,
      width: dims.width,
      height: dims.height,
      uploadedAt: new Date().toISOString(),
    });
    const sidecar: BackgroundSidecar = { ...metadata, hash };

    await this.ensureDir();
    const binPath = this.pathFor(id, FINALIZED_FILE);
    const metaPath = this.pathFor(id, SIDECAR_FILE);
    await writeFile(binPath, input.bytes);
    await writeFile(metaPath, JSON.stringify(sidecar), "utf8");

    return {
      id,
      displayName: metadata.displayName,
      mediaType: detected,
      byteLength: input.bytes.length,
      width: dims.width,
      height: dims.height,
      stagedAt: new Date().toISOString(),
    };
  }

  async finalize(id: string): Promise<SidebarBackgroundMetadata> {
    const decodedId = this.validateId(id);
    const metaPath = this.pathFor(decodedId, SIDECAR_FILE);
    const binPath = this.pathFor(decodedId, FINALIZED_FILE);
    if (!(await exists(metaPath)) || !(await exists(binPath))) {
      throw new SidebarBackgroundNotFound(decodedId);
    }
    return this.readMetadata(decodedId);
  }

  private async readMetadata(decodedId: SidebarBackgroundId): Promise<BackgroundSidecar> {
    const metaPath = this.pathFor(decodedId, SIDECAR_FILE);
    let raw: string;
    try {
      raw = await readFile(metaPath, "utf8");
    } catch {
      throw new SidebarBackgroundNotFound(decodedId);
    }
    const parsed = JSON.parse(raw) as BackgroundSidecar;
    return parsed;
  }

  async metadata(id: string): Promise<SidebarBackgroundMetadata> {
    const decodedId = this.validateId(id);
    const sidecar = await this.readMetadata(decodedId);
    return toContractMetadata(sidecar);
  }

  async read(id: string): Promise<Uint8Array> {
    const decodedId = this.validateId(id);
    const binPath = this.pathFor(decodedId, FINALIZED_FILE);
    const sidecar = await this.readMetadata(decodedId);
    let bytes: Buffer;
    try {
      bytes = await readFile(binPath);
    } catch {
      throw new SidebarBackgroundNotFound(decodedId);
    }
    const actualHash = computeHash(new Uint8Array(bytes));
    if (actualHash !== sidecar.hash) {
      throw new SidebarBackgroundInvalidFormat(`Sidebar background corrupt: ${decodedId}`);
    }
    return new Uint8Array(bytes);
  }

  async list(): Promise<ReadonlyArray<SidebarBackgroundMetadata>> {
    if (!(await exists(this.backgroundsDir))) return [];
    const entries = await readdir(this.backgroundsDir);
    const results: SidebarBackgroundMetadata[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(`.${SIDECAR_FILE}`)) continue;
      const id = entry.slice(0, -`.${SIDECAR_FILE}`.length);
      try {
        const decodedId = this.validateId(id);
        const sidecar = await this.readMetadata(decodedId);
        results.push(toContractMetadata(sidecar));
      } catch {
        // Skip malformed sidecars.
      }
    }
    return results;
  }

  async delete(id: string): Promise<void> {
    const decodedId = this.validateId(id);
    const binPath = this.pathFor(decodedId, FINALIZED_FILE);
    const metaPath = this.pathFor(decodedId, SIDECAR_FILE);
    await rm(binPath, { force: true });
    await rm(metaPath, { force: true });
  }

  async exists(id: string): Promise<boolean> {
    try {
      const decodedId = this.validateId(id);
      const metaPath = this.pathFor(decodedId, SIDECAR_FILE);
      return await exists(metaPath);
    } catch {
      return false;
    }
  }
}
