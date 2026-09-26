/**
 * A person's photo behind the welcome screen is either printed through an
 * ordered dither — one cell per two CSS pixels, four levels per channel,
 * then nearest-neighbour upscale, the same halftone the theme pattern uses —
 * or drawn at the display's device pixels with ordinary sampling when dither
 * is off. The coarse path is a choice, not a ceiling on the clean one.
 */

function displayPixelRatio(): number {
  if (typeof window === "undefined") return 1;
  const ratio = window.devicePixelRatio;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

/** Re-runs `onChange` when the window moves to a display with a different DPR. */
export function watchDisplayPixelRatio(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => undefined;
  }
  let media: MediaQueryList | undefined;
  const handle = () => {
    onChange();
    listen();
  };
  const listen = () => {
    media?.removeEventListener("change", handle);
    media = window.matchMedia(`(resolution: ${String(displayPixelRatio())}dppx)`);
    media.addEventListener("change", handle);
  };
  listen();
  return () => media?.removeEventListener("change", handle);
}

/** One photo cell spans two CSS pixels; finer than the pattern, still a grid. */
export const PHOTO_CELL_PX = 2;
/** Four levels per channel: enough to keep a face, few enough to look printed. */
export const PHOTO_LEVELS = 4;

/** The 8x8 ordered threshold in (0, 1), the same matrix the pattern shader uses. */
export function bayerThreshold(x: number, y: number): number {
  const xy = (x ^ y) & 7;
  const row = y & 7;
  const value =
    ((xy & 1) << 5) |
    ((row & 1) << 4) |
    ((xy & 2) << 2) |
    ((row & 2) << 1) |
    ((xy & 4) >> 1) |
    ((row & 4) >> 2);
  return (value + 0.5) / 64;
}

/** Quantizes the RGB channels of `pixels` in place; alpha is left alone. */
export function ditherPixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  levels: number = PHOTO_LEVELS,
): void {
  const steps = Math.max(1, levels - 1);
  for (let y = 0; y < height; y += 1) {
    const nudge = (row: number) => (bayerThreshold(row, y) - 0.5) / steps;
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const shift = nudge(x);
      for (let channel = 0; channel < 3; channel += 1) {
        const value = (pixels[offset + channel] ?? 0) / 255 + shift;
        const quantized = Math.round(Math.min(1, Math.max(0, value)) * steps) / steps;
        pixels[offset + channel] = Math.round(quantized * 255);
      }
    }
  }
}

export interface PhotoSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Draws `image` into `target` covering `viewport` the way `object-fit: cover`
 * would. A dithered photo is one cell per `cell` CSS pixels, quantized in
 * place; a clean photo uses the display's device pixels and is not quantized.
 * Returns false when the canvas cannot give a 2D context.
 */
export function drawDitheredPhoto(
  target: HTMLCanvasElement,
  image: CanvasImageSource,
  imageSize: PhotoSize,
  viewport: PhotoSize,
  cell: number = PHOTO_CELL_PX,
): boolean {
  return drawPhoto(target, image, imageSize, viewport, cell, true);
}

/** How a picture ground is printed: plain, in square cells, or dithered cells. */
export interface PrintEffect {
  readonly kind: "none" | "pixelate" | "dither";
  /** CSS pixels per cell. */
  readonly cell: number;
  /** Colour steps per channel, for dither. */
  readonly levels: number;
}

/**
 * Draws a picture ground through its print effect. Pixelate and dither draw
 * one canvas pixel per cell and rely on `image-rendering: pixelated` to keep
 * each cell square; plain uses the display's device pixels.
 */
export function drawPrinted(
  target: HTMLCanvasElement,
  image: CanvasImageSource,
  imageSize: PhotoSize,
  viewport: PhotoSize,
  effect: PrintEffect,
): boolean {
  if (effect.kind === "none") return drawPhoto(target, image, imageSize, viewport);
  return drawPhoto(
    target,
    image,
    imageSize,
    viewport,
    effect.cell,
    effect.kind === "dither",
    effect.levels,
  );
}

/**
 * Draws the photo covering the viewport. At one cell it uses the display's
 * device pixels; at a larger cell it draws one canvas pixel per cell, and
 * quantizes those cells only when `dithered`.
 */
export function drawPhoto(
  target: HTMLCanvasElement,
  image: CanvasImageSource,
  imageSize: PhotoSize,
  viewport: PhotoSize,
  cell = 1,
  dithered = false,
  levels: number = PHOTO_LEVELS,
): boolean {
  let width: number;
  let height: number;
  if (cell > 1) {
    width = Math.max(1, Math.ceil(viewport.width / cell));
    height = Math.max(1, Math.ceil(viewport.height / cell));
  } else {
    const ratio = displayPixelRatio();
    width = Math.max(1, Math.ceil(viewport.width * ratio));
    height = Math.max(1, Math.ceil(viewport.height * ratio));
  }
  if (target.width !== width || target.height !== height) {
    target.width = width;
    target.height = height;
  }
  const context = dithered
    ? target.getContext("2d", { willReadFrequently: true })
    : target.getContext("2d");
  if (context === null) return false;
  const scale = Math.max(width / imageSize.width, height / imageSize.height);
  const drawnWidth = imageSize.width * scale;
  const drawnHeight = imageSize.height * scale;
  context.clearRect(0, 0, width, height);
  context.drawImage(
    image,
    (width - drawnWidth) / 2,
    (height - drawnHeight) / 2,
    drawnWidth,
    drawnHeight,
  );
  if (dithered) {
    const frame = context.getImageData(0, 0, width, height);
    ditherPixels(frame.data, width, height, levels);
    context.putImageData(frame, 0, 0);
  }
  return true;
}

export interface DecodedPhoto {
  readonly source: CanvasImageSource;
  readonly size: PhotoSize;
  readonly release: () => void;
}

/** Decodes a fetched image blob; prefers the off-thread bitmap decoder. */
export async function decodePhoto(blob: Blob): Promise<DecodedPhoto> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    return {
      source: bitmap,
      size: { width: bitmap.width, height: bitmap.height },
      release: () => bitmap.close(),
    };
  }
  const url = URL.createObjectURL(blob);
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("The photo could not be decoded."));
      image.src = url;
    });
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  return {
    source: image,
    size: { width: image.naturalWidth, height: image.naturalHeight },
    release: () => URL.revokeObjectURL(url),
  };
}
