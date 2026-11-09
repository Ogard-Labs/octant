import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ThreadMoveDeparture, decodeWindowId, type MovedThreadReference } from "@octant/contracts";
import { Schema } from "effect";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import {
  THREAD_MOVE_ADMINISTRATION_ROUTES,
  createThreadMoveAdministrationRouteHandler,
} from "./threadMoveAdministrationRoutes";
import { KeptWorktreeRemoval } from "./keptWorktreeRemoval";
import { createThreadMoveStateStore } from "./threadMoveStateStore";
import { ThreadMovesFromWindow } from "./threadMovesFromWindow";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const windowId = decodeWindowId("33333333-3333-4333-8333-333333333333");
const capability = "A".repeat(43);
const secret = "desktop-secret";
const SHOWN: MovedThreadReference = {
  mode: "chat",
  threadId: "77777777-7777-4777-8777-777777777777",
};
const ELSEWHERE: MovedThreadReference = {
  mode: "chat",
  threadId: "88888888-8888-4888-8888-888888888888",
};
const DESKTOP = "55555555-5555-4555-8555-555555555555";
const decodeDeparture = Schema.decodeUnknownSync(ThreadMoveDeparture);
const KEPT_MOVE = "66666666-6666-4666-8666-666666666666";
const PLAIN_MOVE = "44444444-4444-4444-8444-444444444444";
const OTHER_MOVE = "22222222-2222-4222-8222-222222222222";
const KEPT_FOLDER = "/Users/person/.octant/worktrees/plan-moved-out-66666666";

