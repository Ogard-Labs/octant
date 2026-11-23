import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { encode as encodeJpeg } from "jpeg-js";
import { GifWriter } from "omggif";
import { PNG } from "pngjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type { MediaIconSetTarget } from "@octant/plugin-api/media-tools";
import {
  hostIconSetRenderer,
  ICON_SET_SPECS,
  pngDimensions,
  renderIconSet,
  SIPS_PATH,
  type SipsRun,
} from "./iconSetRenderer";

const directories: Array<string> = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function workDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "octant-icon-render-"));
  directories.push(directory);
  return directory;
}

/** A PNG header with the given size: enough for the renderer's read-back check. */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** A valid PNG of one colour: RGB, or RGBA with every pixel at `alpha`. */
function solidPng(
  size: number | { readonly width: number; readonly height: number },
  alpha?: number,
  extra?: ReadonlyArray<{ readonly type: string; readonly data: Uint8Array }>,
): Uint8Array {
  const width = typeof size === "number" ? size : size.width;
  const height = typeof size === "number" ? size : size.height;
  const channels = alpha === undefined ? 3 : 4;
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.byteLength);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.byteLength);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.byteLength, crc(out.subarray(4, 8 + data.byteLength)));
    return out;
  };
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header.set([8, alpha === undefined ? 2 : 6, 0, 0, 0], 8);
  const row = new Uint8Array(1 + width * channels);
  const pixel = alpha === undefined ? [30, 120, 200] : [30, 120, 200, alpha];
  for (let x = 0; x < width; x += 1) row.set(pixel, 1 + x * channels);
  const raw = new Uint8Array(row.byteLength * height);
  for (let y = 0; y < height; y += 1) raw.set(row, y * row.byteLength);
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    ...(extra ?? []).map(({ type, data }) => chunk(type, data)),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array()),
  ];
  const png = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.byteLength;
  }
  return png;
}

/** The chunk types a PNG carries, in order — how a re-encode's colour chunks are checked. */
function pngChunkTypes(bytes: Uint8Array): string[] {
  const types: string[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  while (offset + 8 <= bytes.byteLength) {
    const length = view.getUint32(offset);
    types.push(String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)));
    if (offset + 8 + length + 4 > bytes.byteLength) break;
    offset += 12 + length;
  }
  return types;
}

/** Stands in for `sips`: answers the probe and writes a PNG of the asked size for each resize. */
function fakeSips(source: { width: number; height: number; alpha?: number }) {
  const calls: Array<ReadonlyArray<string>> = [];
  const run: SipsRun = async (args) => {
    calls.push(args);
    if (args[0] === "-g") {
      return {
        stdout: `${String(args.at(-1))}\n  pixelWidth: ${String(source.width)}\n  pixelHeight: ${String(source.height)}\n`,
      };
    }
    const size = Number(args[args.indexOf("-z") + 1]);
    writeFileSync(String(args[args.indexOf("--out") + 1]), solidPng(size, source.alpha));
    return { stdout: "" };
  };
  return { run, calls };
}

const targets: ReadonlyArray<MediaIconSetTarget> = ["apple-ios", "apple-macos", "android", "web"];

