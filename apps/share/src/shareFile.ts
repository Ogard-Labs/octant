import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import {
  CANVAS_SHARE_SCHEMA_VERSION,
  CanvasDesignAssetMediaType,
  type CanvasPublicShareDocument,
  type CanvasShareImage,
} from "./shareKit.ts";

// How one share is laid out in its file. The file is one JSON document, as it
// has been since the first version, so an earlier version of the service
// reads it whole and an operator can go back to it. What this layout adds is
// an order: everything but the document comes first, with the byte range of
// each image's text inside the document, so an image is read from its range
// without parsing the rest.
//
//   {"headBytes":"00000512",<terms>,"imageIndex":{…}   the first 512 bytes
//   ,"document":{…,"images":[…]}}                      `bodyBytes` bytes
//
// The first `headBytes` bytes and a closing brace are a JSON document of their
// own. One file rather than a file per image keeps every write one atomic
// rename and every delete one unlink, so no image outlives or goes missing
// from its share.

const HEAD_START = /^\{"headBytes":"(\d{8})",/;
/** Enough for a share with a few images, so its head takes one read. */
const FIRST_READ_BYTES = 2048;
const QUOTE = 0x22;

interface ImageRange {
  readonly sha256: string;
  readonly mediaType: CanvasShareImage["mediaType"];
  /** Where the image's quoted base64 text starts, counted from the end of the head. */
  readonly start: number;
  readonly length: number;
}

/** A design's block id and the positions of the images it names. */
type DesignImages = readonly [string, ReadonlyArray<number>];

interface ImageIndex {
  /** The share version the document is written in; a later one is not read here. */
  readonly shareSchemaVersion: number;
  readonly bodyBytes: number;
  readonly images: ReadonlyArray<ImageRange>;
  readonly designs: ReadonlyArray<DesignImages>;
}

export interface CarriedImage {
  readonly sha256: string;
  readonly mediaType: CanvasShareImage["mediaType"];
  /** The designs that name it; a frame serves only the images its own design names. */
  readonly designs: ReadonlySet<string>;
  /** Its bytes, or undefined when the file does not hold them where it says. */
  readonly read: () => Buffer<ArrayBuffer> | undefined;
}

// Blocks are looked up by id elsewhere, so a repeated id means its first design.
function designImages(document: CanvasPublicShareDocument): ReadonlyArray<DesignImages> {
  const designs = new Map<string, ReadonlyArray<number>>();
  const images = document.images ?? [];
  for (const block of document.blocks) {
    if (block.kind !== "design" || designs.has(String(block.blockId))) continue;
    const named = new Set((block.assets ?? []).map((asset) => String(asset.imageRef)));
    const positions = images.flatMap((image, at) =>
      named.has(String(image.imageRef)) ? [at] : [],
    );
    designs.set(String(block.blockId), positions);
  }
  return [...designs].filter(([, positions]) => positions.length > 0);
}

function designsNaming(designs: ReadonlyArray<DesignImages>, at: number): ReadonlySet<string> {
  return new Set(
    designs.filter(([, positions]) => positions.includes(at)).map(([blockId]) => blockId),
  );
}

/** The images of a document already read whole. */
export function documentImages(document: CanvasPublicShareDocument): ReadonlyArray<CarriedImage> {
  const designs = designImages(document);
  return (document.images ?? []).map((image, at) => ({
    sha256: image.sha256,
    mediaType: image.mediaType,
    designs: designsNaming(designs, at),
    read: () => Buffer.from(image.data, "base64"),
  }));
}

/** A share's file content: its terms and image index first, its document last. */
export function encodeShareFile<T extends { readonly document: CanvasPublicShareDocument }>(
  share: T,
): string {
  const { document, ...terms } = share;
  const { images, ...text } = document;
  let body = `,"document":${JSON.stringify(text)}`;
  let bodyBytes = Buffer.byteLength(body, "utf8");
  const append = (part: string) => {
    body += part;
    bodyBytes += Buffer.byteLength(part, "utf8");
  };
  const ranges: ImageRange[] = [];
  if (images !== undefined) {
    // Reopen the document's object to write its images last, one by one.
    body = body.slice(0, -1);
    bodyBytes -= 1;
    append(',"images":[');
    images.forEach((image, at) => {
      const { data, ...fields } = image;
      append(`${at === 0 ? "" : ","}${JSON.stringify(fields).slice(0, -1)},"data":`);
      const quoted = JSON.stringify(data);
      ranges.push({
        sha256: image.sha256,
        mediaType: image.mediaType,
        start: bodyBytes,
        length: Buffer.byteLength(quoted, "utf8"),
      });
      append(`${quoted}}`);
    });
    append("]}");
  }
  append("}");
  const imageIndex: ImageIndex = {
    shareSchemaVersion: document.shareSchemaVersion,
    bodyBytes,
    images: ranges,
    designs: designImages(document),
  };
  const head = `,${JSON.stringify({ ...terms, imageIndex }).slice(1, -1)}`;
  const headBytes = `{"headBytes":"00000000"`.length + Buffer.byteLength(head, "utf8");
  return `{"headBytes":"${String(headBytes).padStart(8, "0")}"${head}${body}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readRange(value: unknown, bodyBytes: number): ImageRange | undefined {
  if (!isRecord(value)) return undefined;
  const { sha256, start, length } = value;
  const mediaType = CanvasDesignAssetMediaType.literals.find((each) => each === value.mediaType);
  if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) return undefined;
  if (mediaType === undefined || !isCount(start) || !isCount(length)) return undefined;
  return length > 2 && start + length <= bodyBytes
    ? { sha256, mediaType, start, length }
    : undefined;
}

function readDesign(value: unknown, images: number): DesignImages | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: ReadonlyArray<unknown> = value;
  const [blockId, positions] = entries;
  if (typeof blockId !== "string" || !Array.isArray(positions)) return undefined;
  const named: ReadonlyArray<unknown> = positions;
  const inside = named.filter((at): at is number => isCount(at) && at < images);
  return inside.length === named.length ? [blockId, inside] : undefined;
}

/** The index, or undefined unless all of it fits a file of `bodyBytes` past the head. */
function readImageIndex(value: unknown, bodyBytes: number): ImageIndex | undefined {
  if (!isRecord(value) || value.bodyBytes !== bodyBytes) return undefined;
  const { shareSchemaVersion } = value;
  if (!isCount(shareSchemaVersion) || shareSchemaVersion > CANVAS_SHARE_SCHEMA_VERSION) {
    return undefined;
  }
  if (!Array.isArray(value.images) || !Array.isArray(value.designs)) return undefined;
  const listedImages: ReadonlyArray<unknown> = value.images;
  const listedDesigns: ReadonlyArray<unknown> = value.designs;
  const images = listedImages.flatMap((each) => readRange(each, bodyBytes) ?? []);
  if (images.length !== listedImages.length) return undefined;
  const designs: DesignImages[] = [];
  for (const each of listedDesigns) {
    const design = readDesign(each, images.length);
    if (design === undefined) return undefined;
    designs.push(design);
  }
  return { shareSchemaVersion, bodyBytes, images, designs };
}

function readBytes(fd: number, position: number, length: number): Buffer | undefined {
  const bytes = Buffer.alloc(length);
  let filled = 0;
  try {
    while (filled < length) {
      const count = readSync(fd, bytes, filled, length - filled, position + filled);
      if (count === 0) return undefined;
      filled += count;
    }
  } catch {
    return undefined;
  }
  return bytes;
}

export interface ShareHead {
  /** Everything the file holds but the document, not yet checked. */
  readonly terms: unknown;
  readonly images: ReadonlyArray<CarriedImage>;
}

/**
 * Reads a share file's head and hands it to `use`. Its images read from the
 * same open file, so a share replaced meanwhile never lends its bytes to
 * another's ranges. "whole-only" says the file has no head this version reads: an
 * earlier version wrote it, or it is not the file its index describes.
 */
export function withShareHead<T>(
  path: string,
  use: (head: ShareHead) => T,
): { readonly status: "read"; readonly value: T } | { readonly status: "whole-only" } {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return { status: "whole-only" };
  }
  try {
    const head = readHead(fd);
    return head === undefined ? { status: "whole-only" } : { status: "read", value: use(head) };
  } finally {
    closeSync(fd);
  }
}

function readHead(fd: number): ShareHead | undefined {
  try {
    const { size } = fstatSync(fd);
    const first = readBytes(fd, 0, Math.min(size, FIRST_READ_BYTES));
    const headBytes = Number(HEAD_START.exec(first?.toString("latin1") ?? "")?.[1] ?? "0");
    if (first === undefined || headBytes === 0 || headBytes > size) return undefined;
    const rest =
      headBytes <= first.length
        ? Buffer.alloc(0)
        : readBytes(fd, first.length, headBytes - first.length);
    if (rest === undefined) return undefined;
    const text = Buffer.concat([first.subarray(0, headBytes), rest]).toString("utf8");
    const terms: unknown = JSON.parse(`${text}}`);
    const index = readImageIndex(isRecord(terms) ? terms.imageIndex : undefined, size - headBytes);
    if (index === undefined) return undefined;
    const images = index.images.map((range, at) => ({
      sha256: range.sha256,
      mediaType: range.mediaType,
      designs: designsNaming(index.designs, at),
      read: () => {
        const quoted = readBytes(fd, headBytes + range.start, range.length);
        if (quoted?.at(0) !== QUOTE || quoted.at(-1) !== QUOTE) return undefined;
        return Buffer.from(quoted.toString("latin1", 1, quoted.length - 1), "base64");
      },
    }));
    return { terms, images };
  } catch {
    return undefined;
  }
}
