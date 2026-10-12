import {
  CANVAS_DESIGN_BRIDGE_MAX_ERROR_LENGTH,
  CANVAS_MAX_BLOCKS,
  CANVAS_MAX_DESIGN_FRAMES,
} from "@octant/contracts/canvas";
import type { Frame, Page } from "playwright-core";

/**
 * What the host's browser measured in the design frames it drew for a preview.
 *
 * A design is markup, so how it reads cannot be computed from the document the
 * way a chart's can: whether a frame is wider than its page, whether its text
 * clears its contrast target, and whether a running design threw are facts of
 * the drawn page. The host reads them from the same frames the screenshot
 * shows, after the page has settled.
 *
 * A running design's frame holds the author's script, so everything read from
 * inside a frame is a claim to bound, never a value to trust: each reading is
 * checked for shape and size here, and a frame that does not answer in time is
 * left unmeasured.
 */
export interface CanvasPreviewDesignReading {
  readonly blockId: string;
  /**
   * False when the look ran out of time before this design's frames were
   * read, so the absence of a warning about it says nothing.
   */
  readonly measured: boolean;
  /** The first uncaught errors the running design's bridge reported, as text. */
  readonly scriptErrors: ReadonlyArray<string>;
  readonly overflow: ReadonlyArray<CanvasPreviewFrameOverflow>;
  readonly contrast: ReadonlyArray<CanvasPreviewFrameContrast>;
}

export interface CanvasPreviewFrameOverflow {
  readonly frameId: string;
  /** How far the frame's content runs past its page, in CSS pixels. */
  readonly overflowPx: number;
}

export interface CanvasPreviewFrameContrast {
  readonly frameId: string;
  /** The start of the text that reads worst in this frame. */
  readonly text: string;
  readonly foreground: string;
  readonly background: string;
  readonly ratio: number;
  readonly target: number;
}

/** A design holds at most this many frames. */
const MAX_FRAMES_PER_DESIGN = CANVAS_MAX_DESIGN_FRAMES;
/** The first errors of a design are kept; the root cause is among them. */
export const CANVAS_PREVIEW_MAX_SCRIPT_ERRORS = 8;
/** A frame that has not answered by now is left unmeasured. */
const FRAME_READ_TIMEOUT_MS = 2_000;
/**
 * How long reading every design's frames may take. Every design the page drew
 * is read, however many; past this the rest are reported as not measured
 * rather than left out as if they were clean.
 */
const FRAME_READ_BUDGET_MS = 10_000;
const FRAME_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HEX_COLOR = /^#[0-9a-f]{6}$/;

/**
 * Runs inside one design frame's page. Self-contained: the browser receives
 * its source, so it can name nothing outside itself.
 *
 * Overflow is a frame whose content is wider than the page it is drawn in.
 * Contrast is read per text node against the nearest opaque background behind
 * it; text over an image or gradient, or in a colour the page does not report
 * as sRGB, is left unmeasured rather than guessed. Large text (24px, or 18.66px
 * bold) needs 3:1 and other text 4.5:1 (WCAG 1.4.3). Only the worst text of
 * each frame is returned.
 */
