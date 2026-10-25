import { displayPixelRatio, watchDisplayPixelRatio } from "./appBackdropPhoto";

/**
 * The character ground: a grid of monospace letters and digits whose
 * brightness rolls through slow overlapping waves and breathes as a whole,
 * while a few cells swap their glyph each frame. A click sends an uneven,
 * wobbling ring out across the field from where it landed, now and then a heart. The field is drawn in the
 * canvas's own CSS colour and the ring in the theme's accent, so both follow
 * the theme without knowing it.
 *
 * The field paints through one of two painters behind `CharacterFieldPainter`:
 * a WebGL2 painter that computes brightness, ripples, and glyph coverage in a
 * fragment shader at twenty-four frames a second, and the original 2D painter
 * that batches `fillText` calls by alpha at twelve — kept for hosts without
 * WebGL2 and for tests, since it measured ~0.36 µs per cell on the CPU
 * (10–16 ms a frame at 2560-class windows).
 */

const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Cell size in CSS pixels; about the reference 11px mono line. */
const CELL_WIDTH = 8;
const CELL_HEIGHT = 13;
const FONT_SIZE = 11;

/**
 * Twelve frames a second is enough for a slow pulse and keeps the 2D
 * painter's full-window pass of ~15k fillText calls well under a frame's
 * budget. The GPU painter shades every cell in one draw call, so it can
 * afford twenty-four.
 */
const FRAME_MS_2D = 1000 / 12;
const FRAME_MS_GL = 1000 / 24;

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
/** The shader walks at most this many live ripples per frame. */
const MAX_RIPPLES = 8;

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

/** One frame's painting; the lifecycle above it is identical either way. */
interface CharacterFieldPainter {
  /** The pace the scheduler keeps while animated. */
  readonly frameMs: number;
  fit(columns: number, rows: number, ratio: number): void;
  theme(font: string, ink: string, accent: string): void;
  draw(t: number, field: CharacterField, ripples: ReadonlyArray<Ripple>): void;
  dispose(): void;
}

/**
 * The original painter: a 2D context that groups cells by colour and alpha
 * step so the fill changes sixteen times a frame, not once per glyph.
 */
function createCanvas2dPainter(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
): CharacterFieldPainter {
  /** Brightness is drawn in this many alpha steps so cells batch by alpha. */
  const ALPHA_STEPS = 8;
  let font = "";
  let ink = "";
  let accent = "";
  return {
    frameMs: FRAME_MS_2D,
    fit: (_columns, _rows, ratio) => {
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    },
    theme: (nextFont, nextInk, nextAccent) => {
      font = nextFont;
      ink = nextInk;
      accent = nextAccent;
    },
    draw: (t, field, ripples) => {
      const { columns, rows, glyphs, phase } = field;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.font = `${String(FONT_SIZE)}px ${font === "" ? "ui-monospace, monospace" : font}`;
      context.textBaseline = "top";
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
    },
    dispose: () => undefined,
  };
}

const GROUND_VERTEX_SHADER = `#version 300 es
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`;

/**
 * Exact ports of cellBrightness/edgeReach/rippleBrightness, run once per
 * cell's centre like the 2D painter. Brightness is continuous here rather
 * than rounded to eight steps — the steps only existed to batch fillText
 * calls by alpha, which one draw call no longer needs.
 */
const GROUND_FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform vec2 uCell;
uniform vec2 uCellCss;
uniform vec2 uGrid;
uniform float uTime;
uniform vec3 uInk;
uniform vec3 uAccent;
uniform sampler2D uField;
uniform sampler2D uAtlas;
uniform vec2 uAtlasSize;
uniform float uAtlasStride;
uniform int uRippleCount;
uniform vec4 uRipples[${MAX_RIPPLES}];
uniform vec2 uRippleShape[${MAX_RIPPLES}];
out vec4 outColor;

float cellBrightness(float column, float row, float phase, float t) {
  float waves = sin(column * 0.09 + t * 0.35)
    + sin(row * 0.16 - t * 0.27)
    + sin((column + row) * 0.05 + t * 0.5);
  float patches = max(0.0, waves / 3.0);
  float breath = 0.65 + 0.35 * sin(t * 0.9);
  float flicker = 0.75 + 0.25 * sin(t * 2.3 + phase);
  return min(1.0, pow(patches, 1.4) * breath * flicker * 1.5);
}

