import { displayPixelRatio, watchDisplayPixelRatio } from "./appBackdropPhoto";

/**
 * The character ground: a field of small monospace letters and digits in the
 * theme's text ink, visible only inside slowly drifting patches and dimmed
 * toward the middle of the page so the heading and the composer stay clean.
 *
 * It is cheap on purpose. The glyphs are painted once into a layer (and a few
 * of them swap each frame); a frame only rewrites one alpha byte per cell in a
 * tiny mask and lays that mask over the layer, so the cost does not grow with
 * the number of glyphs drawn. It runs at about fifteen frames a second, stops
 * while the document is hidden or the field is off screen, and holds one still
 * frame when motion is not wanted.
 */

const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** One cell in CSS pixels: a ten-pixel monospace glyph on a thirteen-pixel line. */
export const CELL_WIDTH = 7;
export const CELL_HEIGHT = 13;
const FONT_SIZE = 10;
const FONT_FAMILY = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/** The ink at its strongest. The field is texture, never text to be read. */
export const PEAK_ALPHA = 0.15;
/** The middle of the page keeps this share of the ink; it is full at 30% out. */
export const CENTRE_SHARE = 0.45;
const CENTRE_REACH = 0.3;
/** Value noise below the first edge is empty, above the second it is full. */
const PATCH_LOW = 0.52;
const PATCH_HIGH = 0.82;
/** A pattern lasts this long and cross-fades into the next over the last part. */
export const PATTERN_SECONDS = 20;
export const FADE_SECONDS = 4;
/** Share of cells that take a new glyph each frame. */
const SWAP_SHARE = 0.025;
const FRAME_MS = 1000 / 15;
/** The backing store never exceeds this many device pixels or this ratio. */
const MAX_RATIO = 2;
const MAX_PIXELS = 5_000_000;
/** The ink is read again this many frames apart, so a theme change follows. */
const INK_CHECK_FRAMES = 30;

function smoothstep(low: number, high: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
}

/** A repeatable hash of an integer lattice point, in [0, 1). */
function lattice(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1). */
function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const top = lattice(x0, y0, seed) * (1 - sx) + lattice(x0 + 1, y0, seed) * sx;
  const bottom = lattice(x0, y0 + 1, seed) * (1 - sx) + lattice(x0 + 1, y0 + 1, seed) * sx;
  return top * (1 - sy) + bottom * sy;
}

/** The patterns the field cycles through: round blotches, long currents, rings. */
const PATTERN_COUNT = 3;

function patternValue(pattern: number, column: number, row: number, t: number): number {
  if (pattern === 0) {
    return valueNoise(column / 9 + t * 0.05, row / 9 - t * 0.03, 1);
  }
  if (pattern === 1) {
    return valueNoise(column / 34 + t * 0.12, row / 4.5, 2);
  }
  const radius = Math.hypot(column - 60, (row - 24) * 1.8) / 7;
  return valueNoise(radius - t * 0.18, 0.5 + valueNoise(column / 18, row / 18, 3) * 3, 4);
}

/**
 * How much of the peak ink one cell shows, in [0, 1], at `t` seconds. The two
 * patterns around a change are blended across the end of the first, so the
 * field never jumps.
 */
export function patchStrength(column: number, row: number, t: number): number {
  const phase = t / PATTERN_SECONDS;
  const index = Math.floor(phase);
  const within = (phase - index) * PATTERN_SECONDS;
  const fadeStart = PATTERN_SECONDS - FADE_SECONDS;
  let value = patternValue(index % PATTERN_COUNT, column, row, t);
  if (within > fadeStart) {
    const next = patternValue((index + 1) % PATTERN_COUNT, column, row, t);
    const mix = smoothstep(0, 1, (within - fadeStart) / FADE_SECONDS);
    value = value * (1 - mix) + next * mix;
  }
  return smoothstep(PATCH_LOW, PATCH_HIGH, value);
}

/** The share of ink a cell keeps once the middle of the page is dimmed. */
export function centreShare(x: number, y: number, width: number, height: number): number {
  if (width <= 0 || height <= 0) return 1;
  const distance = Math.hypot((x - width / 2) / width, (y - height / 2) / height);
  return CENTRE_SHARE + (1 - CENTRE_SHARE) * smoothstep(0, CENTRE_REACH, distance);
}

