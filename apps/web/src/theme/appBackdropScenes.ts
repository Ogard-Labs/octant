/**
 * The pixel ground's built-in scenes, generated in code from smooth noise so
 * no picture ships. A scene answers one question for each cell of the print's
 * grid: how much ink, and how much accent glow, at time `t`. The painter turns
 * those two numbers into dither cells. Every scene is a pure function of its
 * grid, its seed and `t`, so the same seed draws the same picture.
 */

export type SceneKind = "ridges" | "burst" | "drift";

/** What a scene puts in one cell: both in [0, 1]. */
export interface SceneSample {
  ink: number;
  glow: number;
}

export interface Scene {
  /** Readies the scene for time `t` in seconds; call before reading cells. */
  readonly frame: (t: number) => void;
  /** Writes the cell at (`column`, `row`) into `out`. */
  readonly read: (column: number, row: number, out: SceneSample) => void;
}

/** The seed every scene draws with; a different seed is a different landscape. */
export const SCENE_SEED = 7;

function smoothstep(low: number, high: number, value: number): number {
  const x = Math.min(1, Math.max(0, (value - low) / (high - low)));
  return x * x * (3 - 2 * x);
}

/** A hash of an integer and a seed, in [0, 1). */
export function hashUnit(seed: number, index: number): number {
  let h = Math.imul((index | 0) ^ Math.imul(seed | 0, 0x27d4eb2d), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth one-dimensional value noise, in [0, 1]. */
export function noise1(seed: number, x: number): number {
  const floor = Math.floor(x);
  const fraction = x - floor;
  const eased = fraction * fraction * (3 - 2 * fraction);
  const low = hashUnit(seed, floor);
  return low + (hashUnit(seed, floor + 1) - low) * eased;
}

/** Two octaves of noise, in [0, 1]: broad hills with a rougher edge. */
function hills(seed: number, x: number): number {
  return noise1(seed, x) * 0.7 + noise1(seed + 101, x * 2.3) * 0.3;
}

const RIDGE_COUNT = 5;

function createRidges(columns: number, rows: number, seed: number): Scene {
  const tops = new Float32Array(RIDGE_COUNT * columns);
  const sunOnRight = hashUnit(seed, 1) >= 0.5;
  const horizon = rows * 0.64;
  const sunX = columns * (sunOnRight ? 0.74 : 0.26);
  const sunY = horizon - rows * 0.015;
  let breath = 1;

  const frame = (t: number) => {
    breath = 1 + 0.08 * Math.sin(t * 0.7);
    for (let ridge = 0; ridge < RIDGE_COUNT; ridge += 1) {
      const depth = ridge / (RIDGE_COUNT - 1);
      const base = horizon + rows * 0.19 * depth ** 1.1;
      const amplitude = rows * (0.07 + 0.08 * depth);
      const width = columns * (0.34 - 0.05 * ridge);
      // Far ridges drift slowest, so the layers slide against each other.
      const speed = 0.5 + 1.1 * depth;
      for (let column = 0; column < columns; column += 1) {
        const x = (column + t * speed * (sunOnRight ? 1 : -1)) / width + ridge * 17.3;
        tops[ridge * columns + column] = base - amplitude * hills(seed + ridge * 31, x);
      }
    }
  };
  frame(0);

  const sunGlow = (column: number, row: number): number => {
    const dx = (column - sunX) / (columns * 0.12 * breath);
    const dy = (row - sunY) / (rows * 0.15 * breath);
    const squared = dx * dx + dy * dy;
    return Math.min(1, Math.exp(-squared) * 0.95 + Math.exp(-squared * 7));
  };

  return {
    frame,
    read: (column, row, out) => {
      const x = Math.min(columns - 1, Math.max(0, column));
      let ridge = -1;
      for (let candidate = RIDGE_COUNT - 1; candidate >= 0; candidate -= 1) {
        if (row >= (tops[candidate * columns + x] ?? Infinity)) {
          ridge = candidate;
          break;
        }
      }
      const sun = sunGlow(column, row);
      if (ridge < 0) {
        // Sky: a faint haze that thickens toward the horizon, and the sun.
        const haze = Math.exp(-Math.max(0, horizon - row) / (rows * 0.1)) * 0.22;
        out.ink = Math.min(1, haze + Math.sqrt(sun) * 0.32);
        out.glow = sun;
        return;
      }
      const depth = ridge / (RIDGE_COUNT - 1);
      const below = row - (tops[ridge * columns + x] ?? row);
      // The far ridges are fainter; each ridge's edge is its brightest line.
      const fade = 0.32 + 0.68 * depth;
      const edge = Math.exp(-below / 1.15);
      const body = 0.2 * Math.exp(-below / (rows * 0.06));
      out.ink = Math.min(1, fade * (0.9 * edge + body));
      // The sun lights the edges and upper slopes it can see.
      out.glow = Math.min(
        1,
        sun * (0.9 * edge + 0.45 * Math.exp(-below / (rows * 0.03))) * (0.5 + 0.5 * fade),
      );
    },
  };
}

/** The slow turn of the burst's rays, in radians a second. */
const BURST_SPIN = 0.012;
const BURST_RAYS = 20;

function createBurst(columns: number, rows: number, seed: number): Scene {
  // The corner is the top right, away from the sidebar, which sits on the left.
  const originX = columns * 0.99;
  const originY = rows * 0.02;
  const radius = new Float32Array(columns * rows);
  const angle = new Float32Array(columns * rows);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const dx = column - originX;
      const dy = row - originY;
      radius[row * columns + column] = Math.hypot(dx, dy);
      angle[row * columns + column] = Math.atan2(dy, dx);
    }
  }
  const reach = Math.max(columns * 0.62, rows * 0.9);
  let size = reach;
  const turn = hashUnit(seed, 2) * Math.PI * 2;
  let spin = turn;

  return {
    frame: (t) => {
      size = reach * (1 + 0.06 * Math.sin(t * 0.5));
      spin = turn + t * BURST_SPIN * BURST_RAYS;
    },
    read: (column, row, out) => {
      const at = row * columns + column;
      const r = (radius[at] ?? 0) / size;
      if (r >= 1) {
        out.ink = 0;
        out.glow = 0;
        return;
      }
      const wave = 0.5 + 0.5 * Math.cos((angle[at] ?? 0) * BURST_RAYS + spin);
      // Rays sharpen as they leave the centre, so their tips are rounded.
      const ray = wave ** (1.2 + 2.4 * r);
      const falloff = (1 - r) ** 1.7;
      const core = Math.exp(-((r / 0.1) ** 2));
      out.glow = Math.min(1, core + ray * falloff * 0.95);
      out.ink = Math.min(1, falloff * (0.18 + 0.5 * wave) * 0.9);
    },
  };
}

