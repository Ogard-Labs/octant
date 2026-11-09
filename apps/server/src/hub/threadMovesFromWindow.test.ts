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
        rateTo: () => ({ basis: "assumed", bytesPerSecond: 1_048_576 }),
      },
      state: createThreadMoveStateStore(folder),
      tickets: {
        challenge: async () => ({ status: "refused", kind: "refused" }),
        redeem: async () => ({ status: "issued", ticketId: "ticket" }),
      },
      source: {
        measure: async () => ({ status: "unknown" }),
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
    // A batch that named the thread reads that it stays, rather than waiting on it.
    expect(moves.status(THREAD).settled?.settledAt).toEqual(expect.any(String));
    expect(moves.status(THREAD).waiting).toBeUndefined();
    moves.close();
  });
});

describe("where a moved thread stands", () => {
  it("still says a move ended after its failure notice was put away", async () => {
    const folder = mkdtempSync(join(tmpdir(), "octant-move-settled-"));
    folders.push(folder);
    // The move fails and its notice has already been dismissed: the state holds none.
    const start = vi.fn(async () => ({ status: "failed" as const, reason: "refused" as const }));
    const moves = new ThreadMovesFromWindow({
      moves: {
        askProjects: async () => "unreachable",
        start,
        cancel: async () => ({ status: "cancelled" }),
        takeBack: async () => {},
        activateAnyway: async () => ({ httpStatus: 409, body: {} }),
        dismissFailure: () => {},
        refuseBeforeStart: () => {},
        rateTo: () => ({ basis: "assumed", bytesPerSecond: 1_048_576 }),
      },
      state: createThreadMoveStateStore(folder),
      tickets: {
        challenge: async () => ({ status: "refused", kind: "refused" }),
        redeem: async () => ({ status: "issued", ticketId: "ticket" }),
      },
      source: { read: async () => reading(false), measure: async () => ({ status: "unknown" }) },
      members: () => [],
      selfMemberId: () => "self",
      listThreads: async () => [],
      now: Date.now,
    });

    expect(moves.status(THREAD).settled).toBeUndefined();
    expect(
      await moves.start({
        thread: THREAD,
        destinationMemberId: DESKTOP as never,
        timing: "now",
        unlock: { challengeId: "12345678-1234-4234-8234-123456789012", signature: "c2ln" },
      }),
    ).toEqual({ status: "started" });

    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(moves.status(THREAD).settled?.settledAt).toEqual(expect.any(String)),
    );
    expect(moves.status(THREAD).failure).toBeUndefined();
    moves.close();
  });
});

describe("sizes before a move", () => {
  it("reads each thread's size with the rate to that member, and a thread it cannot measure as unknown", async () => {
    const folder = mkdtempSync(join(tmpdir(), "octant-move-sizes-"));
    folders.push(folder);
    const broken: MovedThreadReference = {
      mode: "chat",
      threadId: "88888888-8888-4888-8888-888888888888",
    };
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
        rateTo: (memberId) =>
          memberId === DESKTOP
            ? { basis: "measured", bytesPerSecond: 4_000_000 }
            : { basis: "assumed", bytesPerSecond: 1_048_576 },
      },
      state: createThreadMoveStateStore(folder),
      tickets: {
        challenge: async () => ({ status: "refused", kind: "refused" }),
        redeem: async () => ({ status: "issued", ticketId: "ticket" }),
      },
      source: {
        read: async () => reading(false),
        measure: async (thread) => {
          if (thread.threadId === broken.threadId) throw new Error("The checkout is gone.");
          return {
            status: "measured",
            bytes: 12_000_000,
            parts: [
              { kind: "thread-bundle", bytes: 40_000 },
              { kind: "git-bundle", bytes: 11_960_000 },
            ],
          };
        },
      },
      members: () => [],
      selfMemberId: () => "self",
      listThreads: async () => [],
      now: Date.now,
    });

    const sizes = await moves.sizes({
      destinationMemberId: DESKTOP as never,
      threads: [THREAD, broken],
    });

    expect(sizes.rate).toEqual({ basis: "measured", bytesPerSecond: 4_000_000 });
    expect(sizes.rows.map((row) => [row.thread.threadId, row.size.status])).toEqual([
      [THREAD.threadId, "measured"],
      [broken.threadId, "unknown"],
    ]);
    // Measuring never starts or freezes a move.
    expect(start).not.toHaveBeenCalled();
    expect(moves.status(THREAD)).toEqual({ status: "read" });
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
