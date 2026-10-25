import { afterEach, describe, expect, it, vi } from "vitest";
import { createRipple, rippleBrightness, runCharacterField } from "./appBackdropCharacters";

/** A stand-in compositor: frames are requested here and delivered at the
 * next simulated vsync, as a browser would. */
function fakeVsync() {
  const pendingFrames = new Map<number, FrameRequestCallback>();
  let framesRequested = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    framesRequested += 1;
    pendingFrames.set(framesRequested, callback);
    return framesRequested;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    pendingFrames.delete(id);
  });
  const runSecondAt125Hz = () => {
    for (let vsync = 0; vsync < 125; vsync += 1) {
      vi.advanceTimersByTime(8);
      const due = [...pendingFrames.values()];
      pendingFrames.clear();
      for (const callback of due) callback(performance.now());
    }
  };
  return { pendingFrames, runSecondAt125Hz, requested: () => framesRequested };
}

/** The smallest 2D context the fallback painter touches. */
function fake2dContext() {
  const fills = { fillText: vi.fn(), clearRect: vi.fn() };
  const context: Partial<CanvasRenderingContext2D> = {
    setTransform: vi.fn(),
    clearRect: fills.clearRect,
    fillText: fills.fillText,
    fillRect: vi.fn(),
    drawImage: vi.fn(),
    getImageData: vi.fn().mockReturnValue({ data: new Uint8ClampedArray(4) }),
  };
  return { context, fills };
}

/** A thin recording stand-in for the calls the GPU painter makes. */
function fakeWebGl2() {
  const calls = {
    drawArrays: vi.fn(),
    texSubImage2D: vi.fn(),
    uniform1f: vi.fn(),
    uniform1i: vi.fn(),
    uniform4fv: vi.fn(),
    unpackErrors: [] as Array<number>,
  };
  // GL defaults to four-byte unpack rows; the painter may relax it.
  let unpackAlignment = 4;
  const uniformNames = new Map<WebGLUniformLocation, string>();
  const gl: Partial<WebGL2RenderingContext> = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    TEXTURE_2D: 0x0de1,
    TEXTURE0: 0x84c0,
    TEXTURE1: 0x84c1,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    LINEAR: 0x2601,
    NEAREST: 0x2600,
    CLAMP_TO_EDGE: 0x812f,
    RGBA: 0x1908,
    RG8: 0x822b,
    RG: 0x8227,
    UNPACK_ALIGNMENT: 0x0cf5,
    UNSIGNED_BYTE: 0x1401,
    COLOR_BUFFER_BIT: 0x4000,
    TRIANGLES: 0x0004,
    createShader: vi.fn().mockReturnValue({}),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn().mockReturnValue(true),
    getShaderInfoLog: vi.fn().mockReturnValue(""),
    deleteShader: vi.fn(),
    createProgram: vi.fn().mockReturnValue({}),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn().mockReturnValue(true),
    getProgramInfoLog: vi.fn().mockReturnValue(""),
    deleteProgram: vi.fn(),
    getExtension: vi.fn().mockReturnValue(null),
    useProgram: vi.fn(),
    getUniformLocation: vi.fn().mockImplementation((_program, name: string) => {
      const location = { name } as WebGLUniformLocation;
      uniformNames.set(location, name);
      return location;
    }),
    createVertexArray: vi.fn().mockReturnValue({}),
    bindVertexArray: vi.fn(),
    deleteVertexArray: vi.fn(),
    createTexture: vi.fn().mockReturnValue({}),
    bindTexture: vi.fn(),
    activeTexture: vi.fn(),
    texParameteri: vi.fn(),
    texImage2D: vi.fn(),
    texSubImage2D: vi.fn().mockImplementation((...args: Array<unknown>) => {
      calls.texSubImage2D(...args);
      // The GL reads each row on the current unpack alignment: an RG8
      // grid row is width*2 bytes, so the data must cover the padded
      // stride for every row but the last or the upload fails.
      const width = args[4] as number;
      const height = args[5] as number;
      const data = args[8] as { readonly length: number } | null;
      const rowBytes = width * 2;
      const need =
        Math.ceil(rowBytes / unpackAlignment) * unpackAlignment * (height - 1) + rowBytes;
      if (data !== null && data.length < need) calls.unpackErrors.push(need - data.length);
    }),
    pixelStorei: vi.fn().mockImplementation((pname: number, param: number) => {
      if (pname === 0x0cf5) unpackAlignment = param;
    }),
    deleteTexture: vi.fn(),
    viewport: vi.fn(),
    clearColor: vi.fn(),
    clear: vi.fn(),
    drawArrays: calls.drawArrays,
    uniform1f: calls.uniform1f,
    uniform1i: calls.uniform1i,
    uniform2f: vi.fn(),
    uniform3f: vi.fn(),
    uniform4f: vi.fn(),
    uniform2fv: vi.fn(),
    uniform4fv: calls.uniform4fv,
  };
  return { gl, calls, uniformNames };
}