float edgeReach(vec4 ripple, vec2 shape, float angle, float t) {
  if (shape.y > 0.5) {
    float up = -sin(angle);
    float across = cos(angle);
    return (2.0 - 2.0 * up + (up * sqrt(abs(across))) / (up + 1.4)) / 2.2;
  }
  return 1.0
    + shape.x * (0.6 * sin(3.0 * angle + ripple.w + t * 1.7)
      + 0.4 * sin(5.0 * angle - ripple.w * 1.3 - t * 2.3));
}

float rippleBrightness(vec4 ripple, vec2 shape, vec2 point, float t) {
  float angle = atan(point.y - ripple.y, point.x - ripple.x);
  float distance = length(point - ripple.xy);
  float band = ${RIPPLE_BAND.toFixed(1)} * (0.8 + 0.4 * sin(angle * 4.0 + ripple.w));
  float lit = 0.0;
  for (int echo = 0; echo < 2; echo += 1) {
    float delay = echo == 0 ? 0.0 : ${ECHO_DELAY.toFixed(2)};
    float gain = echo == 0 ? 1.0 : ${ECHO_GAIN.toFixed(2)};
    float age = t - ripple.z - delay;
    if (age >= 0.0 && age <= ${RIPPLE_SECONDS.toFixed(1)}) {
      float fromEdge = abs(distance - age * ${RIPPLE_SPEED.toFixed(1)} * edgeReach(ripple, shape, angle, t));
      if (fromEdge < band)
        lit = max(lit, gain * (1.0 - fromEdge / band) * (1.0 - age / ${RIPPLE_SECONDS.toFixed(1)}));
    }
  }
  return lit;
}

