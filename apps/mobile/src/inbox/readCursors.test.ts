import type { MobileInboxRow } from "@octant/client-runtime";
import { describe, expect, it } from "vitest";
import { isUnread, markRead, NO_READ_CURSORS, parseReadCursors, seedHosts } from "./readCursors";

const row = (threadId: string, lastSequence?: number, hostId = "studio"): MobileInboxRow => ({
  hostId,
  mode: "code",
  threadId,
  title: threadId,
  status: "active",
  freshness: "2026-11-25T08:00:00.000Z",
  ...(lastSequence === undefined ? {} : { lastSequence }),
});

describe("what this phone has read", () => {
  it("counts everything a newly paired computer already finished as read", () => {
    const seeded = seedHosts(NO_READ_CURSORS, [row("a", 4), row("b", 9)]);
    expect(isUnread(seeded, row("a", 4))).toBe(false);
    expect(isUnread(seeded, row("b", 9))).toBe(false);
    expect(isUnread(seeded, row("a", 12))).toBe(true);
  });

  it("is read again once the thread is opened, until it moves on", () => {
    const seeded = seedHosts(NO_READ_CURSORS, [row("a", 4)]);
    const opened = markRead(seeded, row("a", 12));
    expect(isUnread(opened, row("a", 12))).toBe(false);
    expect(isUnread(opened, row("a", 13))).toBe(true);
    // An older read never takes back a newer one.
    expect(isUnread(markRead(opened, row("a", 6)), row("a", 12))).toBe(false);
  });

  it("keeps one computer's threads apart from another's", () => {
    const seeded = seedHosts(NO_READ_CURSORS, [row("a", 4)]);
    expect(isUnread(seeded, row("a", 4, "laptop"))).toBe(false);
    const both = seedHosts(seeded, [row("a", 2, "laptop")]);
    expect(isUnread(both, row("a", 3, "laptop"))).toBe(true);
    expect(isUnread(both, row("a", 3))).toBe(false);
  });

  it("says nothing of a thread whose computer reports no position", () => {
    expect(isUnread(seedHosts(NO_READ_CURSORS, [row("a")]), row("a"))).toBe(false);
  });

  it("survives a restart, and starts over from a file it cannot read", () => {
    const opened = markRead(seedHosts(NO_READ_CURSORS, [row("a", 4)]), row("a", 12));
    expect(parseReadCursors(JSON.stringify(opened))).toEqual(opened);
    expect(parseReadCursors("not json")).toEqual(NO_READ_CURSORS);
    expect(parseReadCursors('{"studio":{"baseline":"4"}}')).toEqual(NO_READ_CURSORS);
    expect(parseReadCursors(null)).toEqual(NO_READ_CURSORS);
  });

  it("forgets the threads read longest ago rather than growing without end", () => {
    let cursors = seedHosts(NO_READ_CURSORS, [row("a", 1)]);
    for (let index = 0; index < 600; index += 1)
      cursors = markRead(cursors, row(`thread-${index}`, 10 + index));
    expect(Object.keys(cursors["studio"]?.read ?? {})).toHaveLength(500);
    expect(isUnread(cursors, row("thread-599", 609))).toBe(false);
  });
});
