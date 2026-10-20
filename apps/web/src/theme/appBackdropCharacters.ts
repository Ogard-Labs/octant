/**
 * The character ground: a grid of monospace letters and digits whose
 * brightness rolls through slow overlapping waves and breathes as a whole,
 * while a few cells swap their glyph each frame. A click sends a bright ring
 * out across the field from where it landed. The field is drawn in the
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
const RIPPLE_SPEED = 320;
const RIPPLE_BAND = 40;
const RIPPLE_SECONDS = 1.6;

export interface Ripple {
  readonly x: number;
  readonly y: number;
  /** Field time, in seconds, when the click landed. */
  readonly start: number;
}

/**
 * The brightness a click's ring lends a point at time `t`: full on the ring's
 * edge, falling off across its band, and fading as the ring grows old.
 */
export function rippleBrightness(ripple: Ripple, x: number, y: number, t: number): number {
  const age = t - ripple.start;
  if (age < 0 || age > RIPPLE_SECONDS) return 0;
  const distance = Math.hypot(x - ripple.x, y - ripple.y);
  const fromEdge = Math.abs(distance - age * RIPPLE_SPEED);
  if (fromEdge > RIPPLE_BAND) return 0;
  return (1 - fromEdge / RIPPLE_BAND) * (1 - age / RIPPLE_SECONDS);
}

function displayPixelRatio(): number {
  const ratio = typeof window === "undefined" ? 1 : window.devicePixelRatio;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

/**
 * Draws the field into `canvas` and, when `animated`, keeps it moving until
 * the returned stop is called. A still field draws one frame and stops, which
 * is what reduced motion asks for. A hidden window draws nothing.
 */
export function runCharacterField(canvas: HTMLCanvasElement, animated: boolean): () => void {
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
    ripples = ripples.filter((ripple) => t - ripple.start <= RIPPLE_SECONDS);
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
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return;
    ripples = [...ripples, { x, y, start: (performance.now() - started) / 1000 }];
  };

  fit();
  draw(performance.now());
  if (animated) {
    frame = requestAnimationFrame(tick);
    window.addEventListener("pointerdown", ripple, { passive: true });
  }
  const observer =
    typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(() => {
          fit();
          draw(performance.now());
        });
  observer?.observe(canvas);
  return () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    window.removeEventListener("pointerdown", ripple);
    observer?.disconnect();
  };
}