export function measureDesignFrame(): unknown {
  const MAX_TEXT_NODES = 1_500;
  const root = document.documentElement;
  const pageWidth = root.clientWidth;
  const parse = (color: string): { r: number; g: number; b: number; a: number } | undefined => {
    const match = /^rgba?\(([^)]+)\)$/.exec(color.trim());
    if (match === null || match[1] === undefined) return undefined;
    const parts = match[1]
      .split(/[\s,/]+/)
      .filter((part) => part.length > 0)
      .map(Number);
    const [r, g, b, a = 1] = parts;
    if (r === undefined || g === undefined || b === undefined) return undefined;
    if (![r, g, b, a].every((part) => Number.isFinite(part))) return undefined;
    return { r, g, b, a };
  };
  const luminance = (color: { r: number; g: number; b: number }): number => {
    const channel = (value: number): number => {
      const unit = value / 255;
      return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
  };
  const hex = (color: { r: number; g: number; b: number }): string =>
    `#${[color.r, color.g, color.b]
      .map((value) =>
        Math.max(0, Math.min(255, Math.round(value)))
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")}`;
  const over = (
    top: { r: number; g: number; b: number; a: number },
    under: { r: number; g: number; b: number },
  ): { r: number; g: number; b: number } => ({
    r: top.r * top.a + under.r * (1 - top.a),
    g: top.g * top.a + under.g * (1 - top.a),
    b: top.b * top.a + under.b * (1 - top.a),
  });
  // The colour behind an element: the nearest opaque fill, with any
  // translucent fills above it laid over. `undefined` when an image or a
  // gradient sits behind the text, or a fill is not reported as sRGB.
  const backgroundBehind = (element: Element): { r: number; g: number; b: number } | undefined => {
    const layers: Array<{ r: number; g: number; b: number; a: number }> = [];
    let base: { r: number; g: number; b: number } | undefined;
    for (let node: Element | null = element; node !== null; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.backgroundImage !== "none") return undefined;
      const fill = parse(style.backgroundColor);
      if (fill === undefined) return undefined;
      if (fill.a >= 1) {
        base = fill;
        break;
      }
      if (fill.a > 0) layers.push(fill);
    }
    // No opaque fill anywhere: the page's own canvas, white unless the page
    // asks for a dark scheme.
    let color =
      base ??
      (getComputedStyle(root).colorScheme.includes("dark") &&
      !getComputedStyle(root).colorScheme.includes("light")
        ? { r: 18, g: 18, b: 18 }
        : { r: 255, g: 255, b: 255 });
    for (let index = layers.length - 1; index >= 0; index -= 1) {
      const layer = layers[index];
      if (layer !== undefined) color = over(layer, color);
    }
    return color;
  };

  const overflow: Array<{ frameId: string; overflowPx: number }> = [];
  const frames = Array.from(document.querySelectorAll(".octant-frame")).filter(
    (frame) => frame.getClientRects().length > 0,
  );
  for (const frame of frames) {
    const past = frame.scrollWidth - pageWidth;
    if (past > 1) overflow.push({ frameId: frame.id, overflowPx: Math.round(past) });
  }
  const first = frames[0];
  if (overflow.length === 0 && first !== undefined && root.scrollWidth - pageWidth > 1) {
    overflow.push({ frameId: first.id, overflowPx: Math.round(root.scrollWidth - pageWidth) });
  }

  const worst = new Map<
    string,
    { text: string; foreground: string; background: string; ratio: number; target: number }
  >();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let seen = 0;
  for (
    let node = walker.nextNode();
    node !== null && seen < MAX_TEXT_NODES;
    node = walker.nextNode()
  ) {
    const text = (node.textContent ?? "").trim();
    const element = node.parentElement;
    if (text.length === 0 || element === null) continue;
    if (element.closest("script, style, noscript, template") !== null) continue;
    seen += 1;
    const frame = element.closest(".octant-frame");
    if (frame === null || frame.getClientRects().length === 0) continue;
    if (element.getClientRects().length === 0) continue;
    const style = getComputedStyle(element);
    if (style.visibility !== "visible") continue;
    const ink = parse(style.color);
    if (ink === undefined || ink.a === 0) continue;
    const background = backgroundBehind(element);
    if (background === undefined) continue;
    const foreground = over(ink, background);
    const light = Math.max(luminance(foreground), luminance(background));
    const dark = Math.min(luminance(foreground), luminance(background));
    const ratio = (light + 0.05) / (dark + 0.05);
    const size = Number.parseFloat(style.fontSize);
    const bold = Number.parseInt(style.fontWeight, 10) >= 700;
    const target = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
    if (ratio >= target) continue;
    const known = worst.get(frame.id);
    // Worst is the one furthest below its own target.
    if (known !== undefined && known.ratio / known.target <= ratio / target) continue;
    worst.set(frame.id, {
      text: text.slice(0, 60),
      foreground: hex(foreground),
      background: hex(background),
      ratio: Math.round(ratio * 100) / 100,
      target,
    });
  }
  return {
    overflow,
    contrast: Array.from(worst, ([frameId, reading]) => ({ frameId, ...reading })),
  };
}

/**
 * One frame's answer, kept only where it has the shape and bounds asked for.
 * A running design's script shares the page the reading came from, so a
 * missing field, a wrong type, or an oversized string drops that entry.
 */
export function boundedFrameReading(value: unknown): {
  readonly overflow: ReadonlyArray<CanvasPreviewFrameOverflow>;
  readonly contrast: ReadonlyArray<CanvasPreviewFrameContrast>;
} {
  const record = isRecord(value) ? value : {};
  const overflow: CanvasPreviewFrameOverflow[] = [];
  for (const entry of asArray(record.overflow).slice(0, MAX_FRAMES_PER_DESIGN)) {
    if (!isRecord(entry)) continue;
    const { frameId, overflowPx } = entry;
    if (typeof frameId !== "string" || !FRAME_ID.test(frameId)) continue;
    if (typeof overflowPx !== "number" || !Number.isFinite(overflowPx) || overflowPx <= 0) continue;
    overflow.push({ frameId, overflowPx: Math.min(100_000, Math.round(overflowPx)) });
  }
  const contrast: CanvasPreviewFrameContrast[] = [];
  for (const entry of asArray(record.contrast).slice(0, MAX_FRAMES_PER_DESIGN)) {
    if (!isRecord(entry)) continue;
    const { frameId, text, foreground, background, ratio, target } = entry;
    if (typeof frameId !== "string" || !FRAME_ID.test(frameId)) continue;
    if (typeof text !== "string" || text.length === 0) continue;
    if (typeof foreground !== "string" || !HEX_COLOR.test(foreground)) continue;
    if (typeof background !== "string" || !HEX_COLOR.test(background)) continue;
    if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 1 || ratio > 21) continue;
    if (target !== 3 && target !== 4.5) continue;
    if (ratio >= target) continue;
    contrast.push({ frameId, text: text.slice(0, 60), foreground, background, ratio, target });
  }
  return { overflow, contrast };
}

