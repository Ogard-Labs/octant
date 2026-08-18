import { describe, expect, it, vi } from "vitest";
import { createPlanRouteHandler } from "./planRoutes";
import { InMemoryPlanStore, PlanService } from "./planService";
import type { WindowAuthorityStore } from "../windowAuthorityStore";

const ids = {
  plan: "00000000-0000-4000-8000-000000000301",
  revision: "00000000-0000-4000-8000-000000000302",
  thread: "00000000-0000-4000-8000-000000000303",
  step: "00000000-0000-4000-8000-000000000304",
} as const;

const capability = "C".repeat(43);

function authStore(): WindowAuthorityStore {
  return { authenticate: vi.fn(() => "w1") } as unknown as WindowAuthorityStore;
}

function handler(authorizeThread: () => boolean) {
  return createPlanRouteHandler({
    service: new PlanService({
      store: new InMemoryPlanStore(),
      clock: () => "2026-08-18T09:00:00.000Z",
    }),
    windowAuthorityStore: authStore(),
    authorizeThread,
  });
}

function proposal() {
  return {
    kind: "propose-thread-plan",
    threadId: ids.thread,
    expectedVersion: 0,
    planId: ids.plan,
    revisionId: ids.revision,
    title: "Land the replay fix",
    steps: [{ stepId: ids.step, title: "Reproduce the gap" }],
  };
}

function post(body: unknown): Request {
  return new Request("http://127.0.0.1/api/plans/commands", {
    method: "POST",
    headers: { "content-type": "application/json", "x-octant-window-capability": capability },
    body: JSON.stringify(body),
  });
}

describe("plan routes", () => {
  it("proposes and then reads back the thread's own plan", async () => {
    const handle = handler(() => true);

    expect((await handle(post(proposal())))?.status).toBe(200);
    const read = await handle(
      new Request(`http://127.0.0.1/api/plans?threadId=${ids.thread}`, {
        headers: { "x-octant-window-capability": capability },
      }),
    );

    expect(read?.status).toBe(200);
    const body = (await read!.json()) as {
      plan: { status: string; steps: ReadonlyArray<unknown> };
    };
    expect(body.plan.status).toBe("proposed");
    expect(body.plan.steps).toHaveLength(1);
  });

  it("refuses a thread this window may not act on", async () => {
    const handle = handler(() => false);

    expect((await handle(post(proposal())))?.status).toBe(403);
    expect(
      (
        await handle(
          new Request(`http://127.0.0.1/api/plans?threadId=${ids.thread}`, {
            headers: { "x-octant-window-capability": capability },
          }),
        )
      )?.status,
    ).toBe(403);
  });

  it("reports an approval of wording the plan no longer has as a conflict", async () => {
    const handle = handler(() => true);
    await handle(post(proposal()));

    const stale = await handle(
      post({
        kind: "approve-thread-plan",
        threadId: ids.thread,
        expectedVersion: 1,
        planId: ids.plan,
        revisionId: "00000000-0000-4000-8000-0000000003ff",
      }),
    );

    expect(stale?.status).toBe(409);
    expect(((await stale!.json()) as { error: string }).error).toMatch(/revision/i);
  });

  it("reads a thread with no plan as a plan of nothing, not a failure", async () => {
    const handle = handler(() => true);

    const read = await handle(
      new Request(`http://127.0.0.1/api/plans?threadId=${ids.thread}`, {
        headers: { "x-octant-window-capability": capability },
      }),
    );

    expect(read?.status).toBe(200);
    expect(await read!.json()).toEqual({ plan: null, history: [] });
  });
});
