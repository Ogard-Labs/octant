import { describe, expect, it } from "vitest";
import type { ZenElementPayload, ZenGeometry, ZenViewport } from "@octant/contracts/zen";
import type { AggregateVersion } from "@octant/contracts/events";
import {
  bringElementToFront,
  clampGeometryToBounds,
  computeVisibleRegion,
  computeZoomToFit,
  DEFAULT_ZEN_VIEWPORT_BOUNDS,
  DEFAULT_ZEN_VISIBLE_REGION,
  nudgeGeometry,
  reconcileOptimisticSpace,
  resizeGeometry,
  translateGeometry,
} from "./zenGeometry";

const baseGeo = (overrides: Partial<ZenGeometry> = {}): ZenGeometry => ({
  x: 100,
  y: 80,
  width: 320,
  height: 200,
  ...overrides,
});

function notesElement(
  id: string,
  zIndex: number,
  geometry: ZenGeometry = baseGeo(),
): ZenElementPayload {
  return {
    elementId: id as ZenElementPayload["elementId"],
    kind: "notes",
    widgetVersion: 0 as AggregateVersion,
    content: "hello",
    geometry,
    zIndex,
    minimized: false,
    locked: false,
  };
}

describe("zenGeometry", () => {
  it("translates geometry without changing size", () => {
    expect(translateGeometry(baseGeo(), 40, -20)).toEqual({
      x: 140,
      y: 60,
      width: 320,
      height: 200,
    });
  });

  it("clamps translated geometry into non-negative bounds", () => {
    expect(clampGeometryToBounds(baseGeo({ x: -50, y: -10 }), DEFAULT_ZEN_VIEWPORT_BOUNDS)).toEqual(
      {
        x: 0,
        y: 0,
        width: 320,
        height: 200,
      },
    );
  });

  it("nudges geometry for keyboard move steps", () => {
    expect(nudgeGeometry(baseGeo(), "ArrowRight", false)).toEqual(baseGeo({ x: 116 }));
    expect(nudgeGeometry(baseGeo(), "ArrowUp", true)).toEqual(baseGeo({ y: 40 }));
  });

  it("resizes from edges while respecting minimum size", () => {
    expect(resizeGeometry(baseGeo({ width: 220, height: 120 }), "se", 10, 15)).toEqual(
      baseGeo({ width: 230, height: 135 }),
    );
    expect(resizeGeometry(baseGeo({ width: 220, height: 120 }), "nw", 50, 50)).toEqual({
      x: 120,
      y: 100,
      width: 200,
      height: 100,
    });
  });

  it("brings a focused element to the front without colliding z-index", () => {
    const elements = [notesElement("a", 1), notesElement("b", 2), notesElement("c", 3)];
    const next = bringElementToFront(elements, "a" as ZenElementPayload["elementId"]);
    expect(next.map((el) => ({ id: el.elementId, z: el.zIndex }))).toEqual([
      { id: "a", z: 4 },
      { id: "b", z: 2 },
      { id: "c", z: 3 },
    ]);
  });

  it("computes zoom-to-fit for visible elements", () => {
    const elements = [
      notesElement("a", 1, baseGeo({ x: 0, y: 0, width: 400, height: 200 })),
      notesElement("b", 2, baseGeo({ x: 400, y: 200, width: 400, height: 200 })),
    ];
    const viewport = computeZoomToFit(elements, { width: 800, height: 600 }, 40);
    expect(viewport.scale).toBeLessThanOrEqual(1);
    expect(viewport.scale).toBeGreaterThan(0.1);
    expect(Number.isFinite(viewport.panX)).toBe(true);
    expect(Number.isFinite(viewport.panY)).toBe(true);
  });

  it("returns the default viewport when zoom-to-fit has no elements", () => {
    const viewport: ZenViewport = computeZoomToFit([], { width: 800, height: 600 }, 40);
    expect(viewport).toEqual({ panX: 0, panY: 0, scale: 1 });
  });

  it("reconciles optimistic local space against a newer server snapshot", () => {
    const local = {
      version: 2,
      elements: [notesElement("a", 1, baseGeo({ x: 10 }))],
    };
    const server = {
      version: 3,
      elements: [notesElement("a", 1, baseGeo({ x: 90 }))],
    };
    expect(reconcileOptimisticSpace(local, server).elements[0]?.geometry.x).toBe(90);
    expect(reconcileOptimisticSpace(local, server).version).toBe(3);
  });

  it("keeps optimistic local space when versions still match", () => {
    const local = {
      version: 2,
      elements: [notesElement("a", 1, baseGeo({ x: 10 }))],
    };
    const server = {
      version: 2,
      elements: [notesElement("a", 1, baseGeo({ x: 90 }))],
    };
    expect(reconcileOptimisticSpace(local, server).elements[0]?.geometry.x).toBe(10);
  });
});

describe("computeVisibleRegion", () => {
  it("reports the part of the space a panned, zoomed reader can see", () => {
    const region = computeVisibleRegion(
      { panX: -200, panY: -100, scale: 2 },
      { width: 1200, height: 800 },
    );

    expect(region).toEqual({ x: 100, y: 50, width: 600, height: 400 });
  });

  it("falls back to the whole space when the surface has not been measured yet", () => {
    const region = computeVisibleRegion({ panX: 0, panY: 0, scale: 1 }, { width: 0, height: 0 });

    expect(region).toEqual(DEFAULT_ZEN_VISIBLE_REGION);
  });
});