/**
 * Every design the preview page drew, measured. A design in a tab that is not
 * open is not drawn and so is not measured.
 */
export async function readPreviewDesignFrames(
  page: Page,
  now: () => number = Date.now,
): Promise<ReadonlyArray<CanvasPreviewDesignReading>> {
  const readings: CanvasPreviewDesignReading[] = [];
  const errors = boundedScriptErrors(
    await page.getAttribute("html", CANVAS_PREVIEW_SCRIPT_ERRORS_ATTRIBUTE),
  );
  const deadline = now() + FRAME_READ_BUDGET_MS;
  const designs = await page.locator("section.canvas-design[data-canvas-design]").all();
  for (const design of designs.slice(0, CANVAS_MAX_BLOCKS)) {
    const blockId = await design.getAttribute("data-canvas-design");
    if (blockId === null) continue;
    const scriptErrors = errors.get(blockId) ?? [];
    if (now() >= deadline) {
      readings.push({ blockId, measured: false, scriptErrors, overflow: [], contrast: [] });
      continue;
    }
    const answers: unknown[] = [];
    const frames = await design.locator("iframe").elementHandles();
    for (const element of frames.slice(0, MAX_FRAMES_PER_DESIGN)) {
      const frame = await element.contentFrame();
      answers.push(frame === null ? undefined : await readFrame(frame));
    }
    readings.push({ blockId, scriptErrors, ...designFrameReadings(answers) });
  }
  return readings;
}

/**
 * One design from what each of its frames answered. A frame that threw, hung,
 * or held no page answers `undefined`, and the design is then not measured:
 * that frame may overflow or read badly and nothing says so. The frames that
 * did answer keep what they found.
 */
export function designFrameReadings(
  answers: ReadonlyArray<unknown>,
): Pick<CanvasPreviewDesignReading, "measured" | "overflow" | "contrast"> {
  const overflow: CanvasPreviewFrameOverflow[] = [];
  const contrast: CanvasPreviewFrameContrast[] = [];
  for (const answer of answers) {
    const reading = boundedFrameReading(answer);
    overflow.push(...reading.overflow);
    contrast.push(...reading.contrast);
  }
  return { measured: !answers.includes(undefined), overflow, contrast };
}

/**
 * Where the preview page records the script errors each running design's
 * bridge reported, as JSON keyed by block id. The page keeps the first of
 * them itself: the app's own list under a prototype shows only the latest
 * few, which is the wrong end for finding what broke first.
 */
export const CANVAS_PREVIEW_SCRIPT_ERRORS_ATTRIBUTE = "data-canvas-preview-script-errors";

/** The recorded errors, kept only in the shape and bounds asked for. */
export function boundedScriptErrors(recorded: string | null): ReadonlyMap<string, string[]> {
  const errors = new Map<string, string[]>();
  if (recorded === null) return errors;
  let parsed: unknown;
  try {
    parsed = JSON.parse(recorded);
  } catch {
    return errors;
  }
  if (!isRecord(parsed)) return errors;
  for (const [blockId, messages] of Object.entries(parsed).slice(0, CANVAS_MAX_BLOCKS)) {
    const kept = asArray(messages)
      .filter((message): message is string => typeof message === "string" && message.length > 0)
      .slice(0, CANVAS_PREVIEW_MAX_SCRIPT_ERRORS)
      .map((message) => message.slice(0, CANVAS_DESIGN_BRIDGE_MAX_ERROR_LENGTH));
    if (kept.length > 0) errors.set(blockId, kept);
  }
  return errors;
}

async function readFrame(frame: Frame): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      frame.evaluate(measureDesignFrame),
      new Promise<undefined>((resolvePromise) => {
        timer = setTimeout(() => resolvePromise(undefined), FRAME_READ_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): ReadonlyArray<unknown> {
  return Array.isArray(value) ? value : [];
}
