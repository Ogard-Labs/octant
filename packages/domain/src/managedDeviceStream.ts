const MAXIMUM_FRAME_BYTES = 8 * 1024 * 1024;

export interface ManagedDeviceEndpoint {
  readonly origin: string;
  readonly streamUrl: string;
}

/**
 * The streaming tool's own state line. Only a loopback HTTP stream for the
 * requested device is usable: the pane must not follow a URL the tool could
 * be induced to print.
 */
export function readManagedDeviceEndpoint(
  text: string,
  device: string,
): ManagedDeviceEndpoint | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.device !== device) return undefined;
  if (typeof value.url !== "string" || typeof value.streamUrl !== "string") return undefined;
  const origin = loopbackHttp(value.url);
  const stream = loopbackHttp(value.streamUrl);
  if (origin === undefined || stream === undefined || origin.origin !== stream.origin) {
    return undefined;
  }
  const helperPath = `/helper/${encodeURIComponent(device)}/stream.mjpeg`;
  if (stream.pathname !== helperPath) return undefined;
  return { origin: origin.origin, streamUrl: stream.href };
}

export function takeJpegFrames(input: Uint8Array): {
  readonly frames: readonly Uint8Array[];
  readonly rest: Uint8Array;
} {
  const frames: Uint8Array[] = [];
  let start = indexOfMarker(input, 0, 0xff, 0xd8);
  while (start !== -1) {
    const end = indexOfMarker(input, start + 2, 0xff, 0xd9);
    if (end === -1) break;
    const frame = input.subarray(start, end + 2);
    if (frame.byteLength <= MAXIMUM_FRAME_BYTES) frames.push(frame.slice());
    start = indexOfMarker(input, end + 2, 0xff, 0xd8);
  }
  if (start === -1) return { frames, rest: new Uint8Array() };
  if (input.byteLength - start > MAXIMUM_FRAME_BYTES) return { frames, rest: new Uint8Array() };
  return { frames, rest: input.subarray(start).slice() };
}

/** Longest part header Octant reads before it gives up on finding the body. */
const MAXIMUM_PART_HEADER_BYTES = 1024;

/**
 * Cuts a `multipart/x-mixed-replace` stream into its image parts by each
 * part's `Content-Length`. serve-avd sends PNG parts when the emulator image
 * cannot encode `screencap -j`, and PNG data can contain the JPEG start and
 * end markers, so a marker scan would cut those frames in the wrong places.
 * Only parts whose bytes are a JPEG or PNG are returned; `rest` holds an
 * unfinished part for the next chunk.
 */
export function takeMultipartImageFrames(input: Uint8Array): {
  readonly frames: readonly Uint8Array[];
  readonly rest: Uint8Array;
} {
  const frames: Uint8Array[] = [];
  let offset = 0;
  for (;;) {
    const boundary = indexOfMarker(input, offset, 0x2d, 0x2d);
    if (boundary === -1) {
      // A chunk can end between the boundary's two dashes.
      const last = input.byteLength - 1;
      return {
        frames,
        rest: last >= offset && input[last] === 0x2d ? Uint8Array.of(0x2d) : new Uint8Array(),
      };
    }
    const headerEnd = indexOfHeaderEnd(input, boundary);
    if (headerEnd === -1) {
      return input.byteLength - boundary > MAXIMUM_PART_HEADER_BYTES
        ? { frames, rest: new Uint8Array() }
        : { frames, rest: input.subarray(boundary).slice() };
    }
    const header = String.fromCharCode(...input.subarray(boundary, headerEnd));
    const bodyStart = headerEnd + 4;
    const length = /\r\ncontent-length:[ \t]*([0-9]{1,9})\r?$/im.exec(header);
    if (length?.[1] === undefined) {
      offset = bodyStart;
      continue;
    }
    const bodyLength = Number(length[1]);
    if (bodyLength > MAXIMUM_FRAME_BYTES) return { frames, rest: new Uint8Array() };
    if (input.byteLength < bodyStart + bodyLength) {
      return { frames, rest: input.subarray(boundary).slice() };
    }
    const body = input.subarray(bodyStart, bodyStart + bodyLength);
    if (isJpeg(body) || isPng(body)) frames.push(body.slice());
    offset = bodyStart + bodyLength;
  }
}

function indexOfHeaderEnd(bytes: Uint8Array, from: number): number {
  const last = Math.min(bytes.byteLength, from + MAXIMUM_PART_HEADER_BYTES) - 3;
  for (let index = from; index < last; index += 1) {
    if (
      bytes[index] === 0x0d &&
      bytes[index + 1] === 0x0a &&
      bytes[index + 2] === 0x0d &&
      bytes[index + 3] === 0x0a
    ) {
      return index;
    }
  }
  return -1;
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.byteLength > 3 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

function isPng(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength > 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  );
}

function loopbackHttp(value: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return undefined;
  }
  return url;
}

function indexOfMarker(bytes: Uint8Array, from: number, first: number, second: number): number {
  for (let index = from; index < bytes.byteLength - 1; index += 1) {
    if (bytes[index] === first && bytes[index + 1] === second) return index;
  }
  return -1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
