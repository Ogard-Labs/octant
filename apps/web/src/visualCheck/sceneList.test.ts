import { expect, it } from "vitest";
import { updateMode } from "./sceneList";

it("compares, and never writes baselines, unless asked for exactly", () => {
  expect(updateMode(undefined)).toBe("off");
  expect(updateMode("")).toBe("off");
  expect(updateMode("0")).toBe("off");
  expect(updateMode("true")).toBe("off");
  expect(updateMode("1")).toBe("changed");
  expect(updateMode("all")).toBe("all");
});
