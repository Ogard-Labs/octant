import type { ThreadLinkedIssue, ThreadTouchedIssue } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { threadRowCounts } from "./threadRowPullRequests";

const linear = (identifier: string, title?: string): ThreadTouchedIssue =>
  ({
    forge: "linear",
    identifier,
    observedAt: "2026-11-26T10:00:00.000Z",
    ...(title === undefined ? {} : { title }),
  }) as ThreadTouchedIssue;

const linkedLinear = (identifier: string): ThreadLinkedIssue =>
  ({
    issue: { forge: "linear", identifier, issueId: "node" },
    source: "created-from",
    linkedAt: "2026-11-26T09:00:00.000Z",
  }) as ThreadLinkedIssue;

const stacked = (position: number, size: number) =>
  ({
    identity: { number: position },
    state: "open",
    ...(position === 0
      ? {}
      : { stack: { position, size, ...(position > 1 ? { parent: 1 } : {}) } }),
  }) as never;

describe("threadRowCounts", () => {
  it("names the one issue a thread is linked to and counts the others it wrote to, past the entry's bound too", () => {
    expect(
      threadRowCounts({
        linkedIssues: [linkedLinear("OCT-7")],
        touchedIssues: { items: [linear("OCT-7", "Phone app"), linear("OCT-8")], hiddenCount: 3 },
      }),
    ).toEqual({
      issueKey: { reference: "OCT-7", name: "Linear issue OCT-7, Phone app" },
      issueCount: 4,
    });
  });

  it("names the one issue a thread with no links wrote to, and only counts when there are several", () => {
    expect(
      threadRowCounts({ touchedIssues: { items: [linear("OCT-9")], hiddenCount: 0 } }),
    ).toEqual({ issueKey: { reference: "OCT-9", name: "Linear issue OCT-9" } });
    expect(
      threadRowCounts({
        linkedIssues: [linkedLinear("OCT-1"), linkedLinear("OCT-2")],
        touchedIssues: { items: [linear("OCT-9")], hiddenCount: 0 },
      }),
    ).toEqual({ issueCount: 1 });
  });

  it("takes the stack of the first stacked pull request in the host's order", () => {
    expect(
      threadRowCounts({ pullRequests: { items: [stacked(0, 0), stacked(2, 4)], hiddenCount: 0 } }),
    ).toEqual({ stack: { position: 2, size: 4, parent: 1 } });
  });

  it("has nothing to count for a thread with no pull requests or issues", () => {
    expect(threadRowCounts({})).toEqual({});
  });
});
