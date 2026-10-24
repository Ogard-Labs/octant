import type { ResolvedAppBackground } from "@octant/domain";
import {
  ECHO_DELAY,
  RIPPLE_BAND,
  RIPPLE_SPEED,
  acceptsRipple,
  createRipple,
  rippleBrightness,
  type Ripple,
} from "./appBackdropCharacters";
import { displayPixelRatio, watchDisplayPixelRatio } from "./appBackdropPhoto";

/**
 * The moving print: a ground drawn as square cells, one canvas pixel per cell
 * scaled up without smoothing, so a click can push a wave through the cells.
 * It prints either the pixel field (the theme's ink in slow drifting waves) or
 * a picture's cells. A still print draws one frame and takes no clicks; a
 * moving one bounces the cells outward from each click and lights the wave in
 * the theme's accent, the way the character field's ring does.
 */

/** The 4×4 ordered-dither thresholds, in [0, 1). */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((value) => value / 16);

/** The field's brightest cell; it is texture behind the work, never content. */
const FIELD_MAX_ALPHA = 0.42;
/** How far a passing wave pushes a cell, in cells. */
const BOUNCE_CELLS = 2.2;
/** How strongly the wave lights a cell toward the accent. */
const GLOW = 0.6;
/** The field drifts at twelve frames a second; a wave runs at twenty-four. */
const IDLE_FRAME_MS = 1000 / 12;
const WAVE_FRAME_MS = 1000 / 24;
/** A wave and its echo are gone after this long. */
const WAVE_SECONDS = 1.9;

/**
 * The field's brightness at a cell, in [0, 1]: three travelling waves meet in
 * drifting patches. Fractional cells are allowed, which is how a wave's push
 * shows in the field.
 */
export function fieldLevel(column: number, row: number, t: number): number {
  const waves =
    Math.sin(column * 0.07 + t * 0.32) +
    Math.sin(row * 0.11 - t * 0.24) +
    Math.sin((column + row) * 0.04 + t * 0.45);
  const patch = Math.max(0, waves / 3);
  return Math.min(1, Math.pow(patch, 1.3) * 1.45);
}

/**
 * A level in [0, 1] printed in `levels` steps. Dither adds the cell's ordered
 * threshold before rounding down, so in-between levels become a pattern of
 * the two nearest steps; pixelate rounds to the nearest step.
 */
export function printLevel(
  value: number,
  levels: number,
  dithered: boolean,
  column: number,
  row: number,
): number {
  const steps = Math.max(1, levels - 1);
  const clamped = Math.min(1, Math.max(0, value));
  if (!dithered) return Math.round(clamped * steps) / steps;
  const threshold = BAYER[(row & 3) * 4 + (column & 3)] ?? 0;
  return Math.min(steps, Math.floor(clamped * steps + threshold)) / steps;
}

export interface CellWave {
  /** How far the cell is pushed, in cells, along each axis. */
  readonly dx: number;
  readonly dy: number;
  /** How strongly the wave lights the cell, in [0, 1]. */
  readonly glow: number;
}

const STILL: CellWave = { dx: 0, dy: 0, glow: 0 };

/**
 * How the click waves move one cell at time `t`: each wave pushes the cell
 * outward from its click while the wave's edge passes, and lights it.
 */
export function cellWave(
  ripples: ReadonlyArray<Ripple>,
  x: number,
  y: number,
  t: number,
): CellWave {
  let dx = 0;
  let dy = 0;
  let glow = 0;
  for (const ripple of ripples) {
    // Most cells are nowhere near a wave's edge; skip them before the angle
    // and wobble math. The edge wobbles by at most a quarter and the band
    // widens by a fifth, so this annulus holds every cell a wave can light.
    const age = t - ripple.start;
    const distance2 = (x - ripple.x) ** 2 + (y - ripple.y) ** 2;
    const outer = age * RIPPLE_SPEED * 1.25 + RIPPLE_BAND * 1.2;
    const inner = Math.max(0, (age - ECHO_DELAY) * RIPPLE_SPEED * 0.75 - RIPPLE_BAND * 1.2);
    if (distance2 > outer * outer || distance2 < inner * inner) continue;
    const lit = rippleBrightness(ripple, x, y, t);
    if (lit <= 0) continue;
    const distance = Math.hypot(x - ripple.x, y - ripple.y) || 1;
    dx += ((x - ripple.x) / distance) * lit * BOUNCE_CELLS;
    dy += ((y - ripple.y) / distance) * lit * BOUNCE_CELLS;
    glow = Math.max(glow, lit);
  }
  return glow === 0 ? STILL : { dx, dy, glow };
}

/** A picture's cells, sampled once at the print's own resolution. */
export interface PictureCells {
  readonly columns: number;
  readonly rows: number;
  /** RGBA for each cell, row by row. */
  readonly rgba: Uint8ClampedArray;
}

/**
 * Reads `source` into one colour per cell, covering the grid the way the
 * still print does, so the moving print starts from the same picture.
 */
