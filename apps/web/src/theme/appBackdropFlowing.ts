import {
  deriveFlowingPalette,
  flowingPaletteRgb,
  mixFlowingPalettes,
  FLOWING_PALETTE_MIX_MS,
  type FlowingPalette,
  type FlowingPaletteMode,
} from "@octant/theme/flowing-background";
import { watchDisplayPixelRatio } from "./appBackdropPhoto";

/**
 * Flowing ground: a full-window colour field whose stops come from the theme
 * accent. The GPU path is one fragment shader at half resolution and thirty
 * frames a second; hosts without WebGL2 get a few blurred radial gradients
 * that use the same stops. Neither path answers the cursor.
 */

export const FLOWING_FRAME_MS = 1000 / 30;
/** CSS pixels per framebuffer pixel. Half keeps the wash soft and the GPU cheap. */
export const FLOWING_RESOLUTION_SCALE = 0.5;
/** A developed frame, so a still field does not look like time zero. */
const STILL_TIME = 12;

export const FLOWING_VERTEX_SHADER = `#version 300 es
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`;

/**
 * Domain-warped value-noise field, not a rotation or a slide: two warp
 * passes drift the sampling coordinates so the blobs morph in place like
 * ink in water. Four colour stops mix along a diagonal that the warp
 * bends. Grain and a vignette are part of the same pass.
 */
export const FLOWING_FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uDeep;
uniform vec3 uMid;
uniform vec3 uLight;
uniform vec3 uGlow;
out vec4 outColor;

