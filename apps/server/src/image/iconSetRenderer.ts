import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MediaIconSetTarget } from "@octant/plugin-api/media-tools";
import { checkNewFileUnder } from "./generatedImageSave";

/**
 * macOS's own image tool. Icon sets are resized by it rather than by a bundled
 * image library, so no dependency is added; a host without it is not offered
 * icon sets at all.
 */
export const SIPS_PATH = "/usr/bin/sips";

/** The smallest source that every target can be made from without upscaling. */
export const MIN_ICON_SOURCE_PIXELS = 1024;

export interface IconSetFileSpec {
  /** Relative to the icon set's directory. */
  readonly path: string;
  readonly pixels: number;
}

const APPLE_SET = "AppIcon.appiconset";

/**
 * The files each target needs. iOS uses Xcode 14's single 1024 universal
 * icon; macOS still lists every size and scale in its asset catalog.
 */
export const ICON_SET_SPECS: Readonly<Record<MediaIconSetTarget, ReadonlyArray<IconSetFileSpec>>> =
  {
    "apple-ios": [{ path: `${APPLE_SET}/AppIcon-1024.png`, pixels: 1024 }],
    "apple-macos": [
      { path: `${APPLE_SET}/icon_16x16.png`, pixels: 16 },
      { path: `${APPLE_SET}/icon_16x16@2x.png`, pixels: 32 },
      { path: `${APPLE_SET}/icon_32x32.png`, pixels: 32 },
      { path: `${APPLE_SET}/icon_32x32@2x.png`, pixels: 64 },
      { path: `${APPLE_SET}/icon_128x128.png`, pixels: 128 },
      { path: `${APPLE_SET}/icon_128x128@2x.png`, pixels: 256 },
      { path: `${APPLE_SET}/icon_256x256.png`, pixels: 256 },
      { path: `${APPLE_SET}/icon_256x256@2x.png`, pixels: 512 },
      { path: `${APPLE_SET}/icon_512x512.png`, pixels: 512 },
      { path: `${APPLE_SET}/icon_512x512@2x.png`, pixels: 1024 },
    ],
    android: [
      { path: "mipmap-mdpi/ic_launcher.png", pixels: 48 },
      { path: "mipmap-hdpi/ic_launcher.png", pixels: 72 },
      { path: "mipmap-xhdpi/ic_launcher.png", pixels: 96 },
      { path: "mipmap-xxhdpi/ic_launcher.png", pixels: 144 },
      { path: "mipmap-xxxhdpi/ic_launcher.png", pixels: 192 },
      { path: "playstore-icon.png", pixels: 512 },
    ],
    web: [
      { path: "favicon-16.png", pixels: 16 },
      { path: "favicon-32.png", pixels: 32 },
      { path: "apple-touch-icon.png", pixels: 180 },
      { path: "icon-192.png", pixels: 192 },
      { path: "icon-512.png", pixels: 512 },
    ],
  };

/** The asset catalog's `Contents.json` for an Apple target; undefined for the others. */
export function iconSetContentsJson(target: MediaIconSetTarget): string | undefined {
  if (target !== "apple-ios" && target !== "apple-macos") return undefined;
  const images = ICON_SET_SPECS[target].map((spec) => {
    const filename = spec.path.slice(APPLE_SET.length + 1);
    if (target === "apple-ios") {
      return { filename, idiom: "universal", platform: "ios", size: "1024x1024" };
    }
    const scale = filename.includes("@2x") ? 2 : 1;
    const points = spec.pixels / scale;
    return {
      filename,
      idiom: "mac",
      scale: `${String(scale)}x`,
      size: `${String(points)}x${String(points)}`,
    };
  });
  return `${JSON.stringify({ images, info: { author: "xcode", version: 1 } }, null, 2)}\n`;
}

/**
 * What the agent places itself for a web target: Octant never edits an HTML
 * page or a manifest. The paths assume `directory` is served at the site root,
 * as `public` is in most web projects; the agent adjusts them otherwise.
 */
export function webIconSnippets(): { readonly html: string; readonly manifestIcons: string } {
  return {
    html: [
      '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">',
      '<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png">',
      '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">',
    ].join("\n"),
    manifestIcons: JSON.stringify(
      [192, 512].map((pixels) => ({
        src: `/icon-${String(pixels)}.png`,
        sizes: `${String(pixels)}x${String(pixels)}`,
        type: "image/png",
      })),
      null,
      2,
    ),
  };
}

export interface IconSetFile {
  /** Relative to the icon set's directory. */
  readonly path: string;
  readonly bytes: Uint8Array;
}

export type IconSetRenderOutcome =
  | { readonly status: "rendered"; readonly files: ReadonlyArray<IconSetFile> }
  | { readonly status: "refused"; readonly reason: string };

/** Runs `sips` with an argument array; never a shell. */
export type SipsRun = (args: ReadonlyArray<string>) => Promise<{ readonly stdout: string }>;

const SOURCE_EXTENSION: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/**
 * Resizes one finished image into every file a target needs, in a private
 * temporary directory that is always removed. The source is checked first:
 * square, at least 1024 pixels, and opaque for iOS, since App Store Connect
 * rejects a transparent iOS icon. Each output is read back and its PNG header
 * checked against the size it was asked for, so a file `sips` got wrong is
 * refused rather than saved.
 */