export function samplePicture(
  source: CanvasImageSource,
  size: { readonly width: number; readonly height: number },
  columns: number,
  rows: number,
): PictureCells | undefined {
  const scratch = document.createElement("canvas");
  scratch.width = Math.max(1, columns);
  scratch.height = Math.max(1, rows);
  const context = scratch.getContext("2d", { willReadFrequently: true });
  if (context === null || size.width === 0 || size.height === 0) return undefined;
  const scale = Math.max(scratch.width / size.width, scratch.height / size.height);
  const width = size.width * scale;
  const height = size.height * scale;
  context.imageSmoothingEnabled = true;
  context.drawImage(
    source,
    (scratch.width - width) / 2,
    (scratch.height - height) / 2,
    width,
    height,
  );
  return {
    columns: scratch.width,
    rows: scratch.height,
    rgba: context.getImageData(0, 0, scratch.width, scratch.height).data,
  };
}

/**
 * A computed colour as numbers: `rgb(…)`/`rgba(…)`, which computed styles
 * return, or `#rgb`/`#rrggbb`, which the theme's accent property holds.
 */
export function parseColor(value: string): readonly [number, number, number] | undefined {
  const rgb = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(value);
  if (rgb !== null) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (hex === null || hex[1] === undefined) return undefined;
  const digits =
    hex[1].length === 3
      ? hex[1]
          .split("")
          .map((digit) => digit + digit)
          .join("")
      : hex[1];
  const channel = (at: number) => Number.parseInt(digits.slice(at, at + 2), 16);
  return [channel(0), channel(2), channel(4)];
}

export interface MovingPrintSource {
  readonly picture?: {
    readonly source: CanvasImageSource;
    readonly size: { readonly width: number; readonly height: number };
  };
}

/**
 * Draws the print into `canvas` and, when `animated`, keeps it answering
 * clicks (and, for the field, drifting) until the returned stop is called.
 */
