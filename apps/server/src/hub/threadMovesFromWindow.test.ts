import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeShutdownListing, type MovedThreadReference } from "@octant/contracts";
import type { MovableThreadReading } from "./threadMoveService";
import { createThreadMoveStateStore } from "./threadMoveStateStore";
import { hostThreads, shortenedForListing, ThreadMovesFromWindow } from "./threadMovesFromWindow";

const THREAD: MovedThreadReference = {
  mode: "code",
  threadId: "77777777-7777-4777-8777-777777777777",
};
const DESKTOP = "11111111-1111-4111-8111-111111111111";
const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const reading = (busy: boolean): MovableThreadReading => ({
  status: "found",
  title: "Add dark mode",
  busy,
  delegated: false,
  repositoryRemotes: [],
});

describe("moving a thread after its turn", () => {
  it("moves nothing when Don't move is pressed while the thread is still being read", async () => {
    const folder = mkdtempSync(join(tmpdir(), "octant-move-wait-"));
    folders.push(folder);
    let reads = 0;
    let releaseRead: ((value: MovableThreadReading) => void) | undefined;
    const start = vi.fn(async () => ({ status: "interrupted" as const }));
    const moves = new ThreadMovesFromWindow({
      moves: {
        askProjects: async () => "unreachable",
        start,
        cancel: async () => ({ status: "cancelled" }),
        takeBack: async () => {},
        activateAnyway: async () => ({ httpStatus: 409, body: {} }),
        dismissFailure: () => {},
        refuseBeforeStart: () => {},
      },
      state: createThreadMoveStateStore(folder),
      tickets: {
        challenge: async () => ({ status: "refused", kind: "refused" }),
        redeem: async () => ({ status: "issued", ticketId: "ticket" }),
      },
      source: {
        // The start sees the turn running; the poll's read is held open.
        read: () => {
          reads += 1;
          if (reads === 1) return Promise.resolve(reading(true));
          return new Promise((resolve) => {
            releaseRead = resolve;
          });
        },
      },
      members: () => [],
      selfMemberId: () => "self",
      listThreads: async () => [],
      now: Date.now,
      pollMs: 5,
    });

    expect(
      await moves.start({
        thread: THREAD,
        destinationMemberId: DESKTOP as never,
        timing: "after-turn",
        unlock: { challengeId: "12345678-1234-4234-8234-123456789012", signature: "c2ln" },
      }),
    ).toEqual({ status: "waiting-for-turn" });
    await vi.waitFor(() => expect(releaseRead).toBeDefined());

    expect(moves.stopWaiting(THREAD)).toEqual({ status: "stopped" });
    releaseRead?.(reading(false));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(start).not.toHaveBeenCalled();
    moves.close();
  });
});

describe("which threads Prepare to shut down lists", () => {
  const PROJECT = "44444444-4444-4444-8444-444444444444";
  const DONE_AT = "2026-11-08T09:00:00.000Z";

  it("counts a thread put away as completed as closed, in every mode", () => {
    const listed = hostThreads({
      chat: [
        { id: "c-open", title: "Plan the trip", lifecycle: "active" },
        { id: "c-done", title: "Booked", lifecycle: "active", completedAt: DONE_AT },
      ],
      code: [
        { id: "k-open", title: "Add dark mode", projectId: PROJECT, lifecycle: "waiting" },
        {
          id: "k-done",
          title: "Fix the build",
          projectId: PROJECT,
          lifecycle: "active",
          completedAt: DONE_AT,
        },
      ],
      work: [
        { id: "w-open", title: "Weekly digest", projectId: PROJECT, lifecycle: "active" },
        {
          id: "w-done",
          title: "Quarterly report",
          projectId: PROJECT,
          lifecycle: "active",
          completedAt: DONE_AT,
        },
      ],
    });

    expect(listed.filter((entry) => entry.open).map((entry) => entry.thread.threadId)).toEqual([
      "c-open",
      "k-open",
      "w-open",
    ]);
  });

  it("lists a thread whose own title is longer than a listing row allows", () => {
    const title = `  ${"A very long title ".repeat(30)}😀 end  `;
    const shortened = shortenedForListing(title);

    expect(shortened.length).toBeLessThanOrEqual(256);
    expect(shortened.endsWith("…")).toBe(true);
    expect(shortenedForListing("   ")).toBe("Untitled thread");
    expect(
      decodeShutdownListing({
        status: "listed",
        members: [],
        rows: [{ thread: THREAD, title: shortened, busy: false, older: false, placements: [] }],
      }).rows[0]?.title,
    ).toBe(shortened);
  });
});