/** The backing-store ratio for a field of this CSS size on this display. */
export function fieldPixelRatio(width: number, height: number, display: number): number {
  const capped = Math.min(MAX_RATIO, display);
  const area = Math.max(1, width * height);
  return Math.max(0.5, Math.min(capped, Math.sqrt(MAX_PIXELS / area)));
}

interface Surface {
  readonly columns: number;
  readonly rows: number;
  readonly ratio: number;
  readonly glyphs: Uint8Array;
  readonly layer: HTMLCanvasElement;
  readonly mask: HTMLCanvasElement;
  readonly maskImage: ImageData;
  /** The centre dimming per cell, which only the size changes. */
  readonly shares: Float32Array;
  ink: string;
}

function createSurface(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  ink: string,
): Surface | undefined {
  const columns = Math.max(1, Math.ceil(width / CELL_WIDTH));
  const rows = Math.max(1, Math.ceil(height / CELL_HEIGHT));
  const ratio = fieldPixelRatio(width, height, displayPixelRatio());
  canvas.width = Math.max(1, Math.round(columns * CELL_WIDTH * ratio));
  canvas.height = Math.max(1, Math.round(rows * CELL_HEIGHT * ratio));
  const layer = document.createElement("canvas");
  layer.width = canvas.width;
  layer.height = canvas.height;
  const mask = document.createElement("canvas");
  mask.width = columns;
  mask.height = rows;
  const maskContext = mask.getContext("2d");
  if (maskContext === null) return undefined;
  const glyphs = new Uint8Array(columns * rows);
  const shares = new Float32Array(columns * rows);
  // A start screen that scrolls makes the field as tall as its content, whose
  // middle is out of sight; the heading and the composer sit near the middle of
  // what the window shows, so the dimming is measured against that.
  const visibleHeight = Math.min(rows * CELL_HEIGHT, window.innerHeight);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const index = row * columns + column;
      glyphs[index] = Math.floor(Math.random() * GLYPHS.length);
      shares[index] = centreShare(
        (column + 0.5) * CELL_WIDTH,
        (row + 0.5) * CELL_HEIGHT,
        columns * CELL_WIDTH,
        visibleHeight,
      );
    }
  }
  return {
    columns,
    rows,
    ratio,
    glyphs,
    layer,
    mask,
    maskImage: maskContext.createImageData(columns, rows),
    shares,
    ink,
  };
}

function paintCell(context: CanvasRenderingContext2D, surface: Surface, index: number) {
  const column = index % surface.columns;
  const row = Math.floor(index / surface.columns);
  const glyph = GLYPHS.charAt(surface.glyphs[index] ?? 0);
  const x = column * CELL_WIDTH * surface.ratio;
  const y = row * CELL_HEIGHT * surface.ratio;
  context.clearRect(x, y, CELL_WIDTH * surface.ratio, CELL_HEIGHT * surface.ratio);
  context.fillText(glyph, x, y + CELL_HEIGHT * surface.ratio * 0.5);
}

function paintLayer(surface: Surface) {
  const context = surface.layer.getContext("2d");
  if (context === null) return;
  context.clearRect(0, 0, surface.layer.width, surface.layer.height);
  context.fillStyle = surface.ink;
  context.font = `${FONT_SIZE * surface.ratio}px ${FONT_FAMILY}`;
  context.textBaseline = "middle";
  for (let index = 0; index < surface.glyphs.length; index += 1) {
    paintCell(context, surface, index);
  }
}

/**
 * Draws the field into `canvas` and, when `animated`, keeps it moving until
 * the returned stop is called. A still field draws one frame and nothing more.
 * Nothing is drawn or scheduled while the document is hidden or the canvas is
 * off screen.
 */
