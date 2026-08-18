import { describe, expect, it, vi } from "vitest";
import {
  createThreadCheckpointClient,
  ThreadCheckpointClientFailure,
} from "./threadCheckpointClient";

const ids = {
  checkpoint: "11111111-1111-4111-8111-111111111111",
  thread: "22222222-2222-4222-8222-222222222222",
  turn: "33333333-3333-4333-8333-333333333333",
};

const now = "2026-08-18T09:00:00.000Z";
const capability = "window-capability";

const checkpoint = {
  id: ids.checkpoint,
  anchor: { mode: "chat", threadId: ids.thread, turnId: ids.turn },
  label: "Before the rewrite",
  lifecycle: "marked",
  restoreCount: 0,
  markedAt: now,
  version: 1,
  updatedAt: now,
};

function client(fetch: typeof globalThis.fetch) {
  return createThreadCheckpointClient({
    baseUrl: "http://127.0.0.1:4319",
    fetch,
    windowCapability: capability,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("checkpoint client", () => {
  it("asks the host for one thread's checkpoints under the window capability", async () => {
    const fetch = vi.fn(async () => jsonResponse({ checkpoints: [checkpoint] }));

    const checkpoints = await client(fetch as never).list(ids.thread);

    expect(checkpoints).toHaveLength(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://127.0.0.1:4319/api/checkpoints?threadId=${ids.thread}`);
    expect((init.headers as Record<string, string>)["x-octant-window-capability"]).toBe(capability);
  });

  it("hands back the host's refusal as an answer rather than an error", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({ kind: "checkpoint-refused", reason: "revision-unavailable" }),
    );

    const result = await client(fetch as never).execute({
      kind: "mark-thread-checkpoint",
      anchor: { mode: "chat", threadId: ids.thread as never, turnId: ids.turn as never },
      label: "Before the rewrite",
    });

    expect(result).toEqual({ kind: "checkpoint-refused", reason: "revision-unavailable" });
  });

  it("reports a refused request with the host's status", async () => {
    const fetch = vi.fn(async () => jsonResponse({ error: "Checkpoint has changed." }, 409));

    await expect(
      client(fetch as never).execute({
        kind: "forget-thread-checkpoint",
        checkpointId: ids.checkpoint as never,
        expectedVersion: 1 as never,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("refuses a base URL that is not loopback", () => {
    expect(() =>
      createThreadCheckpointClient({
        baseUrl: "https://octant.example",
        fetch: vi.fn() as never,
        windowCapability: capability,
      }),
    ).toThrow(ThreadCheckpointClientFailure);
  });
});
