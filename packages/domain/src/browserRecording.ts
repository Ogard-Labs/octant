import type { BrowserRecordingTruncation } from "@octant/contracts";
import {
  BROWSER_RECORDING_FRAME_INTERVAL_MS,
  MAX_BROWSER_RECORDING_BYTES,
  MAX_BROWSER_RECORDING_FRAMES,
  MAX_BROWSER_RECORDING_MS,
} from "@octant/contracts";
import { originAllowed } from "./browserAutomationPolicy";

/**
 * A Browser recording as an animated PNG, built from the PNG frames the page's
 * own screencast sends, with no image library.
 *
 * Each screencast frame is already a complete PNG of one size. An animated PNG
 * is the first frame's header, then each frame's compressed image data behind
 * a frame-control chunk, so the frames are carried over byte for byte: no
 * decoding, no re-compression. A frame whose header differs from the first one
 * (the page was resized) ends the animation.
 *
 * Rationale: GitHub draws an animated PNG dragged into a pull request body as
 * an animation, and a viewer that does not animate PNG shows its first frame.
 * An animated GIF would need palette quantization and an LZW encoder, and an
 * animated WebP a VP8 encoder; carrying the browser's own PNG data needs only
 * chunk framing and a CRC.
 */

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
/** IHDR's data is always 13 bytes: width, height, depth, colour, method, filter, interlace. */
const IHDR_LENGTH = 13;
/** Colour type 3 needs a palette chunk the frames would have to share; screencasts send none. */
const PALETTE_COLOUR_TYPE = 3;
const CHUNK_OVERHEAD = 12;
const ACTL_LENGTH = 8;
const FCTL_LENGTH = 26;

/** The parts of one PNG frame an animation carries over. */
export interface BrowserRecordingPngFrame {
  /** The 13 bytes of the frame's IHDR. Every frame of one animation shares them. */
  readonly header: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** The frame's IDAT data, joined: one zlib stream of the filtered image. */
  readonly data: Uint8Array;
}

/**
 * The frame's header and image data, or undefined when the bytes are not a
 * PNG an animation can carry: a bad signature or CRC, a palette image, a
 * missing header or image, or a chunk that runs past the end.
 */
export function parseBrowserRecordingPng(bytes: Uint8Array): BrowserRecordingPngFrame | undefined {
  if (bytes.length < PNG_SIGNATURE.length + CHUNK_OVERHEAD + IHDR_LENGTH) return undefined;
  for (const [index, value] of PNG_SIGNATURE.entries()) {
    if (bytes[index] !== value) return undefined;
  }
  let offset = PNG_SIGNATURE.length;
  let header: Uint8Array | undefined;
  const data: Uint8Array[] = [];
  let ended = false;
  while (offset + CHUNK_OVERHEAD <= bytes.length) {
    const length = readUint32(bytes, offset);
    const end = offset + CHUNK_OVERHEAD + length;
    if (length > 0x7fffffff || end > bytes.length) return undefined;
    const typed = bytes.subarray(offset + 4, offset + 8 + length);
    if (crc32(typed) !== readUint32(bytes, offset + 8 + length)) return undefined;
    const type = String.fromCharCode(...typed.subarray(0, 4));
    const body = typed.subarray(4);
    if (type === "IHDR") {
      if (header !== undefined || length !== IHDR_LENGTH) return undefined;
      header = body;
    } else if (type === "PLTE") {
      return undefined;
    } else if (type === "IDAT") {
      data.push(body);
    } else if (type === "IEND") {
      ended = true;
      break;
    }
    offset = end;
  }
  if (!ended || header === undefined || data.length === 0) return undefined;
  if (header[9] === PALETTE_COLOUR_TYPE) return undefined;
  const width = readUint32(header, 0);
  const height = readUint32(header, 4);
  if (width === 0 || height === 0) return undefined;
  return { header: Uint8Array.from(header), width, height, data: joined(data) };
}

/** One frame of the animation and how long it stays on screen. */
export interface BrowserRecordingAnimationFrame {
  readonly frame: BrowserRecordingPngFrame;
  readonly delayMs: number;
}

