import type { ThreadGoal } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import type { WindowAuthorityStore } from "../windowAuthorityStore";
import { createGoalLoopRouteHandler } from "./goalLoopRoutes";
import { GoalLoopService } from "./goalLoopService";

const ids = {
  loop: "00000000-0000-4000-8000-000000000301",
  goal: "00000000-0000-4000-8000-000000000302",
  thread: "00000000-0000-4000-8000-000000000303",
} as const;

const ceiling = {
  filesystem: true,
  shell: false,
  git: false,
  network: false,
  tools: true,
  subagents: false,
  executionPolicy: "approval-gated",
  permissionPersistence: "current-session",
} as const;

function authStore(): WindowAuthorityStore {
  return { authenticate: vi.fn(() => "w1") } as unknown as WindowAuthorityStore;
}

function service() {
  return new GoalLoopService({
    readGoal: () =>
      ({
        id: ids.goal,
        threadId: ids.thread,
        revisionId: "00000000-0000-4000-8000-000000000304",
        objective: "Get the migration passing",
        status: "active",
        budget: { turnBudget: 3 },
        usage: { tokensUsed: 0, elapsedMs: 0, turnsUsed: 0 },
        evidence: [],
        createdAt: "2026-08-19T09:00:00.000Z",
        updatedAt: "2026-08-19T09:00:00.000Z",
        version: 1,
      }) as unknown as ThreadGoal,
    recordUsage: async () => undefined,
    threadAuthority: () => ceiling,
    modePosture: () => ceiling,
    pendingApproval: () => undefined,
    markCheckpoint: async () => "checkpoint-1",
    runRound: async () => ({ outcome: "ran" as const, tokensSpent: 1, elapsedMs: 1 }),
    journal: { append: () => undefined },
    uuid: () => "00000000-0000-4000-8000-000000000305",
    clock: () => "2026-08-19T09:00:00.000Z" as never,
  });
}

function handler(authorizeThread: () => boolean = () => true) {
  return createGoalLoopRouteHandler({
    service: service(),
    windowAuthorityStore: authStore(),
    authorizeThread,
  });
}

const capability = {
  "x-octant-window-capability": "C".repeat(43),
  "content-type": "application/json",
};

function start(body: Record<string, unknown> = {}) {
  return new Request("http://127.0.0.1/api/goal-loops/commands", {
    method: "POST",
    headers: capability,
    body: JSON.stringify({
      kind: "start-goal-loop",
      threadId: ids.thread,
      expectedVersion: 0,
      loopId: ids.loop,
      goalId: ids.goal,
      ceiling,
      trigger: { kind: "continuous" },
      ...body,
    }),
  });
}

describe("steering a goal loop over the API", () => {
  it("starts a loop and reads it back for an authenticated local window", async () => {
    const handle = handler();

    const started = await handle(start());
    expect(started?.status).toBe(200);
    expect(await started?.json()).toMatchObject({ kind: "goal-loop", loop: { status: "running" } });

    const read = await handle(
      new Request(`http://127.0.0.1/api/goal-loops?threadId=${ids.thread}`, {
        headers: capability,
      }),
    );
    expect(await read?.json()).toMatchObject({ loop: { id: ids.loop } });
  });

  it("refuses a window that may not act on the thread, without touching the service", async () => {
    const loopService = service();
    const execute = vi.spyOn(loopService, "execute");
    const handle = createGoalLoopRouteHandler({
      service: loopService,
      windowAuthorityStore: authStore(),
      authorizeThread: () => false,
    });

    const response = await handle(start());

    expect(response?.status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated request", async () => {
    const handle = createGoalLoopRouteHandler({
      service: service(),
      windowAuthorityStore: {
        authenticate: () => {
          throw new Error("no capability");
        },
      } as unknown as WindowAuthorityStore,
      authorizeThread: () => true,
    });

    expect((await handle(start()))?.status).toBe(400);
  });

  it("refuses a request that did not come over loopback", async () => {
    const handle = handler();

    const response = await handle(
      new Request("http://octant.example/api/goal-loops?threadId=x", { headers: capability }),
    );

    expect(response?.status).toBe(400);
  });

  it("refuses a command that names no thread rather than guessing one", async () => {
    const handle = handler();

    const response = await handle(
      new Request("http://127.0.0.1/api/goal-loops/commands", {
        method: "POST",
        headers: capability,
        body: JSON.stringify({ kind: "pause-goal-loop", expectedVersion: 1 }),
      }),
    );

    expect(response?.status).toBe(400);
  });

  it("leaves paths it does not serve to the next handler", async () => {
    const handle = handler();

    expect(await handle(new Request("http://127.0.0.1/api/goals?threadId=x"))).toBeUndefined();
  });
});
