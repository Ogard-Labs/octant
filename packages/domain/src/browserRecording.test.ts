import { deflateSync, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  BrowserRecordingFrames,
  browserRecordingFrameKept,
  browserRecordingStillFrame,
  crc32,
  encodeBrowserRecordingApng,
  parseBrowserRecordingPng,
  type BrowserRecordingLimits,
} from "./browserRecording";

/** A real RGBA PNG of one flat colour, the shape a page's screencast sends. */
function png(width: number, height: number, rgba: readonly [number, number, number, number]) {
  const row = Buffer.alloc(1 + width * 4);
  for (let x = 0; x < width; x += 1) row.set(rgba, 1 + x * 4);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Uint8Array.from(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk("IHDR", header),
      pngChunk("IDAT", deflateSync(raw)),
      pngChunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

interface ParsedAnimation {
  readonly width: number;
  readonly height: number;
  readonly plays: number;
  readonly declaredFrames: number;
  readonly frames: ReadonlyArray<{
    readonly width: number;
    readonly height: number;
    readonly delayMs: number;
    readonly pixels: Buffer;
  }>;
}

/**
 * An animated PNG read the way a viewer reads one: every chunk's CRC checked,
 * sequence numbers counted from 0 across fcTL and fdAT, and each frame's data
 * inflated, so a file this accepts is one a browser would play.
 */
function parseApng(bytes: Uint8Array): ParsedAnimation {
  const buffer = Buffer.from(bytes);
  expect([...buffer.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let offset = 8;
  let width = 0;
  let height = 0;
  let plays = -1;
  let declaredFrames = 0;
  let sequence = 0;
  const frames: Array<{ width: number; height: number; delayMs: number; data: Buffer[] }> = [];
  const order: string[] = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    expect(buffer.readUInt32BE(offset + 8 + length)).toBe(
      crc32(buffer.subarray(offset + 4, offset + 8 + length)),
    );
    order.push(type);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (type === "acTL") {
      declaredFrames = data.readUInt32BE(0);
      plays = data.readUInt32BE(4);
    } else if (type === "fcTL") {
      expect(data.readUInt32BE(0)).toBe(sequence++);
      frames.push({
        width: data.readUInt32BE(4),
        height: data.readUInt32BE(8),
        delayMs: (data.readUInt16BE(20) * 1000) / data.readUInt16BE(22),
        data: [],
      });
    } else if (type === "IDAT") {
      frames.at(-1)?.data.push(data);
    } else if (type === "fdAT") {
      expect(data.readUInt32BE(0)).toBe(sequence++);
      frames.at(-1)?.data.push(data.subarray(4));
    }
    offset += 12 + length;
  }
  // acTL before the first IDAT, IEND last: what makes a viewer animate it.
  expect(order.indexOf("acTL")).toBeLessThan(order.indexOf("IDAT"));
  expect(order.at(-1)).toBe("IEND");
  return {
    width,
    height,
    plays,
    declaredFrames,
    frames: frames.map((frame) => ({
      width: frame.width,
      height: frame.height,
      delayMs: frame.delayMs,
      pixels: inflateSync(Buffer.concat(frame.data)),
    })),
  };
}

const RED = [255, 0, 0, 255] as const;
const GREEN = [0, 255, 0, 255] as const;
const BLUE = [0, 0, 255, 255] as const;

describe("encodeBrowserRecordingApng", () => {
  it("writes an animation a viewer plays with every frame, delay, and size", () => {
    const frames = [RED, GREEN, BLUE].map((colour, index) => {
      const frame = parseBrowserRecordingPng(png(4, 3, colour));
      if (frame === undefined) throw new Error("fixture is not a PNG");
      return { frame, delayMs: 250 * (index + 1) };
    });
    const animation = parseApng(encodeBrowserRecordingApng(frames));
    expect(animation).toMatchObject({ width: 4, height: 3, plays: 0, declaredFrames: 3 });
    expect(animation.frames.map((frame) => frame.delayMs)).toEqual([250, 500, 750]);
    expect(animation.frames.every((frame) => frame.width === 4 && frame.height === 3)).toBe(true);
    // Each frame's pixels come through unchanged: one filter byte per row of RGBA.
    expect(animation.frames[1]?.pixels.subarray(1, 5)).toEqual(Buffer.from(GREEN));
    expect(animation.frames[2]?.pixels.length).toBe(3 * (1 + 4 * 4));
  });

  it("refuses frames of different sizes in one animation", () => {
    const small = parseBrowserRecordingPng(png(4, 3, RED));
    const large = parseBrowserRecordingPng(png(5, 3, RED));
    if (small === undefined || large === undefined) throw new Error("fixture is not a PNG");
    expect(() =>
      encodeBrowserRecordingApng([
        { frame: small, delayMs: 250 },
        { frame: large, delayMs: 250 },
      ]),
    ).toThrow();
  });
});

describe("browserRecordingStillFrame", () => {
  it("keeps the first frame of an animation as a still picture", () => {
    const frames = [RED, GREEN].map((colour) => {
      const frame = parseBrowserRecordingPng(png(4, 3, colour));
      if (frame === undefined) throw new Error("fixture is not a PNG");
      return { frame, delayMs: 250 };
    });
    const still = browserRecordingStillFrame(encodeBrowserRecordingApng(frames));
    if (still === undefined) throw new Error("no still frame");
    const parsed = parseBrowserRecordingPng(still);
    expect(parsed).toMatchObject({ width: 4, height: 3 });
    expect(inflateSync(Buffer.from(parsed?.data ?? [])).subarray(1, 5)).toEqual(Buffer.from(RED));
    expect(Buffer.from(still).includes(Buffer.from("acTL"))).toBe(false);
  });
});

describe("parseBrowserRecordingPng", () => {
  it("refuses bytes that are not a whole, intact PNG", () => {
    const good = png(2, 2, RED);
    expect(parseBrowserRecordingPng(good.subarray(0, good.length - 4))).toBeUndefined();
    const corrupt = Uint8Array.from(good);
    corrupt[20] = (corrupt[20] ?? 0) ^ 0xff;
    expect(parseBrowserRecordingPng(corrupt)).toBeUndefined();
    expect(parseBrowserRecordingPng(Uint8Array.from([1, 2, 3]))).toBeUndefined();
  });
});

describe("browserRecordingFrameKept", () => {
  const approved = ["https://shop.example.com"];
  const kept = (pageUrl: string | undefined, credentialField = false) =>
    browserRecordingFrameKept({ pageUrl, allowedOrigins: approved, credentialField });

  it("keeps a frame of a page on an origin the thread approved", () => {
    expect(kept("https://shop.example.com/cart?item=2")).toBe(true);
  });

  it("leaves out a frame of a page on any origin the thread did not approve", () => {
    expect(kept("https://other.example.com/")).toBe(false);
    expect(kept("https://shop.example.com:8443/")).toBe(false);
    expect(kept("http://localhost:5173/")).toBe(false);
  });

  it("leaves out a frame whose page has no origin that can be checked", () => {
    for (const pageUrl of [
      undefined,
      "",
      "about:blank",
      "chrome-error://chromewebdata/",
      "data:text/html,hi",
      "file:///etc/hosts",
      "not a url",
    ]) {
      expect(kept(pageUrl), String(pageUrl)).toBe(false);
    }
  });

  it("leaves out a frame of an approved page that holds a credential field", () => {
    expect(kept("https://shop.example.com/sign-in", true)).toBe(false);
  });
});

const LIMITS: BrowserRecordingLimits = {
  maxDurationMs: 30_000,
  frameIntervalMs: 250,
  maxFrames: 120,
  maxBytes: 2 * 1024 * 1024,
};

describe("BrowserRecordingFrames", () => {
  it("keeps the newest frame of each interval and times frames by interval", () => {
    const recording = new BrowserRecordingFrames(1_000, LIMITS);
    expect(recording.offer(png(4, 4, RED), 1_000)).toBe("kept");
    // Painted again 100 ms later: the newer picture stands for the interval.
    expect(recording.offer(png(4, 4, GREEN), 1_100)).toBe("replaced");
    expect(recording.offer(png(4, 4, BLUE), 1_600)).toBe("kept");
    const result = recording.finish(2_000);
    if (result.status !== "recorded") throw new Error(result.status);
    const animation = parseApng(result.bytes);
    expect(animation.frames.map((frame) => frame.delayMs)).toEqual([500, 500]);
    expect(animation.frames[0]?.pixels.subarray(1, 5)).toEqual(Buffer.from(GREEN));
    expect(result).toMatchObject({ frames: 2, durationMs: 1_000 });
    expect(result).not.toHaveProperty("truncated");
  });

  it("skips a frame that shows the page exactly as before", () => {
    const recording = new BrowserRecordingFrames(0, LIMITS);
    recording.offer(png(4, 4, RED), 0);
    expect(recording.offer(png(4, 4, RED), 900)).toBe("unchanged");
    const result = recording.finish(1_000);
    expect(result).toMatchObject({ status: "recorded", frames: 1, durationMs: 1_000 });
  });

  it("stops at its duration limit and says the recording was cut short", () => {
    const recording = new BrowserRecordingFrames(0, LIMITS);
    recording.offer(png(4, 4, RED), 0);
    recording.offer(png(4, 4, GREEN), 29_900);
    expect(recording.offer(png(4, 4, BLUE), 30_000)).toBe("stopped");
    expect(recording.recording).toBe(false);
    const result = recording.finish(45_000);
    expect(result).toMatchObject({
      status: "recorded",
      frames: 2,
      durationMs: 30_000,
      truncated: "duration-limit",
    });
  });

  it("stops at its frame limit", () => {
    const recording = new BrowserRecordingFrames(0, { ...LIMITS, maxFrames: 2 });
    recording.offer(png(4, 4, RED), 0);
    recording.offer(png(4, 4, GREEN), 250);
    expect(recording.offer(png(4, 4, BLUE), 500)).toBe("stopped");
    expect(recording.finish(1_000)).toMatchObject({ frames: 2, truncated: "frame-limit" });
  });

  it("never builds a file over its size cap", () => {
    const one = png(64, 64, RED).length;
    const recording = new BrowserRecordingFrames(0, { ...LIMITS, maxBytes: one * 2 });
    recording.offer(png(64, 64, RED), 0);
    recording.offer(png(64, 64, GREEN), 250);
    expect(recording.offer(png(64, 64, BLUE), 500)).toBe("stopped");
    const result = recording.finish(1_000);
    if (result.status !== "recorded") throw new Error(result.status);
    expect(result.bytes.length).toBeLessThanOrEqual(one * 2);
    expect(result.truncated).toBe("size-limit");
    expect(parseApng(result.bytes).declaredFrames).toBe(result.frames);
  });

  it("ends at the last frame of the old size when the page is resized", () => {
    const recording = new BrowserRecordingFrames(0, LIMITS);
    recording.offer(png(4, 4, RED), 0);
    expect(recording.offer(png(8, 4, GREEN), 300)).toBe("stopped");
    expect(recording.finish(1_000)).toMatchObject({ frames: 1, truncated: "viewport-changed" });
  });

  it("leaves out the frames of a credential page and keeps the frames around them", () => {
    const recording = new BrowserRecordingFrames(0, LIMITS);
    recording.offer(png(4, 4, RED), 0);
    // A sign-in page painted here; its frames never reach the recording.
    recording.leaveOut();
    recording.leaveOut();
    recording.offer(png(4, 4, BLUE), 1_000);
    const result = recording.finish(1_500);
    if (result.status !== "recorded") throw new Error(result.status);
    const animation = parseApng(result.bytes);
    expect(animation.frames.map((frame) => frame.pixels.subarray(1, 5))).toEqual([
      Buffer.from(RED),
      Buffer.from(BLUE),
    ]);
    // The frame before the sign-in page stays on screen in its place.
    expect(animation.frames[0]?.delayMs).toBe(1_000);
  });

  it("keeps nothing when every frame showed a credential page, or when it is discarded", () => {
    const shut = new BrowserRecordingFrames(0, LIMITS);
    shut.leaveOut();
    expect(shut.finish(1_000)).toEqual({ status: "withheld" });

    const dropped = new BrowserRecordingFrames(0, LIMITS);
    dropped.offer(png(4, 4, RED), 0);
    dropped.withhold(300);
    expect(dropped.offer(png(4, 4, GREEN), 500)).toBe("stopped");
    expect(dropped.finish(1_000)).toEqual({ status: "withheld" });
  });

  it("reports an empty recording when the page painted nothing", () => {
    expect(new BrowserRecordingFrames(0, LIMITS).finish(1_000)).toEqual({ status: "empty" });
  });
});
