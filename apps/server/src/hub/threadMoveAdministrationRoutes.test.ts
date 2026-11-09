import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeWindowId, type MovedThreadReference } from "@octant/contracts";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import {
  THREAD_MOVE_ADMINISTRATION_ROUTES,
  createThreadMoveAdministrationRouteHandler,
} from "./threadMoveAdministrationRoutes";
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

function setup() {
  const folder = mkdtempSync(join(tmpdir(), "octant-move-routes-"));
  folders.push(folder);
  const state = createThreadMoveStateStore(folder);
  const dismissed: string[] = [];
  const summariesAsked: Array<boolean | undefined> = [];
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
  const authority = new WindowAuthorityStore();
  authority.register({ windowId, capability, now: Date.now() });
  const handle = createThreadMoveAdministrationRouteHandler({
    desktopBridgeSecret: secret,
    windowAuthorityStore: authority,
    moves,
    handovers: {
      preview: async () => ({ status: "refused", reason: "refused" }),
      handOver: async (_thread, _destination, choices) => {
        summariesAsked.push(choices?.summarize);
        return { status: "refused", reason: "refused" };
      },
      takeBack: () => ({ status: "taken-back" }),
    },
    exchange: {
      list: async () => ({ status: "listed", handovers: [] }),
      continueHandover: async () => ({ status: "refused", reason: "refused" }),
    },
    state,
    authorizeThread: ({ thread, windowId: asking }) =>
      String(asking) === String(windowId) && thread.threadId === SHOWN.threadId,
  });
  return { handle, dismissed, summariesAsked };
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
      [
        THREAD_MOVE_ADMINISTRATION_ROUTES.phoneAsk,
        { thread: ELSEWHERE, destinationMemberId: DESKTOP, timing: "now" },
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

  it("holds a thread the window shows for an owner phone, and lists it on the thread", async () => {
    const { handle } = setup();
    const response = await handle(
      post(THREAD_MOVE_ADMINISTRATION_ROUTES.phoneAsk, {
        thread: SHOWN,
        destinationMemberId: DESKTOP,
        timing: "now",
      }),
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ status: "waiting-for-phone" });
    const status = await handle(post(THREAD_MOVE_ADMINISTRATION_ROUTES.status, { thread: SHOWN }));
    expect(await status?.json()).toMatchObject({
      waitingForPhone: { destinationMemberId: DESKTOP },
    });
  });

  it("asks the agent to summarize a handover only when the window says so", async () => {
    const { handle, summariesAsked } = setup();
    const path = THREAD_MOVE_ADMINISTRATION_ROUTES.handover;
    await handle(post(path, { thread: SHOWN, summarize: true }));
    await handle(post(path, { thread: SHOWN, summarize: false }));
    await handle(post(path, { thread: SHOWN }));
    expect(summariesAsked).toEqual([true, false, false]);
  });

  it("rejects a body that is not exactly a move request", async () => {
    const { handle } = setup();
    const response = await handle(
      post(THREAD_MOVE_ADMINISTRATION_ROUTES.status, { thread: SHOWN, extra: true }),
    );
    expect(response?.status).toBe(400);
  });
});
