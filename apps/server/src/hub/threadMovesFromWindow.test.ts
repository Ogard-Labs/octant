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
      stopWork: async () => ({ status: "stopped" }),
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
    // A batch that named the thread reads that it stays, rather than waiting on it.
    expect(moves.status(THREAD).settled?.settledAt).toEqual(expect.any(String));
    expect(moves.status(THREAD).waiting).toBeUndefined();
    moves.close();
  });
});

describe("Stop and move", () => {
  const UNLOCK = { challengeId: "12345678-1234-4234-8234-123456789012", signature: "c2ln" };

  function stopAndMoveHost(options: {
    readonly redeem?: "issued" | "refused";
    readonly stopTakes?: boolean;
    readonly delegated?: boolean;
    readonly idle?: boolean;
  }) {
    const folder = mkdtempSync(join(tmpdir(), "octant-move-stop-"));
    folders.push(folder);
    const order: string[] = [];
    let running = options.idle !== true;
    const start = vi.fn(async () => {
      order.push("move");
      return { status: "interrupted" as const };
    });
    const refuseBeforeStart = vi.fn();
    const stopWork = vi.fn(async () => {
      order.push("stop");
      if (options.stopTakes !== false) running = false;
      return { status: "stopped" as const };
    });
    const moves = new ThreadMovesFromWindow({
      moves: {
        askProjects: async () => "unreachable",
        start,
        cancel: async () => ({ status: "cancelled" }),
        takeBack: async () => {},
        activateAnyway: async () => ({ httpStatus: 409, body: {} }),
        dismissFailure: () => {},
        refuseBeforeStart,
      },
      state: createThreadMoveStateStore(folder),
      tickets: {
        challenge: async () => ({ status: "refused", kind: "refused" }),
        redeem: async () => {
          order.push("unlock");
          return options.redeem === "refused"
            ? { status: "refused", reason: "unlock-required" }
            : { status: "issued", ticketId: "ticket" };
        },
      },
      source: {
        read: async () => ({ ...reading(running), delegated: options.delegated === true }),
      },
      stopWork,
      members: () => [],
      selfMemberId: () => "self",
      listThreads: async () => [],
      now: Date.now,
      pollMs: 5,
      stopWaitMs: 40,
    });
    return { moves, order, start, stopWork, refuseBeforeStart };
  }

  it("stops the running turn only after the destination's unlock, then moves the thread", async () => {
    const host = stopAndMoveHost({});

    expect(
      await host.moves.start({
        thread: THREAD,
        destinationMemberId: DESKTOP as never,
        timing: "stop-and-move",
        unlock: UNLOCK,
      }),
    ).toEqual({ status: "started" });

    await vi.waitFor(() => expect(host.start).toHaveBeenCalledOnce());
    expect(host.order).toEqual(["unlock", "stop", "move"]);
    host.moves.close();
  });

  it("stops nothing when the person's unlock is refused", async () => {
    const host = stopAndMoveHost({ redeem: "refused" });

    expect(
      await host.moves.start({
        thread: THREAD,
        destinationMemberId: DESKTOP as never,
        timing: "stop-and-move",
        unlock: UNLOCK,
      }),
    ).toEqual({ status: "refused", reason: "unlock-required" });
    expect(host.stopWork).not.toHaveBeenCalled();
    expect(host.start).not.toHaveBeenCalled();
    host.moves.close();
  });

  it("says it is stopping until the turn has stopped, and ends as busy when it never does", async () => {
    const host = stopAndMoveHost({ stopTakes: false });

    await host.moves.start({
      thread: THREAD,
      destinationMemberId: DESKTOP as never,
      timing: "stop-and-move",
      unlock: UNLOCK,
    });
    expect(host.moves.status(THREAD).waiting?.stopping).toBe(true);

    await vi.waitFor(() => expect(host.refuseBeforeStart).toHaveBeenCalledWith(THREAD, "busy"));
    expect(host.start).not.toHaveBeenCalled();
    expect(host.moves.status(THREAD).waiting).toBeUndefined();
    expect(host.moves.status(THREAD).settled).toBeDefined();
    host.moves.close();
  });

  it("stops each batch row set to Stop and move once the batch is unlocked, and no delegated one", async () => {
    const host = stopAndMoveHost({});
    const delegatedHost = stopAndMoveHost({ delegated: true });

    expect(
      await host.moves.shutdownStart({
        destinationMemberId: DESKTOP as never,
        rows: [{ thread: THREAD, timing: "stop-and-move" }],
        unlock: UNLOCK,
      }),
    ).toEqual({ status: "started" });
    await vi.waitFor(() => expect(host.start).toHaveBeenCalledOnce());
    expect(host.order).toEqual(["unlock", "stop", "move"]);

    await delegatedHost.moves.shutdownStart({
      destinationMemberId: DESKTOP as never,
      rows: [{ thread: THREAD, timing: "stop-and-move" }],
      unlock: UNLOCK,
    });
    expect(delegatedHost.stopWork).not.toHaveBeenCalled();
    expect(delegatedHost.refuseBeforeStart).toHaveBeenCalledWith(THREAD, "delegated");
    host.moves.close();
    delegatedHost.moves.close();
  });

  it("moves an idle thread at once without stopping anything", async () => {
    const host = stopAndMoveHost({ idle: true });

    await host.moves.start({
      thread: THREAD,
      destinationMemberId: DESKTOP as never,
      timing: "stop-and-move",
      unlock: UNLOCK,
    });

    await vi.waitFor(() => expect(host.start).toHaveBeenCalledOnce());
    expect(host.stopWork).not.toHaveBeenCalled();
    host.moves.close();
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
      },
      state: createThreadMoveStateStore(folder),
      tickets: {
        challenge: async () => ({ status: "refused", kind: "refused" }),
        redeem: async () => ({ status: "issued", ticketId: "ticket" }),
      },
      source: { read: async () => reading(false) },
      stopWork: async () => ({ status: "stopped" }),
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