describe("icon set rendering", () => {
  it.each(targets)("makes exactly the files %s needs at their pixel sizes", async (target) => {
    const sips = fakeSips({ width: 1024, height: 1024 });
    const rendered = await renderIconSet({
      bytes: Uint8Array.from([1]),
      mime: "image/png",
      target,
      workDirectory: workDirectory(),
      run: sips.run,
    });
    if (rendered.status !== "rendered") throw new Error(rendered.reason);
    const images = rendered.files.filter((file) => file.path.endsWith(".png"));
    expect(images.map((file) => [file.path, pngDimensions(file.bytes)?.width])).toEqual(
      ICON_SET_SPECS[target].map((spec) => [spec.path, spec.pixels]),
    );
    const contents = rendered.files.find((file) => file.path.endsWith("Contents.json"));
    expect(contents === undefined).toBe(target === "android" || target === "web");
    expect(rendered.files).toHaveLength(images.length + (contents === undefined ? 0 : 1));
  });

  it("writes an asset catalog listing every macOS size and scale", async () => {
    const sips = fakeSips({ width: 1024, height: 1024, alpha: 255 });
    const rendered = await renderIconSet({
      bytes: Uint8Array.from([1]),
      mime: "image/png",
      target: "apple-macos",
      workDirectory: workDirectory(),
      run: sips.run,
    });
    if (rendered.status !== "rendered") throw new Error(rendered.reason);
    const contents = rendered.files.find(
      (file) => file.path === "AppIcon.appiconset/Contents.json",
    );
    const parsed: unknown = JSON.parse(new TextDecoder().decode(contents?.bytes));
    expect(parsed).toMatchObject({ info: { author: "xcode", version: 1 } });
    expect(parsed).toHaveProperty(
      "images",
      expect.arrayContaining([
        { filename: "icon_16x16.png", idiom: "mac", scale: "1x", size: "16x16" },
        { filename: "icon_512x512@2x.png", idiom: "mac", scale: "2x", size: "512x512" },
      ]),
    );
    expect((parsed as { images: ReadonlyArray<unknown> }).images).toHaveLength(10);
    // Each pixel size is resized once even where two files share it.
    expect(sips.calls.filter((args) => args.includes("-z"))).toHaveLength(7);
  });

  it("writes the single universal iOS icon Xcode 14 accepts, without an alpha channel", async () => {
    const sips = fakeSips({ width: 2048, height: 2048, alpha: 255 });
    const rendered = await renderIconSet({
      bytes: Uint8Array.from([1]),
      mime: "image/jpeg",
      target: "apple-ios",
      workDirectory: workDirectory(),
      run: sips.run,
    });
    if (rendered.status !== "rendered") throw new Error(rendered.reason);
    const contents = rendered.files.find((file) => file.path.endsWith("Contents.json"));
    expect(JSON.parse(new TextDecoder().decode(contents?.bytes))).toEqual({
      images: [
        { filename: "AppIcon-1024.png", idiom: "universal", platform: "ios", size: "1024x1024" },
      ],
      info: { author: "xcode", version: 1 },
    });
    // The source stored an alpha channel with every pixel opaque, as image
    // models often do; App Store Connect refuses any alpha channel at all.
    const icon = rendered.files.find((file) => file.path.endsWith("AppIcon-1024.png"));
    expect(icon?.bytes[25]).toBe(2);
    expect(pngDimensions(icon?.bytes ?? new Uint8Array())).toEqual({ width: 1024, height: 1024 });
  });

  it.each([
    [{ width: 1024, height: 768 }, "web", /square/],
    [{ width: 512, height: 512 }, "web", /at least 1024/],
  ] as const)("refuses a source of %o for %s", async (source, target, reason) => {
    const sips = fakeSips(source);
    const directory = workDirectory();
    const rendered = await renderIconSet({
      bytes: Uint8Array.from([1]),
      mime: "image/png",
      target,
      workDirectory: directory,
      run: sips.run,
    });
    expect(rendered).toEqual({ status: "refused", reason: expect.stringMatching(reason) });
    expect(sips.calls.some((args) => args.includes("-z"))).toBe(false);
    expect(readdirSync(directory)).toEqual([]);
  });

  it("refuses an iOS icon that shows any transparency", async () => {
    const directory = workDirectory();
    const rendered = await renderIconSet({
      bytes: Uint8Array.from([1]),
      mime: "image/png",
      target: "apple-ios",
      workDirectory: directory,
      run: fakeSips({ width: 1024, height: 1024, alpha: 128 }).run,
    });
    expect(rendered).toEqual({
      status: "refused",
      reason: expect.stringMatching(/must not be transparent/),
    });
    expect(readdirSync(directory)).toEqual([]);
  });

  it("returns a refusal rather than throwing when its temporary directory cannot be made", async () => {
    const parent = workDirectory();
    const blocked = join(parent, "not-a-directory");
    writeFileSync(blocked, "a file where the work directory should be");
    const rendered = await renderIconSet({
      bytes: Uint8Array.from([1]),
      mime: "image/png",
      target: "web",
      workDirectory: blocked,
      run: fakeSips({ width: 1024, height: 1024 }).run,
    });
    expect(rendered).toEqual({ status: "refused", reason: "The image could not be resized." });
  });

  it("lists the other launcher formats Android would treat as the same resource", () => {
    const launcher = ICON_SET_SPECS.android.find(
      (spec) => spec.path === "mipmap-hdpi/ic_launcher.png",
    );
    expect(launcher?.conflicts).toContain("mipmap-hdpi/ic_launcher.webp");
  });

  it("removes its temporary files when resizing fails", async () => {
    const directory = workDirectory();
    const rendered = await renderIconSet({
      bytes: Uint8Array.from([1]),
      mime: "image/png",
      target: "android",
      workDirectory: directory,
      run: async (args) => {
        if (args[0] === "-g") return { stdout: "pixelWidth: 1024\npixelHeight: 1024\n" };
        throw new Error("sips exited 13");
      },
    });
    expect(rendered).toEqual({ status: "refused", reason: "The image could not be resized." });
    expect(readdirSync(directory)).toEqual([]);
  });

  it("refuses an output whose size is not the one asked for", async () => {
    const rendered = await renderIconSet({
      bytes: Uint8Array.from([1]),
      mime: "image/png",
      target: "web",
      workDirectory: workDirectory(),
      run: async (args) => {
        if (args[0] === "-g") return { stdout: "pixelWidth: 1024\npixelHeight: 1024\n" };
        writeFileSync(String(args[args.indexOf("--out") + 1]), pngHeader(10, 10));
        return { stdout: "" };
      },
    });
    expect(rendered).toMatchObject({ status: "refused" });
  });

  it("resizes in pure JavaScript off macOS and in sips on it", async () => {
    // The pure-JavaScript renderer answers on every platform without sips.
    for (const platform of ["linux", "win32", "darwin"] as const) {
      const render = hostIconSetRenderer({
        workDirectory: workDirectory(),
        platform,
        sipsExists: () => false,
      });
      const rendered = await render({ bytes: solidPng(1024), mime: "image/png", target: "web" });
      expect(rendered.status).toBe("rendered");
    }
    expect(
      hostIconSetRenderer({
        workDirectory: workDirectory(),
        platform: "darwin",
        sipsExists: () => true,
      }),
    ).toBeTypeOf("function");
  });
});

