import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CENTRE_SHARE,
  PEAK_ALPHA,
  fieldPixelRatio,
  densityScale,
  inkScale,
  meanStrength,
  patchStrength,
  patchThresholds,
  runAsciiField,
} from "./appBackdropAscii";
import {
  COLUMN_MARGIN,
  columnFloor,
  columnShare,
  isDarkPage,
  readContentColumns,
} from "./appBackdropColumn";

/**
 * Canvases that record what a frame does. Each frame copies the glyph layer
 * onto the field once, so the number of copies is the number of frames drawn.
 * Every cell mask written to the screen is kept, so a test can see which cells
 * a ring lit and how strongly.
 */
interface MaskWrite {
  readonly width: number;
  readonly alphas: ReadonlyArray<number>;
}

function recordingCanvases() {
  const writes = {
    frames: 0,
    glyphPaints: 0,
    surfaces: 0,
    masks: [] as MaskWrite[],
    ringMasks: [] as MaskWrite[],
  };
  const maskCanvases: HTMLCanvasElement[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    function (this: HTMLCanvasElement) {
      // Cell masks are one pixel per cell: the first is the field's, the second a ring's.
      if (this.width === 100 && !maskCanvases.includes(this)) maskCanvases.push(this);
      return {
        createImageData: (width: number, height: number) => {
          writes.surfaces += 1;
          return { width, data: new Uint8ClampedArray(width * height * 4) };
        },
        putImageData: (
          (owner: HTMLCanvasElement) => (image: { width: number; data: Uint8ClampedArray }) => {
            const alphas: number[] = [];
            for (let index = 3; index < image.data.length; index += 4) {
              alphas.push(image.data[index] ?? 0);
            }
            const write = { width: image.width, alphas };
            if (owner === maskCanvases[0]) writes.masks.push(write);
            else writes.ringMasks.push(write);
          }
        )(this),
        set globalCompositeOperation(value: string) {
          if (value === "copy") writes.frames += 1;
        },
        drawImage: () => undefined,
        clearRect: () => undefined,
        fillText: () => {
          writes.glyphPaints += 1;
        },
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

  it("dims the ground behind the content column to a fifth and leaves the edges at full strength", () => {
    const column = { left: 300, right: 700 };
    expect(columnShare(500, [column])).toBeCloseTo(CENTRE_SHARE, 5);
    expect(columnShare(300, [column])).toBeCloseTo(CENTRE_SHARE, 5);
    expect(columnShare(column.left - COLUMN_MARGIN, [column])).toBe(1);
    expect(columnShare(0, [column])).toBe(1);
    expect(columnShare(column.right - 60 + COLUMN_MARGIN / 2, [column])).toBeGreaterThan(
      CENTRE_SHARE,
    );
  });

  it("dims the ground behind the content column to a sixth on a light page, where dark ink reads louder", () => {
    const column = { left: 300, right: 700 };
    expect(isDarkPage([240, 240, 240])).toBe(true);
    expect(isDarkPage([20, 20, 20])).toBe(false);
    expect(columnFloor(true)).toBeCloseTo(CENTRE_SHARE, 5);
    expect(columnFloor(false)).toBeCloseTo(1 / 6, 5);
    expect(columnShare(500, [column], columnFloor(false))).toBeCloseTo(1 / 6, 5);
    expect(columnShare(0, [column], columnFloor(false))).toBe(1);
  });

  it("measures the content column from the start screen it lies behind", () => {
    document.body.innerHTML =
      '<div id="stage"><div class="app-backdrop"><canvas id="ground"></canvas></div><div class="welcome"></div></div>';
    const rect = (left: number, width: number) =>
      ({
        left,
        right: left + width,
        width,
        top: 0,
        bottom: 10,
        height: 10,
        x: left,
        y: 0,
      }) as DOMRect;
    const ground = document.querySelector("canvas");
    const content = document.querySelector<HTMLElement>(".welcome");
    if (ground === null || content === null) throw new Error("The fixture lost its elements.");
    ground.getBoundingClientRect = () => rect(100, 1000);
    content.getBoundingClientRect = () => rect(300, 600);
    expect(readContentColumns(ground, 1000)).toEqual([{ left: 200, right: 800 }]);
    document.body.innerHTML = "";
  });

  it("caps the backing store by display ratio and by area", () => {
    expect(fieldPixelRatio(800, 600, 3)).toBe(2);
    expect(fieldPixelRatio(800, 600, 1)).toBe(1);
    const ratio = fieldPixelRatio(3840, 2160, 2);
    expect(ratio).toBeLessThan(1);
    expect(3840 * ratio * (2160 * ratio)).toBeLessThanOrEqual(5_000_001);
  });
});

describe("character ground click rings", () => {
  const COLUMNS = 100;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestIdleCallback", undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  const click = (x: number, y: number, target: Element = document.body) =>
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y }));

  /** The rows a ring lit in the newest ring mask, as [first, last], or undefined. */
  function litRows(writes: ReturnType<typeof recordingCanvases>) {
    const latest = writes.ringMasks[writes.ringMasks.length - 1];
    if (latest === undefined) return undefined;
    const rows: number[] = [];
    latest.alphas.forEach((alpha, index) => {
      if (alpha > 0) rows.push(Math.floor(index / COLUMNS));
    });
    return rows.length === 0 ? undefined : ([Math.min(...rows), Math.max(...rows)] as const);
  }

  it("sends a ring out from a click on empty ground that grows and then fades away", () => {
    const writes = recordingCanvases();
    const stop = runAsciiField(sizedCanvas(), true);
    vi.advanceTimersByTime(300);
    expect(writes.ringMasks).toHaveLength(0);
    click(350, 200);
    vi.advanceTimersByTime(300);
    const early = litRows(writes);
    vi.advanceTimersByTime(500);
    const later = litRows(writes);
    expect(early).toBeDefined();
    expect(later).toBeDefined();
    // The ring grew: its lit rows reach further from the click's row (15).
    expect((later?.[1] ?? 0) - (later?.[0] ?? 0)).toBeGreaterThan(
      (early?.[1] ?? 0) - (early?.[0] ?? 0),
    );
    const strongest = Math.max(...(writes.ringMasks.flatMap((write) => write.alphas) ?? [0]));
    expect(strongest).toBeGreaterThan(0.5 * 255);
    expect(strongest).toBeLessThanOrEqual(Math.round(0.9 * 255));
    vi.advanceTimersByTime(2500);
    const settled = writes.ringMasks.length;
    vi.advanceTimersByTime(1000);
    expect(writes.ringMasks).toHaveLength(settled);
    stop();
  });

  it("draws a heart now and then, whose point runs further below the click than a round ring would", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.05);
    const writes = recordingCanvases();
    const stop = runAsciiField(sizedCanvas(), true);
    vi.advanceTimersByTime(300);
    click(350, 80);
    vi.advanceTimersByTime(500);
    const rows = litRows(writes);
    // Row 6 holds the click. Half a second on, a round ring would reach about
    // row 22; a heart's point is already near the bottom of the field.
    expect(rows?.[1] ?? 0).toBeGreaterThan(25);
    stop();
  });

  it("draws a round ring, reaching above the click, when the roll is not a heart", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.9);
    const writes = recordingCanvases();
    const stop = runAsciiField(sizedCanvas(), true);
    vi.advanceTimersByTime(300);
    click(350, 200);
    vi.advanceTimersByTime(500);
    const rows = litRows(writes);
    expect(rows?.[0] ?? 99).toBeLessThan(8);
    stop();
  });

  it("answers no click on a control, a menu, a drag or a text selection", () => {
    const writes = recordingCanvases();
    const button = document.createElement("button");
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    const item = document.createElement("span");
    menu.append(item);
    document.body.append(button, menu);
    const stop = runAsciiField(sizedCanvas(), true);
    vi.advanceTimersByTime(300);
    click(300, 200, button);
    click(300, 200, item);
    expect(writes.ringMasks).toHaveLength(0);

    document.body.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, clientX: 10, clientY: 10 }),
    );
    click(200, 200);
    expect(writes.ringMasks).toHaveLength(0);

    vi.spyOn(window, "getSelection").mockReturnValue({ isCollapsed: false } as Selection);
    click(300, 200);
    vi.advanceTimersByTime(500);
    expect(writes.ringMasks).toHaveLength(0);
    stop();
  });

  it("answers a click only inside the area it is restricted to", () => {
    const writes = recordingCanvases();
    const start = document.createElement("div");
    start.className = "start-screen";
    const thread = document.createElement("div");
    document.body.append(start, thread);
    const stop = runAsciiField(sizedCanvas(), true, ".start-screen");
    vi.advanceTimersByTime(300);
    click(300, 200, thread);
    vi.advanceTimersByTime(300);
    expect(writes.ringMasks).toHaveLength(0);
    click(300, 200, start);
    vi.advanceTimersByTime(300);
    expect(writes.ringMasks.length).toBeGreaterThan(0);
    stop();
  });

  it("runs at about forty frames a second only while a ring is alive", () => {
    const writes = recordingCanvases();
    const stop = runAsciiField(sizedCanvas(), true);
    vi.advanceTimersByTime(500);
    const framesIn = (ms: number) => {
      const before = writes.frames;
      vi.advanceTimersByTime(ms);
      return writes.frames - before;
    };
    const idle = framesIn(2000);
    expect(idle).toBeGreaterThanOrEqual(28);
    expect(idle).toBeLessThanOrEqual(32);
    click(350, 200);
    const alive = framesIn(1500);
    expect(alive).toBeGreaterThanOrEqual(55);
    expect(alive).toBeLessThanOrEqual(62);
    vi.advanceTimersByTime(1000);
    const after = framesIn(2000);
    expect(after).toBeGreaterThanOrEqual(28);
    expect(after).toBeLessThanOrEqual(32);
    stop();
  });

  it("takes no rings, and schedules nothing, when motion is not wanted", () => {
    const writes = recordingCanvases();
    const stop = runAsciiField(sizedCanvas(), false);
    click(350, 200);
    vi.advanceTimersByTime(3000);
    expect(writes.frames).toBe(1);
    expect(writes.ringMasks).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });

  it("leaves nothing scheduled and ignores clicks once stopped", () => {
    const writes = recordingCanvases();
    const stop = runAsciiField(sizedCanvas(), true);
    vi.advanceTimersByTime(300);
    click(350, 200);
    vi.advanceTimersByTime(200);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    click(350, 200);
    vi.advanceTimersByTime(1000);
    expect(vi.getTimerCount()).toBe(0);
    expect(writes.ringMasks.length).toBeGreaterThan(0);
  });

  it("lights more cells at the highest density than at the default, and fewer at the lowest", () => {
    const lit = (density: number) => {
      const thresholds = patchThresholds(density);
      let count = 0;
      for (let row = 0; row < 40; row += 1) {
        for (let column = 0; column < 120; column += 1) {
          count += patchStrength(column, row, 7, thresholds);
        }
      }
      return count;
    };
    expect(lit(100)).toBeGreaterThan(lit(50));
    expect(lit(0)).toBeLessThan(lit(50));
    expect(patchThresholds(50)).toEqual({ low: 0.52, high: 0.82 });
  });

  it("holds one frame at speed zero, however long it runs", () => {
    const writes = recordingCanvases();
    const stop = runAsciiField(sizedCanvas(), false, undefined, () => ({
      characterSet: "01",
      density: 50,
      speed: 0,
    }));
    vi.advanceTimersByTime(3000);
    expect(writes.frames).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });

  it("draws a heavier set fainter than the default letters, and never boosts a lighter one", () => {
    expect(inkScale(0.25, 1)).toBeCloseTo(0.25);
    expect(inkScale(0.25, 0.25)).toBe(1);
    expect(inkScale(0.25, 0.1)).toBe(1);
    expect(PEAK_ALPHA * inkScale(0.25, 1)).toBeLessThan(PEAK_ALPHA);
  });

  it("keeps the field running when the set changes, repainting its glyphs once", () => {
    const writes = recordingCanvases();
    let options = { characterSet: "ab", density: 50, speed: 50 };
    const stop = runAsciiField(sizedCanvas(), true, undefined, () => options);
    vi.advanceTimersByTime(500);
    const before = writes.frames;
    options = { ...options, characterSet: "01" };
    vi.advanceTimersByTime(500);
    expect(writes.frames).toBeGreaterThan(before);
    stop();
  });

  it("never inks more on average than the default field, at any density or set", () => {
    const defaultInk = meanStrength(50) * 0.25;
    for (const density of [0, 50, 100]) {
      for (const coverage of [0.1, 0.25, 0.6, 1]) {
        const ink =
          meanStrength(density) * densityScale(density) * inkScale(0.25, coverage) * coverage;
        expect(ink).toBeLessThanOrEqual(defaultInk + 1e-9);
      }
    }
    expect(densityScale(100)).toBeLessThan(1);
    expect(densityScale(0)).toBe(1);
  });

  it("redraws a still field in place when the density changes, without rebuilding or re-rolling it", () => {
    const writes = recordingCanvases();
    let options = { characterSet: "ab", density: 50, speed: 0 };
    const stop = runAsciiField(sizedCanvas(), false, undefined, () => options);
    vi.advanceTimersByTime(100);
    const surfaces = writes.surfaces;
    const paints = writes.glyphPaints;
    const frames = writes.frames;
    const litBefore = writes.masks.at(-1)?.alphas.filter((alpha) => alpha > 0).length ?? 0;
    options = { ...options, density: 100 };
    stop.redraw();
    expect(writes.frames).toBe(frames + 1);
    const litAfter = writes.masks.at(-1)?.alphas.filter((alpha) => alpha > 0).length ?? 0;
    expect(litAfter).toBeGreaterThan(litBefore);
    expect(writes.surfaces).toBe(surfaces);
    expect(writes.glyphPaints).toBe(paints);
    stop();
  });
});
