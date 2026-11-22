import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
function solidPng(size: number, alpha?: number): Uint8Array {
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
  headerView.setUint32(0, size);
  headerView.setUint32(4, size);
  header.set([8, alpha === undefined ? 2 : 6, 0, 0, 0], 8);
  const row = new Uint8Array(1 + size * channels);
  const pixel = alpha === undefined ? [30, 120, 200] : [30, 120, 200, alpha];
  for (let x = 0; x < size; x += 1) row.set(pixel, 1 + x * channels);
  const raw = new Uint8Array(row.byteLength * size);
  for (let y = 0; y < size; y += 1) raw.set(row, y * row.byteLength);
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
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

  it("is not offered off macOS or without sips", () => {
    const directory = workDirectory();
    expect(hostIconSetRenderer({ workDirectory: directory, platform: "linux" })).toBeUndefined();
    expect(hostIconSetRenderer({ workDirectory: directory, platform: "win32" })).toBeUndefined();
    expect(
      hostIconSetRenderer({
        workDirectory: directory,
        platform: "darwin",
        sipsExists: () => false,
      }),
    ).toBeUndefined();
    expect(
      hostIconSetRenderer({ workDirectory: directory, platform: "darwin", sipsExists: () => true }),
    ).toBeTypeOf("function");
  });
});

describe.runIf(process.platform === "darwin")("icon set rendering with macOS's sips", () => {
  it.each(targets)("makes every %s icon at its size", async (target) => {
    const render = hostIconSetRenderer({ workDirectory: workDirectory() });
    if (render === undefined) throw new Error(`${SIPS_PATH} is missing on this Mac.`);
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
});
