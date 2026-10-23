import { displayPixelRatio, watchDisplayPixelRatio } from "./appBackdropPhoto";

/**
 * The character ground: a grid of monospace letters and digits whose
 * brightness rolls through slow overlapping waves and breathes as a whole,
 * while a few cells swap their glyph each frame. A click sends an uneven,
 * wobbling ring out across the field from where it landed, now and then a heart. The field is drawn in the
 * canvas's own CSS colour and the ring in the theme's accent, so both follow
 * the theme without knowing it.
 */

const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Cell size in CSS pixels; about the reference 11px mono line. */
const CELL_WIDTH = 8;
const CELL_HEIGHT = 13;
const FONT_SIZE = 11;

/**
 * Twelve frames a second is enough for a slow pulse and keeps a full-window
 * field of ~15k glyphs well under a frame's budget.
 */
const FRAME_MS = 1000 / 12;

/** Brightness is drawn in this many alpha steps so cells batch by alpha. */
const ALPHA_STEPS = 8;
/**
 * The brightest cell. The field is texture, never text to be read, but at a
 * third opaque with squared patches it measured near-invisible on the dark
 * start screen: most lit pixels sat under 10% alpha.
 */
const MAX_ALPHA = 0.5;
/** A click's ring is meant to be seen, so it may run brighter than the field. */
const RING_MAX_ALPHA = 0.9;
/** Share of cells that swap glyph each frame. */
const SWAP_SHARE = 0.015;

export interface CharacterField {
  readonly columns: number;
  readonly rows: number;
  readonly glyphs: Uint8Array;
  /** A fixed per-cell offset so neighbours never pulse in lockstep. */
  readonly phase: Float32Array;
}

export function createCharacterField(columns: number, rows: number, random = Math.random) {
  const count = Math.max(0, columns * rows);
  const glyphs = new Uint8Array(count);
  const phase = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    glyphs[index] = Math.floor(random() * GLYPHS.length);
    phase[index] = random() * Math.PI * 2;
  }
  return { columns, rows, glyphs, phase } satisfies CharacterField;
}

/**
 * Brightness of one cell in [0, 1] at time `t` seconds: three travelling waves
 * meet in drifting bright patches, the whole field breathes, and each cell
 * flickers a little around that on its own phase.
 */
export function cellBrightness(column: number, row: number, phase: number, t: number): number {
  const waves =
    Math.sin(column * 0.09 + t * 0.35) +
    Math.sin(row * 0.16 - t * 0.27) +
    Math.sin((column + row) * 0.05 + t * 0.5);
  const patch = Math.max(0, waves / 3);
  const breath = 0.65 + 0.35 * Math.sin(t * 0.9);
  const flicker = 0.75 + 0.25 * Math.sin(t * 2.3 + phase);
  return Math.min(1, Math.pow(patch, 1.4) * breath * flicker * 1.5);
}

/** How fast a click's ring spreads, how wide it is, and how long it lasts. */
export const RIPPLE_SPEED = 320;
export const RIPPLE_BAND = 40;
const RIPPLE_SECONDS = 1.6;
/** A fainter echo follows each ring this many seconds behind, at this strength. */
export const ECHO_DELAY = 0.22;
const ECHO_GAIN = 0.45;
/** About one click in this many draws a heart instead of a ring. */
const HEART_ODDS = 6;

export interface Ripple {
  readonly x: number;
  readonly y: number;
  /** Field time, in seconds, when the click landed. */
  readonly start: number;
  /** Phase for the ring's wobble, so no two clicks look alike. */
  readonly seed: number;
  /** How far the ring's edge strays from a circle; 0 is a perfect circle. */
  readonly wobble: number;
  readonly heart: boolean;
}

export function createRipple(x: number, y: number, start: number, random = Math.random): Ripple {
  return {
    x,
    y,
    start,
    seed: random() * Math.PI * 2,
    wobble: 0.08 + random() * 0.14,
    heart: random() < 1 / HEART_ODDS,
  };
}

