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
      stopWork: async () => ({ status: "stopped" }),
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

describe("holding a move for an owner phone", () => {
  function heldMoves(
    options: {
      readonly busy?: boolean;
      readonly read?: () => Promise<MovableThreadReading>;
    } = {},
  ) {
    const folder = mkdtempSync(join(tmpdir(), "octant-move-phone-"));
    folders.push(folder);
    const clock = { now: 1_000_000 };
    const refused: Array<{ readonly threadId: string; readonly reason: string }> = [];
    const start = vi.fn(async () => ({ status: "interrupted" as const }));
    const moves = new ThreadMovesFromWindow({
      moves: {
        askProjects: async () => "unreachable",
        start,
        cancel: async () => ({ status: "cancelled" }),
        takeBack: async () => {},
        activateAnyway: async () => ({ httpStatus: 409, body: {} }),
        dismissFailure: () => {},
        refuseBeforeStart: (thread, reason) => refused.push({ threadId: thread.threadId, reason }),
        rateTo: () => ({ basis: "assumed", bytesPerSecond: 1_048_576 }),
      },
      state: createThreadMoveStateStore(folder),
      tickets: {
        challenge: async () => ({ status: "refused", kind: "refused" }),
        redeem: async () => ({ status: "issued", ticketId: "ticket" }),
      },
      source: {
        read: options.read ?? (async () => reading(options.busy ?? false)),
        measure: async () => ({ status: "unknown" }),
      },
      stopWork: async () => ({ status: "stopped" }),
      members: () => [],
      selfMemberId: () => "self",
      listThreads: async () => [],
      now: () => clock.now,
      pollMs: 5,
    });
    return { moves, clock, refused, start };
  }
  const ask = { thread: THREAD, destinationMemberId: DESKTOP as never, timing: "now" } as const;
  const phone = { kind: "owner-unlock", memberId: DESKTOP as never } as const;

  it("ends the wait as an unlock that never came once five minutes pass without the phone", async () => {
    const { moves, clock, refused, start } = heldMoves();
    expect(await moves.askPhone(ask)).toEqual({
      status: "waiting-for-phone",
      expiresAt: clock.now + 5 * 60_000,
    });
    const [held] = moves.phoneConfirmations().confirmations;
    if (held === undefined) throw new Error("Nothing waits for the phone.");

    clock.now += 5 * 60_000 + 1;

    expect(moves.status(THREAD).waitingForPhone).toBeUndefined();
    expect(refused).toEqual([{ threadId: THREAD.threadId, reason: "unlock-required" }]);
    expect(moves.phoneConfirmations().confirmations).toEqual([]);
    expect(
      moves.confirmOnPhone({
        confirmationId: held.confirmationId,
        ticketId: "12345678-1234-4234-8234-123456789012",
        principal: phone,
      }),
    ).toEqual({ status: "refused", kind: "no-such-confirmation" });
    expect(start).not.toHaveBeenCalled();
    moves.close();
  });

  it("refuses a second move of a thread that already waits for the phone, and Don't move ends the wait", async () => {
    const { moves, start } = heldMoves();
    await moves.askPhone(ask);

    expect(await moves.askPhone(ask)).toEqual({ status: "refused", reason: "busy" });
    expect(
      await moves.start({
        ...ask,
        unlock: { challengeId: "12345678-1234-4234-8234-123456789012", signature: "c2ln" },
      }),
    ).toEqual({ status: "refused", reason: "busy" });

    moves.stopWaiting(THREAD);

    expect(moves.status(THREAD).waitingForPhone).toBeUndefined();
    expect(moves.status(THREAD).settled?.settledAt).toEqual(expect.any(String));
    expect(moves.phoneConfirmations().confirmations).toEqual([]);
    expect(start).not.toHaveBeenCalled();
    moves.close();
  });

  for (const timing of ["after-turn", "now"] as const) {
    const would = timing === "after-turn" ? "wait for its turn" : "start at once";
    it(`moves nothing when Don't move is pressed while a phone-confirmed move that would ${would} is still being read`, async () => {
      let reads = 0;
      let releaseRead: ((value: MovableThreadReading) => void) | undefined;
      const { moves, start } = heldMoves({
        // The ask sees the turn running; the read after the phone confirms is held open.
        read: () => {
          reads += 1;
          if (reads === 1) return Promise.resolve(reading(true));
          return new Promise((resolve) => {
            releaseRead = resolve;
          });
        },
      });
      await moves.askPhone({ ...ask, timing: "after-turn" });
      const [held] = moves.phoneConfirmations().confirmations;
      if (held === undefined) throw new Error("Nothing waits for the phone.");
      expect(
        moves.confirmOnPhone({
          confirmationId: held.confirmationId,
          ticketId: "12345678-1234-4234-8234-123456789012",
          principal: phone,
        }),
      ).toEqual({ status: "started" });
      await vi.waitFor(() => expect(releaseRead).toBeDefined());

      expect(moves.stopWaiting(THREAD)).toEqual({ status: "stopped" });
      // Busy for after-turn, so a turn wait would be installed; idle for now, so it would start.
      releaseRead?.(reading(timing === "after-turn"));
      await new Promise((resolve) => setTimeout(resolve, 40));

      expect(start).not.toHaveBeenCalled();
      expect(moves.status(THREAD).waiting).toBeUndefined();
      expect(moves.status(THREAD).settled?.settledAt).toEqual(expect.any(String));
      moves.close();
    });
  }

  /** A source whose reads all wait until the test opens the gate. */
  function gatedReads() {
    const waiting: Array<() => void> = [];
    return {
      read: () =>
        new Promise<MovableThreadReading>((resolve) => {
          waiting.push(() => resolve(reading(false)));
        }),
      pending: () => waiting.length,
      open: () => {
        for (const release of waiting.splice(0)) release();
      },
    };
  }
  const single = () => (moves: ThreadMovesFromWindow) => moves.askPhone(ask);
  const batch = () => (moves: ThreadMovesFromWindow) =>
    moves.shutdownAskPhone({
      destinationMemberId: DESKTOP as never,
      rows: [{ thread: THREAD, timing: "now" }],
    });

  for (const [first, second, title] of [
    [single(), single(), "two windows ask the phone"],
    [batch(), batch(), "two Prepare to shut down batches ask the phone"],
    [single(), batch(), "a window and a Prepare to shut down batch ask the phone"],
    [batch(), single(), "a Prepare to shut down batch and a window ask the phone"],
  ] as const) {
    it(`holds one wait when ${title} for the same thread at once, and Don't move leaves nothing to confirm`, async () => {
      const gate = gatedReads();
      const { moves, start } = heldMoves({ read: gate.read });

      const asked = [first(moves), second(moves)];
      await vi.waitFor(() => expect(gate.pending()).toBeGreaterThan(0));
      gate.open();
      const answers = await Promise.all(asked);

      expect(answers.map((answer) => answer.status).sort()).toEqual([
        "refused",
        "waiting-for-phone",
      ]);
      expect(answers.find((answer) => answer.status === "refused")).toEqual({
        status: "refused",
        reason: "busy",
      });
      expect(moves.phoneConfirmations().confirmations).toHaveLength(1);

      moves.stopWaiting(THREAD);

      expect(moves.phoneConfirmations().confirmations).toEqual([]);
      expect(moves.status(THREAD).waitingForPhone).toBeUndefined();
      expect(start).not.toHaveBeenCalled();
      moves.close();
    });
  }

  it("fails only the row whose thread can no longer be read after the phone confirms, and moves the rest", async () => {
    const OTHER: MovedThreadReference = {
      mode: "chat",
      threadId: "88888888-8888-4888-8888-888888888888",
    };
    let confirmed = false;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const { moves, refused, start } = heldMoves({
        // The Code thread's checkout receipt became unreadable after the ask.
        read: async () => {
          if (confirmed && reads.next === THREAD.threadId) {
            reads.next = OTHER.threadId;
            throw new Error("The managed worktree receipt could not be read.");
          }
          return reading(false);
        },
      });
      const reads = { next: THREAD.threadId };
      await moves.shutdownAskPhone({
        destinationMemberId: DESKTOP as never,
        rows: [
          { thread: THREAD, timing: "now" },
          { thread: OTHER, timing: "now" },
        ],
      });
      const [held] = moves.phoneConfirmations().confirmations;
      if (held === undefined) throw new Error("Nothing waits for the phone.");
      confirmed = true;

      moves.confirmOnPhone({
        confirmationId: held.confirmationId,
        ticketId: "12345678-1234-4234-8234-123456789012",
        principal: phone,
      });

      await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
      expect(start).toHaveBeenCalledWith(expect.objectContaining({ thread: OTHER }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(refused).toEqual([{ threadId: THREAD.threadId, reason: "transfer-failed" }]);
      expect(moves.status(THREAD).settled?.settledAt).toEqual(expect.any(String));
      // The failed row is no longer claimed, so the window can ask again.
      expect(await moves.askPhone(ask)).toMatchObject({ status: "waiting-for-phone" });
      expect(unhandled).toEqual([]);
      moves.close();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("gives the thread back when the ask is refused, so it can be asked again", async () => {
    const { moves } = heldMoves({ busy: true });

    expect(await moves.askPhone(ask)).toEqual({ status: "refused", reason: "busy" });
    expect(await moves.askPhone({ ...ask, timing: "after-turn" })).toMatchObject({
      status: "waiting-for-phone",
    });
    moves.close();
  });

  it("asks no phone to move a busy thread now", async () => {
    const { moves } = heldMoves({ busy: true });

    expect(await moves.askPhone(ask)).toEqual({ status: "refused", reason: "busy" });
    expect(await moves.askPhone({ ...ask, timing: "after-turn" })).toMatchObject({
      status: "waiting-for-phone",
    });
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
        rateTo: () => ({ basis: "assumed", bytesPerSecond: 1_048_576 }),
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
        measure: async () => ({ status: "unknown" }),
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

  it("stops a phone-held Stop and move row only once the phone confirms, then moves it", async () => {
    const host = stopAndMoveHost({});
    expect(
      await host.moves.shutdownAskPhone({
        destinationMemberId: DESKTOP as never,
        rows: [{ thread: THREAD, timing: "stop-and-move" }],
      }),
    ).toMatchObject({ status: "waiting-for-phone" });
    expect(host.stopWork).not.toHaveBeenCalled();
    const [held] = host.moves.phoneConfirmations().confirmations;
    if (held === undefined) throw new Error("Nothing waits for the phone.");

    host.moves.confirmOnPhone({
      confirmationId: held.confirmationId,
      ticketId: "12345678-1234-4234-8234-123456789012",
      principal: { kind: "owner-unlock", memberId: DESKTOP as never },
    });

    await vi.waitFor(() => expect(host.start).toHaveBeenCalledOnce());
    expect(host.order).toEqual(["stop", "move"]);
    host.moves.close();
  });

  it("refuses Stop and move with Touch ID as busy while the phone holds the thread, and stops nothing", async () => {
    const host = stopAndMoveHost({});
    await host.moves.askPhone({
      thread: THREAD,
      destinationMemberId: DESKTOP as never,
      timing: "stop-and-move",
    });

    expect(
      await host.moves.start({
        thread: THREAD,
        destinationMemberId: DESKTOP as never,
        timing: "stop-and-move",
        unlock: UNLOCK,
      }),
    ).toEqual({ status: "refused", reason: "busy" });
    expect(host.order).toEqual([]);
    expect(host.moves.phoneConfirmations().confirmations).toHaveLength(1);
    host.moves.close();
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
        rateTo: () => ({ basis: "assumed", bytesPerSecond: 1_048_576 }),
      },
      state: createThreadMoveStateStore(folder),
      tickets: {
        challenge: async () => ({ status: "refused", kind: "refused" }),
        redeem: async () => ({ status: "issued", ticketId: "ticket" }),
      },
      source: { read: async () => reading(false), measure: async () => ({ status: "unknown" }) },
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
      stopWork: async () => ({ status: "stopped" }),
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