function sizedCanvas(width = 160, height = 104) {
  const canvas = document.createElement("canvas");
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    width,
    height,
    right: width,
    bottom: height,
    toJSON: () => ({}),
  } as DOMRect);
  document.body.append(canvas);
  return canvas;
}

describe("character ground frame pacing", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("asks for an animation frame about twelve times a second, not at every vsync, and leaves nothing pending once stopped", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const { context, fills } = fake2dContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((id) =>
      id === "2d" ? (context as CanvasRenderingContext2D) : null,
    );
    const { pendingFrames, runSecondAt125Hz, requested } = fakeVsync();
    const canvas = sizedCanvas();

    const stop = runCharacterField(canvas, true);
    const drawsBefore = fills.clearRect.mock.calls.length;
    runSecondAt125Hz();
    const drawsInOneSecond = fills.clearRect.mock.calls.length - drawsBefore;
    expect(drawsInOneSecond).toBeGreaterThanOrEqual(10);
    expect(drawsInOneSecond).toBeLessThanOrEqual(13);
    expect(requested()).toBeGreaterThanOrEqual(10);
    expect(requested()).toBeLessThanOrEqual(13);

    stop();
    expect(pendingFrames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    const drawsAtStop = fills.clearRect.mock.calls.length;
    runSecondAt125Hz();
    expect(fills.clearRect.mock.calls.length).toBe(drawsAtStop);
    canvas.remove();
  });

  it("paints the field on the GPU when the canvas offers WebGL2: one draw call per frame at about twenty-four frames a second, glyph swaps uploaded per frame, and nothing pending once stopped", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const { context } = fake2dContext();
    const { gl, calls } = fakeWebGl2();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((id) =>
      id === "webgl2" ? (gl as WebGL2RenderingContext) : (context as CanvasRenderingContext2D),
    );
    const { pendingFrames, runSecondAt125Hz } = fakeVsync();
    const canvas = sizedCanvas();

    const stop = runCharacterField(canvas, true);
    const drawsBefore = calls.drawArrays.mock.calls.length;
    const uploadsBefore = calls.texSubImage2D.mock.calls.length;
    runSecondAt125Hz();
    const drawsInOneSecond = calls.drawArrays.mock.calls.length - drawsBefore;
    const uploadsInOneSecond = calls.texSubImage2D.mock.calls.length - uploadsBefore;
    // The 41.7 ms timer lands on the next 8 ms vsync, so the simulated 125 Hz
    // compositor sees about twenty frames a second.
    expect(drawsInOneSecond).toBeGreaterThanOrEqual(18);
    expect(drawsInOneSecond).toBeLessThanOrEqual(26);
    // The animated field re-uploads its glyph grid once per frame.
    expect(uploadsInOneSecond).toBeGreaterThanOrEqual(18);
    expect(calls.drawArrays.mock.calls.every((args) => args[1] === 0 && args[2] === 3)).toBe(true);

    stop();
    expect(pendingFrames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    const drawsAtStop = calls.drawArrays.mock.calls.length;
    runSecondAt125Hz();
    expect(calls.drawArrays.mock.calls.length).toBe(drawsAtStop);
    canvas.remove();
  });

  it("keeps the grid uploading when the window width gives an odd number of columns", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const { context } = fake2dContext();
    const { gl, calls } = fakeWebGl2();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((id) =>
      id === "webgl2" ? (gl as WebGL2RenderingContext) : (context as CanvasRenderingContext2D),
    );
    fakeVsync();
    // 21 columns by 2 rows: each grid row is 42 bytes, not a multiple of 4.
    const canvas = sizedCanvas(168, 26);

    const stop = runCharacterField(canvas, true);
    const uploads = calls.texSubImage2D.mock.calls;
    expect(uploads.length).toBeGreaterThan(0);
    expect(uploads.every((args) => args[4] === 21 && args[5] === 2)).toBe(true);
    expect(calls.unpackErrors).toEqual([]);
    stop();
    canvas.remove();
  });

  it("falls back to the 2D painter when WebGL2 is unavailable and draws the same field", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const { context, fills } = fake2dContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((id) =>
      id === "2d" ? (context as CanvasRenderingContext2D) : null,
    );
    fakeVsync();
    const canvas = sizedCanvas();

    const stop = runCharacterField(canvas, true);
    expect(fills.fillText.mock.calls.length).toBeGreaterThan(0);
    stop();
    canvas.remove();
  });

  it("a click over the field reaches the GPU painter as a ripple uniform and is gone after it fades", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const { context } = fake2dContext();
    const { gl, calls, uniformNames } = fakeWebGl2();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((id) =>
      id === "webgl2" ? (gl as WebGL2RenderingContext) : (context as CanvasRenderingContext2D),
    );
    const { runSecondAt125Hz } = fakeVsync();
    const canvas = sizedCanvas();

    const stop = runCharacterField(canvas, true);
    const rippleCounts = () =>
      calls.uniform1i.mock.calls
        .filter((args) => uniformNames.get(args[0] as WebGLUniformLocation) === "uRippleCount")
        .map((args) => args[1]);
    const ripplePositions = () =>
      calls.uniform4fv.mock.calls
        .filter((args) => uniformNames.get(args[0] as WebGLUniformLocation) === "uRipples")
        .map((args) => args[1] as Float32Array);

    window.dispatchEvent(new MouseEvent("pointerdown", { clientX: 20, clientY: 20 }));
    runSecondAt125Hz();
    expect(rippleCounts()).toContain(1);
    // The click travels in canvas CSS pixels; a bitmap-space regression
    // would land the ring at twice that on a 2x display.
    expect(ripplePositions().some((v) => v[0] === 20 && v[1] === 20)).toBe(true);

    // The ring and its echo live 1.82 s; two more seconds leaves none.
    runSecondAt125Hz();
    runSecondAt125Hz();
    const counts = rippleCounts();
    expect(counts[counts.length - 1]).toBe(0);
    stop();
    canvas.remove();
  });
});

