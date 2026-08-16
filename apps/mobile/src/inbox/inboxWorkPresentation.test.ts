import { describe, expect, it } from "vitest";
import { backMobileHomeView } from "./homeView";
import { inboxStatusCounts, inboxWorkStatus } from "./inboxWorkPresentation";
import type { MobileInboxRow } from "@octant/client-runtime";

const row = (mode: MobileInboxRow["mode"], status: string, threadId: string): MobileInboxRow => ({
  hostId: "11111111-1111-4111-8111-111111111111",
  mode,
  threadId,
  title: `${mode} ${status}`,
  status,
  freshness: "2026-08-10T09:30:00.000Z",
});

describe("Inbox work presentation", () => {
  it("turns host lifecycle values into concise work status labels", () => {
    expect(inboxWorkStatus("active")).toBe("Working");
    expect(inboxWorkStatus("waiting for approval")).toBe("Needs attention");
    expect(inboxWorkStatus("in review")).toBe("Recent");
    expect(inboxWorkStatus("archived")).toBe("Recent");
  });

  it("counts only Work and Code work for the Inbox dashboard", () => {
    expect(
      inboxStatusCounts([
        row("chat", "active", "chat"),
        row("work", "active", "work-working"),
        row("code", "waiting for approval", "code-attention"),
        row("code", "archived", "code-recent"),
      ]),
    ).toEqual({ all: 3, working: 1, needsAttention: 1, inReview: 0 });
  });

  it("uses the server-authoritative Code review state for the review count", () => {
    const reviewed = { ...row("code", "active", "code-review"), reviewState: "approved" as const };
    expect(inboxStatusCounts([reviewed])).toEqual({
      all: 1,
      working: 0,
      needsAttention: 0,
      inReview: 1,
    });
  });

  it("returns home from a nested work view without exiting the app", () => {
    expect(backMobileHomeView("chat")).toBe("inbox");
    expect(backMobileHomeView("work")).toBe("inbox");
    expect(backMobileHomeView("code")).toBe("inbox");
    expect(backMobileHomeView("inbox")).toBeUndefined();
  });
});
