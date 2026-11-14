import {
  ECHO_DELAY,
  RING_MAX_ALPHA,
  RIPPLE_SECONDS,
  acceptsRipple,
  createRipple,
  rippleBrightness,
  type Ripple,
} from "./appBackdropCharacters";
import {
  COLUMN_SHARE,
  columnShare,
  readContentColumns,
  readSidebarColumns,
  type ContentColumn,
} from "./appBackdropColumn";
import { displayPixelRatio, watchDisplayPixelRatio } from "./appBackdropPhoto";

/**
 * The character ground: a field of small monospace letters and digits in the
 * theme's text ink, visible only inside slowly drifting patches and dimmed
 * behind the start screen's content column so its text and cards stay clean.
 *
 * It is cheap on purpose. The glyphs are painted once into a layer (and a few
 * of them swap each frame); a frame only rewrites one alpha byte per cell in a
 * tiny mask and lays that mask over the layer, so the cost does not grow with
 * the number of glyphs drawn. It runs at about fifteen frames a second, stops
 * while the document is hidden or the field is off screen, and holds one still
 * frame when motion is not wanted.
 *
 * A click on empty ground sends a wobbling ring (now and then a heart) out
 * across it in the theme's accent. The cells the ring crosses take the accent
 * at the ring's strength and scramble their glyphs faster, and the field runs
 * at about forty frames a second only while a ring is alive.
 */

const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** One cell in CSS pixels: a ten-pixel monospace glyph on a thirteen-pixel line. */
export const CELL_WIDTH = 7;
export const CELL_HEIGHT = 13;
const FONT_SIZE = 10;
const FONT_FAMILY = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/** The ink at its strongest. The field is texture, never text to be read. */
export const PEAK_ALPHA = 0.15;
/** Behind the content column the ink keeps this share; it is full past the margin. */
export const CENTRE_SHARE = COLUMN_SHARE;
/** Value noise below the first edge is empty, above the second it is full. */
const PATCH_LOW = 0.52;
const PATCH_HIGH = 0.82;
/** A pattern lasts this long and cross-fades into the next over the last part. */
export const PATTERN_SECONDS = 20;
export const FADE_SECONDS = 4;
/** Share of cells that take a new glyph each frame. */
const SWAP_SHARE = 0.025;
const FRAME_MS = 1000 / 15;
/** The pace while a click's ring is alive, so its edge moves smoothly. */
export const RING_FRAME_MS = 1000 / 40;
/** Share of the cells a ring crosses that take a new glyph each frame. */
const RING_SWAP_SHARE = 0.3;
/** At most this many rings are drawn at once; the newest win. */
const MAX_RINGS = 8;
/** A click further than this from where it went down is a drag, not a click. */
const DRAG_SLOP = 6;
/** Elements a click on which belongs to the control, not to the ground. */
const CONTROL_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "textarea",
  "select",
  "summary",
  "label",
  "[contenteditable]:not([contenteditable='false'])",
  "[role='button']",
  "[role='link']",
  "[role='tab']",
  "[role='menu']",
  "[role='menuitem']",
  "[role='option']",
  "[role='checkbox']",
  "[role='switch']",
  "[role='slider']",
  "[role='dialog']",
  "[role='listbox']",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

/**
 * Whether a click on `target` is a click on empty ground: not on a control
 * (or inside a menu or dialog), and not the end of a text selection.
 */
export function isEmptyGroundClick(target: EventTarget | null, selection: Selection | null) {
  if (!(target instanceof Element)) return false;
  if (target.closest(CONTROL_SELECTOR) !== null) return false;
  return selection === null || selection.isCollapsed;
}
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
  /** The content column's dimming per cell, which only the size changes. */
  readonly shares: Float32Array;
  ink: string;
}

