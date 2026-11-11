import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyFlowingPaletteCss,
  FLOWING_FRAME_MS,
  FLOWING_RESOLUTION_SCALE,
  runFlowingField,
} from "./appBackdropFlowing";
import { deriveFlowingPalette } from "@octant/theme/flowing-background";

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

function fakeWebGl2() {
  const calls = { drawArrays: vi.fn() };
  const gl: Partial<WebGL2RenderingContext> = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
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
    getUniformLocation: vi.fn().mockReturnValue({}),
    createVertexArray: vi.fn().mockReturnValue({}),
    bindVertexArray: vi.fn(),
    deleteVertexArray: vi.fn(),
    viewport: vi.fn(),
    uniform1f: vi.fn(),
    uniform2f: vi.fn(),
    uniform3f: vi.fn(),
    drawArrays: calls.drawArrays,
  };
  return { gl, calls };
}

function mount(width = 400, height = 240) {
  const root = document.createElement("div");
  const canvas = document.createElement("canvas");
  root.style.setProperty("--octant-accent", "#5b9cf5");
  document.documentElement.setAttribute("data-octant-theme-mode", "dark");
  document.body.append(root);
  root.append(canvas);
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
  vi.spyOn(root, "getBoundingClientRect").mockReturnValue({
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
  return { root, canvas };
}

describe("flowing ground", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.replaceChildren();
    document.documentElement.removeAttribute("data-octant-theme-mode");
  });

  it("writes the four palette stops as CSS custom properties", () => {
    const root = document.createElement("div");
    const palette = deriveFlowingPalette("#d97757", "dark");
    applyFlowingPaletteCss(root, palette);
    expect(root.style.getPropertyValue("--octant-flowing-deep")).toBe(palette.deep);
    expect(root.style.getPropertyValue("--octant-flowing-mid")).toBe(palette.mid);
    expect(root.style.getPropertyValue("--octant-flowing-light")).toBe(palette.light);
    expect(root.style.getPropertyValue("--octant-flowing-glow")).toBe(palette.glow);
  });

  it("falls back to CSS when WebGL2 is missing and paints one still frame without scheduling", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const { root, canvas } = mount();
    const stop = runFlowingField(canvas, root, false);
    expect(root.dataset.engine).toBe("css");
    expect(root.style.getPropertyValue("--octant-flowing-mid")).toBe(
      deriveFlowingPalette("#5b9cf5", "dark").mid,
    );
    expect(canvas.width).toBe(Math.round(400 * FLOWING_RESOLUTION_SCALE));
    stop();
  });

  it("paints on the GPU about thirty times a second and leaves nothing pending once stopped", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const { gl, calls } = fakeWebGl2();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((id) =>
      id === "webgl2" ? (gl as WebGL2RenderingContext) : null,
    );
    const { pendingFrames, runSecondAt125Hz } = fakeVsync();
    const { root, canvas } = mount();

    const stop = runFlowingField(canvas, root, true);
    expect(root.dataset.engine).toBe("webgl");
    const drawsBefore = calls.drawArrays.mock.calls.length;
    runSecondAt125Hz();
    const drawsInOneSecond = calls.drawArrays.mock.calls.length - drawsBefore;
    // The 33 ms timer lands on the next 8 ms vsync, so the simulated 125 Hz
    // compositor sees a little under thirty frames a second.
    expect(drawsInOneSecond).toBeGreaterThanOrEqual(22);
    expect(drawsInOneSecond).toBeLessThanOrEqual(34);
    expect(FLOWING_FRAME_MS).toBeCloseTo(1000 / 30, 5);
    expect(calls.drawArrays.mock.calls.every((args) => args[1] === 0 && args[2] === 3)).toBe(true);

    stop();
    expect(pendingFrames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    const drawsAtStop = calls.drawArrays.mock.calls.length;
    runSecondAt125Hz();
    expect(calls.drawArrays.mock.calls.length).toBe(drawsAtStop);
  });

  it("repaints a still field after the GPU context is restored", () => {
    const { gl, calls } = fakeWebGl2();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((id) =>
      id === "webgl2" ? (gl as WebGL2RenderingContext) : null,
    );
    const { root, canvas } = mount();
    const stop = runFlowingField(canvas, root, false);
    const drawsBefore = calls.drawArrays.mock.calls.length;
    expect(drawsBefore).toBeGreaterThan(0);
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(calls.drawArrays.mock.calls.length).toBe(drawsBefore + 1);
    stop();
  });

  it("does not schedule frames while the document is hidden", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const { gl, calls } = fakeWebGl2();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((id) =>
      id === "webgl2" ? (gl as WebGL2RenderingContext) : null,
    );
    const { runSecondAt125Hz } = fakeVsync();
    const { root, canvas } = mount();
    const stop = runFlowingField(canvas, root, true);
    const drawsBeforeHide = calls.drawArrays.mock.calls.length;
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    runSecondAt125Hz();
    expect(calls.drawArrays.mock.calls.length).toBe(drawsBeforeHide);
    stop();
  });
});