const STREAK_SLOPE = [0.6, 0.8] as const;

function createDrift(seed: number): Scene {
  let slide = 0;
  return {
    frame: (t) => {
      slide = t * 0.32;
    },
    read: (column, row, out) => {
      // `across` runs perpendicular to the streaks and `along` runs with them.
      const across = column * STREAK_SLOPE[0] + row * STREAK_SLOPE[1];
      const along = column * STREAK_SLOPE[1] - row * STREAK_SLOPE[0];
      const position = across / 3.4 - slide;
      const line = Math.floor(position);
      const inside = position - line;
      if (hashUnit(seed, line) < 0.4 || inside > 0.5 + 0.5 * hashUnit(seed + 3, line)) {
        out.ink = 0;
        out.glow = 0;
        return;
      }
      // Streaks come in loose bands, and each breaks up along its length.
      const band = smoothstep(0.1, 0.55, noise1(seed + 5, across * 0.008));
      const run = smoothstep(
        0.3,
        0.6,
        noise1(seed + line * 13, along * 0.011 + hashUnit(seed + 9, line) * 60),
      );
      const strength = (0.3 + 0.7 * hashUnit(seed + 7, line)) * band * run;
      // A few streaks carry the accent instead of the ink.
      const lit = hashUnit(seed + 11, line) > 0.8;
      out.ink = Math.min(1, lit ? strength * 0.45 : strength);
      out.glow = lit ? Math.min(1, strength * 0.95) : 0;
    },
  };
}

/** Builds a scene for a grid of `columns` × `rows` cells. */
export function createScene(
  kind: SceneKind,
  columns: number,
  rows: number,
  seed: number = SCENE_SEED,
): Scene {
  const wide = Math.max(1, columns);
  const tall = Math.max(1, rows);
  if (kind === "ridges") return createRidges(wide, tall, seed);
  if (kind === "burst") return createBurst(wide, tall, seed);
  return createDrift(seed);
}