function createSurface(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  ink: string,
  contentColumn: ReadonlyArray<ContentColumn>,
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
  // The column's text and cards run the field's full height, so every row is
  // dimmed alike; only the distance from the column's edges varies.
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const index = row * columns + column;
      glyphs[index] = Math.floor(Math.random() * GLYPHS.length);
      shares[index] = columnShare((column + 0.5) * CELL_WIDTH, contentColumn);
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

function paintLayer(surface: Surface, layer: HTMLCanvasElement, ink: string) {
  const context = layer.getContext("2d");
  if (context === null) return;
  context.clearRect(0, 0, layer.width, layer.height);
  context.fillStyle = ink;
  context.font = `${FONT_SIZE * surface.ratio}px ${FONT_FAMILY}`;
  context.textBaseline = "middle";
  for (let index = 0; index < surface.glyphs.length; index += 1) {
    paintCell(context, surface, index);
  }
}

/**
 * Draws the field into `canvas` and, when `animated`, keeps it moving until
 * the returned stop is called. A still field draws one frame and nothing more,
 * and takes no rings. With `ripplesWithin`, only a click inside a matching
 * element sends a ring. Nothing is drawn or scheduled while the document is
 * hidden or the canvas is off screen.
 */
export function runAsciiField(
  canvas: HTMLCanvasElement,
  animated: boolean,
  ripplesWithin?: string,
): () => void {
  const context = canvas.getContext("2d");
  if (context === null) return () => undefined;
  let surface: Surface | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idle: number | undefined;
  let stopped = false;
  let onScreen = true;
  let started = 0;
  let frames = 0;
  let rings: ReadonlyArray<Ripple> = [];
  // The accent glyphs a ring is shown through. They exist only while a ring
  // does, so an idle field carries one layer, not two.
  let accentLayer: HTMLCanvasElement | undefined;
  let accentInk = "";
  let ringMask: HTMLCanvasElement | undefined;
  let ringImage: ImageData | undefined;
  let scratch: HTMLCanvasElement | undefined;
  // The field's own alpha per cell moves slowly, so the faster ring frames
  // reuse it and only the ring is worked out again.
  let fieldAlpha = new Float32Array(0);
  let fieldAt = Number.NEGATIVE_INFINITY;
  const crossed: number[] = [];

  const readInk = () => getComputedStyle(canvas).color;
  const readAccent = () => {
    const accent = getComputedStyle(canvas).getPropertyValue("--octant-accent").trim();
    return accent === "" ? readInk() : accent;
  };

  const releaseAccent = () => {
    accentLayer = undefined;
    ringMask = undefined;
    ringImage = undefined;
    scratch = undefined;
  };

  const createAccent = () => {
    if (surface === undefined) return;
    accentInk = readAccent();
    accentLayer = document.createElement("canvas");
    accentLayer.width = surface.layer.width;
    accentLayer.height = surface.layer.height;
    paintLayer(surface, accentLayer, accentInk);
    scratch = document.createElement("canvas");
    scratch.width = surface.layer.width;
    scratch.height = surface.layer.height;
    ringMask = document.createElement("canvas");
    ringMask.width = surface.columns;
    ringMask.height = surface.rows;
    ringImage = ringMask.getContext("2d")?.createImageData(surface.columns, surface.rows);
  };

  const build = () => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) {
      surface = undefined;
      return;
    }
    surface = createSurface(canvas, rect.width, rect.height, readInk(), [
      ...readContentColumns(canvas, rect.width),
      ...readSidebarColumns(canvas),
    ]);
    if (surface !== undefined) paintLayer(surface, surface.layer, surface.ink);
    fieldAlpha = new Float32Array(surface === undefined ? 0 : surface.columns * surface.rows);
    fieldAt = Number.NEGATIVE_INFINITY;
    releaseAccent();
    if (rings.length > 0) createAccent();
  };

  const draw = (seconds: number) => {
    if (surface === undefined) return;
    const current = surface;
    const { columns, rows, maskImage, shares, glyphs } = surface;
    const bytes = maskImage.data;
    // The patches drift slowly, so a ring's faster frames keep the last ones.
    if (seconds - fieldAt >= FRAME_MS / 1000 - 0.005 || seconds < fieldAt) {
      fieldAt = seconds;
      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          const index = row * columns + column;
          fieldAlpha[index] =
            patchStrength(column, row, seconds) * (shares[index] ?? 1) * PEAK_ALPHA;
        }
      }
    }
    rings = rings.filter((ring) => seconds - ring.start <= RIPPLE_SECONDS + ECHO_DELAY);
    const shown = rings.slice(-MAX_RINGS);
    const ringBytes = shown.length > 0 ? ringImage?.data : undefined;
    crossed.length = 0;
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const index = row * columns + column;
        let alpha = fieldAlpha[index] ?? 0;
        if (ringBytes !== undefined) {
          const x = (column + 0.5) * CELL_WIDTH;
          const y = (row + 0.5) * CELL_HEIGHT;
          let lit = 0;
          for (const ring of shown) lit = Math.max(lit, rippleBrightness(ring, x, y, seconds));
          const ringAlpha = lit * RING_MAX_ALPHA;
          // Where the ring is stronger than the field it takes the cell over.
          if (ringAlpha > alpha) {
            ringBytes[index * 4 + 3] = Math.round(ringAlpha * 255);
            crossed.push(index);
            alpha = 0;
          } else {
            ringBytes[index * 4 + 3] = 0;
          }
        }
        bytes[index * 4 + 3] = Math.round(alpha * 255);
      }
    }
    const maskContext = surface.mask.getContext("2d");
    const layerContext = surface.layer.getContext("2d");
    if (maskContext === null || layerContext === null) return;
    maskContext.putImageData(maskImage, 0, 0);
    // A few cells take a new glyph, so the field shimmers where it shows, and
    // many of those a ring crosses do, so the ring seems to stir the field.
    if (animated) {
      const accentContext = accentLayer?.getContext("2d") ?? null;
      const font = `${FONT_SIZE * surface.ratio}px ${FONT_FAMILY}`;
      layerContext.fillStyle = surface.ink;
      layerContext.font = font;
      layerContext.textBaseline = "middle";
      if (accentContext !== null) {
        accentContext.fillStyle = accentInk;
        accentContext.font = font;
        accentContext.textBaseline = "middle";
      }
      const swap = (index: number) => {
        glyphs[index] = Math.floor(Math.random() * GLYPHS.length);
        paintCell(layerContext, current, index);
        if (accentContext !== null) paintCell(accentContext, current, index);
      };
      const swaps = Math.ceil(glyphs.length * SWAP_SHARE);
      for (let count = 0; count < swaps; count += 1) {
        swap(Math.floor(Math.random() * glyphs.length));
      }
      for (const index of crossed) {
        if (Math.random() < RING_SWAP_SHARE) swap(index);
      }
    }
    context.globalCompositeOperation = "copy";
    context.drawImage(surface.layer, 0, 0);
    context.globalCompositeOperation = "destination-in";
    context.imageSmoothingEnabled = false;
    context.drawImage(surface.mask, 0, 0, canvas.width, canvas.height);
    context.globalCompositeOperation = "source-over";
    if (ringBytes !== undefined && ringMask !== undefined && ringImage !== undefined) {
      const scratchContext = scratch?.getContext("2d") ?? null;
      const ringContext = ringMask.getContext("2d");
      if (scratch !== undefined && accentLayer !== undefined) {
        if (scratchContext !== null && ringContext !== null) {
          ringContext.putImageData(ringImage, 0, 0);
          scratchContext.clearRect(0, 0, scratch.width, scratch.height);
          scratchContext.globalCompositeOperation = "source-over";
          scratchContext.drawImage(accentLayer, 0, 0);
          scratchContext.globalCompositeOperation = "destination-in";
          scratchContext.imageSmoothingEnabled = false;
          scratchContext.drawImage(ringMask, 0, 0, scratch.width, scratch.height);
          context.drawImage(scratch, 0, 0);
        }
      }
    } else if (accentLayer !== undefined) {
      releaseAccent();
    }
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
        paintLayer(surface, surface.layer, ink);
      }
    }
    draw((performance.now() - started) / 1000);
    timer = setTimeout(frame, rings.length > 0 ? RING_FRAME_MS : FRAME_MS);
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

  // The canvas takes no pointer events, so clicks are read on the window. A
  // press that travelled is a drag, and one that ended a text selection is not
  // a click on the ground either.
  let pressed: { readonly x: number; readonly y: number } | undefined;
  const onPress = (event: PointerEvent) => {
    pressed = { x: event.clientX, y: event.clientY };
  };
  const onClick = (event: MouseEvent) => {
    if (!running() || surface === undefined || event.button !== 0) return;
    if (
      pressed !== undefined &&
      Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > DRAG_SLOP
    ) {
      return;
    }
    if (!isEmptyGroundClick(event.target, window.getSelection())) return;
    if (!acceptsRipple(event.target, ripplesWithin)) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return;
    rings = [...rings, createRipple(x, y, (performance.now() - started) / 1000)].slice(-MAX_RINGS);
    if (accentLayer === undefined) createAccent();
    // The next frame is due at the ring's pace, not after an idle wait.
    halt();
    schedule();
  };
  if (animated) {
    window.addEventListener("pointerdown", onPress, { capture: true, passive: true });
    window.addEventListener("click", onClick, { capture: true, passive: true });
  }

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
    window.removeEventListener("pointerdown", onPress, { capture: true });
    window.removeEventListener("click", onClick, { capture: true });
    observer?.disconnect();
    resizeObserver?.disconnect();
    stopPixelRatio();
    delete canvas.dataset["ready"];
  };
}
