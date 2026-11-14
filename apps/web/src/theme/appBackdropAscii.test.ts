import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CENTRE_SHARE,
  PEAK_ALPHA,
  centreShare,
  fieldPixelRatio,
  patchStrength,
  runAsciiField,
} from "./appBackdropAscii";

/**
 * A canvas that records what a frame does. A frame writes the cell mask once,
 * so the number of mask writes is the number of frames drawn.
 */
function recordingCanvases() {
  const writes = { frames: 0 };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    function (this: HTMLCanvasElement) {
      return {
        createImageData: (width: number, height: number) => ({
          data: new Uint8ClampedArray(width * height * 4),
        }),
        putImageData: () => {
          writes.frames += 1;
        },
        drawImage: () => undefined,
        clearRect: () => undefined,
        fillText: () => undefined,
      } as unknown as CanvasRenderingContext2D;
    },
  );
  return writes;
}

function sizedCanvas() {
  const canvas = document.createElement("canvas");
  canvas.getBoundingClientRect = () => new DOMRect(0, 0, 700, 400);
  document.body.append(canvas);
  return canvas;
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("character ground", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestIdleCallback", undefined);
  });

  afterEach(() => {
    setVisibility("visible");
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("draws about fifteen frames a second, not one per display refresh", () => {
    const writes = recordingCanvases();
    const stop = runAsciiField(sizedCanvas(), true);
    vi.advanceTimersByTime(3000);
    expect(writes.frames).toBeGreaterThanOrEqual(40);
    expect(writes.frames).toBeLessThanOrEqual(48);
    stop();
  });

  it("stops drawing while the document is hidden and carries on when it is shown again", () => {
    const writes = recordingCanvases();
    const stop = runAsciiField(sizedCanvas(), true);
    vi.advanceTimersByTime(500);
    setVisibility("hidden");
    const atHide = writes.frames;
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(writes.frames).toBe(atHide);
    setVisibility("visible");
    vi.advanceTimersByTime(500);
    expect(writes.frames).toBeGreaterThan(atHide);
    stop();
  });

  it("stops drawing while the field is scrolled out of view", () => {
    const writes = recordingCanvases();
    let report: IntersectionObserverCallback | undefined;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          report = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    const stop = runAsciiField(sizedCanvas(), true);
    vi.advanceTimersByTime(500);
    const entry = (isIntersecting: boolean) =>
      [{ isIntersecting } as IntersectionObserverEntry] as IntersectionObserverEntry[];
    report?.(entry(false), {} as IntersectionObserver);
    const atHide = writes.frames;
    vi.advanceTimersByTime(5000);
    expect(writes.frames).toBe(atHide);
    report?.(entry(true), {} as IntersectionObserver);
    vi.advanceTimersByTime(500);
    expect(writes.frames).toBeGreaterThan(atHide);
    stop();
  });

  it("holds one still frame, and schedules nothing, when motion is not wanted", () => {
    const writes = recordingCanvases();
    const canvas = sizedCanvas();
    const stop = runAsciiField(canvas, false);
    vi.advanceTimersByTime(10_000);
    expect(writes.frames).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(canvas.dataset["ready"]).toBe("true");
    stop();
  });

  it("leaves nothing scheduled once it is stopped", () => {
    const writes = recordingCanvases();
    const stop = runAsciiField(sizedCanvas(), true);
    vi.advanceTimersByTime(500);
    stop();
    const atStop = writes.frames;
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(writes.frames).toBe(atStop);
  });

  it("shows ink only inside patches and never above its peak", () => {
    let lit = 0;
    let empty = 0;
    for (let column = 0; column < 80; column += 1) {
      for (let row = 0; row < 40; row += 1) {
        const strength = patchStrength(column, row, 3);
        expect(strength).toBeGreaterThanOrEqual(0);
        expect(strength).toBeLessThanOrEqual(1);
        if (strength > 0) lit += 1;
        else empty += 1;
      }
    }
    expect(lit).toBeGreaterThan(0);
    expect(empty).toBeGreaterThan(lit);
    expect(PEAK_ALPHA).toBeLessThanOrEqual(0.18);
  });

  it("dims the middle of the page and is at full strength well away from it", () => {
    expect(centreShare(500, 300, 1000, 600)).toBeCloseTo(CENTRE_SHARE, 5);
    expect(centreShare(0, 0, 1000, 600)).toBe(1);
  });

  it("caps the backing store by display ratio and by area", () => {
    expect(fieldPixelRatio(800, 600, 3)).toBe(2);
    expect(fieldPixelRatio(800, 600, 1)).toBe(1);
    const ratio = fieldPixelRatio(3840, 2160, 2);
    expect(ratio).toBeLessThan(1);
    expect(3840 * ratio * (2160 * ratio)).toBeLessThanOrEqual(5_000_001);
  });
});