/**
 * An animated PNG of `frames`, looping forever. Every frame must share the
 * first frame's header; the first frame is also the still image a viewer
 * without animation shows.
 */
export function encodeBrowserRecordingApng(
  frames: ReadonlyArray<BrowserRecordingAnimationFrame>,
): Uint8Array {
  const first = frames[0];
  if (first === undefined) throw new Error("An animation needs at least one frame.");
  for (const { frame } of frames) {
    if (!sameBytes(frame.header, first.frame.header)) {
      throw new Error("Every frame of an animation shares the first frame's header.");
    }
  }
  const parts: Uint8Array[] = [PNG_SIGNATURE, chunk("IHDR", first.frame.header)];
  const control = new Uint8Array(ACTL_LENGTH);
  writeUint32(control, 0, frames.length);
  // Zero plays means it loops, which is how a reviewer watches a short demo.
  writeUint32(control, 4, 0);
  parts.push(chunk("acTL", control));
  let sequence = 0;
  for (const [index, { frame, delayMs }] of frames.entries()) {
    const fctl = new Uint8Array(FCTL_LENGTH);
    writeUint32(fctl, 0, sequence++);
    writeUint32(fctl, 4, frame.width);
    writeUint32(fctl, 8, frame.height);
    writeUint32(fctl, 12, 0);
    writeUint32(fctl, 16, 0);
    // Delay as a fraction of a second: milliseconds over 1000.
    writeUint16(fctl, 20, Math.min(0xffff, Math.max(1, Math.round(delayMs))));
    writeUint16(fctl, 22, 1000);
    // Dispose none, blend source: each frame is a whole picture of the page.
    fctl[24] = 0;
    fctl[25] = 0;
    parts.push(chunk("fcTL", fctl));
    if (index === 0) {
      parts.push(chunk("IDAT", frame.data));
    } else {
      const fdat = new Uint8Array(4 + frame.data.length);
      writeUint32(fdat, 0, sequence++);
      fdat.set(frame.data, 4);
      parts.push(chunk("fdAT", fdat));
    }
  }
  parts.push(chunk("IEND", new Uint8Array(0)));
  return joined(parts);
}

/** The chunks that make a PNG move; without them a viewer shows the first frame. */
const ANIMATION_CHUNKS: ReadonlySet<string> = new Set(["acTL", "fcTL", "fdAT"]);

/**
 * The first frame of an animated PNG as a still PNG: the same chunks without
 * the animation ones, copied whole so every CRC still holds. A recording's
 * thumbnail is still, so a thread with recordings does not move by itself;
 * only a recording the person opens plays. Undefined when the bytes are not
 * a PNG.
 */
export function browserRecordingStillFrame(bytes: Uint8Array): Uint8Array | undefined {
  for (const [index, value] of PNG_SIGNATURE.entries()) {
    if (bytes[index] !== value) return undefined;
  }
  const parts: Uint8Array[] = [PNG_SIGNATURE];
  let offset = PNG_SIGNATURE.length;
  while (offset + CHUNK_OVERHEAD <= bytes.length) {
    const length = readUint32(bytes, offset);
    const end = offset + CHUNK_OVERHEAD + length;
    if (length > 0x7fffffff || end > bytes.length) return undefined;
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (!ANIMATION_CHUNKS.has(type)) parts.push(bytes.subarray(offset, end));
    offset = end;
    if (type === "IEND") return joined(parts);
  }
  return undefined;
}

/** The size `encodeBrowserRecordingApng` gives frames whose image data is this long. */
function encodedSize(dataLengths: ReadonlyArray<number>): number {
  const fixed =
    PNG_SIGNATURE.length +
    CHUNK_OVERHEAD +
    IHDR_LENGTH +
    CHUNK_OVERHEAD +
    ACTL_LENGTH +
    CHUNK_OVERHEAD;
  return dataLengths.reduce(
    (total, length, index) =>
      total + CHUNK_OVERHEAD + FCTL_LENGTH + CHUNK_OVERHEAD + length + (index === 0 ? 0 : 4),
    fixed,
  );
}

