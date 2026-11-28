import { expect, it } from "vitest";
import { GROUND_TOLERANCE, SCENE_LIST, updateMode } from "./sceneList";

it("compares, and never writes baselines, unless asked for exactly", () => {
  expect(updateMode(undefined)).toBe("off");
  expect(updateMode("")).toBe("off");
  expect(updateMode("0")).toBe("off");
  expect(updateMode("true")).toBe("off");
  expect(updateMode("1")).toBe("changed");
  expect(updateMode("all")).toBe("all");
});

it("checks every ground scene with the finer tolerance, so a faint field that vanishes fails", () => {
  const grounds = SCENE_LIST.filter((scene) => scene.id.startsWith("ground-"));
  expect(grounds.length).toBeGreaterThan(0);
  for (const scene of grounds) expect(scene.tolerance).toBe(GROUND_TOLERANCE);
});