void main() {
  vec2 fc = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y);
  vec2 cell = floor(fc / uCell);
  if (cell.x < 0.0 || cell.y < 0.0 || cell.x >= uGrid.x || cell.y >= uGrid.y) discard;
  vec2 packed = texelFetch(uField, ivec2(cell), 0).rg;
  float glyph = floor(packed.r * 255.0 + 0.5);
  float phase = packed.g * 6.283185307179586;
  float brightness = cellBrightness(cell.x, cell.y, phase, uTime);
  float lit = 0.0;
  vec2 centre = (cell + 0.5) * uCellCss;
  for (int i = 0; i < uRippleCount; i += 1) {
    lit = max(lit, rippleBrightness(uRipples[i], uRippleShape[i], centre, uTime));
  }
  bool ringed = lit > brightness;
  // FragCoord centres are integers + 0.5, so local is too and the LINEAR
  // sample lands on atlas texel centres: the one-pixel pad never bleeds.
  vec2 local = mod(fc, uCell);
  vec2 atlasPixel = vec2(glyph * uAtlasStride + 1.0, 1.0) + local;
  float coverage = texture(uAtlas, atlasPixel / uAtlasSize).a;
  float alpha = coverage * (ringed ? lit : brightness) * (ringed ? ${RING_MAX_ALPHA.toFixed(2)} : ${MAX_ALPHA.toFixed(2)});
  vec3 colour = ringed ? uAccent : uInk;
  outColor = vec4(colour * alpha, alpha);
}
`;

type Rgb = readonly [number, number, number];

/** Resolves any CSS colour Chrome accepts (oklch included) to 0–1 RGB. */
function resolveCanvasColour(css: string): Rgb {
  const scratch = document.createElement("canvas");
  scratch.width = 1;
  scratch.height = 1;
  const context = scratch.getContext("2d");
  if (context === null) return [0, 0, 0];
  context.fillStyle = css;
  context.fillRect(0, 0, 1, 1);
  const data = context.getImageData(0, 0, 1, 1).data;
  return [(data[0] ?? 0) / 255, (data[1] ?? 0) / 255, (data[2] ?? 0) / 255];
}

/**
 * The GPU painter: one full-screen triangle whose fragment shader does all
 * the per-cell work. Glyphs and phases live in an RG8 texture the size of the
 * grid; the glyph atlas is a scratch-2D render of all 62 glyphs at the
 * display's pixel density, one pad pixel around each cell so LINEAR sampling
 * never bleeds a neighbour.
 */
function createGlPainter(
  canvas: HTMLCanvasElement,
  gl: WebGL2RenderingContext,
  animated: boolean,
  redraw: () => void,
): CharacterFieldPainter {
  let program: WebGLProgram | undefined;
  let vertexArray: WebGLVertexArrayObject | null = null;
  let fieldTexture: WebGLTexture | null = null;
  let atlasTexture: WebGLTexture | null = null;
  let fieldData: Uint8Array | undefined;
  let fieldUploaded = false;
  let atlasDirty = true;
  let lost = false;
  let columns = 0;
  let rows = 0;
  let ratio = 1;
  let font = "";
  let inkText = "";
  let accentText = "";
  let ink: Rgb = [0, 0, 0];
  let accent: Rgb = [0, 0, 0];
  const u: Record<string, WebGLUniformLocation | null> = {};
  const uniformRipples = new Float32Array(MAX_RIPPLES * 4);
  const uniformRippleShape = new Float32Array(MAX_RIPPLES * 2);

  const compile = (type: number, source: string): WebGLShader => {
    const shader = gl.createShader(type);
    if (shader === null) throw new Error("WebGL shader allocation failed");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) ?? "";
      gl.deleteShader(shader);
      throw new Error(`Octant ground shader did not compile: ${log}`);
    }
    return shader;
  };

  const build = () => {
    const vertex = compile(gl.VERTEX_SHADER, GROUND_VERTEX_SHADER);
    const fragment = compile(gl.FRAGMENT_SHADER, GROUND_FRAGMENT_SHADER);
    const next = gl.createProgram();
    if (next === null) throw new Error("WebGL program allocation failed");
    gl.attachShader(next, vertex);
    gl.attachShader(next, fragment);
    gl.linkProgram(next);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(next, gl.LINK_STATUS)) {
      gl.deleteProgram(next);
      throw new Error("Octant ground shader did not link");
    }
    program = next;
    for (const name of [
      "uResolution",
      "uCell",
      "uCellCss",
      "uGrid",
      "uTime",
      "uInk",
      "uAccent",
      "uField",
      "uAtlas",
      "uAtlasSize",
      "uAtlasStride",
      "uRippleCount",
      "uRipples",
      "uRippleShape",
    ]) {
      u[name] = gl.getUniformLocation(next, name);
    }
    vertexArray = gl.createVertexArray();
    fieldTexture = gl.createTexture();
    atlasTexture = gl.createTexture();
    for (const texture of [fieldTexture, atlasTexture]) {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
  };

  const renderAtlas = () => {
    const cellW = CELL_WIDTH * ratio;
    const cellH = CELL_HEIGHT * ratio;
    // One pad pixel around each cell so LINEAR sampling at a cell's edge
    // never mixes in the next glyph.
    const stride = cellW + 2;
    const atlas = document.createElement("canvas");
    atlas.width = Math.ceil(GLYPHS.length * stride);
    atlas.height = Math.ceil(cellH + 2);
    const context = atlas.getContext("2d");
    if (context === null) return;
    context.font = `${String(FONT_SIZE * ratio)}px ${
      font === "" ? "ui-monospace, monospace" : font
    }`;
    context.textBaseline = "top";
    context.fillStyle = "#ffffff";
    for (let glyph = 0; glyph < GLYPHS.length; glyph += 1) {
      context.fillText(GLYPHS[glyph] ?? "0", glyph * stride + 1, 1);
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, atlasTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
    atlasDirty = false;
  };

  const applyFit = (nextColumns: number, nextRows: number, nextRatio: number) => {
    columns = nextColumns;
    rows = nextRows;
    ratio = nextRatio;
    fieldData = new Uint8Array(columns * rows * 2);
    fieldUploaded = false;
    atlasDirty = true;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, fieldTexture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RG8,
      Math.max(1, columns),
      Math.max(1, rows),
      0,
      gl.RG,
      gl.UNSIGNED_BYTE,
      null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  };

  const applyTheme = (nextFont: string, nextInk: string, nextAccent: string) => {
    font = nextFont;
    inkText = nextInk;
    accentText = nextAccent;
    ink = resolveCanvasColour(inkText === "" ? "#000000" : inkText);
    accent = accentText === "" ? ink : resolveCanvasColour(accentText);
    atlasDirty = true;
  };

  build();
  const onLost = (event: Event) => {
    event.preventDefault();
    lost = true;
  };
  const onRestored = () => {
    lost = false;
    build();
    applyFit(columns, rows, ratio);
    applyTheme(font, inkText, accentText);
    redraw();
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  return {
    frameMs: FRAME_MS_GL,
    fit: (nextColumns, nextRows, nextRatio) => {
      applyFit(nextColumns, nextRows, nextRatio);
    },
    theme: (nextFont, nextInk, nextAccent) => {
      applyTheme(nextFont, nextInk, nextAccent);
    },
    draw: (t, field, ripples) => {
      if (lost || program === undefined) return;
      gl.useProgram(program);
      gl.bindVertexArray(vertexArray);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(u["uResolution"] ?? null, canvas.width, canvas.height);
      gl.uniform2f(u["uCell"] ?? null, CELL_WIDTH * ratio, CELL_HEIGHT * ratio);
      gl.uniform2f(u["uCellCss"] ?? null, CELL_WIDTH, CELL_HEIGHT);
      gl.uniform2f(u["uGrid"] ?? null, field.columns, field.rows);
      gl.uniform1f(u["uTime"] ?? null, t);
      gl.uniform3f(u["uInk"] ?? null, ink[0], ink[1], ink[2]);
      gl.uniform3f(u["uAccent"] ?? null, accent[0], accent[1], accent[2]);
      if (atlasDirty) renderAtlas();
      // Glyph swaps are the field's only per-frame change, so the RG8 grid
      // goes up once per animated frame (and once ever for a still field).
      if (!fieldUploaded || animated) {
        const data = fieldData;
        if (data !== undefined && data.length === field.columns * field.rows * 2) {
          for (let index = 0; index < field.columns * field.rows; index += 1) {
            data[index * 2] = field.glyphs[index] ?? 0;
            data[index * 2 + 1] = Math.round(((field.phase[index] ?? 0) / (Math.PI * 2)) * 255);
          }
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, fieldTexture);
          gl.texSubImage2D(
            gl.TEXTURE_2D,
            0,
            0,
            0,
            field.columns,
            field.rows,
            gl.RG,
            gl.UNSIGNED_BYTE,
            data,
          );
          fieldUploaded = true;
        }
      }
      // More than eight live ripples keeps the newest: the oldest are the
      // ones about to fade, and a fresh click should always show.
      const shown = ripples.slice(-MAX_RIPPLES);
      uniformRipples.fill(0);
      uniformRippleShape.fill(0);
      for (let i = 0; i < shown.length; i += 1) {
        const ripple = shown[i];
        if (ripple === undefined) continue;
        uniformRipples[i * 4] = ripple.x;
        uniformRipples[i * 4 + 1] = ripple.y;
        uniformRipples[i * 4 + 2] = ripple.start;
        uniformRipples[i * 4 + 3] = ripple.seed;
        uniformRippleShape[i * 2] = ripple.wobble;
        uniformRippleShape[i * 2 + 1] = ripple.heart ? 1 : 0;
      }
      gl.uniform4fv(u["uRipples"] ?? null, uniformRipples);
      gl.uniform2fv(u["uRippleShape"] ?? null, uniformRippleShape);
      gl.uniform1i(u["uRippleCount"] ?? null, shown.length);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, fieldTexture);
      gl.uniform1i(u["uField"] ?? null, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, atlasTexture);
      gl.uniform1i(u["uAtlas"] ?? null, 1);
      gl.uniform2f(
        u["uAtlasSize"] ?? null,
        GLYPHS.length * (CELL_WIDTH * ratio + 2),
        CELL_HEIGHT * ratio + 2,
      );
      gl.uniform1f(u["uAtlasStride"] ?? null, CELL_WIDTH * ratio + 2);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose: () => {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      if (program !== undefined) gl.deleteProgram(program);
      if (vertexArray !== null) gl.deleteVertexArray(vertexArray);
      if (fieldTexture !== null) gl.deleteTexture(fieldTexture);
      if (atlasTexture !== null) gl.deleteTexture(atlasTexture);
      program = undefined;
    },
  };
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
  const attributes: WebGLContextAttributes = {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "low-power",
  };
  // A canvas that answers getContext("webgl2") can never serve a 2D context
  // again, so the shaders get a scratch-compile first: a driver that refuses
  // them must not leave the field unpaintable.
  const probe = document.createElement("canvas").getContext("webgl2", attributes);
  let painter: CharacterFieldPainter | undefined;
  if (probe !== null) {
    try {
      const vertex = probe.createShader(probe.VERTEX_SHADER);
      const fragment = probe.createShader(probe.FRAGMENT_SHADER);
      if (vertex === null || fragment === null) throw new Error("shader allocation failed");
      probe.shaderSource(vertex, GROUND_VERTEX_SHADER);
      probe.compileShader(vertex);
      probe.shaderSource(fragment, GROUND_FRAGMENT_SHADER);
      probe.compileShader(fragment);
      let compiled = false;
      if (
        probe.getShaderParameter(vertex, probe.COMPILE_STATUS) === true &&
        probe.getShaderParameter(fragment, probe.COMPILE_STATUS) === true
      ) {
        compiled = true;
      }
      probe.deleteShader(vertex);
      probe.deleteShader(fragment);
      probe.getExtension("WEBGL_lose_context")?.loseContext();
      if (compiled) {
        const gl = canvas.getContext("webgl2", attributes);
        if (gl !== null)
          painter = createGlPainter(canvas, gl, animated, () => draw(performance.now()));
      }
    } catch {
      painter = undefined;
    }
  }
  if (painter === undefined) {
    const context = canvas.getContext("2d");
    if (context === null) return () => undefined;
    painter = createCanvas2dPainter(canvas, context);
  }
  let field = createCharacterField(0, 0);
  let frame: number | undefined;
  let nextFrame: ReturnType<typeof setTimeout> | undefined;
  let lastDrawn = 0;
  let ripples: ReadonlyArray<Ripple> = [];
  let font = "";
  let ink = "";
  let accent = "";
  const started = performance.now();

  // The ink, accent, and mono font are copied into pixels; they only move
  // when the theme rewrites the root element, which the observer below
  // reports, so they are read then rather than twice per frame.
  const readTheme = () => {
    const style = getComputedStyle(canvas);
    font = style.getPropertyValue("--oct-font-mono").trim();
    ink = style.color;
    accent = style.getPropertyValue("--octant-accent").trim();
    painter.theme(font, ink, accent);
  };

  const fit = () => {
    const rect = canvas.getBoundingClientRect();
    const ratio = displayPixelRatio();
    canvas.width = Math.max(1, Math.round(rect.width * ratio));
    canvas.height = Math.max(1, Math.round(rect.height * ratio));
    const columns = Math.ceil(rect.width / CELL_WIDTH);
    const rows = Math.ceil(rect.height / CELL_HEIGHT);
    if (columns !== field.columns || rows !== field.rows) {
      field = createCharacterField(columns, rows);
    }
    painter.fit(columns, rows, ratio);
  };

  const draw = (now: number) => {
    const t = (now - started) / 1000;
    ripples = ripples.filter((ripple) => t - ripple.start <= RIPPLE_SECONDS + ECHO_DELAY);
    if (animated) {
      const swaps = Math.ceil(field.glyphs.length * SWAP_SHARE);
      for (let swap = 0; swap < swaps; swap += 1) {
        field.glyphs[Math.floor(Math.random() * field.glyphs.length)] = Math.floor(
          Math.random() * GLYPHS.length,
        );
      }
    }
    painter.draw(t, field, ripples);
  };

  // One frame is asked for only when the painter's pace is due, and a timer
  // waits out the rest. Asking for a frame at every vsync and returning early
  // from nine in ten (at 120 Hz) still kept the compositor producing frames
  // behind a transcript: a bare 120 Hz requestAnimationFrame loop measured
  // about +1.5% of a renderer core on its own, and pacing the draws this way
  // measured about two points of a renderer core less behind a transcript.
  // The draw itself stays on an animation frame so it lands with the paint.
  const tick = (now: number) => {
    frame = undefined;
    if (document.hidden) return;
    lastDrawn = now;
    draw(now);
    schedule();
  };
  const schedule = () => {
    if (frame !== undefined || nextFrame !== undefined) return;
    nextFrame = setTimeout(
      () => {
        nextFrame = undefined;
        frame = requestAnimationFrame(tick);
      },
      Math.max(0, lastDrawn + painter.frameMs - performance.now()),
    );
  };
  // A hidden window ends the loop above; it starts again on return.
  const visibility = () => {
    if (!document.hidden) schedule();
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
  readTheme();
  lastDrawn = performance.now();
  draw(lastDrawn);
  if (animated) {
    schedule();
    window.addEventListener("pointerdown", ripple, { passive: true });
    document.addEventListener("visibilitychange", visibility);
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
  // A theme switch rewrites the colours on the root element; a still field
  // has no next frame to pick that up.
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
    window.removeEventListener("pointerdown", ripple);
    document.removeEventListener("visibilitychange", visibility);
    observer?.disconnect();
    stopPixelRatio();
    themeObserver?.disconnect();
    painter.dispose();
  };
}
