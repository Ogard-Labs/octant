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
import {
  columnFloor,
  columnShare,
  isDarkPage,
  readContentColumns,
  readSidebarColumns,
} from "./appBackdropColumn";
import { displayPixelRatio, watchDisplayPixelRatio } from "./appBackdropPhoto";
import { createScene, type SceneKind, type SceneSample } from "./appBackdropScenes";

/**
 * The moving print: a ground drawn as square cells, one canvas pixel per cell
 * scaled up without smoothing, so a click can push a wave through the cells.
 * It prints a built-in scene or a picture. A scene (and a picture printed in
 * two tones) uses the theme's ink at a few ordered-dither levels and the accent
 * for one glow; a picture printed in colour keeps its own colours. A still
 * print draws one frame and takes no clicks; a moving one bounces the cells
 * outward from each click and lights the wave in the theme's accent, the way
 * the character field's ring does.
 */

/** The 4×4 ordered-dither thresholds, in [0, 1). */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((value) => value / 16);

/**
 * The most opaque an ink cell and an accent cell get, by the page they sit on.
 * A glow on a light page stays fainter: dark ink and a warm accent on pale
 * paper read much louder than light cells on a dark page.
 */
const DARK_PAGE = { ink: 0.5, accent: 0.72 } as const;
const LIGHT_PAGE = { ink: 0.4, accent: 0.36 } as const;
/**
 * Ridges is the one scene meant to be a picture rather than a texture: crisp
 * crests at near full ink, filled slopes, and a sun that saturates to the
 * accent. It carries its own peak opacities above the field caps. The light
 * page stays a little lighter, since dark ink on pale paper reads louder.
 */
const RIDGES_DARK_PAGE = { ink: 0.96, accent: 1 } as const;
const RIDGES_LIGHT_PAGE = { ink: 0.8, accent: 0.72 } as const;
/** How far a passing wave pushes a cell, in cells. */
const BOUNCE_CELLS = 2.2;
/** How strongly the wave lights a cell toward the accent. */
const GLOW = 0.6;
/** A scene drifts at fifteen frames a second; a wave runs at twenty-four. */
const IDLE_FRAME_MS = 1000 / 15;
const WAVE_FRAME_MS = 1000 / 24;
/** A wave and its echo are gone after this long. */
const WAVE_SECONDS = 1.9;
/** The backing store never exceeds this ratio, however dense the display. */
const MAX_RATIO = 2;
/** Behind the content column a scene keeps a third of its strength. */
const CALM_FLOOR = 1 / 3;
/**
 * Ridges is the bold scene, so it runs at full strength outside the text: its
 * own sky is empty behind the heading and subtitle, and the column is calmed
 * only where the composer and its chips sit, in the foot of the window, to a
 * fifth. At half its crests still ran through the chips, the usage meter and
 * the notice that sit on the ground with no fill of their own.
 */
const RIDGES_CALM_FLOOR = 0.2;
const RIDGES_COMPOSER_ZONE = { from: 0.72, to: 0.8 } as const;