/**
 * How far the edge reaches in the direction `angle`, as a share of the ring's
 * plain radius. A ring wobbles and the wobble drifts while it grows; a heart
 * keeps its cleft above the click and its point below (screen y runs down).
 */
function edgeReach(ripple: Ripple, angle: number, t: number): number {
  if (ripple.heart) {
    const up = -Math.sin(angle);
    const across = Math.cos(angle);
    return (2 - 2 * up + (up * Math.sqrt(Math.abs(across))) / (up + 1.4)) / 2.2;
  }
  return (
    1 +
    ripple.wobble *
      (0.6 * Math.sin(3 * angle + ripple.seed + t * 1.7) +
        0.4 * Math.sin(5 * angle - ripple.seed * 1.3 - t * 2.3))
  );
}

/**
 * The brightness a click's wave lends a point at time `t`: full on the edge,
 * falling off across a band whose width varies around the ring, fading as the
 * wave grows old, with a fainter echo just behind it.
 */
export function rippleBrightness(ripple: Ripple, x: number, y: number, t: number): number {
  const angle = Math.atan2(y - ripple.y, x - ripple.x);
  const distance = Math.hypot(x - ripple.x, y - ripple.y);
  const band = RIPPLE_BAND * (0.8 + 0.4 * Math.sin(angle * 4 + ripple.seed));
  let lit = 0;
  for (const [delay, gain] of [
    [0, 1],
    [ECHO_DELAY, ECHO_GAIN],
  ] as const) {
    const age = t - ripple.start - delay;
    if (age < 0 || age > RIPPLE_SECONDS) continue;
    const fromEdge = Math.abs(distance - age * RIPPLE_SPEED * edgeReach(ripple, angle, t));
    if (fromEdge < band)
      lit = Math.max(lit, gain * (1 - fromEdge / band) * (1 - age / RIPPLE_SECONDS));
  }
  return lit;
}

/**
 * Whether a click may send a ring. With `within`, only a click inside a
 * matching element counts: under the whole shell the field also lies behind
 * threads, where a ring answering every click in a transcript was a
 * distraction, so there it answers the start screen alone.
 */
export function acceptsRipple(target: EventTarget | null, within: string | undefined): boolean {
  if (within === undefined) return true;
  return target instanceof Element && target.closest(within) !== null;
}

/**
 * Draws the field into `canvas` and, when `animated`, keeps it moving until
 * the returned stop is called. A still field draws one frame and stops, which
 * is what reduced motion asks for. A hidden window draws nothing.
 */
