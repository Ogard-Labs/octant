import { describe, expect, it } from "vitest";
import { decodeUtcTimestamp } from "@octant/contracts";
import { hostRestartNotice } from "./hostRestartNotice";

const at = decodeUtcTimestamp("2026-11-12T09:00:00.000Z");
const threads = [
  { threadId: "continued", title: "Fix the parser", projectId: "project" },
  { threadId: "held", title: "Ship the release", projectId: "project" },
];

describe("hostRestartNotice", () => {
  it("says how many threads continued and opens the one that needs the person", () => {
    const notice = hostRestartNotice(
      {
        at,
        continued: [{ mode: "code", threadId: "continued" }],
        held: [
          {
            mode: "code",
            threadId: "held",
            reason: "uncertain-external-action",
            detail: "A push or pull request may have reached the remote before Octant stopped.",
          },
        ],
      },
      threads,
    );
    expect(notice).toEqual({
      id: `restart:${at}`,
      title: "Octant restarted",
      detail:
        "Continued 1 thread; 1 needs you. Ship the release: A push or pull request may have reached the remote before Octant stopped.",
      needsYou: true,
      open: threads[1],
    });
  });

  it("names no thread this window cannot open, and says nothing when none is left", () => {
    expect(
      hostRestartNotice(
        { at, continued: [{ mode: "code", threadId: "elsewhere" }], held: [] },
        threads,
      ),
    ).toBeUndefined();
    expect(
      hostRestartNotice(
        {
          at,
          continued: [
            { mode: "code", threadId: "continued" },
            { mode: "code", threadId: "elsewhere" },
          ],
          held: [],
        },
        threads,
      ),
    ).toMatchObject({ detail: "Continued 1 thread; 0 need you.", needsYou: false });
  });
});
