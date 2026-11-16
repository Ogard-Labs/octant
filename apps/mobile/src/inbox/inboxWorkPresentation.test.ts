import { describe, expect, it } from "vitest";
import { backMobileHomeView } from "./homeView";
import { inboxPriorityRows, inboxStatusCounts, inboxWorkStatus } from "./inboxWorkPresentation";
import type { MobileInboxRow } from "@octant/client-runtime";

const row = (
  mode: MobileInboxRow["mode"],
  status: string,
  threadId: string,
  live?: MobileInboxRow["live"],
): MobileInboxRow => ({
  hostId: "11111111-1111-4111-8111-111111111111",
  mode,
  threadId,
  title: `${mode} ${status}`,
  status,
  freshness: "2026-08-10T09:30:00.000Z",
  ...(live === undefined ? {} : { live }),
});

describe("Inbox work presentation", () => {
  it("turns host lifecycle values into concise work status labels", () => {
    expect(inboxWorkStatus("active", undefined, "working")).toBe("Working");
    expect(inboxWorkStatus("active", undefined, "needs-input")).toBe("Needs attention");
    expect(inboxWorkStatus("waiting for approval")).toBe("Needs attention");
    expect(inboxWorkStatus("in review")).toBe("Recent");
    expect(inboxWorkStatus("archived")).toBe("Recent");
  });

  it("does not call an open thread working unless the host says a turn is running", () => {
    expect(inboxWorkStatus("active")).toBe("Recent");
  });

  it("lists what needs the person first on the home, leaving Chat threads to the full list", () => {
    const ids = inboxPriorityRows(
      [
        row("code", "archived", "code-recent"),
        row("work", "active", "work-working", "working"),
        row("chat", "waiting for approval", "chat-attention"),
        row("code", "waiting for approval", "code-attention"),
        row("work", "archived", "work-recent"),
      ],
      3,
    ).map((entry) => entry.threadId);
    expect(ids).toEqual(["code-attention", "work-working", "code-recent"]);
  });

  it("counts only Work and Code work for the Inbox dashboard", () => {
    expect(
      inboxStatusCounts([
        row("chat", "active", "chat"),
        row("work", "active", "work-working", "working"),
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
    expect(backMobileHomeView("work")).toBe("inbox");
    expect(backMobileHomeView("code")).toBe("inbox");
    expect(backMobileHomeView("inbox")).toBeUndefined();
  });
});
