import { describe, expect, it, vi } from "vitest";
import { createGoalRouteHandler } from "./goalRoutes";
import { GoalService, InMemoryGoalStore } from "./goalService";
import type { WindowAuthorityStore } from "../windowAuthorityStore";

const ids = {
  goal: "00000000-0000-4000-8000-000000000206",
  revision: "00000000-0000-4000-8000-000000000207",
  thread: "00000000-0000-4000-8000-000000000208",
} as const;

// `WindowAuthorityStore.authenticate` returns the WindowId itself. The fake used
// to answer `{ windowId: "w1" }`, so the route saw `[object Object]` as the
// authenticated window — harmless while nothing read the value, and exactly the
// fixture drift that would have hidden the authorization bug this file now
// covers.
function authStore(): WindowAuthorityStore {
  return {
    authenticate: vi.fn(() => "w1"),
  } as unknown as WindowAuthorityStore;
}

describe("goal routes", () => {
  it("reads and executes goal commands for local authenticated windows", async () => {
    const service = new GoalService({
      store: new InMemoryGoalStore(),
      clock: () => "2026-08-01T00:00:00.000Z",
    });
    const handle = createGoalRouteHandler({
      service,
      windowAuthorityStore: authStore(),
      authorizeThread: () => true,
    });
    const create = await handle(
      new Request("http://127.0.0.1/api/goals/commands", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": "C".repeat(43),
        },
        body: JSON.stringify({
          kind: "create-thread-goal",
          threadId: ids.thread,
          expectedVersion: 0,
          goalId: ids.goal,
          revisionId: ids.revision,
          objective: "Ship Goal API",
          budget: {},
        }),
      }),
    );
    expect(create?.status).toBe(200);
    const read = await handle(
      new Request(`http://127.0.0.1/api/goals?threadId=${ids.thread}`, {
        headers: { "x-octant-window-capability": "C".repeat(43) },
      }),
    );
    expect(read?.status).toBe(200);
    const body = (await read!.json()) as { goal: { status: string } };
    expect(body.goal.status).toBe("active");
  });

  it("refuses to read a thread the window is not authorized for", async () => {
    const service = new GoalService({ store: new InMemoryGoalStore() });
    const authorizeThread = vi.fn(() => false);
    const handle = createGoalRouteHandler({
      service,
      windowAuthorityStore: authStore(),
      authorizeThread,
    });

    const read = await handle(
      new Request(`http://127.0.0.1/api/goals?threadId=${ids.thread}`, {
        headers: { "x-octant-window-capability": "C".repeat(43) },
      }),
    );

    // A window capability proves the caller is a renderer of this host, not
    // that it may see this thread.
    expect(read?.status).toBe(403);
    expect(authorizeThread).toHaveBeenCalledWith({
      threadId: ids.thread,
      windowId: "w1",
    });
  });

  it("journals nothing for a command naming a thread the window may not touch", async () => {
    const store = new InMemoryGoalStore();
    const service = new GoalService({ store });
    const execute = vi.spyOn(service, "execute");
    const handle = createGoalRouteHandler({
      service,
      windowAuthorityStore: authStore(),
      authorizeThread: () => false,
    });

    const denied = await handle(
      new Request("http://127.0.0.1/api/goals/commands", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": "C".repeat(43),
        },
        body: JSON.stringify({
          kind: "create-thread-goal",
          threadId: ids.thread,
          expectedVersion: 0,
          goalId: ids.goal,
          revisionId: ids.revision,
          objective: "Someone else's goal",
          budget: {},
        }),
      }),
    );

    expect(denied?.status).toBe(403);
    // The refusal happens before the service runs, so no state exists for a
    // thread the caller was never entitled to.
    expect(execute).not.toHaveBeenCalled();
    expect(store.read(ids.thread)).toEqual({ goal: null, history: [] });
  });

  it("rejects a command body that names no thread rather than guessing one", async () => {
    const handle = createGoalRouteHandler({
      service: new GoalService({ store: new InMemoryGoalStore() }),
      windowAuthorityStore: authStore(),
      authorizeThread: () => true,
    });

    const response = await handle(
      new Request("http://127.0.0.1/api/goals/commands", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": "C".repeat(43),
        },
        body: JSON.stringify({ kind: "create-thread-goal", objective: "No thread" }),
      }),
    );

    expect(response?.status).toBe(400);
  });
});
