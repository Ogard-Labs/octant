/**
 * A person's photo behind the welcome screen is drawn once, small, through
 * an ordered dither with four levels per channel and its own colours, then
 * scaled up with nearest-neighbour sampling. That is the same halftone the
 * theme pattern uses, so the two read as one print rather than a photo with
 * a texture laid over it.
 */

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
 * Draws `image` into `target` at one cell per `cell` CSS pixels, covering
 * `viewport` the way `object-fit: cover` would, and dithers the result.
 * Returns false when the canvas cannot give a 2D context.
 */
export function drawDitheredPhoto(
  target: HTMLCanvasElement,
  image: CanvasImageSource,
  imageSize: PhotoSize,
  viewport: PhotoSize,
  cell: number = PHOTO_CELL_PX,
): boolean {
  const width = Math.max(1, Math.ceil(viewport.width / cell));
  const height = Math.max(1, Math.ceil(viewport.height / cell));
  if (target.width !== width || target.height !== height) {
    target.width = width;
    target.height = height;
  }
  const context = target.getContext("2d", { willReadFrequently: true });
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
  const frame = context.getImageData(0, 0, width, height);
  ditherPixels(frame.data, width, height);
  context.putImageData(frame, 0, 0);
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
