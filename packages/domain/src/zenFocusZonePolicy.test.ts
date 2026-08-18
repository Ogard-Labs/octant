import { describe, expect, it } from "vitest";
import type { AggregateVersion, UtcTimestamp, ZenFocusZone } from "@octant/contracts";
import {
  applyZenFocusZoneCommand,
  createZenFocusZone,
  cycleZenSpace,
  MAX_ZEN_SPACES_PER_WINDOW,
  ZenFocusZoneRejected,
} from "./zenFocusZonePolicy";

const windowId = "10000000-0000-4000-8000-000000000001" as never;
const first = "20000000-0000-4000-8000-000000000001" as never;
const second = "20000000-0000-4000-8000-000000000002" as never;
const third = "20000000-0000-4000-8000-000000000003" as never;
const now = "2026-08-18T09:00:00.000Z" as UtcTimestamp;

function zone(): ZenFocusZone {
  return createZenFocusZone(windowId, first, "Focus", now);
}

function withThree(): ZenFocusZone {
  const two = applyZenFocusZoneCommand(
    zone(),
    { command: "add-space", name: "Research", expectedVersion: 1 as AggregateVersion },
    { spaceId: second, now },
  ).zone;
  return applyZenFocusZoneCommand(
    two,
    { command: "add-space", name: "Review", expectedVersion: 2 as AggregateVersion },
    { spaceId: third, now },
  ).zone;
}

describe("opening a focus zone", () => {
  it("starts with one named space, in front", () => {
    const created = zone();

    expect(created.spaces).toEqual([{ spaceId: first, name: "Focus", position: 0 }]);
    expect(created.activeSpaceId).toBe(first);
    expect(created.version).toBe(1);
  });
});

describe("adding a space", () => {
  it("puts it last and brings it to the front, because that is why you added it", () => {
    const added = applyZenFocusZoneCommand(
      zone(),
      { command: "add-space", name: "Research", expectedVersion: 1 as AggregateVersion },
      { spaceId: second, now },
    );

    expect(added.zone.spaces.map((space) => space.name)).toEqual(["Focus", "Research"]);
    expect(added.zone.activeSpaceId).toBe(second);
    expect(added.activated).toBe(second);
  });

  it("refuses more spaces than a switcher can stay useful with", () => {
    let current = zone();
    for (let index = 1; index < MAX_ZEN_SPACES_PER_WINDOW; index += 1) {
      current = applyZenFocusZoneCommand(
        current,
        {
          command: "add-space",
          name: `Space ${String(index)}`,
          expectedVersion: current.version,
        },
        {
          spaceId:
            `20000000-0000-4000-8000-0000000000${String(index + 10).padStart(2, "0")}` as never,
          now,
        },
      ).zone;
    }

    expect(current.spaces).toHaveLength(MAX_ZEN_SPACES_PER_WINDOW);
    expect(() =>
      applyZenFocusZoneCommand(
        current,
        { command: "add-space", name: "One too many", expectedVersion: current.version },
        { spaceId: "20000000-0000-4000-8000-0000000000ff" as never, now },
      ),
    ).toThrow(ZenFocusZoneRejected);
  });
});

describe("switching between spaces", () => {
  it("names the space to leave as well as the one to show", () => {
    const three = withThree();

    const switched = applyZenFocusZoneCommand(
      three,
      { command: "activate-space", spaceId: first, expectedVersion: three.version },
      { now },
    );

    expect(switched.zone.activeSpaceId).toBe(first);
    // The caller has to clear the leaving space's own showing flag, so the
    // policy says which one it was rather than leaving it to be guessed.
    expect(switched.deactivated).toBe(third);
    expect(switched.activated).toBe(first);
  });

  it("refuses a space this window does not hold", () => {
    const three = withThree();

    expect(() =>
      applyZenFocusZoneCommand(
        three,
        {
          command: "activate-space",
          spaceId: "20000000-0000-4000-8000-0000000000aa" as never,
          expectedVersion: three.version,
        },
        { now },
      ),
    ).toThrow(/space/i);
  });

  it("cycles forward and wraps, so one keystroke reaches every space", () => {
    const three = withThree();

    expect(cycleZenSpace(three, 1)).toBe(first);
    expect(cycleZenSpace({ ...three, activeSpaceId: first }, 1)).toBe(second);
    expect(cycleZenSpace({ ...three, activeSpaceId: first }, -1)).toBe(third);
  });

  it("cycles to the same space when the window has only one", () => {
    expect(cycleZenSpace(zone(), 1)).toBe(first);
  });
});

describe("renaming and reordering", () => {
  it("renames one space and leaves the order alone", () => {
    const three = withThree();

    const renamed = applyZenFocusZoneCommand(
      three,
      { command: "rename-space", spaceId: first, name: "Bug hunt", expectedVersion: three.version },
      { now },
    ).zone;

    expect(renamed.spaces.map((space) => space.name)).toEqual(["Bug hunt", "Research", "Review"]);
  });

  it("moves a space and keeps the positions contiguous", () => {
    const three = withThree();

    const moved = applyZenFocusZoneCommand(
      three,
      { command: "reorder-space", spaceId: third, position: 0, expectedVersion: three.version },
      { now },
    ).zone;

    expect(moved.spaces.map((space) => [space.name, space.position])).toEqual([
      ["Review", 0],
      ["Focus", 1],
      ["Research", 2],
    ]);
  });
});

describe("removing a space", () => {
  it("hands the front to a neighbour rather than to nothing", () => {
    const three = withThree();

    const removed = applyZenFocusZoneCommand(
      three,
      { command: "remove-space", spaceId: third, expectedVersion: three.version },
      { now },
    );

    expect(removed.zone.spaces.map((space) => space.name)).toEqual(["Focus", "Research"]);
    expect(removed.zone.activeSpaceId).toBe(second);
    expect(removed.activated).toBe(second);
  });

  it("refuses to remove the last space, because a zone with none cannot be shown", () => {
    const only = zone();

    expect(() =>
      applyZenFocusZoneCommand(
        only,
        { command: "remove-space", spaceId: first, expectedVersion: only.version },
        { now },
      ),
    ).toThrow(/last/i);
  });
});

describe("every focus-zone command", () => {
  it("refuses a version the caller did not actually read", () => {
    const three = withThree();

    expect(() =>
      applyZenFocusZoneCommand(
        three,
        { command: "activate-space", spaceId: first, expectedVersion: 99 as AggregateVersion },
        { now },
      ),
    ).toThrow(/moved under this command/i);
  });
});
