import { describe, expect, it } from "vitest";
import {
  createScene,
  hashUnit,
  SCENE_SEED,
  type SceneKind,
  type SceneSample,
} from "./appBackdropScenes";

const KINDS: ReadonlyArray<SceneKind> = ["ridges", "burst", "drift"];

/** Every cell of a scene at time `t`, as one flat list of numbers. */
function render(kind: SceneKind, seed: number, t: number, columns = 90, rows = 56): number[] {
  const scene = createScene(kind, columns, rows, seed);
  scene.frame(t);
  const sample: SceneSample = { ink: 0, glow: 0 };
  const values: number[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      scene.read(column, row, sample);
      values.push(sample.ink, sample.glow);
    }
  }
  return values;
}

describe("the built-in pixel scenes", () => {
  it("draws the same picture for the same seed and a different one for another seed", () => {
    for (const kind of KINDS) {
      expect(render(kind, SCENE_SEED, 3.5)).toEqual(render(kind, SCENE_SEED, 3.5));
      expect(render(kind, SCENE_SEED, 3.5)).not.toEqual(render(kind, SCENE_SEED + 1, 3.5));
    }
  });

  it("keeps ink and glow between none and full", () => {
    for (const kind of KINDS) {
      for (const t of [0, 4.2, 61]) {
        for (const value of render(kind, SCENE_SEED, t)) {
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("moves slowly: a few seconds on, most cells are unchanged", () => {
    for (const kind of KINDS) {
      const before = render(kind, SCENE_SEED, 10);
      const after = render(kind, SCENE_SEED, 11);
      expect(after).not.toEqual(before);
      const same = before.filter((value, index) => Math.abs(value - (after[index] ?? 0)) < 0.2);
      expect(same.length / before.length).toBeGreaterThan(0.8);
    }
  });

  it("puts the ridges' sun on one side of the horizon, saturated at its core, with ink beneath it", () => {
    const columns = 120;
    const rows = 70;
    const scene = createScene("ridges", columns, rows, SCENE_SEED);
    scene.frame(0);
    const sample: SceneSample = { ink: 0, glow: 0 };
    let glowTotal = 0;
    let glowMoment = 0;
    let peak = 0;
    let lowerInk = 0;
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        scene.read(column, row, sample);
        glowTotal += sample.glow;
        glowMoment += sample.glow * column;
        peak = Math.max(peak, sample.glow);
        if (row > rows * 0.75) lowerInk += sample.ink;
      }
    }
    expect(Math.abs(glowMoment / glowTotal - columns / 2)).toBeGreaterThan(columns * 0.15);
    expect(peak).toBe(1);
    expect(lowerInk).toBeGreaterThan(0);
  });

  it("draws the ridges' crests at near full ink over a mostly empty sky", () => {
    const columns = 120;
    const rows = 70;
    const scene = createScene("ridges", columns, rows, SCENE_SEED);
    scene.frame(0);
    const sample: SceneSample = { ink: 0, glow: 0 };
    let skyInk = 0;
    let skyCells = 0;
    let brightCells = 0;
    for (let row = 0; row < rows * 0.3; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        scene.read(column, row, sample);
        skyInk += sample.ink;
        skyCells += 1;
      }
    }
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        scene.read(column, row, sample);
        if (sample.ink > 0.9) brightCells += 1;
      }
    }
    expect(skyInk / skyCells).toBeLessThan(0.02);
    expect(brightCells).toBeGreaterThan(columns);
  });

  it("keeps a burst's glow to one corner", () => {
    const columns = 120;
    const rows = 70;
    const scene = createScene("burst", columns, rows, SCENE_SEED);
    scene.frame(0);
    const sample: SceneSample = { ink: 0, glow: 0 };
    let corner = 0;
    let far = 0;
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        scene.read(column, row, sample);
        const onLeft = column < columns / 2;
        if (row < rows / 2 && !onLeft) corner += sample.glow;
        if (row >= rows / 2 && onLeft) far += sample.glow;
      }
    }
    expect(corner).toBeGreaterThan(far * 5);
  });

  it("hashes to the unit interval", () => {
    for (let index = -50; index < 50; index += 1) {
      const value = hashUnit(SCENE_SEED, index);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});
