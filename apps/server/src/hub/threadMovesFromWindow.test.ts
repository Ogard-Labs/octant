import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MovedThreadReference } from "@octant/contracts";
import type { MovableThreadReading } from "./threadMoveService";
import { createThreadMoveStateStore } from "./threadMoveStateStore";
import { ThreadMovesFromWindow } from "./threadMovesFromWindow";

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
