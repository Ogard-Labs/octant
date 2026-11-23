import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MediaIconSetTarget } from "@octant/plugin-api/media-tools";
import { checkNewFileUnder } from "./generatedImageSave";
import { pngWithoutAlpha } from "./pngOpacity";
import { pureJsIconResizer } from "./pureJsIconResizer";

/**
 * macOS's own image tool, still the resizer there. Hosts without it use the
 * pure-JavaScript renderer instead, so the operation is offered on every
 * platform and no host is told about a tool it cannot use.
 */
export const SIPS_PATH = "/usr/bin/sips";

/** The smallest source that every target can be made from without upscaling. */
export const MIN_ICON_SOURCE_PIXELS = 1024;

export interface IconSetFileSpec {
  /** Relative to the icon set's directory. */
  readonly path: string;
  readonly pixels: number;
  /**
   * Other files, relative to the same directory, that must not exist either.
   * Android names a resource by folder and base name, not extension, so an
   * existing `ic_launcher.webp` beside a new `ic_launcher.png` fails the
   * project's resource merge even though neither file is overwritten.
   */
  readonly conflicts?: ReadonlyArray<string>;
}

const ANDROID_LAUNCHER_ALTERNATES = ["webp", "jpg", "jpeg", "gif", "xml"] as const;