vec2 hash2(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(hash2(i) * 2.0 - 1.0, f);
  float b = dot(hash2(i + vec2(1.0, 0.0)) * 2.0 - 1.0, f - vec2(1.0, 0.0));
  float c = dot(hash2(i + vec2(0.0, 1.0)) * 2.0 - 1.0, f - vec2(0.0, 1.0));
  float d = dot(hash2(i + vec2(1.0, 1.0)) * 2.0 - 1.0, f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 rot = mat2(0.80, 0.60, -0.60, 0.80);
  for (int i = 0; i < 4; i++) {
    v += a * valueNoise(p);
    p = rot * p * 1.95;
    a *= 0.5;
  }
  return v;
}

vec3 ramp(float amount) {
  float t = clamp(amount, 0.0, 1.0);
  if (t < 0.36) return mix(uDeep, uMid, smoothstep(0.0, 0.36, t));
  if (t < 0.66) return mix(uMid, uLight, smoothstep(0.36, 0.66, t));
  return mix(uLight, uGlow, smoothstep(0.66, 1.0, t));
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 p = vec2(uv.x * aspect, uv.y);
  float t = uTime * 0.022;

  vec2 q = vec2(
    fbm(p * 0.62 + vec2(0.0, t * 0.31)),
    fbm(p * 0.62 + vec2(5.2, 1.3) - vec2(t * 0.24, t * 0.16))
  );
  vec2 r = vec2(
    fbm(p * 0.48 + 2.4 * q + vec2(1.7, 9.2) + vec2(t * 0.13, -t * 0.1)),
    fbm(p * 0.48 + 2.4 * q + vec2(8.3, 2.8) - vec2(t * 0.11, t * 0.09))
  );
  float n = fbm(p * 0.42 + 2.1 * r);

  float diag = uv.x * 0.58 + uv.y * 0.76;
  float field = clamp(diag * 0.92 + n * 0.28 - 0.04, 0.0, 1.0);
  field = smoothstep(0.02, 0.98, field);

  vec3 col = ramp(field);
  float blob = smoothstep(0.72, 0.18, length((uv - vec2(0.88, 0.92)) * vec2(0.7, 1.0)));
  col = mix(col, uGlow, blob * 0.32);

  vec2 vigUv = (uv - 0.5) * vec2(1.12, 1.02);
  float vig = clamp(1.0 - 0.48 * dot(vigUv, vigUv), 0.0, 1.0);
  col = mix(uDeep, col, vig);

  float grain = hash2(gl_FragCoord.xy).x;
  col += (grain - 0.5) * 0.032;
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

const CSS_VARS = {
  deep: "--octant-flowing-deep",
  mid: "--octant-flowing-mid",
  light: "--octant-flowing-light",
  glow: "--octant-flowing-glow",
} as const;

export function applyFlowingPaletteCss(element: HTMLElement, palette: FlowingPalette): void {
  element.style.setProperty(CSS_VARS.deep, palette.deep);
  element.style.setProperty(CSS_VARS.mid, palette.mid);
  element.style.setProperty(CSS_VARS.light, palette.light);
  element.style.setProperty(CSS_VARS.glow, palette.glow);
}

function cssColorToHex(css: string): string | null {
  if (css.trim() === "") return null;
  const scratch = document.createElement("canvas");
  scratch.width = 1;
  scratch.height = 1;
  const context = scratch.getContext("2d");
  if (context === null) return null;
  context.fillStyle = css;
  context.fillRect(0, 0, 1, 1);
  const data = context.getImageData(0, 0, 1, 1).data;
  const hex = (channel: number) => channel.toString(16).padStart(2, "0");
  return `#${hex(data[0] ?? 0)}${hex(data[1] ?? 0)}${hex(data[2] ?? 0)}`;
}

function themeMode(): FlowingPaletteMode {
  return document.documentElement.getAttribute("data-octant-theme-mode") === "light"
    ? "light"
    : "dark";
}

function readAccentHex(element: HTMLElement): string {
  const css = getComputedStyle(element).getPropertyValue("--octant-accent").trim();
  return cssColorToHex(css) ?? "#5b9cf5";
}

function easeMix(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return clamped * clamped * (3 - 2 * clamped);
}

interface FlowingPainter {
  readonly draw: (time: number, palette: FlowingPalette) => void;
  readonly dispose: () => void;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (shader === null) throw new Error("shader allocation failed");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
    const log = gl.getShaderInfoLog(shader) ?? "";
    gl.deleteShader(shader);
    throw new Error(log);
  }
  return shader;
}

function createGlPainter(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext): FlowingPainter {
  let program: WebGLProgram | undefined;
  let vertexArray: WebGLVertexArrayObject | null = null;
  let lost = false;
  const u: Record<string, WebGLUniformLocation | null> = {};

  const build = () => {
    const vertex = compileShader(gl, gl.VERTEX_SHADER, FLOWING_VERTEX_SHADER);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FLOWING_FRAGMENT_SHADER);
    const next = gl.createProgram();
    if (next === null) throw new Error("WebGL program allocation failed");
    gl.attachShader(next, vertex);
    gl.attachShader(next, fragment);
    gl.linkProgram(next);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (gl.getProgramParameter(next, gl.LINK_STATUS) !== true) {
      gl.deleteProgram(next);
      throw new Error("Octant flowing ground shader did not link");
    }
    program = next;
    for (const name of ["uResolution", "uTime", "uDeep", "uMid", "uLight", "uGlow"]) {
      u[name] = gl.getUniformLocation(next, name);
    }
    vertexArray = gl.createVertexArray();
  };

  build();
  const onLost = (event: Event) => {
    event.preventDefault();
    lost = true;
  };
  const onRestored = () => {
    lost = false;
    build();
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  return {
    draw: (time, palette) => {
      if (lost || program === undefined) return;
      const rgb = flowingPaletteRgb(palette);
      gl.useProgram(program);
      gl.bindVertexArray(vertexArray);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(u["uResolution"] ?? null, canvas.width, canvas.height);
      gl.uniform1f(u["uTime"] ?? null, time);
      gl.uniform3f(u["uDeep"] ?? null, rgb.deep[0], rgb.deep[1], rgb.deep[2]);
      gl.uniform3f(u["uMid"] ?? null, rgb.mid[0], rgb.mid[1], rgb.mid[2]);
      gl.uniform3f(u["uLight"] ?? null, rgb.light[0], rgb.light[1], rgb.light[2]);
      gl.uniform3f(u["uGlow"] ?? null, rgb.glow[0], rgb.glow[1], rgb.glow[2]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose: () => {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      if (program !== undefined) gl.deleteProgram(program);
      if (vertexArray !== null) gl.deleteVertexArray(vertexArray);
      program = undefined;
    },
  };
}

function shadersCompile(gl: WebGL2RenderingContext): boolean {
  const vertex = gl.createShader(gl.VERTEX_SHADER);
  const fragment = gl.createShader(gl.FRAGMENT_SHADER);
  if (vertex === null || fragment === null) return false;
  gl.shaderSource(vertex, FLOWING_VERTEX_SHADER);
  gl.compileShader(vertex);
  gl.shaderSource(fragment, FLOWING_FRAGMENT_SHADER);
  gl.compileShader(fragment);
  const compiled =
    gl.getShaderParameter(vertex, gl.COMPILE_STATUS) === true &&
    gl.getShaderParameter(fragment, gl.COMPILE_STATUS) === true;
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  return compiled;
}

/**
 * Paints the flowing field into `canvas` (or the CSS fallback on `root` when
 * WebGL2 is missing). `animated` keeps it morphing; a still field draws one
 * frame and only runs again to follow an accent change.
 */
export function runFlowingField(
  canvas: HTMLCanvasElement,
  root: HTMLElement,
  animated: boolean,
): () => void {
  const attributes: WebGLContextAttributes = {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "low-power",
    preserveDrawingBuffer: false,
  };
  const probe = document.createElement("canvas").getContext("webgl2", attributes);
  let painter: FlowingPainter | undefined;
  if (probe !== null) {
    try {
      const compiled = shadersCompile(probe);
      probe.getExtension("WEBGL_lose_context")?.loseContext();
      if (compiled) {
        const gl = canvas.getContext("webgl2", attributes);
        if (gl !== null) painter = createGlPainter(canvas, gl);
      }
    } catch {
      painter = undefined;
    }
  }
  const engine = painter === undefined ? "css" : "webgl";
  root.dataset.engine = engine;

  let fromPalette = deriveFlowingPalette(readAccentHex(root), themeMode());
  let toPalette = fromPalette;
  let mixStarted = 0;
  let mixing = false;
  let visible = true;
  let frame: number | undefined;
  let nextFrame: ReturnType<typeof setTimeout> | undefined;
  let lastDrawn = 0;
  const started = performance.now();

  const currentPalette = (now: number): FlowingPalette => {
    if (!mixing) return toPalette;
    const t = easeMix((now - mixStarted) / FLOWING_PALETTE_MIX_MS);
    if (t >= 1) {
      mixing = false;
      fromPalette = toPalette;
      return toPalette;
    }
    return mixFlowingPalettes(fromPalette, toPalette, t);
  };

  const applyPalette = (palette: FlowingPalette) => {
    applyFlowingPaletteCss(root, palette);
  };

  const fieldTime = (now: number): number => (animated ? (now - started) / 1000 : STILL_TIME);

  const fit = () => {
    const rect = canvas.getBoundingClientRect();
    const scale = FLOWING_RESOLUTION_SCALE;
    canvas.width = Math.max(1, Math.round(rect.width * scale));
    canvas.height = Math.max(1, Math.round(rect.height * scale));
  };

  const draw = (now: number) => {
    const palette = currentPalette(now);
    applyPalette(palette);
    painter?.draw(fieldTime(now), palette);
  };

  const running = () => (animated || mixing) && visible && !document.hidden;

  const tick = (now: number) => {
    frame = undefined;
    if (!running()) return;
    lastDrawn = now;
    draw(now);
    schedule();
  };
  const schedule = () => {
    if (!running() || frame !== undefined || nextFrame !== undefined) return;
    nextFrame = setTimeout(
      () => {
        nextFrame = undefined;
        frame = requestAnimationFrame(tick);
      },
      Math.max(0, lastDrawn + FLOWING_FRAME_MS - performance.now()),
    );
  };
  const wake = () => {
    if (running()) schedule();
  };

  const readTheme = () => {
    const next = deriveFlowingPalette(readAccentHex(root), themeMode());
    if (
      next.deep === toPalette.deep &&
      next.mid === toPalette.mid &&
      next.light === toPalette.light &&
      next.glow === toPalette.glow
    ) {
      return;
    }
    fromPalette = currentPalette(performance.now());
    toPalette = next;
    mixStarted = performance.now();
    mixing = true;
    wake();
  };

  fit();
  applyPalette(toPalette);
  lastDrawn = performance.now();
  draw(lastDrawn);
  if (animated) schedule();

  const visibility = () => {
    if (!document.hidden) wake();
  };
  document.addEventListener("visibilitychange", visibility);

  const refit = () => {
    fit();
    draw(performance.now());
  };
  const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(refit);
  observer?.observe(root);
  const stopPixelRatio = watchDisplayPixelRatio(refit);

  const intersect =
    typeof IntersectionObserver === "undefined"
      ? undefined
      : new IntersectionObserver((entries) => {
          visible = entries.some((entry) => entry.isIntersecting);
          if (visible) wake();
        });
  intersect?.observe(root);

  const themeObserver =
    typeof MutationObserver === "undefined"
      ? undefined
      : new MutationObserver(() => {
          readTheme();
          if (!running()) draw(performance.now());
        });
  themeObserver?.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["style", "class", "data-octant-theme-mode"],
  });

  return () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    if (nextFrame !== undefined) clearTimeout(nextFrame);
    document.removeEventListener("visibilitychange", visibility);
    observer?.disconnect();
    stopPixelRatio();
    intersect?.disconnect();
    themeObserver?.disconnect();
    painter?.dispose();
  };
}