export function runCharacterField(
  canvas: HTMLCanvasElement,
  animated: boolean,
  ripplesWithin?: string,
): () => void {
  const context = canvas.getContext("2d");
  if (context === null) return () => undefined;
  let field = createCharacterField(0, 0);
  let frame: number | undefined;
  let lastDrawn = 0;
  let ripples: ReadonlyArray<Ripple> = [];
  const started = performance.now();

  const fit = () => {
    const rect = canvas.getBoundingClientRect();
    const ratio = displayPixelRatio();
    canvas.width = Math.max(1, Math.round(rect.width * ratio));
    canvas.height = Math.max(1, Math.round(rect.height * ratio));
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const columns = Math.ceil(rect.width / CELL_WIDTH);
    const rows = Math.ceil(rect.height / CELL_HEIGHT);
    if (columns !== field.columns || rows !== field.rows) {
      field = createCharacterField(columns, rows);
    }
  };

  const draw = (now: number) => {
    const t = (now - started) / 1000;
    const { columns, rows, glyphs, phase } = field;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const font = getComputedStyle(canvas).getPropertyValue("--oct-font-mono").trim();

    context.font = `${String(FONT_SIZE)}px ${font === "" ? "ui-monospace, monospace" : font}`;
    context.textBaseline = "top";
    const style = getComputedStyle(canvas);
    const ink = style.color;
    const accent = style.getPropertyValue("--octant-accent").trim();
    ripples = ripples.filter((ripple) => t - ripple.start <= RIPPLE_SECONDS + ECHO_DELAY);
    if (animated) {
      const swaps = Math.ceil(glyphs.length * SWAP_SHARE);
      for (let swap = 0; swap < swaps; swap += 1) {
        glyphs[Math.floor(Math.random() * glyphs.length)] = Math.floor(
          Math.random() * GLYPHS.length,
        );
      }
    }
    // Group cells by colour and alpha step so the fill changes sixteen times a
    // frame, not once per glyph. A cell the ring outshines takes the accent.
    const inkCells: Array<Array<number>> = Array.from({ length: ALPHA_STEPS }, () => []);
    const ringCells: Array<Array<number>> = Array.from({ length: ALPHA_STEPS }, () => []);
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const index = row * columns + column;
        const brightness = cellBrightness(column, row, phase[index] ?? 0, t);
        let lit = 0;
        for (const ripple of ripples) {
          const x = (column + 0.5) * CELL_WIDTH;
          const y = (row + 0.5) * CELL_HEIGHT;
          lit = Math.max(lit, rippleBrightness(ripple, x, y, t));
        }
        const ringed = lit > brightness;
        const step = Math.floor((ringed ? lit : brightness) * (ALPHA_STEPS - 0.001));
        if (step > 0) (ringed ? ringCells : inkCells)[step]?.push(index);
      }
    }
    const paint = (buckets: ReadonlyArray<ReadonlyArray<number>>, color: string, max: number) =>
      buckets.forEach((cells, step) => {
        if (cells.length === 0) return;
        context.fillStyle = color;
        context.globalAlpha = (step / (ALPHA_STEPS - 1)) * max;
        for (const index of cells) {
          const glyph = GLYPHS[glyphs[index] ?? 0] ?? "0";
          context.fillText(
            glyph,
            (index % columns) * CELL_WIDTH,
            Math.floor(index / columns) * CELL_HEIGHT,
          );
        }
      });
    paint(inkCells, ink, MAX_ALPHA);
    paint(ringCells, accent === "" ? ink : accent, RING_MAX_ALPHA);
    context.globalAlpha = 1;
  };

  const tick = (now: number) => {
    frame = requestAnimationFrame(tick);
    if (document.hidden || now - lastDrawn < FRAME_MS) return;
    lastDrawn = now;
    draw(now);
  };

  // The canvas takes no pointer events, so clicks are read on the window and
  // kept only when they land over the field. A still field takes no ripples.
  const ripple = (event: PointerEvent) => {
    if (!acceptsRipple(event.target, ripplesWithin)) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return;
    ripples = [...ripples, createRipple(x, y, (performance.now() - started) / 1000)];
  };

  fit();
  draw(performance.now());
  if (animated) {
    frame = requestAnimationFrame(tick);
    window.addEventListener("pointerdown", ripple, { passive: true });
  }
  const refit = () => {
    fit();
    draw(performance.now());
  };
  const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(refit);
  observer?.observe(canvas);
  // Moving to a display with another scale keeps the CSS box, so the resize
  // observer stays quiet and the old bitmap would be stretched blurry.
  const stopPixelRatio = watchDisplayPixelRatio(refit);
  // The ink and accent are copied into pixels. A theme switch rewrites them
  // on the root element; a still field has no next frame to pick that up.
  const themeObserver =
    typeof MutationObserver === "undefined"
      ? undefined
      : new MutationObserver(() => draw(performance.now()));
  themeObserver?.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["style", "class", "data-octant-theme-mode"],
  });
  return () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    window.removeEventListener("pointerdown", ripple);
    observer?.disconnect();
    stopPixelRatio();
    themeObserver?.disconnect();
  };
}
