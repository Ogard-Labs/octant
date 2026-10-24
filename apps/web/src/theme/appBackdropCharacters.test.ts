import { afterEach, describe, expect, it, vi } from "vitest";
import { createRipple, rippleBrightness, runCharacterField } from "./appBackdropCharacters";

describe("character ground frame pacing", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("asks for an animation frame about twelve times a second, not at every vsync, and leaves nothing pending once stopped", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const draws = vi.fn();
    const context: Partial<CanvasRenderingContext2D> = {
      setTransform: vi.fn(),
      clearRect: draws,
      fillText: vi.fn(),
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

    const stop = runCharacterField(canvas, true);
    const drawsBefore = draws.mock.calls.length;
    runSecondAt125Hz();
    const drawsInOneSecond = draws.mock.calls.length - drawsBefore;
    expect(drawsInOneSecond).toBeGreaterThanOrEqual(10);
    expect(drawsInOneSecond).toBeLessThanOrEqual(13);
    expect(framesRequested).toBeGreaterThanOrEqual(10);
    expect(framesRequested).toBeLessThanOrEqual(13);

    stop();
    expect(pendingFrames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    const drawsAtStop = draws.mock.calls.length;
    runSecondAt125Hz();
    expect(draws.mock.calls.length).toBe(drawsAtStop);
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