export async function renderIconSet(input: {
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly target: MediaIconSetTarget;
  /** A private directory the host owns; each render uses its own child. */
  readonly workDirectory: string;
  readonly run: SipsRun;
}): Promise<IconSetRenderOutcome> {
  await mkdir(input.workDirectory, { recursive: true, mode: 0o700 });
  const scratch = await mkdtemp(join(input.workDirectory, "icon-set-"));
  try {
    const source = join(scratch, `source.${SOURCE_EXTENSION[input.mime] ?? "png"}`);
    await writeFile(source, input.bytes, { mode: 0o600 });
    const probed = await input.run([
      "-g",
      "pixelWidth",
      "-g",
      "pixelHeight",
      "-g",
      "hasAlpha",
      source,
    ]);
    const width = Number(sipsProperty(probed.stdout, "pixelWidth"));
    const height = Number(sipsProperty(probed.stdout, "pixelHeight"));
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0) {
      return { status: "refused", reason: "The image's size could not be read." };
    }
    if (width !== height) {
      return {
        status: "refused",
        reason: `Icon sets need a square image; this one is ${String(width)}×${String(height)}.`,
      };
    }
    if (width < MIN_ICON_SOURCE_PIXELS) {
      return {
        status: "refused",
        reason: `Icon sets need an image at least 1024×1024; this one is ${String(width)}×${String(height)}.`,
      };
    }
    if (input.target === "apple-ios" && sipsProperty(probed.stdout, "hasAlpha") === "yes") {
      return {
        status: "refused",
        reason: "iOS app icons must not be transparent; generate one with an opaque background.",
      };
    }
    const files: IconSetFile[] = [];
    // Each size is rendered once and reused, since several paths share one.
    const rendered = new Map<number, Uint8Array>();
    for (const spec of ICON_SET_SPECS[input.target]) {
      let bytes = rendered.get(spec.pixels);
      if (bytes === undefined) {
        const output = join(scratch, `${String(spec.pixels)}.png`);
        const size = String(spec.pixels);
        await input.run(["-s", "format", "png", "-z", size, size, source, "--out", output]);
        bytes = new Uint8Array(await readFile(output));
        const dimensions = pngDimensions(bytes);
        if (dimensions?.width !== spec.pixels || dimensions.height !== spec.pixels) {
          return { status: "refused", reason: `The ${size}-pixel icon could not be made.` };
        }
        rendered.set(spec.pixels, bytes);
      }
      files.push({ path: spec.path, bytes });
    }
    const contents = iconSetContentsJson(input.target);
    if (contents !== undefined) {
      files.push({ path: `${APPLE_SET}/Contents.json`, bytes: new TextEncoder().encode(contents) });
    }
    return { status: "rendered", files };
  } catch {
    return { status: "refused", reason: "The image could not be resized." };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** The file count a target writes, `Contents.json` included. */
export function iconSetFileCount(target: MediaIconSetTarget): number {
  return ICON_SET_SPECS[target].length + (iconSetContentsJson(target) === undefined ? 0 : 1);
}

function sipsProperty(stdout: string, name: string): string | undefined {
  for (const line of stdout.split("\n")) {
    const match = /^\s*([A-Za-z]+):\s*(.*?)\s*$/u.exec(line);
    if (match?.[1] === name) return match[2];
  }
  return undefined;
}

/** Width and height from a PNG's IHDR chunk; undefined when the bytes are not a PNG. */
export function pngDimensions(
  bytes: Uint8Array,
): { readonly width: number; readonly height: number } | undefined {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.byteLength < 24 || signature.some((byte, index) => bytes[index] !== byte)) {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * The host's renderer, or undefined where `sips` is missing: off macOS the
 * operation is not offered, so no model is told about a tool it cannot use.
 */
export function hostIconSetRenderer(input: {
  readonly workDirectory: string;
  readonly platform?: NodeJS.Platform;
  readonly sipsExists?: () => boolean;
}):
  | ((source: {
      readonly bytes: Uint8Array;
      readonly mime: string;
      readonly target: MediaIconSetTarget;
    }) => Promise<IconSetRenderOutcome>)
  | undefined {
  const platform = input.platform ?? process.platform;
  const sipsExists = input.sipsExists ?? (() => existsSync(SIPS_PATH));
  if (platform !== "darwin" || !sipsExists()) return undefined;
  return (source) => renderIconSet({ ...source, workDirectory: input.workDirectory, run: runSips });
}

function runSips(args: ReadonlyArray<string>): Promise<{ readonly stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      SIPS_PATH,
      [...args],
      { timeout: 20_000, maxBuffer: 256 * 1024, encoding: "utf8" },
      (error, stdout) => {
        if (error === null) resolve({ stdout });
        else reject(error);
      },
    );
  });
}

/**
 * The image tool's icon-set port for a turn's folder, spread into its options:
 * empty where this host cannot resize images, so the operation is not offered.
 */
export function hostIconSetsUnder(root: string, dataDirectory: string) {
  const render = hostIconSetRenderer({ workDirectory: join(dataDirectory, "icon-sets") });
  return render === undefined
    ? {}
    : {
        iconSets: {
          render,
          check: (relativePath: string) => checkNewFileUnder({ root, relativePath }),
        },
      };
}
