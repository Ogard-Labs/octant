import { describe, expect, it } from "vitest";
import {
  decodeFleetActivity,
  decodeFleetActivityThread,
  MAX_FLEET_ACTIVITY_THREADS,
} from "./fleetActivity";

const working = {
  mode: "code",
  threadId: "44444444-4444-4444-8444-444444444444",
  title: "Fix the parser",
  projectName: "octant",
  state: "working",
  activitySource: "journal",
  since: "2026-10-06T08:00:00.000Z",
} as const;

describe("fleet activity contract", () => {
  it("names the source of every state it carries", () => {
    expect(decodeFleetActivityThread(working)).toEqual(working);
    expect(() => decodeFleetActivityThread({ ...working, activitySource: undefined })).toThrow();
    expect(() => decodeFleetActivityThread({ ...working, activitySource: "guess" })).toThrow();
  });

  it("refuses a needs-you state observed only on screen", () => {
    expect(
      decodeFleetActivityThread({ ...working, state: "needs-you", activitySource: "session" }),
    ).toMatchObject({ state: "needs-you" });
    expect(() =>
      decodeFleetActivityThread({ ...working, state: "needs-you", activitySource: "screen" }),
    ).toThrow();
    expect(decodeFleetActivityThread({ ...working, activitySource: "screen" })).toMatchObject({
      activitySource: "screen",
    });
  });

  it("carries no done state, because a finish is the reader's own observation", () => {
    expect(() => decodeFleetActivityThread({ ...working, state: "done" })).toThrow();
  });

  it("bounds the list and says when it was cut", () => {
    expect(decodeFleetActivity({ threads: [working], truncated: false }).threads).toHaveLength(1);
    expect(() =>
      decodeFleetActivity({
        threads: Array.from({ length: MAX_FLEET_ACTIVITY_THREADS + 1 }, () => working),
        truncated: true,
      }),
    ).toThrow();
    expect(() => decodeFleetActivity({ threads: [], truncated: false, extra: 1 })).toThrow();
  });
});