/**
 * Whether a frame may join a recording: the page it shows is on an origin the
 * thread approved, and holds no credential field. A page with no web origin to
 * check (a blank page, the browser's own error page, an address that cannot be
 * read) fails closed, as an unapproved one does, because what it shows cannot
 * be tied to an approval.
 */
export function browserRecordingFrameKept(input: {
  readonly pageUrl: string | undefined;
  readonly allowedOrigins: ReadonlyArray<string>;
  readonly credentialField: boolean;
}): boolean {
  if (input.credentialField || input.pageUrl === undefined) return false;
  let protocol: string;
  try {
    protocol = new URL(input.pageUrl).protocol;
  } catch {
    return false;
  }
  if (protocol !== "http:" && protocol !== "https:") return false;
  return originAllowed(input.pageUrl, input.allowedOrigins);
}

/** The bounds one recording keeps to; see the contract's recording constants. */
export interface BrowserRecordingLimits {
  readonly maxDurationMs: number;
  readonly frameIntervalMs: number;
  readonly maxFrames: number;
  readonly maxBytes: number;
}

export const BROWSER_RECORDING_LIMITS: BrowserRecordingLimits = {
  maxDurationMs: MAX_BROWSER_RECORDING_MS,
  frameIntervalMs: BROWSER_RECORDING_FRAME_INTERVAL_MS,
  maxFrames: MAX_BROWSER_RECORDING_FRAMES,
  maxBytes: MAX_BROWSER_RECORDING_BYTES,
};

/** What a frame offered to a recording did. */
export type BrowserRecordingOffer =
  | "kept"
  /** The frame replaced the newer frame of the same interval. */
  | "replaced"
  /** The page looked exactly as it did in the frame before. */
  | "unchanged"
  /** Not a PNG an animation can carry. */
  | "unreadable"
  /** The recording has stopped taking frames. */
  | "stopped";

/** What a finished recording holds. */
export type BrowserRecordingResult =
  | {
      readonly status: "recorded";
      readonly bytes: Uint8Array;
      readonly frames: number;
      readonly durationMs: number;
      readonly truncated?: BrowserRecordingTruncation;
    }
  /** No frame arrived: the page painted nothing while the call ran. */
  | { readonly status: "empty" }
  /**
   * Every frame showed a page that holds a credential field (or one that could
   * not be checked), so nothing is kept, as a screenshot of it would be withheld.
   */
  | { readonly status: "withheld" };

interface TimedFrame {
  frame: BrowserRecordingPngFrame;
  /** The start of the interval this frame stands for, from the recording's start. */
  readonly atMs: number;
}

/**
 * The frames of one recording, sampled and bounded. The page's screencast sends
 * a frame whenever it paints; a recording keeps the newest frame of each
 * interval (so the last state of an animation survives), skips a frame that
 * repeats the one before, and stops taking frames at the first bound it meets:
 * the duration, the frame count, the encoded size, or a change of frame size.
 * Times are milliseconds on one monotonic clock the runtime supplies.
 */
export class BrowserRecordingFrames {
  readonly #limits: BrowserRecordingLimits;
  readonly #startedAtMs: number;
  readonly #frames: TimedFrame[] = [];
  #stoppedAtMs: number | undefined;
  #truncated: BrowserRecordingTruncation | undefined;
  #withheld = false;
  #leftOut = false;

  constructor(startedAtMs: number, limits: BrowserRecordingLimits = BROWSER_RECORDING_LIMITS) {
    this.#startedAtMs = startedAtMs;
    this.#limits = limits;
  }

  /** Whether the recording still takes frames. */
  get recording(): boolean {
    return this.#stoppedAtMs === undefined;
  }

  /** When the recording reaches its duration bound, from the clock it started on. */
  get deadlineMs(): number {
    return this.#startedAtMs + this.#limits.maxDurationMs;
  }