export function runAsciiField(canvas: HTMLCanvasElement, animated: boolean): () => void {
  const context = canvas.getContext("2d");
  if (context === null) return () => undefined;
  let surface: Surface | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idle: number | undefined;
  let stopped = false;
  let onScreen = true;
  let started = 0;
  let frames = 0;

  const readInk = () => getComputedStyle(canvas).color;

  const build = () => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) {
      surface = undefined;
      return;
    }
    surface = createSurface(canvas, rect.width, rect.height, readInk());
    if (surface !== undefined) paintLayer(surface);
  };

  const draw = (seconds: number) => {
    if (surface === undefined) return;
    const { columns, rows, maskImage, shares, glyphs } = surface;
    const bytes = maskImage.data;
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const index = row * columns + column;
        const alpha = patchStrength(column, row, seconds) * (shares[index] ?? 1) * PEAK_ALPHA;
        bytes[index * 4 + 3] = Math.round(alpha * 255);
      }
    }
    const maskContext = surface.mask.getContext("2d");
    const layerContext = surface.layer.getContext("2d");
    if (maskContext === null || layerContext === null) return;
    maskContext.putImageData(maskImage, 0, 0);
    // A few cells take a new glyph, so the field shimmers where it shows.
    if (animated) {
      layerContext.fillStyle = surface.ink;
      layerContext.font = `${FONT_SIZE * surface.ratio}px ${FONT_FAMILY}`;
      layerContext.textBaseline = "middle";
      const swaps = Math.ceil(glyphs.length * SWAP_SHARE);
      for (let swap = 0; swap < swaps; swap += 1) {
        const index = Math.floor(Math.random() * glyphs.length);
        glyphs[index] = Math.floor(Math.random() * GLYPHS.length);
        paintCell(layerContext, surface, index);
      }
    }
    context.globalCompositeOperation = "copy";
    context.drawImage(surface.layer, 0, 0);
    context.globalCompositeOperation = "destination-in";
    context.imageSmoothingEnabled = false;
    context.drawImage(surface.mask, 0, 0, canvas.width, canvas.height);
    context.globalCompositeOperation = "source-over";
  };

  const running = () => animated && !stopped && onScreen && document.visibilityState !== "hidden";

  const frame = () => {
    timer = undefined;
    if (!running()) return;
    frames += 1;
    if (surface !== undefined && frames % INK_CHECK_FRAMES === 0) {
      const ink = readInk();
      if (ink !== surface.ink) {
        surface.ink = ink;
        paintLayer(surface);
      }
    }
    draw((performance.now() - started) / 1000);
    timer = setTimeout(frame, FRAME_MS);
  };

  const schedule = () => {
    if (timer !== undefined || !running()) return;
    timer = setTimeout(frame, 0);
  };

  const halt = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };

  const settle = () => {
    if (stopped) return;
    build();
    // A still field (reduced motion, or a field set to Still) shows one frame.
    if (!animated) draw(0);
    else if (running()) draw((performance.now() - started) / 1000);
    canvas.dataset["ready"] = "true";
    schedule();
  };

  const onVisibility = () => {
    if (document.visibilityState === "hidden") halt();
    else schedule();
  };
  document.addEventListener("visibilitychange", onVisibility);

  const observer =
    typeof IntersectionObserver === "undefined"
      ? undefined
      : new IntersectionObserver((entries) => {
          const latest = entries[entries.length - 1];
          if (latest === undefined) return;
          onScreen = latest.isIntersecting;
          if (onScreen) schedule();
          else halt();
        });
  observer?.observe(canvas);

  let resizing: ReturnType<typeof setTimeout> | undefined;
  const resize = () => {
    if (resizing !== undefined) clearTimeout(resizing);
    resizing = setTimeout(() => {
      resizing = undefined;
      halt();
      settle();
    }, 120);
  };
  const resizeObserver =
    typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(resize);
  resizeObserver?.observe(canvas);
  const stopPixelRatio = watchDisplayPixelRatio(resize);

  // Setup waits for idle time, so the first paint of the page is not delayed.
  const begin = () => {
    idle = undefined;
    started = performance.now();
    settle();
  };
  const hasIdle = typeof window.requestIdleCallback === "function";
  if (hasIdle) idle = window.requestIdleCallback(begin, { timeout: 600 });
  else idle = window.setTimeout(begin, 1);

  return () => {
    stopped = true;
    halt();
    if (resizing !== undefined) clearTimeout(resizing);
    if (idle !== undefined) {
      if (hasIdle) window.cancelIdleCallback(idle);
      else window.clearTimeout(idle);
    }
    document.removeEventListener("visibilitychange", onVisibility);
    observer?.disconnect();
    resizeObserver?.disconnect();
    stopPixelRatio();
    delete canvas.dataset["ready"];
  };
}