function smoothstep(low: number, high: number, value: number): number {
  const x = Math.min(1, Math.max(0, (value - low) / (high - low)));
  return x * x * (3 - 2 * x);
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

/** One printed cell of a two-tone print. */
export interface Toned {
  /** Whether the cell is the accent rather than the ink. */
  accent: boolean;
  /** 0..1 opacity of the cell. */
  alpha: number;
}

/**
 * Prints one cell in the two tones: the ink at `levels` ordered-dither steps,
 * or, where the glow stands higher than the ink, the accent. The accent only
 * ever appears where `glow` is above zero, so it stays a single glow and the
 * rest of the page reads as ink.
 */
export function toneCell(
  ink: number,
  glow: number,
  levels: number,
  dithered: boolean,
  column: number,
  row: number,
  page: { readonly ink: number; readonly accent: number },
  into: Toned,
): void {
  const inkLevel = printLevel(ink, levels, dithered, column, row);
  const glowLevel = printLevel(glow, levels, dithered, column, row);
  if (glowLevel > inkLevel) {
    into.accent = true;
    into.alpha = glowLevel * page.accent;
    return;
  }
  into.accent = false;
  into.alpha = inkLevel * page.ink;
}

/** A picture read as brightness and warmth per cell, ready to print in two tones. */
export interface TwoTonePicture {
  readonly columns: number;
  readonly rows: number;
  /** Brightness stretched to the picture's own range, in [0, 1]. */
  readonly light: Float32Array;
  /** How strongly a cell wants the accent: bright and warm, in [0, 1]. */
  readonly glow: Float32Array;
}

/**
 * Reduces a picture's cells to brightness and glow. Brightness is stretched
 * between the picture's 4th and 96th percentile so a flat or dim photo still
 * uses every ink level; the glow takes the brightest warm cells, so a sunset
 * lights in the accent and a grey photo does not.
 */
export function toTwoTone(cells: PictureCells): TwoTonePicture {
  const count = cells.columns * cells.rows;
  const light = new Float32Array(count);
  const warmth = new Float32Array(count);
  const histogram = new Uint32Array(64);
  for (let index = 0; index < count; index += 1) {
    const red = (cells.rgba[index * 4] ?? 0) / 255;
    const green = (cells.rgba[index * 4 + 1] ?? 0) / 255;
    const blue = (cells.rgba[index * 4 + 2] ?? 0) / 255;
    const value = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    light[index] = value;
    warmth[index] = Math.max(0, red - blue);
    const bin = Math.min(63, Math.floor(value * 64));
    histogram[bin] = (histogram[bin] ?? 0) + 1;
  }
  const percentile = (share: number) => {
    let seen = 0;
    for (let bin = 0; bin < 64; bin += 1) {
      seen += histogram[bin] ?? 0;
      if (seen >= count * share) return (bin + 1) / 64;
    }
    return 1;
  };
  const low = percentile(0.04);
  const high = Math.max(low + 0.05, percentile(0.96));
  const glow = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    const stretched = Math.min(1, Math.max(0, ((light[index] ?? 0) - low) / (high - low)));
    light[index] = stretched;
    glow[index] = smoothstep(0.5, 0.95, stretched * (0.4 + 2.2 * (warmth[index] ?? 0)));
  }
  return { columns: cells.columns, rows: cells.rows, light, glow };
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
  /**
   * A built-in scene to draw in two tones. With a picture and no scene, the
   * picture is printed in its own colours; with `twoTone` set it is printed in
   * the theme's ink and accent instead.
   */
  readonly scene?: SceneKind;
  readonly twoTone?: boolean;
  readonly seed?: number;
}

