import { describe, expect, it } from "vitest";
import {
  ROUTINE_REQUEST_SUGGESTIONS,
  draftRoutineFromRequest,
  type RoutineRequestContext,
} from "./routineRequestDraft";

const context: RoutineRequestContext = {
  now: "2026-08-18T08:00:00.000Z",
  timeZone: "UTC",
};

describe("drafting a routine from a plain-English request", () => {
  it("reads a weekday schedule and keeps the work separate from the schedule", () => {
    const draft = draftRoutineFromRequest(
      "Every weekday at 9:00, summarise what changed overnight",
      context,
    );

    expect(draft.trigger).toEqual({
      kind: "weekly-local",
      weekdays: [1, 2, 3, 4, 5],
      localTime: "09:00",
      timeZone: "UTC",
    });
    // The schedule is the host's job now, so the prompt must not repeat it.
    expect(draft.prompt).toBe("summarise what changed overnight");
    expect(draft.needsSchedule).toBe(false);
  });

  it("reads a named weekday", () => {
    expect(
      draftRoutineFromRequest("Every Monday at 9:00, plan the week", context).trigger,
    ).toMatchObject({ kind: "weekly-local", weekdays: [1] });
  });

  it("reads an hourly cadence and does not invent a time of day for it", () => {
    const draft = draftRoutineFromRequest("Every hour, check the test suite", context);

    expect(draft.trigger).toEqual({
      kind: "interval",
      anchorAt: "2026-08-18T08:00:00.000Z",
      intervalMinutes: 60,
    });
  });

  it("anchors a daily routine at the time that was asked for", () => {
    expect(draftRoutineFromRequest("Every day at 17:00, write a digest", context).trigger).toEqual({
      kind: "interval",
      anchorAt: "2026-08-18T17:00:00.000Z",
      intervalMinutes: 1_440,
    });
  });

  it("rolls a daily routine to the next day when the time has already passed", () => {
    expect(
      draftRoutineFromRequest("Every day at 7:00, write a digest", context).trigger,
    ).toMatchObject({ anchorAt: "2026-08-19T07:00:00.000Z" });
  });

  it("reads a one-time request for tomorrow", () => {
    expect(
      draftRoutineFromRequest("Tomorrow at 10:00, review the open pull requests", context).trigger,
    ).toEqual({ kind: "once", scheduledAt: "2026-08-19T10:00:00.000Z" });
  });

  it("never reads a bare count as a time of day", () => {
    // "every 3 days" must not become "at 03:00".
    expect(draftRoutineFromRequest("Every 3 days, tidy the board", context).trigger).toEqual({
      kind: "interval",
      anchorAt: "2026-08-18T08:00:00.000Z",
      intervalMinutes: 4_320,
    });
  });

  it("keeps the time when a count comes before it", () => {
    // "3" is a count, not 03:00 — but stopping there would throw away the 9am
    // the person actually asked for.
    expect(draftRoutineFromRequest("Every 3 days at 9am, tidy the board", context).trigger).toEqual(
      {
        kind: "interval",
        anchorAt: "2026-08-18T09:00:00.000Z",
        intervalMinutes: 4_320,
      },
    );
    expect(draftRoutineFromRequest("Every 3 days at 9am, tidy the board", context).prompt).toBe(
      "tidy the board",
    );
  });

  it("reads am and pm rather than assuming a 24-hour clock", () => {
    expect(
      draftRoutineFromRequest("Every day at 5pm, do the thing", context).trigger,
    ).toMatchObject({ anchorAt: "2026-08-18T17:00:00.000Z" });
    expect(
      draftRoutineFromRequest("Every day at 12am, do the thing", context).trigger,
    ).toMatchObject({ anchorAt: "2026-08-19T00:00:00.000Z" });
  });

  it("asks for a schedule rather than guessing one it could not read", () => {
    const draft = draftRoutineFromRequest("Keep an eye on the deploy queue", context);

    expect(draft.trigger).toBeUndefined();
    expect(draft.needsSchedule).toBe(true);
    expect(draft.scheduleSummary).toContain("Could not read a schedule");
    // The work survives even when the schedule does not.
    expect(draft.prompt).toBe("Keep an eye on the deploy queue");
  });

  it("names the routine from the work it describes", () => {
    expect(draftRoutineFromRequest("Every day at 9:00, review open PRs", context).name).toBe(
      "Review open PRs",
    );
  });

  it("returns an empty draft for an empty request rather than throwing", () => {
    expect(draftRoutineFromRequest("   ", context)).toMatchObject({
      name: "",
      needsSchedule: true,
    });
  });

  it("drafts a complete routine from every suggestion it offers", () => {
    for (const suggestion of ROUTINE_REQUEST_SUGGESTIONS) {
      const draft = draftRoutineFromRequest(suggestion.request, context);
      expect(draft.needsSchedule, suggestion.label).toBe(false);
      expect(draft.prompt.length, suggestion.label).toBeGreaterThan(0);
    }
  });

  it("puts a routine in the requested zone rather than the host's", () => {
    const draft = draftRoutineFromRequest("Every day at 9:00, do the thing", {
      now: "2026-08-18T08:00:00.000Z",
      timeZone: "America/Los_Angeles",
    });

    // 09:00 in Los Angeles on 18 Aug is 16:00Z, which is still ahead of 08:00Z.
    expect(draft.trigger).toMatchObject({ anchorAt: "2026-08-18T16:00:00.000Z" });
  });
});
