import { afterEach, describe, expect, it, vi } from "vitest";
import { createRipple } from "./appBackdropCharacters";
import { cellWave, fieldLevel, parseColor, printLevel, runMovingPrint } from "./appBackdropPrint";

describe("pixel ground frame pacing", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("asks for an animation frame about twelve times a second while drifting, twenty-four while a wave runs, and leaves nothing pending once stopped", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const draws = vi.fn();
    const context: Partial<CanvasRenderingContext2D> = {
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      drawImage: draws,
      putImageData: vi.fn(),
      createImageData: vi
        .fn()
        .mockReturnValue({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context as CanvasRenderingContext2D,
    );
    // A stand-in compositor: frames are requested here and delivered at the
    // next simulated vsync, as a browser would.
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
    const canvas = document.createElement("canvas");
    document.body.append(canvas);

    const stop = runMovingPrint(canvas, {}, { kind: "dither", cell: 4, levels: 4 }, true);
    const drawsBefore = draws.mock.calls.length;
    runSecondAt125Hz();
    const drawsInOneSecond = draws.mock.calls.length - drawsBefore;
    expect(drawsInOneSecond).toBeGreaterThanOrEqual(10);
    expect(drawsInOneSecond).toBeLessThanOrEqual(13);
    expect(framesRequested).toBeGreaterThanOrEqual(10);
    expect(framesRequested).toBeLessThanOrEqual(13);

    // A click over the print starts a wave, which runs at twice the cadence
    // (an 8 ms vsync rounds both cadences down a little, as a real one does).
    window.dispatchEvent(new PointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
    const drawsBeforeWave = draws.mock.calls.length;
    const framesBeforeWave = framesRequested;
    runSecondAt125Hz();
    const drawsInWaveSecond = draws.mock.calls.length - drawsBeforeWave;
    expect(drawsInWaveSecond).toBeGreaterThanOrEqual(20);
    expect(drawsInWaveSecond).toBeLessThanOrEqual(26);
    expect(framesRequested - framesBeforeWave).toBeLessThanOrEqual(26);

    stop();
    expect(pendingFrames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    const drawsAtStop = draws.mock.calls.length;
    runSecondAt125Hz();
    expect(draws.mock.calls.length).toBe(drawsAtStop);
    canvas.remove();
  });
});

describe("the moving print", () => {
  it("keeps the field's brightness between dark and full", () => {
    for (let t = 0; t < 20; t += 1.7) {
      for (let cell = 0; cell < 200; cell += 13) {
        const level = fieldLevel(cell, cell * 0.6, t);
        expect(level).toBeGreaterThanOrEqual(0);
        expect(level).toBeLessThanOrEqual(1);
      }
    }
  });

  it("dithers an in-between level into a pattern of its two nearest steps", () => {
    const steps = new Set<number>();
    for (let row = 0; row < 4; row += 1) {
      for (let column = 0; column < 4; column += 1) {
        steps.add(printLevel(0.4, 3, true, column, row));
      }
    }
    expect([...steps].sort()).toEqual([0, 0.5]);
    // Plain pixels round to one step everywhere.
    expect(printLevel(0.4, 3, false, 0, 0)).toBe(0.5);
    expect(printLevel(0.4, 3, false, 3, 2)).toBe(0.5);
  });

  it("pushes a cell outward from a click while the wave passes, and leaves far cells alone", () => {
    const ripple = { ...createRipple(100, 100, 0, () => 0), heart: false, wobble: 0 };
    // At half a second the edge has travelled about 160px.
    const onEdge = cellWave([ripple], 260, 100, 0.5);
    expect(onEdge.dx).toBeGreaterThan(0);
    expect(Math.abs(onEdge.dy)).toBeLessThan(0.01);
    expect(onEdge.glow).toBeGreaterThan(0.3);
    expect(cellWave([ripple], 1000, 1000, 0.5)).toEqual({ dx: 0, dy: 0, glow: 0 });
    expect(cellWave([ripple], 105, 100, 0.5).glow).toBe(0);
  });

  it("reads the theme's colours whether computed or written as hex", () => {
    expect(parseColor("rgb(12, 34, 56)")).toEqual([12, 34, 56]);
    expect(parseColor("rgba(1, 2, 3, 0.5)")).toEqual([1, 2, 3]);
    expect(parseColor("#e3a33a")).toEqual([227, 163, 58]);
    expect(parseColor(" #fff ")).toEqual([255, 255, 255]);
    expect(parseColor("transparent")).toBeUndefined();
  });
});
