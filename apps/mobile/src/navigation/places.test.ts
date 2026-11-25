import { describe, expect, it } from "vitest";
import { MOBILE_PLACES, placeFor, shippedMobilePlaces, screenHidesBar } from "./places";

describe("the phone's places", () => {
  it("shows Home, Threads and Inbox, while Bots and PRs stay hidden until their work lands", () => {
    expect(shippedMobilePlaces().map((place) => place.id)).toEqual(["home", "threads", "inbox"]);
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

  it("puts the bar away in a thread and keeps it on a place and its lists", () => {
    expect(screenHidesBar("thread")).toBe(true);
    for (const screen of ["home", "threads", "inbox", "counted", "settings", "todos"])
      expect(screenHidesBar(screen)).toBe(false);
  });

  it("falls back to Home for a place that has not shipped", () => {
    expect(placeFor("inbox")).toBe("inbox");
    expect(placeFor("bots")).toBe("home");
    expect(placeFor("anything")).toBe("home");
  });
});
