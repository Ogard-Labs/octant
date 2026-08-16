import { deflateRawSync, inflateRawSync } from "node:zlib";

/**
 * Maximum uncompressed byte size for a single ZIP entry. Bounded to the Work
 * output budget so a crafted or externally modified entry cannot expand to
 * hundreds of MiB and block or crash the server before the post-inflate output
 * budget check can reject it. Must stay aligned with `MAX_WORK_OUTPUT_BYTES`.
 */
const MAX_WORK_ZIP_ENTRY_BYTES = 16 * 1024 * 1024;

/**
 * Maximum number of ZIP entries in a single container. A valid OOXML file
 * (docx, xlsx, pptx) has at most a few dozen parts; a crafted archive could
 * declare up to 65535 central-directory entries, each up to 16 MiB
 * uncompressed. Bounding the entry count prevents a crafted archive from
 * inflating tens of thousands of parts into memory during decode/revise.
 */
const MAX_WORK_ZIP_ENTRY_COUNT = 1000;

/**
 * Maximum total uncompressed bytes across all entries in a single container.
 * Even with per-entry and entry-count limits, 1000 × 16 MiB = 16 GiB would
 * exhaust memory. A valid OOXML file (docx/xlsx/pptx) is well under 100 MiB
 * total; 256 MiB is a generous ceiling that prevents a crafted archive from
 * inflating into memory while accommodating any legitimate Office artifact.
 */
const MAX_WORK_ZIP_TOTAL_BYTES = 256 * 1024 * 1024;

function isSafeZipEntryName(name: string): boolean {
  if (
    name.length === 0 ||
    name.includes("\\") ||
    name.includes("\0") ||
    name.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(name)
  ) {
    return false;
  }
  return name.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * Minimal in-memory ZIP (Open Packaging Conventions) port for Work OOXML
 * adapters (docx, xlsx, pptx). Produces valid ZIP containers with deflate
 * compression so the resulting Office files are recognized by Quick Look,
 * Finder, and external applications. Reads entries back for round-trip decode.
 *
 * This is a deliberately small, dependency-free OPC container writer/reader:
 * it handles the ZIP central directory and local file headers, CRC-32, and
 * deflate/inflate through Node's built-in zlib. It does not implement
 * encryption, ZIP64, or non-OPC ZIP features; Work Office artifacts only
 * need a constrained set of XML parts inside the container.
 */

export interface WorkZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

const CRC_TABLE: ReadonlyArray<number> = (() => {
  const table = Array.from({ length: 256 }, () => 0);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const textEncoder = new TextEncoder();

function u16(value: number): number {
  return value & 0xffff;
}

function u32(value: number): number {
  return value >>> 0;
}

function writeU16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, u16(value), true);
}

function writeU32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, u32(value), true);
}

/**
 * Pack entries into a ZIP container. Uses deflate compression for entries
 * larger than a small threshold and stored (uncompressed) for tiny entries
 * where deflate overhead exceeds the payload. Returns the raw container bytes.
 */
