import { afterEach, describe, expect, it, vi } from "vitest";
import { createRipple } from "./appBackdropCharacters";
import {
  calmShare,
  cellWave,
  parseColor,
  printLevel,
  runMovingPrint,
  toTwoTone,
  toneCell,
  type Toned,
} from "./appBackdropPrint";

describe("pixel ground frame pacing", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("asks for an animation frame about fifteen times a second while drifting, twenty-four while a wave runs, and leaves nothing pending once stopped", () => {
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

    const stop = runMovingPrint(
      canvas,
      { scene: "ridges" },
      { kind: "dither", cell: 4, levels: 4 },
      true,
    );
    // Setup waits for idle time, then the first frame draws.
    vi.advanceTimersByTime(10);
    const drawsBefore = draws.mock.calls.length;
    runSecondAt125Hz();
    const drawsInOneSecond = draws.mock.calls.length - drawsBefore;
    expect(drawsInOneSecond).toBeGreaterThanOrEqual(13);
    expect(drawsInOneSecond).toBeLessThanOrEqual(16);
    expect(framesRequested).toBeGreaterThanOrEqual(13);
    expect(framesRequested).toBeLessThanOrEqual(16);

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

/** A stand-in 2d context and a counted compositor, shared by the lifecycle tests below. */
function stubCanvas() {
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
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) =>
    window.setTimeout(() => callback(performance.now()), 0),
  );
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => window.clearTimeout(id));
  const canvas = document.createElement("canvas");
  document.body.append(canvas);
  return { draws, canvas };
}

describe("the pixel ground's lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("holds one frame and keeps no timer when motion is off", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const { draws, canvas } = stubCanvas();
    const stop = runMovingPrint(
      canvas,
      { scene: "burst" },
      { kind: "dither", cell: 3, levels: 4 },
      false,
    );
    vi.advanceTimersByTime(5000);
    expect(draws).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(canvas.dataset["ready"]).toBe("true");
    stop();
    expect(canvas.dataset["ready"]).toBeUndefined();
  });

  it("stops drawing while the document is hidden and resumes when it returns", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const { draws, canvas } = stubCanvas();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    const stop = runMovingPrint(
      canvas,
      { scene: "drift" },
      { kind: "dither", cell: 3, levels: 4 },
      true,
    );
    vi.advanceTimersByTime(1000);
    expect(draws.mock.calls.length).toBeGreaterThan(5);
    hidden.mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(100);
    const whileHidden = draws.mock.calls.length;
    vi.advanceTimersByTime(3000);
    expect(draws.mock.calls.length).toBe(whileHidden);
    expect(vi.getTimerCount()).toBe(0);
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(1000);
    expect(draws.mock.calls.length).toBeGreaterThan(whileHidden);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("the two-tone print", () => {
  const page = { ink: 0.5, accent: 0.7 };

  it("uses the accent only where the glow is above the ink", () => {
    const into: Toned = { accent: false, alpha: 0 };
    let accents = 0;
    for (let row = 0; row < 4; row += 1) {
      for (let column = 0; column < 4; column += 1) {
        toneCell(0.6, 0, 4, true, column, row, page, into);
        expect(into.accent).toBe(false);
        toneCell(0.2, 1, 4, true, column, row, page, into);
        if (into.accent) accents += 1;
      }
    }
    expect(accents).toBe(16);
    toneCell(0.2, 1, 4, true, 0, 0, page, into);
    expect(into.alpha).toBeCloseTo(0.7);
  });

  it("steps the ink through the chosen number of levels and no more", () => {
    const into: Toned = { accent: false, alpha: 0 };
    const alphas = new Set<number>();
    for (let value = 0; value <= 1; value += 0.01) {
      for (let row = 0; row < 4; row += 1) {
        for (let column = 0; column < 4; column += 1) {
          toneCell(value, 0, 4, true, column, row, page, into);
          alphas.add(Math.round(into.alpha * 1000));
        }
      }
    }
    expect([...alphas].sort((a, b) => a - b)).toEqual([0, 167, 333, 500]);
  });

  it("keeps the middle of the page calmer than its edges", () => {
    const centre = calmShare(720, 450, 1440, 900);
    const edge = calmShare(40, 860, 1440, 900);
    expect(centre).toBeLessThan(0.3);
    expect(edge).toBeGreaterThan(0.95);
  });

  it("gives only the bright warm cells of a picture the accent", () => {
    const rgba = new Uint8ClampedArray(4 * 4);
    // Dark, grey, bright blue, bright orange.
    rgba.set([20, 20, 20, 255, 128, 128, 128, 255, 200, 220, 255, 255, 255, 190, 60, 255]);
    const picture = toTwoTone({ columns: 4, rows: 1, rgba });
    expect(picture.glow[3]).toBeGreaterThan(0.5);
    expect(picture.glow[0]).toBe(0);
    expect(picture.glow[1]).toBe(0);
    expect(picture.glow[2]).toBeLessThan(0.3);
    expect(picture.light[0]).toBeLessThan(picture.light[3] ?? 0);
  });
});
