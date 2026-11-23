import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { GifReader } from "omggif";
import { decode as decodeJpeg } from "jpeg-js";
import { resampleRgbaYielding, type RgbaImage } from "./resampleRgba";
import { carryPngColour } from "./pngOpacity";
import type { IconSetResizer } from "./iconSetRenderer";

/** No icon is larger than this, so a source bigger than it is prescaled once. */
const LARGEST_ICON_PIXELS = 1024;

/**
 * The resizer hosts without `sips` use: pure JavaScript decoders (pngjs for
 * PNG, jpeg-js for JPEG, libwebp through a WebAssembly module for WebP,
 * omggif for a GIF's first frame), the in-repo resampler, and a PNG
 * re-encode through pngjs.
 */
export function pureJsIconResizer(input: {
  readonly bytes: Uint8Array;
  readonly mime: string;
}): IconSetResizer {
  let decodedSource: Promise<RgbaImage | undefined> | undefined;
  const source = () => (decodedSource ??= decodeIconSource(input.bytes, input.mime));
  let decodedScaled: Promise<RgbaImage | undefined> | undefined;
  const scaled = () =>
    (decodedScaled ??= source().then((image) =>
      image === undefined ? undefined : shrinkOversize(image),
    ));
  return {
    // The size and opacity checks read the decoded source, not the prescaled
    // raster: rounding would call a 2049×2048 source square, and averaging
    // would dilute a transparent speck below the refusal.
    measure: async () => {
      const image = await source();
      return image === undefined ? undefined : { width: image.width, height: image.height };
    },
    opaque: async () => {
      const image = await source();
      if (image === undefined) return undefined;
      for (let index = 3; index < image.data.byteLength; index += 4) {
        if ((image.data[index] ?? 0) < 255) return false;
      }
      return true;
    },
    png: async (pixels) => {
      // An awaited boundary before the resample lets a queued Stop or a level
      // drop land between outputs instead of after the whole set.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const image = await scaled();
      if (image === undefined) return undefined;
      const resized = await resampleRgbaYielding(image, pixels, pixels);
      const png = new PNG({ width: pixels, height: pixels });
      png.data = Buffer.from(resized.buffer, resized.byteOffset, resized.byteLength);
      return carryPngColour(input.bytes, new Uint8Array(PNG.sync.write(png)));
    },
  };
}

/**
 * A source larger than the biggest icon is averaged down to it once, so a
 * 4K photo's resample work happens at 1024 for every size instead of again
 * from the whole raster for each one.
 */
async function shrinkOversize(image: RgbaImage): Promise<RgbaImage> {
  const biggest = Math.max(image.width, image.height);
  if (biggest <= LARGEST_ICON_PIXELS) return image;
  const scale = LARGEST_ICON_PIXELS / biggest;
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  return { width, height, data: await resampleRgbaYielding(image, width, height) };
}

/**
 * The source's straight-alpha RGBA raster, or undefined where its bytes are
 * not a readable PNG, JPEG, WebP or GIF — the four formats a generated or
 * attached image can hold.
 */
async function decodeIconSource(bytes: Uint8Array, mime: string): Promise<RgbaImage | undefined> {
  try {
    if (mime === "image/png") {
      const png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
    }
    if (mime === "image/jpeg") {
      // `maxMemoryUsageInMB` keeps a hostile decompression bomb from
      // exhausting the host; the raster is straight-alpha RGBA as declared.
      const jpeg = decodeJpeg(bytes, {
        useTArray: true,
        formatAsRGBA: true,
        maxMemoryUsageInMB: 1024,
      });
      return { width: jpeg.width, height: jpeg.height, data: jpeg.data };
    }
    if (mime === "image/webp") {
      const image = await decodeWebp(bytes);
      return image === undefined
        ? undefined
        : { width: image.width, height: image.height, data: image.data };
    }
    if (mime === "image/gif") {
      // Only the first frame is the icon source, as `sips` reads it.
      const reader = new GifReader(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      const data = new Uint8Array(reader.width * reader.height * 4);
      reader.decodeAndBlitFrameRGBA(0, data);
      return { width: reader.width, height: reader.height, data };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * libwebp's decoder result. The decoder is written for the browser's
 * `ImageData`, a type Node does not declare; only these fields are read.
 */
interface DecodedWebp {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

let webpDecoderReady: Promise<typeof import("@jsquash/webp/decode.js")> | undefined;

/**
 * Instantiates the decoder's WebAssembly module once, from the `.wasm` beside
 * its glue in the installed package: the glue only locates the file itself on
 * the web, so on Node the binary is handed to it as `wasmBinary`. The package
 * stays external to the server bundle and is staged whole into the packaged
 * app, so the file is present beside its glue there too.
 */
function webpDecoder(): Promise<typeof import("@jsquash/webp/decode.js")> {
  return (webpDecoderReady ??= (async () => {
    const decoder = await import("@jsquash/webp/decode.js");
    const wasm = createRequire(import.meta.url).resolve("@jsquash/webp/codec/dec/webp_dec.wasm");
    await decoder.init({ wasmBinary: new Uint8Array(readFileSync(wasm)).buffer });
    return decoder;
  })());
}

async function decodeWebp(bytes: Uint8Array): Promise<DecodedWebp | undefined> {
  try {
    const decoder = await webpDecoder();
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const image: DecodedWebp = await decoder.default(buffer);
    return image;
  } catch {
    return undefined;
  }
}