export function runMovingPrint(
  canvas: HTMLCanvasElement,
  source: MovingPrintSource,
  effect: ResolvedAppBackground["effect"],
  animated: boolean,
  ripplesWithin?: string,
): () => void {
  const context = canvas.getContext("2d");
  if (context === null) return () => undefined;
  const grid = document.createElement("canvas");
  const gridContext = grid.getContext("2d");
  if (gridContext === null) return () => undefined;
  const cell = Math.max(2, effect.cell);
  const levels = Math.max(2, effect.levels);
  const dithered = effect.kind !== "pixelate";
  const started = performance.now();
  let columns = 0;
  let rows = 0;
  let pixels: ImageData | undefined;
  let picture: PictureCells | undefined;
  let ripples: ReadonlyArray<Ripple> = [];
  let waves: CellWave[] = [];
  let blockColumns = 1;
  let frame: number | undefined;
  let nextFrame: ReturnType<typeof setTimeout> | undefined;
  let lastDrawn = 0;
  let ink: readonly [number, number, number] = [128, 128, 128];
  let accent: readonly [number, number, number] = ink;

  // The ink and accent only move when the theme rewrites the root element,
  // which the observer below reports, so they are read then, not per frame.
  const readTheme = () => {
    const style = getComputedStyle(canvas);
    ink = parseColor(style.color) ?? [128, 128, 128];
    accent = parseColor(style.getPropertyValue("--octant-accent").trim()) ?? ink;
  };

  const fit = () => {
    const rect = canvas.getBoundingClientRect();
    const ratio = displayPixelRatio();
    canvas.width = Math.max(1, Math.round(rect.width * ratio));
    canvas.height = Math.max(1, Math.round(rect.height * ratio));
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    columns = Math.max(1, Math.ceil(rect.width / cell));
    rows = Math.max(1, Math.ceil(rect.height / cell));
    grid.width = columns;
    grid.height = rows;
    const stride = Math.max(1, Math.round(4 / cell));
    blockColumns = Math.ceil(columns / stride);
    waves = Array.from({ length: blockColumns * Math.ceil(rows / stride) }, () => STILL);
    pixels = gridContext.createImageData(columns, rows);
    picture =
      source.picture === undefined
        ? undefined
        : samplePicture(source.picture.source, source.picture.size, columns, rows);
  };

  const draw = (now: number) => {
    if (pixels === undefined) return;
    const t = (now - started) / 1000;
    ripples = ripples.filter((ripple) => t - ripple.start <= WAVE_SECONDS);
    const out = pixels.data;
    // The wave is smooth across a few pixels, so small cells share one
    // reading per block: at 2px cells a full-window wave measured about 40ms
    // a frame computed per cell, and about a quarter of that per 2×2 block.
    const stride = Math.max(1, Math.round(4 / cell));
    let wave = STILL;
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        if (ripples.length === 0) wave = STILL;
        else if (row % stride === 0 && column % stride === 0) {
          wave = cellWave(ripples, (column + 0.5) * cell, (row + 0.5) * cell, t);
          waves[(row / stride) * blockColumns + column / stride] = wave;
        } else {
          wave =
            waves[Math.floor(row / stride) * blockColumns + Math.floor(column / stride)] ?? STILL;
        }
        const at = (row * columns + column) * 4;
        if (picture === undefined) {
          const level = printLevel(
            fieldLevel(column - wave.dx, row - wave.dy, t),
            levels,
            dithered,
            column,
            row,
          );
          // The wave's light goes through the same print as the field, so
          // the ring stays in cells rather than a soft blur.
          const glow = printLevel(wave.glow * GLOW, levels, dithered, column, row);
          const lit = glow > level;
          const color = lit ? accent : ink;
          out[at] = color[0];
          out[at + 1] = color[1];
          out[at + 2] = color[2];
          out[at + 3] = Math.round(255 * (lit ? glow * 0.85 : level * FIELD_MAX_ALPHA));
          continue;
        }
        const sourceColumn = Math.min(
          picture.columns - 1,
          Math.max(0, Math.round(column - wave.dx)),
        );
        const sourceRow = Math.min(picture.rows - 1, Math.max(0, Math.round(row - wave.dy)));
        const glow =
          wave.glow === 0 ? 0 : printLevel(wave.glow * GLOW * 0.6, levels, true, column, row);
        const from = (sourceRow * picture.columns + sourceColumn) * 4;
        for (let channel = 0; channel < 3; channel += 1) {
          const value = (picture.rgba[from + channel] ?? 0) / 255;
          // Pixelate keeps a picture's colours, as the still print does;
          // only dither steps them down.
          const printed = dithered ? printLevel(value, levels, true, column, row) : value;
          const toward = (accent[channel] ?? 0) / 255;
          out[at + channel] = Math.round(255 * (printed + (toward - printed) * glow));
        }
        out[at + 3] = 255;
      }
    }
    gridContext.putImageData(pixels, 0, 0);
    const rect = canvas.getBoundingClientRect();
    context.clearRect(0, 0, rect.width, rect.height);
    context.imageSmoothingEnabled = false;
    context.drawImage(grid, 0, 0, columns * cell, rows * cell);
  };

  // A timer waits out each frame interval and one animation frame draws, for
  // the reason given on the character field's tick: asking for a frame at
  // every vsync kept the compositor busy even when most of them drew nothing.
  const tick = (now: number) => {
    frame = undefined;
    if (document.hidden) return;
    lastDrawn = now;
    draw(now);
    scheduleNext();
  };
  const schedule = (intervalMs: number) => {
    if (frame !== undefined) return;
    if (nextFrame !== undefined) clearTimeout(nextFrame);
    nextFrame = setTimeout(
      () => {
        nextFrame = undefined;
        frame = requestAnimationFrame(tick);
      },
      Math.max(0, lastDrawn + intervalMs - performance.now()),
    );
  };
  // The field keeps drifting and a wave runs at twice its pace; a picture has
  // nothing to move between waves, so it rests until the next click.
  const scheduleNext = () => {
    const waving = ripples.length > 0;
    if (!waving && picture !== undefined) return;
    schedule(waving ? WAVE_FRAME_MS : IDLE_FRAME_MS);
  };
  // A hidden window ends the loop above; it starts again on return.
  const visibility = () => {
    if (!document.hidden) scheduleNext();
  };

  // Clicks are read on the window, like the character field's, and kept only
  // when they land over the print.
  const wave = (event: PointerEvent) => {
    if (!acceptsRipple(event.target, ripplesWithin)) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return;
    const ripple = createRipple(x, y, (performance.now() - started) / 1000);
    // A heart is the character field's joke; the print keeps to rings.
    ripples = [...ripples, { ...ripple, heart: false }];
    // A click may land mid-way through an idle wait or while a picture
    // rests; the wave's first frame is due at its own, faster, cadence.
    scheduleNext();
  };

  fit();
  readTheme();
  lastDrawn = performance.now();
  draw(lastDrawn);
  if (animated) {
    scheduleNext();
    window.addEventListener("pointerdown", wave, { passive: true });
    document.addEventListener("visibilitychange", visibility);
  }
  const refit = () => {
    fit();
    draw(performance.now());
  };
  const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(refit);
  observer?.observe(canvas);
  const stopPixelRatio = watchDisplayPixelRatio(refit);
  // The ink and accent are copied into pixels, so a theme switch redraws.
  const themeObserver =
    typeof MutationObserver === "undefined"
      ? undefined
      : new MutationObserver(() => {
          readTheme();
          draw(performance.now());
        });
  themeObserver?.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["style", "class", "data-octant-theme-mode"],
  });
  return () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    if (nextFrame !== undefined) clearTimeout(nextFrame);
    window.removeEventListener("pointerdown", wave);
    document.removeEventListener("visibilitychange", visibility);
    observer?.disconnect();
    stopPixelRatio();
    themeObserver?.disconnect();
  };
}
