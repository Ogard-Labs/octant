/**
 * The welcome screen's ambient ground: an ordered-dither cloud in the theme's
 * accent, drawn by the GPU at one cell per three CSS pixels and scaled up with
 * nearest-neighbour sampling so the cells stay crisp instead of blurring.
 *
 * Nothing here knows a theme. The ink is whatever the theme provider painted
 * into `--octant-accent`; the caller pushes a new ink when that changes, and
 * tells the loop to hold still when reduced motion asks for it.
 */
export type InkRgb = readonly [number, number, number];

export interface AppPatternOptions {
  readonly ink: InkRgb;
  readonly animated: boolean;
  /** A multiplier on the base drift: 1 is the default pace, 0 holds still. */
  readonly speed: number;
  /** 0..1: how much of the field the cloud fills at its densest. */
  readonly intensity: number;
}

export interface AppPatternHandle {
  readonly setInk: (ink: InkRgb) => void;
  readonly setAnimated: (animated: boolean) => void;
  readonly setSpeed: (speed: number) => void;
  readonly setIntensity: (intensity: number) => void;
  readonly stop: () => void;
}

/** One dither cell spans three CSS pixels: visibly a grid, never a haze. */
export const PATTERN_CELL_PX = 3;
/** The cloud drifts slowly; a full-rate loop would only warm the machine. */
const FRAME_INTERVAL_MS = 1000 / 24;
/** A tab hidden for an hour resumes where it left off, not an hour later. */
const MAX_STEP_MS = 250;

const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

// Value noise summed over four octaves gives the soft cloud; an 8x8 ordered
// threshold turns its density into cells that are either ink or nothing, so
// the ground reads as a printed halftone rather than a gradient. The cloud
// is densest along the top edge and gone by the lower third, where the
// composer and the recent-thread list need the plain page.
const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_intensity;
uniform vec3 u_ink;
out vec4 outColor;

float hash21(vec2 p) {
  p = fract(p * vec2(0.1031, 0.1030));
  p += dot(p, p.yx + 33.33);
  return fract((p.x + p.y) * p.x);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float cloud(vec2 p, float t) {
  float v = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    v += amp * valueNoise(p + vec2(t * 0.11, -t * 0.07));
    p = p * 2.03 + vec2(1.7, 9.2);
    amp *= 0.5;
  }
  return v;
}

float bayer8(ivec2 c) {
  int x = c.x ^ c.y;
  int y = c.y;
  int v = ((x & 1) << 5) | ((y & 1) << 4) | ((x & 2) << 2) | ((y & 2) << 1) | ((x & 4) >> 1) | ((y & 4) >> 2);
  return (float(v) + 0.5) / 64.0;
}

