import { expect, it } from "vitest";
import {
  CHANNEL_TOLERANCE,
  GROUND_TOLERANCE,
  updateMode,
  visualShard,
  visualShots,
} from "./sceneList";

it("compares, and never writes baselines, unless asked for exactly", () => {
  expect(updateMode(undefined)).toBe("off");
  expect(updateMode("")).toBe("off");
  expect(updateMode("0")).toBe("off");
  expect(updateMode("true")).toBe("off");
  expect(updateMode("1")).toBe("changed");
  expect(updateMode("all")).toBe("all");
});

it("compares every ground picture at the finer tolerance and every other at the default", () => {
  const shots = visualShots();
  const grounds = shots.filter((shot) => shot.scene.startsWith("ground-"));
  expect(grounds.length).toBeGreaterThan(0);
  for (const shot of grounds) expect(shot.tolerance).toBe(GROUND_TOLERANCE);
  for (const shot of shots.filter((each) => !each.scene.startsWith("ground-")))
    expect(shot.tolerance).toBe(CHANNEL_TOLERANCE);
});

it("splits the pictures into shards that together take each one exactly once", () => {
  const all = visualShots().map((shot) => shot.name);
  const first = visualShots({ index: 1, count: 2 }).map((shot) => shot.name);
  const second = visualShots({ index: 2, count: 2 }).map((shot) => shot.name);
  expect([...first, ...second].toSorted()).toEqual([...all].toSorted());
  expect(first.filter((name) => second.includes(name))).toEqual([]);
});

it("draws every picture when the shard is missing or malformed, never none", () => {
  expect(visualShard("2/2")).toEqual({ index: 2, count: 2 });
  for (const value of [undefined, "", "2", "0/2", "3/2", "1/0", "a/b"])
    expect(visualShard(value)).toBeUndefined();
});
