import type { ZenVisibleRegion } from "@octant/domain";
import {
  DEFAULT_ZEN_VIEWPORT,
  MAX_ZEN_ELEMENT_HEIGHT,
  MAX_ZEN_ELEMENT_WIDTH,
  MIN_ZEN_ELEMENT_HEIGHT,
  MIN_ZEN_ELEMENT_WIDTH,
  type ZenElementId,
  type ZenElementPayload,
  type ZenGeometry,
  type ZenViewport,
} from "@octant/contracts/zen";

export interface ZenViewportBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export const DEFAULT_ZEN_VIEWPORT_BOUNDS: ZenViewportBounds = {
  minX: 0,
  minY: 0,
  maxX: 10000,
  maxY: 10000,
};

const KEYBOARD_NUDGE = 16;
const KEYBOARD_NUDGE_LARGE = 40;

export function translateGeometry(geometry: ZenGeometry, dx: number, dy: number): ZenGeometry {
  return {
    x: geometry.x + dx,
    y: geometry.y + dy,
    width: geometry.width,
    height: geometry.height,
  };
}

export function clampGeometryToBounds(
  geometry: ZenGeometry,
  bounds: ZenViewportBounds = DEFAULT_ZEN_VIEWPORT_BOUNDS,
): ZenGeometry {
  const width = clamp(geometry.width, MIN_ZEN_ELEMENT_WIDTH, MAX_ZEN_ELEMENT_WIDTH);
  const height = clamp(geometry.height, MIN_ZEN_ELEMENT_HEIGHT, MAX_ZEN_ELEMENT_HEIGHT);
  const maxX = Math.max(bounds.minX, bounds.maxX - width);
  const maxY = Math.max(bounds.minY, bounds.maxY - height);
  return {
    x: clamp(geometry.x, bounds.minX, maxX),
    y: clamp(geometry.y, bounds.minY, maxY),
    width,
    height,
  };
}

export function nudgeGeometry(
  geometry: ZenGeometry,
  key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown",
  largeStep: boolean,
): ZenGeometry {
  const step = largeStep ? KEYBOARD_NUDGE_LARGE : KEYBOARD_NUDGE;
  switch (key) {
    case "ArrowLeft":
      return translateGeometry(geometry, -step, 0);
    case "ArrowRight":
      return translateGeometry(geometry, step, 0);
    case "ArrowUp":
      return translateGeometry(geometry, 0, -step);
    case "ArrowDown":
      return translateGeometry(geometry, 0, step);
  }
}

export type ZenResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export function resizeGeometry(
  geometry: ZenGeometry,
  edge: ZenResizeEdge,
  dx: number,
  dy: number,
): ZenGeometry {
  let { x, y, width, height } = geometry;

  if (edge.includes("e")) {
    width = clamp(width + dx, MIN_ZEN_ELEMENT_WIDTH, MAX_ZEN_ELEMENT_WIDTH);
  }
  if (edge.includes("s")) {
    height = clamp(height + dy, MIN_ZEN_ELEMENT_HEIGHT, MAX_ZEN_ELEMENT_HEIGHT);
  }
  if (edge.includes("w")) {
    const nextWidth = clamp(width - dx, MIN_ZEN_ELEMENT_WIDTH, MAX_ZEN_ELEMENT_WIDTH);
    x += width - nextWidth;
    width = nextWidth;
  }
  if (edge.includes("n")) {
    const nextHeight = clamp(height - dy, MIN_ZEN_ELEMENT_HEIGHT, MAX_ZEN_ELEMENT_HEIGHT);
    y += height - nextHeight;
    height = nextHeight;
  }

  return { x, y, width, height };
}

export function bringElementToFront(
  elements: ReadonlyArray<ZenElementPayload>,
  elementId: ZenElementId,
): ZenElementPayload[] {
  const target = elements.find((el) => el.elementId === elementId);
  if (target === undefined) return [...elements];
  const maxZ = elements.reduce((max, el) => Math.max(max, el.zIndex), 0);
  const nextZ = Math.min(maxZ + 1, 1000);
  return elements.map((el) => (el.elementId === elementId ? { ...el, zIndex: nextZ } : el));
}

export function computeZoomToFit(
  elements: ReadonlyArray<ZenElementPayload>,
  viewportSize: { readonly width: number; readonly height: number },
  padding: number,
): ZenViewport {
  if (elements.length === 0) {
    return { ...DEFAULT_ZEN_VIEWPORT };
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const element of elements) {
    if (element.minimized) continue;
    const { x, y, width, height } = element.geometry;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + width);
    maxY = Math.max(maxY, y + height);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return { ...DEFAULT_ZEN_VIEWPORT };
  }

  const contentWidth = Math.max(1, maxX - minX);
  const contentHeight = Math.max(1, maxY - minY);
  const availableWidth = Math.max(1, viewportSize.width - padding * 2);
  const availableHeight = Math.max(1, viewportSize.height - padding * 2);
  const scale = clamp(
    Math.min(availableWidth / contentWidth, availableHeight / contentHeight),
    0.1,
    5,
  );
  const panX = padding + (availableWidth - contentWidth * scale) / 2 - minX * scale;
  const panY = padding + (availableHeight - contentHeight * scale) / 2 - minY * scale;
  return {
    panX: clamp(panX, -10000, 10000),
    panY: clamp(panY, -10000, 10000),
    scale,
  };
}

/**
 * The whole placeable space, used before the surface has been measured.
 *
 * A zero-sized surface means the first render has not laid out yet, not that
 * the reader can see nothing — freezing every card on that frame would tear
 * down streams a moment after opening them.
 */
export const DEFAULT_ZEN_VISIBLE_REGION: ZenVisibleRegion = {
  x: DEFAULT_ZEN_VIEWPORT_BOUNDS.minX,
  y: DEFAULT_ZEN_VIEWPORT_BOUNDS.minY,
  width: DEFAULT_ZEN_VIEWPORT_BOUNDS.maxX - DEFAULT_ZEN_VIEWPORT_BOUNDS.minX,
  height: DEFAULT_ZEN_VIEWPORT_BOUNDS.maxY - DEFAULT_ZEN_VIEWPORT_BOUNDS.minY,
};

/** Invert the canvas pan and zoom to say which part of the space is on screen. */
export function computeVisibleRegion(
  viewport: ZenViewport,
  surfaceSize: { readonly width: number; readonly height: number },
): ZenVisibleRegion {
  if (surfaceSize.width <= 0 || surfaceSize.height <= 0 || viewport.scale <= 0) {
    return DEFAULT_ZEN_VISIBLE_REGION;
  }
  return {
    x: -viewport.panX / viewport.scale,
    y: -viewport.panY / viewport.scale,
    width: surfaceSize.width / viewport.scale,
    height: surfaceSize.height / viewport.scale,
  };
}

export interface OptimisticSpaceSlice {
  readonly version: number;
  readonly elements: ReadonlyArray<ZenElementPayload>;
}

export function reconcileOptimisticSpace<T extends OptimisticSpaceSlice>(local: T, server: T): T {
  if (server.version > local.version) {
    return server;
  }
  return local;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
