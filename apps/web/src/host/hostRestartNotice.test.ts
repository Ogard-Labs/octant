import { describe, expect, it } from "vitest";
import { decodeUtcTimestamp } from "@octant/contracts";
import { hostRestartNotice } from "./hostRestartNotice";

const at = decodeUtcTimestamp("2026-11-12T09:00:00.000Z");
const threads = [
  { mode: "code" as const, threadId: "continued", title: "Fix the parser", projectId: "project" },
  { mode: "code" as const, threadId: "held", title: "Ship the release", projectId: "project" },
  { mode: "chat" as const, threadId: "answer", title: "Plan the trip" },
  { mode: "work" as const, threadId: "brief", title: "Draft the brief", projectId: "project" },
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

  it("counts and opens Chat and Work threads by their own mode", () => {
    const notice = hostRestartNotice(
      {
        at,
        continued: [{ mode: "chat", threadId: "answer" }],
        held: [
          {
            mode: "work",
            threadId: "brief",
            reason: "turned-off",
            detail: "Continue after restart is off in Settings, so this thread waits for you.",
          },
          // The same id in another mode is another thread, which this window cannot open.
          { mode: "code", threadId: "brief", reason: "crash-loop", detail: "Elsewhere." },
        ],
      },
      threads,
    );
    expect(notice).toMatchObject({
      detail:
        "Continued 1 thread; 1 needs you. Draft the brief: Continue after restart is off in Settings, so this thread waits for you.",
      open: threads[3],
    });
  });
});
