import { describe, expect, it } from "vitest";
import { inboxEmptyState } from "./inboxEmptyState";

describe("Inbox first-run state", () => {
  it("asks the person to pair a first computer when none is paired", () => {
    expect(inboxEmptyState({ hosts: [], hostsLoaded: true })).toEqual({
      title: "Pair your first computer",
      body: "On your computer, open Settings → Remote access and scan the QR code shown there.",
      actionLabel: "Scan QR code",
    });
  });

  it("shows the normal Inbox once a computer is paired", () => {
    expect(inboxEmptyState({ hosts: [{}], hostsLoaded: true })).toBeUndefined();
  });

  it("waits for the saved hosts before showing the first-run card", () => {
    expect(inboxEmptyState({ hosts: [], hostsLoaded: false })).toBeUndefined();
  });
});
