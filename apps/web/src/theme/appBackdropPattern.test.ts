// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppPattern } from "./appBackdropPattern";

/**
 * A WebGL2 stand-in that compiles everything and records the time uniform
 * each draw sets, which is all the drift test needs to see.
 */
function fakeWebGl() {
  const times: number[] = [];
  const locations = { u_time: { name: "u_time" } };
  const gl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    STATIC_DRAW: 6,
    FLOAT: 7,
    COLOR_BUFFER_BIT: 8,
    TRIANGLES: 9,
    createShader: () => ({}),
    shaderSource: () => undefined,
    compileShader: () => undefined,
    getShaderParameter: () => true,
    deleteShader: () => undefined,
    createProgram: () => ({}),
    attachShader: () => undefined,
    linkProgram: () => undefined,
    getProgramParameter: () => true,
    deleteProgram: () => undefined,
    createBuffer: () => ({}),
    deleteBuffer: () => undefined,
    bindBuffer: () => undefined,
    bufferData: () => undefined,
    getAttribLocation: () => 0,
    enableVertexAttribArray: () => undefined,
    vertexAttribPointer: () => undefined,
    useProgram: () => undefined,
    getUniformLocation: (_program: unknown, name: string) =>
      name === "u_time" ? locations.u_time : { name },
    viewport: () => undefined,
    uniform2f: () => undefined,
    uniform3f: () => undefined,
    uniform1f: (location: { name: string }, value: number) => {
      if (location === locations.u_time) times.push(value);
    },
    clearColor: () => undefined,
    clear: () => undefined,
    drawArrays: () => undefined,
    getExtension: () => null,
  };
  return { gl, times };
}

function fakeCanvas(gl: unknown): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "getContext", { value: () => gl });
  Object.defineProperty(canvas, "getBoundingClientRect", {
    value: () => ({ width: 300, height: 150, top: 0, left: 0, right: 300, bottom: 150 }),
  });
  return canvas;
}

describe("app backdrop pattern loop", () => {
  let now = 0;
  const frames: Array<(time: number) => void> = [];

  beforeEach(() => {
    now = 0;
    frames.length = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Runs every pending frame callback `ms` later, the way a visible tab would. */
  const tick = (ms: number) => {
    now += ms;
    const pending = frames.splice(0, frames.length);
    for (const frame of pending) frame(now);
  };

  it("advances the cloud with the clock while animated, at the speed it was given", () => {
    const { gl, times } = fakeWebGl();
    const handle = startAppPattern(fakeCanvas(gl), {
      ink: [1, 1, 1],
      animated: true,
      speed: 1,
      intensity: 0.6,
    });
    expect(handle).not.toBeNull();
    // The first frame starts the clock; the next ones move it at 24 frames a second.
    tick(50);
    tick(50);
    tick(50);
    expect(times.length).toBeGreaterThanOrEqual(2);
    expect(times.at(-1)!).toBeGreaterThan(times[0]!);
    expect(times.at(-1)!).toBeCloseTo(0.1, 2);

    handle!.setSpeed(2);
    const before = times.at(-1)!;
    tick(50);
    tick(50);
    expect(times.at(-1)! - before).toBeCloseTo(0.2, 2);
    handle!.stop();
  });

  it("holds still at speed zero and under reduced motion, and resumes when asked", () => {
    const { gl, times } = fakeWebGl();
    const handle = startAppPattern(fakeCanvas(gl), {
      ink: [1, 1, 1],
      animated: false,
      speed: 1,
      intensity: 0.6,
    });
    // A still ground is drawn once, and no frame is ever requested for it.
    expect(times).toEqual([0]);
    expect(frames).toHaveLength(0);

    handle!.setAnimated(true);
    tick(50);
    tick(50);
    expect(times.at(-1)!).toBeGreaterThan(0);

    handle!.setSpeed(0);
    const drawn = times.length;
    tick(50);
    tick(50);
    expect(times.length).toBe(drawn);
    handle!.stop();
  });
});