export function writeWorkZip(entries: ReadonlyArray<WorkZipEntry>): Uint8Array {
  const localHeaders: Array<{
    readonly name: string;
    readonly crc: number;
    readonly compressed: Uint8Array;
    readonly method: number;
    readonly uncompressedSize: number;
    readonly localHeaderOffset: number;
  }> = [];
  const chunks: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = textEncoder.encode(entry.name);
    const crc = crc32(entry.data);
    const useDeflate = entry.data.byteLength > 16;
    let compressed: Uint8Array;
    let method: number;
    if (useDeflate) {
      compressed = deflateRawSync(entry.data, { level: 6 });
      method = 8;
    } else {
      compressed = entry.data;
      method = 0;
    }
    const localHeaderOffset = offset;
    const localHeader = new Uint8Array(30 + nameBytes.byteLength);
    const localView = new DataView(localHeader.buffer);
    writeU32(localView, 0, 0x04034b50);
    writeU16(localView, 4, 20);
    writeU16(localView, 6, 0);
    writeU16(localView, 8, method);
    writeU16(localView, 10, 0);
    writeU16(localView, 12, 0);
    writeU32(localView, 14, crc);
    writeU32(localView, 18, u32(compressed.byteLength));
    writeU32(localView, 22, u32(entry.data.byteLength));
    writeU16(localView, 26, u16(nameBytes.byteLength));
    writeU16(localView, 28, 0);
    localHeader.set(nameBytes, 30);
    chunks.push(localHeader, compressed);
    offset += localHeader.byteLength + compressed.byteLength;
    localHeaders.push({
      name: entry.name,
      crc,
      compressed,
      method,
      uncompressedSize: entry.data.byteLength,
      localHeaderOffset,
    });
  }

  const centralStart = offset;
  for (const header of localHeaders) {
    const nameBytes = textEncoder.encode(header.name);
    const central = new Uint8Array(46 + nameBytes.byteLength);
    const view = new DataView(central.buffer);
    writeU32(view, 0, 0x02014b50);
    writeU16(view, 4, 20);
    writeU16(view, 6, 20);
    writeU16(view, 8, 0);
    writeU16(view, 10, header.method);
    writeU16(view, 12, 0);
    writeU16(view, 14, 0);
    writeU32(view, 16, header.crc);
    writeU32(view, 20, u32(header.compressed.byteLength));
    writeU32(view, 24, u32(header.uncompressedSize));
    writeU16(view, 28, u16(nameBytes.byteLength));
    writeU16(view, 30, 0);
    writeU16(view, 32, 0);
    writeU16(view, 34, 0);
    writeU16(view, 36, 0);
    writeU32(view, 38, 0);
    writeU32(view, 42, u32(header.localHeaderOffset));
    central.set(nameBytes, 46);
    chunks.push(central);
    offset += central.byteLength;
  }
  const centralSize = offset - centralStart;

  const endRecord = new Uint8Array(22);
  const endView = new DataView(endRecord.buffer);
  writeU32(endView, 0, 0x06054b50);
  writeU16(endView, 4, 0);
  writeU16(endView, 6, 0);
  writeU16(endView, 8, u16(localHeaders.length));
  writeU16(endView, 10, u16(localHeaders.length));
  writeU32(endView, 12, u32(centralSize));
  writeU32(endView, 16, u32(centralStart));
  writeU16(endView, 20, 0);
  chunks.push(endRecord);

  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  return out;
}

/**
 * Read a ZIP container into entries. Returns the entry map keyed by name.
 * Throws when the container is malformed (bad magic, truncated central
 * directory, or inflate failure) so the adapter can surface a parse failure.
 */
export function readWorkZip(bytes: Uint8Array): Map<string, Uint8Array> {
  if (bytes.byteLength < 22) {
    throw new Error("ZIP container is too small to contain an end-of-central-directory record");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let endOffset = -1;
  for (let i = bytes.byteLength - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      endOffset = i;
      break;
    }
  }
  if (endOffset === -1) {
    throw new Error("ZIP end-of-central-directory record not found");
  }
  const entryCount = view.getUint16(endOffset + 10, true);
  if (entryCount > MAX_WORK_ZIP_ENTRY_COUNT) {
    throw new Error(`ZIP entry count ${entryCount} exceeds maximum ${MAX_WORK_ZIP_ENTRY_COUNT}`);
  }
  const centralOffset = view.getUint32(endOffset + 16, true);
  const entries = new Map<string, Uint8Array>();
  let cursor = centralOffset;
  let totalUncompressed = 0;
  for (let i = 0; i < entryCount; i += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) {
      throw new Error("ZIP central directory entry has bad magic");
    }
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;

    if (!isSafeZipEntryName(name)) {
      throw new Error(`ZIP entry ${name} has an unsafe entry name`);
    }
    if (entries.has(name)) {
      throw new Error(`ZIP container has a duplicate entry name: ${name}`);
    }

    if (uncompressedSize > MAX_WORK_ZIP_ENTRY_BYTES) {
      throw new Error(`ZIP entry ${name} uncompressed size ${uncompressedSize} exceeds budget`);
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_WORK_ZIP_TOTAL_BYTES) {
      throw new Error(
        `ZIP total uncompressed size ${totalUncompressed} exceeds budget ${MAX_WORK_ZIP_TOTAL_BYTES}`,
      );
    }
    if (view.getUint32(localHeaderOffset, true) !== 0x04034b50) {
      throw new Error("ZIP local file header has bad magic");
    }
    const localNameLength = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    let data: Uint8Array;
    if (method === 0) {
      data = compressed;
    } else if (method === 8) {
      data = inflateRawSync(compressed, {
        maxOutputLength: MAX_WORK_ZIP_ENTRY_BYTES,
      });
    } else {
      throw new Error(`ZIP entry ${name} uses unsupported method ${method}`);
    }
    if (data.byteLength !== uncompressedSize) {
      throw new Error(`ZIP entry ${name} uncompressed size mismatch`);
    }
    entries.set(name, data);
  }
  return entries;
}