function androidLauncher(folder: string, pixels: number): IconSetFileSpec {
  return {
    path: `${folder}/ic_launcher.png`,
    pixels,
    conflicts: ANDROID_LAUNCHER_ALTERNATES.map((extension) => `${folder}/ic_launcher.${extension}`),
  };
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
      androidLauncher("mipmap-mdpi", 48),
      androidLauncher("mipmap-hdpi", 72),
      androidLauncher("mipmap-xhdpi", 96),
      androidLauncher("mipmap-xxhdpi", 144),
      androidLauncher("mipmap-xxxhdpi", 192),
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
  /** Files that must not exist beside it; see `IconSetFileSpec.conflicts`. */
  readonly conflicts?: ReadonlyArray<string>;
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
 * What a resizer owes the shared render: the source's dimensions up front
 * (undefined where they cannot be read, which the caller refuses), then PNG
 * bytes at exactly the asked square size for each size the target needs.
 */
export interface IconSetResizer {
  measure(): Promise<{ readonly width: number; readonly height: number } | undefined>;
  /**
   * Whether the decoded source shows any transparency, where the resizer
   * reads pixels itself. Absent on resizers that cannot answer — the caller
   * then checks each output instead.
   */
  opaque?(): Promise<boolean | undefined>;
  png(pixels: number): Promise<Uint8Array | undefined>;
}

/** Prepares the resizer for one render; `scratch` is that render's private directory. */
export type IconSetResizerFactory = (input: {
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly scratch: string;
}) => Promise<IconSetResizer>;

/** The `sips` resizer: writes the source beside its outputs and shells out, never a shell. */
export function sipsIconResizer(run: SipsRun): IconSetResizerFactory {
  return async ({ bytes, mime, scratch }) => {
    const source = join(scratch, `source.${SOURCE_EXTENSION[mime] ?? "png"}`);
    await writeFile(source, bytes, { mode: 0o600 });
    return {
      measure: async () => {
        const probed = await run(["-g", "pixelWidth", "-g", "pixelHeight", source]);
        return {
          width: Number(sipsProperty(probed.stdout, "pixelWidth")),
          height: Number(sipsProperty(probed.stdout, "pixelHeight")),
        };
      },
      png: async (pixels) => {
        const output = join(scratch, `${String(pixels)}.png`);
        const size = String(pixels);
        await run(["-s", "format", "png", "-z", size, size, source, "--out", output]);
        return new Uint8Array(await readFile(output));
      },
    };
  };
}

/**
 * Resizes one finished image into every file a target needs, in a private
 * temporary directory that is always removed. The source is checked first:
 * square and at least 1024 pixels. For iOS, App Store Connect rejects an icon
 * with an alpha channel, so a source that shows any transparency is refused
 * and an opaque one is saved without its alpha channel. Each output's PNG
 * header is checked against the size it was asked for, so a file the resizer
 * got wrong is refused rather than saved.
 */
export async function renderIconSetWithResizer(input: {
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly target: MediaIconSetTarget;
  /** A private directory the host owns; each render uses its own child. */
  readonly workDirectory: string;
  readonly resizer: IconSetResizerFactory;
  /**
   * Asked before each output is rendered; a returned reason stops the set.
   * The caller reads the turn's Stop and the thread's access level again
   * through it, so neither is taken only after the whole render.
   */
  readonly beforeOutput?: () => string | undefined;
}): Promise<IconSetRenderOutcome> {
  let scratch: string | undefined;
  try {
    await mkdir(input.workDirectory, { recursive: true, mode: 0o700 });
    scratch = await mkdtemp(join(input.workDirectory, "icon-set-"));
    const resizer = await input.resizer({
      bytes: input.bytes,
      mime: input.mime,
      scratch,
    });
    const measured = await resizer.measure();
    if (
      measured === undefined ||
      !Number.isSafeInteger(measured.width) ||
      !Number.isSafeInteger(measured.height) ||
      measured.width <= 0
    ) {
      return { status: "refused", reason: "The image's size could not be read." };
    }
    const { width, height } = measured;
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
    // Where the resizer reads pixels itself, a transparent source is refused
    // on the decoded raster before any output is rendered.
    if (input.target === "apple-ios" && (await resizer.opaque?.()) === false) {
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
        const hold = input.beforeOutput?.();
        if (hold !== undefined) return { status: "refused", reason: hold };
        const size = String(spec.pixels);
        const png = await resizer.png(spec.pixels);
        if (png === undefined) {
          return { status: "refused", reason: `The ${size}-pixel icon could not be made.` };
        }
        bytes = png;
        const dimensions = pngDimensions(bytes);
        if (dimensions?.width !== spec.pixels || dimensions.height !== spec.pixels) {
          return { status: "refused", reason: `The ${size}-pixel icon could not be made.` };
        }
        if (input.target === "apple-ios") {
          const opacity = pngWithoutAlpha(bytes);
          if (opacity.status === "transparent") {
            return {
              status: "refused",
              reason:
                "iOS app icons must not be transparent; generate one with an opaque background.",
            };
          }
          if (opacity.status === "unreadable") {
            return { status: "refused", reason: "The icon's transparency could not be checked." };
          }
          bytes = opacity.png;
        }
        rendered.set(spec.pixels, bytes);
      }
      files.push({
        path: spec.path,
        bytes,
        ...(spec.conflicts === undefined ? {} : { conflicts: spec.conflicts }),
      });
    }
    const contents = iconSetContentsJson(input.target);
    if (contents !== undefined) {
      files.push({ path: `${APPLE_SET}/Contents.json`, bytes: new TextEncoder().encode(contents) });
    }
    return { status: "rendered", files };
  } catch {
    return { status: "refused", reason: "The image could not be resized." };
  } finally {
    // A failed cleanup leaves a private temporary directory behind; it must
    // not turn a finished render into an exception.
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/** The `sips` render, used on macOS. */
export async function renderIconSet(input: {
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly target: MediaIconSetTarget;
  /** A private directory the host owns; each render uses its own child. */
  readonly workDirectory: string;
  readonly run: SipsRun;
}): Promise<IconSetRenderOutcome> {
  return renderIconSetWithResizer({ ...input, resizer: sipsIconResizer(input.run) });
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
 * The host's renderer: `sips` on macOS, the pure-JavaScript resizer on every
 * other platform, so icon sets are offered wherever the thread has a folder.
 */
export function hostIconSetRenderer(input: {
  readonly workDirectory: string;
  readonly platform?: NodeJS.Platform;
  readonly sipsExists?: () => boolean;
}): (source: {
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly target: MediaIconSetTarget;
  readonly beforeOutput?: () => string | undefined;
}) => Promise<IconSetRenderOutcome> {
  const platform = input.platform ?? process.platform;
  const sipsExists = input.sipsExists ?? (() => existsSync(SIPS_PATH));
  if (platform === "darwin" && sipsExists()) {
    return (source) =>
      renderIconSet({ ...source, workDirectory: input.workDirectory, run: runSips });
  }
  const resizer: IconSetResizerFactory = async (source) => pureJsIconResizer(source);
  return (source) =>
    renderIconSetWithResizer({ ...source, workDirectory: input.workDirectory, resizer });
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
 * The image tool's icon-set port for a turn's folder, spread into its options.
 */
export function hostIconSetsUnder(root: string, dataDirectory: string) {
  const render = hostIconSetRenderer({ workDirectory: join(dataDirectory, "icon-sets") });
  return {
    iconSets: {
      render,
      check: (relativePath: string) => checkNewFileUnder({ root, relativePath }),
    },
  };
}