describe("icon set rendering in pure JavaScript", () => {
  const render = () =>
    hostIconSetRenderer({
      workDirectory: workDirectory(),
      platform: "linux",
      sipsExists: () => false,
    });

  /** A JPEG source encoded in the test, so no fixture file is checked in. */
  function solidJpeg(size: number): Uint8Array {
    const data = new Uint8Array(size * size * 4);
    for (let index = 0; index < data.length; index += 4) {
      data[index] = 30;
      data[index + 1] = 90;
      data[index + 2] = 200;
      data[index + 3] = 255;
    }
    return new Uint8Array(
      encodeJpeg({ data: Buffer.from(data), width: size, height: size }, 90).data,
    );
  }

  /** A WebP source encoded through libwebp's WebAssembly module, as decoding is. */
  async function solidWebp(size: number): Promise<Uint8Array> {
    const encoder = await import("@jsquash/webp/encode.js");
    const wasm = createRequire(import.meta.url).resolve("@jsquash/webp/codec/enc/webp_enc.wasm");
    await encoder.init({ wasmBinary: new Uint8Array(readFileSync(wasm)).buffer });
    const data = new Uint8ClampedArray(size * size * 4);
    for (let index = 0; index < data.length; index += 4) {
      data[index] = 30;
      data[index + 1] = 90;
      data[index + 2] = 200;
      data[index + 3] = 255;
    }
    return new Uint8Array(
      await encoder.default({ data, width: size, height: size, colorSpace: "srgb" }),
    );
  }

  it.each([
    ["image/png", () => Promise.resolve(solidPng(1024))],
    ["image/jpeg", () => Promise.resolve(solidJpeg(1024))],
    ["image/webp", () => solidWebp(1024)],
  ] as const)("makes every web icon from a %s source", async (mime, bytes) => {
    const rendered = await render()({ bytes: await bytes(), mime, target: "web" });
    if (rendered.status !== "rendered") throw new Error(rendered.reason);
    expect(rendered.files.map((file) => [file.path, pngDimensions(file.bytes)?.width])).toEqual(
      ICON_SET_SPECS.web.map((spec) => [spec.path, spec.pixels]),
    );
  });

  it("carries the Android launcher alternates its caller refuses beside", async () => {
    const rendered = await render()({
      bytes: solidPng(1024),
      mime: "image/png",
      target: "android",
    });
    if (rendered.status !== "rendered") throw new Error(rendered.reason);
    const launcher = rendered.files.find((file) => file.path === "mipmap-hdpi/ic_launcher.png");
    expect(launcher?.conflicts).toContain("mipmap-hdpi/ic_launcher.webp");
  });

  it("refuses an iOS icon that shows any transparency", async () => {
    const rendered = await render()({
      bytes: solidPng(1024, 128),
      mime: "image/png",
      target: "apple-ios",
    });
    expect(rendered).toEqual({
      status: "refused",
      reason: expect.stringMatching(/must not be transparent/),
    });
  });

  it("refuses a source smaller than the minimum", async () => {
    const rendered = await render()({ bytes: solidPng(512), mime: "image/png", target: "web" });
    expect(rendered).toEqual({
      status: "refused",
      reason: expect.stringMatching(/at least 1024/),
    });
  });

  it("refuses a non-square source", async () => {
    const width = 1024;
    const height = 768;
    const data = new Uint8Array(width * height * 4).fill(255);
    const rendered = await render()({
      bytes: new Uint8Array(encodeJpeg({ data: Buffer.from(data), width, height }, 90).data),
      mime: "image/jpeg",
      target: "web",
    });
    expect(rendered).toEqual({
      status: "refused",
      reason: expect.stringMatching(/square/),
    });
  });

  it("refuses a non-square source whose prescaled raster would read as square", async () => {
    // 2049×2048 averages down to a 1024×1024 raster the sizes render from;
    // the square check still reads the decoded source's own dimensions.
    const rendered = await render()({
      bytes: solidPng({ width: 2049, height: 2048 }),
      mime: "image/png",
      target: "web",
    });
    expect(rendered).toEqual({
      status: "refused",
      reason: expect.stringMatching(/square/),
    });
  });

  it("refuses a source whose bytes are no image it reads", async () => {
    const rendered = await render()({
      bytes: new Uint8Array([1, 2, 3, 4]),
      mime: "image/png",
      target: "web",
    });
    expect(rendered).toEqual({
      status: "refused",
      reason: "The image's size could not be read.",
    });
  });

  it("refuses an iOS icon whose decoded source shows even faint transparency", async () => {
    const rendered = await render()({
      bytes: solidPng(1024, 254),
      mime: "image/png",
      target: "apple-ios",
    });
    expect(rendered).toEqual({
      status: "refused",
      reason: expect.stringMatching(/must not be transparent/),
    });
  });

  it("refuses an iOS icon whose one faint pixel would average to opaque in the prescale", async () => {
    // A single alpha-254 pixel in a 2048 source rounds to fully opaque in the
    // 1024 raster the outputs render from; the check reads the source.
    const png = new PNG({ width: 2048, height: 2048 });
    png.data.fill(255);
    png.data[3] = 254;
    const rendered = await render()({
      bytes: new Uint8Array(PNG.sync.write(png)),
      mime: "image/png",
      target: "apple-ios",
    });
    expect(rendered).toEqual({
      status: "refused",
      reason: expect.stringMatching(/must not be transparent/),
    });
  });

  it("makes every web icon from a GIF source's first frame", async () => {
    const size = 1024;
    const gif: number[] = [];
    const writer = new GifWriter(gif, size, size, { loop: 0 });
    writer.addFrame(0, 0, size, size, new Array<number>(size * size).fill(0), {
      palette: [0x1e78c8, 0x000000],
    });
    const rendered = await render()({
      bytes: new Uint8Array(gif.slice(0, writer.end())),
      mime: "image/gif",
      target: "web",
    });
    if (rendered.status !== "rendered") throw new Error(rendered.reason);
    expect(rendered.files.map((file) => pngDimensions(file.bytes)?.width)).toEqual(
      ICON_SET_SPECS.web.map((spec) => spec.pixels),
    );
  });

  it("carries the source PNG's colour chunks into every output", async () => {
    const colour = [
      { type: "gAMA", data: Uint8Array.from([0, 0, 0xcf, 0x7a]) },
      {
        type: "cHRM",
        data: Uint8Array.from([
          0, 0, 0x7a, 0x26, 0, 0, 0x80, 0x84, 0, 0, 0xfa, 0, 0, 0, 0x80, 0xe8, 0, 0, 0x75, 0x30, 0,
          0, 0xea, 0x60, 0, 0, 0x3a, 0x98, 0, 0, 0x17, 0x70,
        ]),
      },
      { type: "sRGB", data: Uint8Array.from([0]) },
    ];
    const rendered = await render()({
      bytes: solidPng(1024, undefined, colour),
      mime: "image/png",
      target: "web",
    });
    if (rendered.status !== "rendered") throw new Error(rendered.reason);
    for (const file of rendered.files.filter((candidate) => candidate.path.endsWith(".png"))) {
      const types = pngChunkTypes(file.bytes);
      for (const { type } of colour) expect(types).toContain(type);
    }
  });

  it("stops a large source's render when the caller's stop lands between outputs", async () => {
    let stopped = false;
    const rendered = await render()({
      bytes: solidPng(2048),
      mime: "image/png",
      target: "web",
      beforeOutput: () => {
        if (stopped) return "The turn was stopped.";
        // The stop can only be observed if the render yields to the event
        // loop before the next output is asked for.
        setImmediate(() => {
          stopped = true;
        });
        return undefined;
      },
    });
    expect(rendered).toEqual({ status: "refused", reason: "The turn was stopped." });
  });
});