  offer(png: Uint8Array, atMs: number): BrowserRecordingOffer {
    if (this.#stoppedAtMs !== undefined) return "stopped";
    const elapsed = Math.max(0, atMs - this.#startedAtMs);
    if (elapsed >= this.#limits.maxDurationMs) {
      this.stop(this.deadlineMs, "duration-limit");
      return "stopped";
    }
    const frame = parseBrowserRecordingPng(png);
    if (frame === undefined) return "unreadable";
    const first = this.#frames[0];
    if (first !== undefined && !sameBytes(first.frame.header, frame.header)) {
      this.stop(atMs, "viewport-changed");
      return "stopped";
    }
    const last = this.#frames.at(-1);
    if (last !== undefined && sameBytes(last.frame.data, frame.data)) return "unchanged";
    const slotMs =
      Math.floor(elapsed / this.#limits.frameIntervalMs) * this.#limits.frameIntervalMs;
    const sizes = this.#frames.map((kept) => kept.frame.data.length);
    if (last !== undefined && last.atMs === slotMs) {
      sizes[sizes.length - 1] = frame.data.length;
      if (encodedSize(sizes) > this.#limits.maxBytes) {
        this.stop(atMs, "size-limit");
        return "stopped";
      }
      last.frame = frame;
      return "replaced";
    }
    if (this.#frames.length >= this.#limits.maxFrames) {
      this.stop(atMs, "frame-limit");
      return "stopped";
    }
    if (encodedSize([...sizes, frame.data.length]) > this.#limits.maxBytes) {
      this.stop(atMs, "size-limit");
      return "stopped";
    }
    this.#frames.push({ frame, atMs: slotMs });
    return "kept";
  }

  /**
   * Stop taking frames. A reason says the recording was cut short by a bound;
   * none is the call it covered ending. The first stop wins.
   */
  stop(atMs: number, reason?: BrowserRecordingTruncation): void {
    if (this.#stoppedAtMs !== undefined) return;
    this.#stoppedAtMs = Math.min(atMs, this.deadlineMs);
    this.#truncated = reason;
  }

  /**
   * The frame that just arrived showed a page holding a credential field, or a
   * page that could not be checked for one, so it is not kept. The frame
   * before it stays on screen in its place, as a screenshot of that page would
   * be withheld and the pages around it kept.
   */
  leaveOut(): void {
    if (this.#stoppedAtMs === undefined) this.#leftOut = true;
  }

  /** Drop every frame: the recording is discarded rather than built. */
  withhold(atMs: number): void {
    this.#withheld = true;
    this.#frames.length = 0;
    this.stop(atMs);
  }

  /** The animation, built once the recording has stopped (it stops here if not). */
  finish(atMs: number): BrowserRecordingResult {
    this.stop(atMs);
    if (this.#withheld) return { status: "withheld" };
    const first = this.#frames[0];
    if (first === undefined) return { status: this.#leftOut ? "withheld" : "empty" };
    const endMs = Math.max(0, (this.#stoppedAtMs ?? atMs) - this.#startedAtMs);
    const frames = this.#frames.map((kept, index): BrowserRecordingAnimationFrame => {
      const next = this.#frames[index + 1];
      const delayMs =
        next === undefined
          ? Math.max(this.#limits.frameIntervalMs, endMs - kept.atMs)
          : next.atMs - kept.atMs;
      return { frame: kept.frame, delayMs };
    });
    const last = this.#frames.at(-1) ?? first;
    const lastDelay = frames.at(-1)?.delayMs ?? 0;
    const durationMs = Math.min(this.#limits.maxDurationMs, last.atMs + lastDelay - first.atMs);
    return {
      status: "recorded",
      bytes: encodeBrowserRecordingApng(frames),
      frames: frames.length,
      durationMs,
      ...(this.#truncated === undefined ? {} : { truncated: this.#truncated }),
    };
  }
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(CHUNK_OVERHEAD + data.length);
  writeUint32(out, 0, data.length);
  for (let index = 0; index < 4; index += 1) out[4 + index] = type.charCodeAt(index);
  out.set(data, 8);
  writeUint32(out, 8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < 256; value += 1) {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    table[value] = crc >>> 0;
  }
  return table;
})();

/** The CRC-32 PNG puts after each chunk's type and data (ISO 3309, as zlib's). */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function writeUint16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 8) & 0xff;
  bytes[offset + 1] = value & 0xff;
}

function joined(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}