void main() {
  vec2 px = gl_FragCoord.xy;
  vec2 uv = px / u_resolution.y;
  float n = cloud(uv * 1.25, u_time);
  float height = px.y / u_resolution.y;
  // u_intensity caps the fill: below one the cloud always shows the grid, so
  // it reads as print rather than as a lit panel.
  float density = u_intensity * smoothstep(0.4, 0.95, n) * smoothstep(0.16, 0.8, height);
  float on = step(bayer8(ivec2(px)), density);
  outColor = vec4(u_ink * on, on);
}
`;

interface PatternProgram {
  readonly program: WebGLProgram;
  readonly buffer: WebGLBuffer;
  readonly resolution: WebGLUniformLocation | null;
  readonly time: WebGLUniformLocation | null;
  readonly intensity: WebGLUniformLocation | null;
  readonly ink: WebGLUniformLocation | null;
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (shader === null) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function buildProgram(gl: WebGL2RenderingContext): PatternProgram | null {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (vertex === null || fragment === null || program === null) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  const buffer = gl.createBuffer();
  if (buffer === null) {
    gl.deleteProgram(program);
    return null;
  }
  // One triangle that covers clip space; the fragment shader does the rest.
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "a_position");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  gl.useProgram(program);
  return {
    program,
    buffer,
    resolution: gl.getUniformLocation(program, "u_resolution"),
    time: gl.getUniformLocation(program, "u_time"),
    intensity: gl.getUniformLocation(program, "u_intensity"),
    ink: gl.getUniformLocation(program, "u_ink"),
  };
}

/**
 * Starts drawing into `canvas`. Returns null when the browser has no WebGL2
 * for it, which the caller treats as "no pattern", not as an error: the
 * welcome still works on the plain ground.
 */
export function startAppPattern(
  canvas: HTMLCanvasElement,
  options: AppPatternOptions,
): AppPatternHandle | null {
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: true,
  });
  if (gl === null) return null;
  let resources = buildProgram(gl);
  if (resources === null) return null;

  let ink = options.ink;
  let animated = options.animated;
  let speed = Math.max(0, options.speed);
  let intensity = Math.min(1, Math.max(0, options.intensity));
  let stopped = false;
  let lost = false;
  let visible = typeof document === "undefined" ? true : !document.hidden;
  let onScreen = true;
  let elapsedMs = 0;
  let lastTick: number | null = null;
  let lastDraw = Number.NEGATIVE_INFINITY;
  let frameRequest = 0;

  const fit = () => {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.ceil(rect.width / PATTERN_CELL_PX));
    const height = Math.max(1, Math.ceil(rect.height / PATTERN_CELL_PX));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
  };

  const draw = () => {
    if (stopped || lost || resources === null) return;
    fit();
    gl.uniform2f(resources.resolution, canvas.width, canvas.height);
    gl.uniform1f(resources.time, elapsedMs / 1000);
    gl.uniform1f(resources.intensity, intensity);
    gl.uniform3f(resources.ink, ink[0], ink[1], ink[2]);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  const running = () => animated && speed > 0 && visible && onScreen && !stopped && !lost;

  const frame = (now: number) => {
    frameRequest = 0;
    if (!running()) {
      lastTick = null;
      return;
    }
    frameRequest = requestAnimationFrame(frame);
    if (now - lastDraw < FRAME_INTERVAL_MS) return;
    if (lastTick !== null) elapsedMs += Math.min(now - lastTick, MAX_STEP_MS) * speed;
    lastTick = now;
    lastDraw = now;
    draw();
  };

  // A still ground draws once; a moving one draws on the frame clock.
  const schedule = () => {
    if (stopped || lost) return;
    if (running()) {
      if (frameRequest === 0) frameRequest = requestAnimationFrame(frame);
      return;
    }
    draw();
  };

  const onVisibility = () => {
    visible = !document.hidden;
    if (visible) schedule();
  };
  const onContextLost = (event: Event) => {
    event.preventDefault();
    lost = true;
    resources = null;
  };
  const onContextRestored = () => {
    resources = buildProgram(gl);
    lost = resources === null;
    schedule();
  };

  document.addEventListener("visibilitychange", onVisibility);
  canvas.addEventListener("webglcontextlost", onContextLost);
  canvas.addEventListener("webglcontextrestored", onContextRestored);

  const resizeObserver =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
          if (!running()) draw();
        });
  resizeObserver?.observe(canvas);
  // A pane hidden behind another window's tab has no reason to keep drawing.
  const intersectionObserver =
    typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver((entries) => {
          onScreen = entries.some((entry) => entry.isIntersecting);
          if (onScreen) schedule();
        });
  intersectionObserver?.observe(canvas);

  schedule();

  return {
    setInk(next) {
      ink = next;
      if (!running()) draw();
    },
    setAnimated(next) {
      animated = next;
      schedule();
    },
    setSpeed(next) {
      speed = Math.max(0, next);
      schedule();
    },
    setIntensity(next) {
      intensity = Math.min(1, Math.max(0, next));
      if (!running()) draw();
    },
    stop() {
      stopped = true;
      if (frameRequest !== 0) cancelAnimationFrame(frameRequest);
      frameRequest = 0;
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      if (resources !== null) {
        gl.deleteBuffer(resources.buffer);
        gl.deleteProgram(resources.program);
        resources = null;
      }
      // The context itself is left to the canvas: releasing it here made the
      // next start on the same element (React remounts the effect in
      // development) find a dead context and give up on the pattern.
    },
  };
}
