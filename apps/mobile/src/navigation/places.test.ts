import { describe, expect, it } from "vitest";
import { MOBILE_PLACES, placeFor, shippedMobilePlaces, screenHidesNew } from "./places";

describe("the phone's places", () => {
  it("shows Home, Threads, Pull requests and Inbox, while Bots stays hidden until its work lands", () => {
    expect(shippedMobilePlaces().map((place) => place.id)).toEqual([
      "home",
      "threads",
      "prs",
      "inbox",
    ]);
    expect(MOBILE_PLACES.map((place) => place.id)).toEqual([
      "home",
      "bots",
      "threads",
      "prs",
      "inbox",
    ]);
  });

  it("gives every icon a spoken label", () => {
    for (const place of MOBILE_PLACES) expect(place.label.length).toBeGreaterThan(0);
  });

  it("puts New away over a thread's composer and keeps it on a place and its lists", () => {
    expect(screenHidesNew("thread")).toBe(true);
    for (const screen of ["home", "threads", "prs", "inbox", "counted", "settings", "todos"])
      expect(screenHidesNew(screen)).toBe(false);
  });

  it("falls back to Home for a place that has not shipped", () => {
    expect(placeFor("inbox")).toBe("inbox");
    expect(placeFor("bots")).toBe("home");
    expect(placeFor("anything")).toBe("home");
  });
});
