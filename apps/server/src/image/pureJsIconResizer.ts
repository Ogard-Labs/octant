import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { decode as decodeJpeg } from "jpeg-js";
import { resampleRgba, type RgbaImage } from "./resampleRgba";
import type { IconSetResizer } from "./iconSetRenderer";

/**
 * The resizer hosts without `sips` use: pure JavaScript decoders (pngjs for
 * PNG, jpeg-js for JPEG, libwebp through a WebAssembly module for WebP),
 * the in-repo resampler, and a PNG re-encode through pngjs.
 */
export function pureJsIconResizer(input: {
  readonly bytes: Uint8Array;
  readonly mime: string;
}): IconSetResizer {
  let decoded: Promise<RgbaImage | undefined> | undefined;
  const raster = () => (decoded ??= decodeIconSource(input.bytes, input.mime));
  return {
    measure: async () => {
      const image = await raster();
      return image === undefined ? undefined : { width: image.width, height: image.height };
    },
    png: async (pixels) => {
      const image = await raster();
      if (image === undefined) return undefined;
      const resized = resampleRgba(image, pixels, pixels);
      const png = new PNG({ width: pixels, height: pixels });
      png.data = Buffer.from(resized.buffer, resized.byteOffset, resized.byteLength);
      return new Uint8Array(PNG.sync.write(png));
    },
  };
}

/**
 * The source's straight-alpha RGBA raster, or undefined where its bytes are
 * not a readable PNG, JPEG or WebP — the three formats a generated image can
 * hold. A GIF source ends here too: the macOS renderer decodes it through
 * `sips`, and off macOS there is no decoder for it, so the render is refused.
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