/**
 * Draws the print into `canvas` and, when `animated`, keeps it answering
 * clicks (and, for a scene, drifting) until the returned stop is called.
 * Setup waits for idle time, drawing stops while the document is hidden or the
 * canvas is off screen, and the canvas is marked `data-ready` after its first
 * frame so the stylesheet can fade it in.
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
  let twoTone: TwoTonePicture | undefined;
  let scene: ReturnType<typeof createScene> | undefined;
  let shares = new Float32Array(0);
  let sceneRows = 0;
  let ripples: ReadonlyArray<Ripple> = [];
  let waves: CellWave[] = [];
  let blockColumns = 1;
  let frame: number | undefined;
  let nextFrame: ReturnType<typeof setTimeout> | undefined;
  let idle: number | undefined;
  let lastDrawn = 0;
  let begun = false;
  let stopped = false;
  let onScreen = true;
  let ink: readonly [number, number, number] = [128, 128, 128];
  let accent: readonly [number, number, number] = ink;
  let page: { readonly ink: number; readonly accent: number } = DARK_PAGE;
  const sample: SceneSample = { ink: 0, glow: 0 };
  const toned: Toned = { accent: false, alpha: 0 };

  // The ink and accent only move when the theme rewrites the root element,
  // which the observer below reports, so they are read then, not per frame.
  const readTheme = () => {
    const style = getComputedStyle(canvas);
    ink = parseColor(style.color) ?? [128, 128, 128];
    accent = parseColor(style.getPropertyValue("--octant-accent").trim()) ?? ink;
    const dark = isDarkPage(ink);
    page =
      source.scene === "ridges"
        ? dark
          ? RIDGES_DARK_PAGE
          : RIDGES_LIGHT_PAGE
        : dark
          ? DARK_PAGE
          : LIGHT_PAGE;
  };

  const fit = () => {
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(MAX_RATIO, displayPixelRatio());
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
    twoTone = picture !== undefined && source.twoTone === true ? toTwoTone(picture) : undefined;
    // A start screen that scrolls makes the canvas as tall as its content,
    // whose middle is out of sight. A scene is composed for what the window
    // shows, and the heading and the composer sit within that, so the scene
    // and its calm are measured against the window, not the page.
    const visibleHeight = Math.min(rows * cell, window.innerHeight || rows * cell);
    sceneRows = Math.max(1, Math.min(rows, Math.ceil(visibleHeight / cell)));
    // A ground that runs under the sidebar is composed for the start screen's
    // own stage, which begins where the sidebar ends.
    const stageStart = document
      .querySelector("main.workspace:not([hidden]) .welcome-stage")
      ?.getBoundingClientRect().left;
    const lead =
      stageStart === undefined
        ? 0
        : Math.max(0, Math.round((stageStart - canvas.getBoundingClientRect().left) / cell));
    scene =
      source.scene === undefined
        ? undefined
        : createScene(source.scene, columns, sceneRows, source.seed, lead);
    // A scene is calmed behind the start screen's content column, across its
    // full height; a colour picture keeps every cell.
    shares = new Float32Array(columns * rows);
    const contentColumn = readContentColumns(canvas, columns * cell);
    const sidebarColumn = readSidebarColumns(canvas);
    const floor = source.scene === "ridges" ? RIDGES_CALM_FLOOR : columnFloor(isDarkPage(ink));
    const calmed = scene !== undefined || twoTone !== undefined;
    for (let column = 0; column < columns; column += 1) {
      const x = (column + 0.5) * cell;
      const content = calmed ? columnShare(x, contentColumn, floor) : 1;
      const sidebar = calmed ? columnShare(x, sidebarColumn, CALM_FLOOR) : 1;
      for (let row = 0; row < rows; row += 1) {
        // Ridges keeps the content column's calm for the foot of the window only.
        const zone =
          source.scene === "ridges"
            ? smoothstep(RIDGES_COMPOSER_ZONE.from, RIDGES_COMPOSER_ZONE.to, row / sceneRows)
            : 1;
        shares[row * columns + column] = Math.min(1 - (1 - content) * zone, sidebar);
      }
    }
  };

  const draw = (now: number) => {
    if (pixels === undefined) return;
    const t = (now - started) / 1000;
    ripples = ripples.filter((ripple) => t - ripple.start <= WAVE_SECONDS);
    scene?.frame(t);
    const out = pixels.data;
    // The wave is smooth across a few pixels, so small cells share one
    // reading per block: at 2px cells a full-window wave measured about 40ms
    // a frame computed per cell, and about a quarter of that per 2×2 block.
    const stride = Math.max(1, Math.round(4 / cell));
    const darkPage = isDarkPage(ink);
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
        if (scene !== undefined || twoTone !== undefined) {
          const sourceColumn = Math.min(columns - 1, Math.max(0, Math.round(column - wave.dx)));
          const sourceRow = Math.min(rows - 1, Math.max(0, Math.round(row - wave.dy)));
          const calm = shares[row * columns + column] ?? 1;
          if (scene !== undefined) {
            if (sourceRow < sceneRows) scene.read(sourceColumn, sourceRow, sample);
            else {
              sample.ink = 0;
              sample.glow = 0;
            }
          } else if (twoTone !== undefined) {
            const index =
              Math.min(twoTone.rows - 1, sourceRow) * twoTone.columns +
              Math.min(twoTone.columns - 1, sourceColumn);
            const brightness = twoTone.light[index] ?? 0;
            // On a pale page the ink is dark, so the dark parts of the picture
            // take the ink and its bright, warm parts keep the glow.
            // A steeper curve leaves mid-tones empty, so a photo reads as its
            // shapes and not as a grey blanket; the pale page takes less ink.
            sample.ink = (darkPage ? brightness : 1 - brightness) ** 1.6 * (darkPage ? 0.8 : 0.45);
            sample.glow = twoTone.glow[index] ?? 0;
          }
          // The wave's light goes through the same print as the scene, so the
          // ring stays in cells rather than a soft blur.
          toneCell(
            sample.ink * calm,
            Math.max(sample.glow * calm, wave.glow * GLOW),
            levels,
            dithered,
            column,
            row,
            page,
            toned,
          );
          const color = toned.accent ? accent : ink;
          out[at] = color[0];
          out[at + 1] = color[1];
          out[at + 2] = color[2];
          out[at + 3] = Math.round(255 * toned.alpha);
          continue;
        }
        const sourceColumn = Math.min(
          (picture?.columns ?? 1) - 1,
          Math.max(0, Math.round(column - wave.dx)),
        );
        const sourceRow = Math.min(
          (picture?.rows ?? 1) - 1,
          Math.max(0, Math.round(row - wave.dy)),
        );
        const glow =
          wave.glow === 0 ? 0 : printLevel(wave.glow * GLOW * 0.6, levels, true, column, row);
        const from = (sourceRow * (picture?.columns ?? 1) + sourceColumn) * 4;
        for (let channel = 0; channel < 3; channel += 1) {
          const value = (picture?.rgba[from + channel] ?? 0) / 255;
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

  const halt = () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    if (nextFrame !== undefined) clearTimeout(nextFrame);
    frame = undefined;
    nextFrame = undefined;
  };

  // A timer waits out each frame interval and one animation frame draws, for
  // the reason given on the character field's tick: asking for a frame at
  // every vsync kept the compositor busy even when most of them drew nothing.
  const tick = (now: number) => {
    frame = undefined;
    if (document.hidden || !onScreen || stopped) return;
    lastDrawn = now;
    draw(now);
    scheduleNext();
  };
  const schedule = (intervalMs: number) => {
    if (frame !== undefined || stopped) return;
    if (nextFrame !== undefined) clearTimeout(nextFrame);
    nextFrame = setTimeout(
      () => {
        nextFrame = undefined;
        frame = requestAnimationFrame(tick);
      },
      Math.max(0, lastDrawn + intervalMs - performance.now()),
    );
  };
  // A scene keeps drifting and a wave runs at twice its pace; a picture has
  // nothing to move between waves, so it rests until the next click.
  const scheduleNext = () => {
    if (!begun || document.hidden || !onScreen) return;
    const waving = ripples.length > 0;
    if (!waving && picture !== undefined) return;
    schedule(waving ? WAVE_FRAME_MS : IDLE_FRAME_MS);
  };
  // A hidden window ends the loop above; it starts again on return.
  const visibility = () => {
    if (!document.hidden) scheduleNext();
    else halt();
  };

  // Clicks are read on the window, like the character field's, and kept only
  // when they land over the print.
  const wave = (event: PointerEvent) => {
    if (!begun || !acceptsRipple(event.target, ripplesWithin)) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return;
    const ripple = createRipple(x, y, (performance.now() - started) / 1000);
    // A heart is the character field's joke; the print keeps to rings.
    ripples = [...ripples, { ...ripple, heart: false }];
    // A click may land mid-way through an idle wait or while a picture
    // rests; the wave's first frame is due at its own, faster, cadence.
    halt();
    scheduleNext();
  };

  // Setup waits for idle time, so the first paint of the page is not delayed.
  const begin = () => {
    idle = undefined;
    begun = true;
    readTheme();
    fit();
    lastDrawn = performance.now();
    draw(lastDrawn);
    canvas.dataset["ready"] = "true";
    if (animated) scheduleNext();
  };
  const hasIdle = typeof window.requestIdleCallback === "function";
  if (hasIdle) idle = window.requestIdleCallback(begin, { timeout: 600 });
  else idle = window.setTimeout(begin, 1);
  if (animated) {
    window.addEventListener("pointerdown", wave, { passive: true });
    document.addEventListener("visibilitychange", visibility);
  }
  const refit = () => {
    if (!begun) return;
    fit();
    draw(performance.now());
  };
  const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(refit);
  observer?.observe(canvas);
  const screenObserver =
    typeof IntersectionObserver === "undefined"
      ? undefined
      : new IntersectionObserver((entries) => {
          const latest = entries[entries.length - 1];
          if (latest === undefined) return;
          onScreen = latest.isIntersecting;
          if (onScreen) scheduleNext();
          else halt();
        });
  screenObserver?.observe(canvas);
  const stopPixelRatio = watchDisplayPixelRatio(refit);
  // The ink and accent are copied into pixels, so a theme switch redraws.
  const themeObserver =
    typeof MutationObserver === "undefined"
      ? undefined
      : new MutationObserver(() => {
          if (!begun) return;
          readTheme();
          draw(performance.now());
        });
  themeObserver?.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["style", "class", "data-octant-theme-mode"],
  });
  return () => {
    stopped = true;
    halt();
    if (idle !== undefined) {
      if (hasIdle) window.cancelIdleCallback(idle);
      else window.clearTimeout(idle);
    }
    window.removeEventListener("pointerdown", wave);
    document.removeEventListener("visibilitychange", visibility);
    observer?.disconnect();
    screenObserver?.disconnect();
    stopPixelRatio();
    themeObserver?.disconnect();
    delete canvas.dataset["ready"];
  };
}
