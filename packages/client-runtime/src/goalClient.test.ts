import { describe, expect, it, vi } from "vitest";
import { createGoalClient, GoalClientFailure } from "./goalClient";

const baseUrl = "http://127.0.0.1:7777";
const windowCapability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const threadId = "00000000-0000-4000-8000-000000000208";

const goal = {
  id: "00000000-0000-4000-8000-000000000206",
  threadId,
  revisionId: "00000000-0000-4000-8000-000000000207",
  objective: "Ship the Goal surface",
  status: "active",
  budget: {},
  usage: { tokensUsed: 0, elapsedMs: 0, turnsUsed: 0 },
  evidence: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  version: 1,
};

function client(fetch: typeof globalThis.fetch) {
  return createGoalClient({ baseUrl, fetch, windowCapability });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createGoalClient", () => {
  it("refuses a non-loopback base URL", () => {
    expect(() =>
      createGoalClient({
        baseUrl: "http://example.test",
        fetch: globalThis.fetch,
        windowCapability,
      }),
    ).toThrow(GoalClientFailure);
  });

  it("reads one thread's Goal with the window capability", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ goal, history: [] }));

    const projection = await client(fetch as unknown as typeof globalThis.fetch).read(threadId);

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/goals");
    expect(url).toContain(`threadId=${threadId}`);
    expect((init.headers as Record<string, string>)["x-octant-window-capability"]).toBe(
      windowCapability,
    );
    expect(projection.goal?.objective).toBe("Ship the Goal surface");
  });

  it("reads a thread without a Goal as an empty projection", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ goal: null, history: [] }));

    const projection = await client(fetch as unknown as typeof globalThis.fetch).read(threadId);

    expect(projection).toEqual({ goal: null, history: [] });
  });

  it("decodes the host's typed reply to a command", async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        goal: { ...goal, status: "paused", version: 2 },
        history: [],
      }),
    );

    const updated = await client(fetch as unknown as typeof globalThis.fetch).execute({
      kind: "pause-thread-goal",
      threadId,
      expectedVersion: 1,
      goalId: goal.id,
    } as never);

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/goals/commands");
    expect(init.method).toBe("POST");
    expect(updated.goal.status).toBe("paused");
    expect(updated.goal.version).toBe(2);
  });

  it("keeps the host's rejection category on a stale command", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ error: "Goal version conflict; reload and retry.", category: "stale" }, 409),
      );

    await expect(
      client(fetch as unknown as typeof globalThis.fetch).execute({
        kind: "pause-thread-goal",
        threadId,
        expectedVersion: 1,
        goalId: goal.id,
      } as never),
    ).rejects.toMatchObject({
      status: 409,
      category: "stale",
      message: "Goal version conflict; reload and retry.",
    });
  });

  it("reports an unauthorized window with the host status", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: "Goal request is unauthorized." }, 401));

    await expect(
      client(fetch as unknown as typeof globalThis.fetch).read(threadId),
    ).rejects.toMatchObject({ status: 401, category: "unknown" });
  });

  it("reports a transport failure as unavailable rather than a protocol error", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("offline"));

    await expect(
      client(fetch as unknown as typeof globalThis.fetch).read(threadId),
    ).rejects.toMatchObject({ status: 0 });
  });
});