describe("character ground click wave", () => {
  const circle = { x: 100, y: 100, start: 0, seed: 0, wobble: 0, heart: false };

  it("lights the ring's edge as it spreads and leaves its centre dark", () => {
    // Half a second in, the ring has travelled 160px.
    expect(rippleBrightness(circle, 260, 100, 0.5)).toBeGreaterThan(0.6);
    expect(rippleBrightness(circle, 100, 100, 0.5)).toBe(0);
  });

  it("is gone once it and its echo have faded, and does nothing before the click", () => {
    expect(rippleBrightness(circle, 100 + 320 * 2, 100, 2)).toBe(0);
    expect(rippleBrightness({ ...circle, start: 1 }, 100, 100, 0.5)).toBe(0);
  });

  it("draws a heart with its point below the click and its cleft above", () => {
    const heart = { ...circle, heart: true };
    // At 0.5s a plain ring sits 160px out; a heart reaches further down and
    // barely leaves the click upward.
    expect(rippleBrightness(heart, 100, 100 + 160 * 1.82, 0.5)).toBeGreaterThan(0.6);
    expect(rippleBrightness(heart, 100, 100 - 160, 0.5)).toBe(0);
  });

  it("varies every click and sometimes makes a heart", () => {
    const rolls = [0.1, 0.5, 0.05];
    const ripple = createRipple(0, 0, 0, () => rolls.shift() ?? 0);
    expect(ripple.wobble).toBeGreaterThan(0);
    expect(ripple.heart).toBe(true);
  });
});
