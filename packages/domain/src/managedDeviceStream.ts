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