function setup() {
  const folder = mkdtempSync(join(tmpdir(), "octant-move-routes-"));
  folders.push(folder);
  const state = createThreadMoveStateStore(folder);
  const dismissed: string[] = [];
  const moves = new ThreadMovesFromWindow({
    moves: {
      askProjects: async () => ({ status: "listed", projects: [], noProjectAllowed: true }),
      start: async () => ({ status: "interrupted" }),
      cancel: async () => ({ status: "cancelled" }),
      takeBack: async () => {},
      activateAnyway: async () => ({ httpStatus: 409, body: {} }),
      dismissFailure: (thread) => dismissed.push(thread.threadId),
      refuseBeforeStart: () => {},
    },
    state,
    tickets: {
      challenge: async () => ({ status: "refused", kind: "unlock-required" }),
      redeem: async () => ({ status: "refused", reason: "unlock-required" }),
    },
    source: {
      read: async () => ({
        status: "found",
        title: "Plan the trip",
        busy: false,
        delegated: false,
        repositoryRemotes: [],
      }),
    },
    members: () => [],
    selfMemberId: () => DESKTOP,
    listThreads: async () => [],
    now: Date.now,
  });
  const removedFolders: string[] = [];
  const journaled: string[] = [];
  const keptWorktrees = new KeptWorktreeRemoval({
    state,
    record: { keptWorktreeRemoved: (input) => journaled.push(String(input.moveId)) },
    removeWorktree: async (folder) => {
      removedFolders.push(folder);
      return "removed";
    },
    clock: () => "2026-11-09T10:00:00.000Z",
  });
  const authority = new WindowAuthorityStore();
  authority.register({ windowId, capability, now: Date.now() });
  const handle = createThreadMoveAdministrationRouteHandler({
    desktopBridgeSecret: secret,
    windowAuthorityStore: authority,
    moves,
    handovers: {
      preview: async () => ({ status: "refused", reason: "refused" }),
      handOver: async () => ({ status: "refused", reason: "refused" }),
      takeBack: () => ({ status: "taken-back" }),
    },
    exchange: {
      list: async () => ({ status: "listed", handovers: [] }),
      continueHandover: async () => ({ status: "refused", reason: "refused" }),
    },
    state,
    keptWorktrees,
    // A departed thread's record is gone; the window shows only its tombstone.
    authorizeDepartedThread: ({ thread, windowId: asking }) =>
      String(asking) === String(windowId) && thread.threadId === SHOWN.threadId,
    authorizeThread: ({ thread, windowId: asking }) =>
      String(asking) === String(windowId) && thread.threadId === SHOWN.threadId,
  });
  return { handle, dismissed, state, removedFolders, journaled };
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: {
      "x-octant-desktop-secret": secret,
      "x-octant-window-capability": capability,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("starting a thread move from a window", () => {
  it("answers only a local window with the desktop secret and no Origin", async () => {
    const { handle } = setup();
    const path = THREAD_MOVE_ADMINISTRATION_ROUTES.destinations;
    const body = { thread: SHOWN };

    expect((await handle(post(path, body, { "x-octant-desktop-secret": "wrong" })))?.status).toBe(
      401,
    );
    expect((await handle(post(path, body, { origin: "https://evil.example" })))?.status).toBe(401);
    expect(
      (await handle(post(path, body, { "x-octant-window-capability": "B".repeat(43) })))?.status,
    ).toBe(401);
    expect(
      (
        await handle(
          new Request(`http://100.64.0.1${path}`, {
            method: "POST",
            headers: {
              "x-octant-desktop-secret": secret,
              "x-octant-window-capability": capability,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          }),
        )
      )?.status,
    ).toBe(401);
    expect((await handle(post(path, body)))?.status).toBe(200);
    expect(await handle(post("/api/desktop/hub/thread-moves/other", body))).toBeUndefined();
  });

  it("refuses to list destinations for, start, or dismiss a thread the window does not show", async () => {
    const { handle, dismissed } = setup();
    for (const [path, body] of [
      [THREAD_MOVE_ADMINISTRATION_ROUTES.destinations, { thread: ELSEWHERE }],
      [
        THREAD_MOVE_ADMINISTRATION_ROUTES.start,
        {
          thread: ELSEWHERE,
          destinationMemberId: DESKTOP,
          timing: "now",
          unlock: { challengeId: "12345678-1234-4234-8234-123456789012", signature: "AAAA" },
        },
      ],
      [THREAD_MOVE_ADMINISTRATION_ROUTES.dismiss, { thread: ELSEWHERE }],
      [
        THREAD_MOVE_ADMINISTRATION_ROUTES.cancel,
        { moveId: "99999999-9999-4999-8999-999999999999" },
      ],
    ] as const) {
      const response = await handle(post(path, body));
      expect(response?.status, path).toBe(409);
      expect(await response?.json(), path).toEqual({
        status: "refused",
        kind: "thread-unavailable",
      });
    }
    expect(dismissed).toEqual([]);
  });

  it("reports the explicit error when this Mac is not an owner on the destination", async () => {
    const { handle } = setup();
    const response = await handle(
      post(THREAD_MOVE_ADMINISTRATION_ROUTES.challenge, { destinationMemberId: DESKTOP }),
    );
    expect(response?.status).toBe(409);
    expect(await response?.json()).toEqual({ status: "refused", kind: "unlock-required" });
  });

  it("rejects a body that is not exactly a move request", async () => {
    const { handle } = setup();
    const response = await handle(
      post(THREAD_MOVE_ADMINISTRATION_ROUTES.status, { thread: SHOWN, extra: true }),
    );
    expect(response?.status).toBe(400);
  });
});

describe("removing the worktree a moved thread left behind", () => {
  function departed(state: ReturnType<typeof setup>["state"]) {
    const base = {
      destinationMemberId: DESKTOP,
      destinationThread: { mode: "code", threadId: "11111111-1111-4111-8111-111111111111" },
      changesRemainInCheckout: false,
      movedAt: "2026-11-09T09:00:00.000Z",
    } as const;
    state.save({
      received: [],
      sent: [],
      departures: [
        {
          ...base,
          moveId: KEPT_MOVE,
          thread: { mode: "code", threadId: SHOWN.threadId },
          keptWorktree: KEPT_FOLDER,
          keptFiles: [".env"],
          keptFileCount: 1,
        },
        { ...base, moveId: PLAIN_MOVE, thread: { mode: "code", threadId: SHOWN.threadId } },
        {
          ...base,
          moveId: OTHER_MOVE,
          thread: { mode: "code", threadId: ELSEWHERE.threadId },
          keptWorktree: "/Users/person/.octant/worktrees/other-moved-out-22222222",
        },
      ].map((entry) => decodeDeparture(entry)),
    });
  }

  it("removes exactly the folder the departure recorded, journals it once, and answers a second press again", async () => {
    const { handle, state, removedFolders, journaled } = setup();
    departed(state);
    const path = THREAD_MOVE_ADMINISTRATION_ROUTES.removeKeptWorktree;

    const first = await handle(post(path, { moveId: KEPT_MOVE }));
    expect(first?.status).toBe(200);
    expect(await first?.json()).toEqual({ status: "removed" });
    const second = await handle(post(path, { moveId: KEPT_MOVE }));
    expect(await second?.json()).toEqual({ status: "removed" });

    expect(removedFolders).toEqual([KEPT_FOLDER]);
    expect(journaled).toEqual([KEPT_MOVE]);
    expect(
      state.load().departures?.find((entry) => String(entry.moveId) === KEPT_MOVE)
        ?.keptWorktreeRemovedAt,
    ).toBe("2026-11-09T10:00:00.000Z");
  });

  it("refuses a move that kept no worktree, one this host never recorded, and a thread the window does not show", async () => {
    const { handle, state, removedFolders, journaled } = setup();
    departed(state);
    const path = THREAD_MOVE_ADMINISTRATION_ROUTES.removeKeptWorktree;

    const plain = await handle(post(path, { moveId: PLAIN_MOVE }));
    expect(plain?.status).toBe(409);
    expect(await plain?.json()).toEqual({ status: "refused", kind: "not-kept-worktree" });
    for (const moveId of ["99999999-9999-4999-8999-999999999999", OTHER_MOVE]) {
      const refused = await handle(post(path, { moveId }));
      expect(refused?.status, moveId).toBe(409);
      expect(await refused?.json(), moveId).toEqual({
        status: "refused",
        kind: "thread-unavailable",
      });
    }
    // A folder is never named by the request.
    expect((await handle(post(path, { moveId: KEPT_MOVE, folder: "/" })))?.status).toBe(400);
    expect(removedFolders).toEqual([]);
    expect(journaled).toEqual([]);
  });
});
