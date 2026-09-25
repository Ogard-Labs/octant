import type { ZenBackgroundFill, ZenGroundEffect } from "@octant/contracts/zen";
import { ditherPixels, type PhotoSize } from "../theme/appBackdropPhoto";

/** The width one tile covers when a picture repeats, matching the CSS ground. */
const TILE_WIDTH_PX = 480;

/**
 * Prints a picture ground into `target` at one canvas pixel per effect cell.
 *
 * The canvas is then scaled up to the viewport with nearest-neighbour
 * sampling (`image-rendering: pixelated` in CSS), so a cell stays a hard
 * square instead of blurring. Dither quantizes the cells in place with the
 * same ordered threshold the application ground uses. Returns false when the
 * canvas cannot give a 2D context.
 */
export function drawZenGround(
  target: HTMLCanvasElement,
  image: CanvasImageSource,
  imageSize: PhotoSize,
  viewport: PhotoSize,
  fill: ZenBackgroundFill,
  effect: ZenGroundEffect,
): boolean {
  const cell = effect.cell;
  const width = Math.max(1, Math.ceil(viewport.width / cell));
  const height = Math.max(1, Math.ceil(viewport.height / cell));
  if (target.width !== width || target.height !== height) {
    target.width = width;
    target.height = height;
  }
  const context = target.getContext("2d", { willReadFrequently: effect.kind === "dither" });
  if (context === null) return false;
  context.clearRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  if (fill === "tile") {
    const tileWidth = TILE_WIDTH_PX / cell;
    const tileHeight = (imageSize.height / imageSize.width) * tileWidth;
    const originX = width / 2 - tileWidth / 2;
    const originY = height / 2 - tileHeight / 2;
    const startX = originX - Math.ceil(originX / tileWidth) * tileWidth;
    const startY = originY - Math.ceil(originY / tileHeight) * tileHeight;
    for (let y = startY; y < height; y += tileHeight) {
      for (let x = startX; x < width; x += tileWidth) {
        context.drawImage(image, x, y, tileWidth, tileHeight);
      }
    }
  } else {
    const scale =
      fill === "contain"
        ? Math.min(width / imageSize.width, height / imageSize.height)
        : Math.max(width / imageSize.width, height / imageSize.height);
    const drawnWidth = imageSize.width * scale;
    const drawnHeight = imageSize.height * scale;
    context.drawImage(
      image,
      (width - drawnWidth) / 2,
      (height - drawnHeight) / 2,
      drawnWidth,
      drawnHeight,
    );
  }
  if (effect.kind === "dither") {
    const frame = context.getImageData(0, 0, width, height);
    ditherPixels(frame.data, width, height, effect.levels);
    context.putImageData(frame, 0, 0);
  }
  return true;
}