describe.runIf(process.platform === "darwin")("icon set rendering with macOS's sips", () => {
  it.each(targets)("makes every %s icon at its size", async (target) => {
    if (!existsSync(SIPS_PATH)) throw new Error(`${SIPS_PATH} is missing on this Mac.`);
    const render = hostIconSetRenderer({ workDirectory: workDirectory() });
    const rendered = await render({ bytes: solidPng(1024), mime: "image/png", target });
    if (rendered.status !== "rendered") throw new Error(rendered.reason);
    const check = workDirectory();
    for (const spec of ICON_SET_SPECS[target]) {
      const file = rendered.files.find((candidate) => candidate.path === spec.path);
      const path = join(check, spec.path.replaceAll("/", "_"));
      writeFileSync(path, file?.bytes ?? new Uint8Array());
      const probed = execFileSync(SIPS_PATH, ["-g", "pixelWidth", "-g", "pixelHeight", path], {
        encoding: "utf8",
      });
      expect(probed).toContain(`pixelWidth: ${String(spec.pixels)}`);
      expect(probed).toContain(`pixelHeight: ${String(spec.pixels)}`);
    }
  });

  it("saves an opaque RGBA source as an iOS icon with no alpha channel", async () => {
    if (!existsSync(SIPS_PATH)) throw new Error(`${SIPS_PATH} is missing on this Mac.`);
    const render = hostIconSetRenderer({ workDirectory: workDirectory() });
    const rendered = await render({
      bytes: solidPng(1024, 255),
      mime: "image/png",
      target: "apple-ios",
    });
    if (rendered.status !== "rendered") throw new Error(rendered.reason);
    const icon = rendered.files.find((file) => file.path.endsWith("AppIcon-1024.png"));
    const path = join(workDirectory(), "icon.png");
    writeFileSync(path, icon?.bytes ?? new Uint8Array());
    expect(execFileSync(SIPS_PATH, ["-g", "hasAlpha", path], { encoding: "utf8" })).toContain(
      "hasAlpha: no",
    );
  });
});
