import { describe, expect, it, vi } from "vitest";
import {
  decodeWorkThread,
  decodeWorkThreadCommandResult,
  decodeWorkThreadId,
  decodeProjectId,
  type WorkThreadCommand,
} from "@octant/contracts";
import { WorkThreadClientFailure, createWorkThreadClient } from "./workThreadClient";

const projectId = decodeProjectId("21000000-0000-4000-8000-000000000001");
const threadId = decodeWorkThreadId("21000000-0000-4000-8000-000000000002");
const baseUrl = "http://127.0.0.1:4317";
const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const now = "2026-07-26T21:00:00.000Z";

describe("createWorkThreadClient", () => {
  it("loads Work thread bootstrap from the authenticated route", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ threads: [thread()] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createWorkThreadClient({
      baseUrl,
      fetch,
      windowCapability: capability,
    });

    const bootstrap = await client.bootstrap();
    expect(bootstrap.threads).toEqual([thread()]);
    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/api/work/threads/bootstrap`,
      expect.objectContaining({
        method: "GET",
        headers: { "x-octant-window-capability": capability },
      }),
    );
  });

  it("posts Work thread commands to the authenticated route", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(successResult()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createWorkThreadClient({
      baseUrl,
      fetch,
      windowCapability: capability,
    });

    await expect(client.execute(validCommand())).resolves.toEqual(successResult());
    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/api/work/threads/commands`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        }),
        body: JSON.stringify(validCommand()),
      }),
    );
  });

  it("survives Electron replacing globalThis.fetch after client construction", async () => {
    const original = globalThis.fetch;
    const stale = vi.fn().mockRejectedValue(new TypeError("stale realm fetch"));
    const live = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ threads: [thread()] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    globalThis.fetch = stale;
    const client = createWorkThreadClient({
      baseUrl,
      fetch: globalThis.fetch,
      windowCapability: capability,
    });
    globalThis.fetch = live;

    const bootstrap = await client.bootstrap();
    expect(bootstrap.threads[0]?.id).toBe(threadId);
    expect(live).toHaveBeenCalled();
    expect(stale).not.toHaveBeenCalled();
    globalThis.fetch = original;
  });

  it("maps typed HTTP failures", async () => {
    const client = createWorkThreadClient({
      baseUrl,
      fetch: vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ message: "unauthorized" }), { status: 401 }),
        ),
      windowCapability: capability,
    });

    await expect(client.bootstrap()).rejects.toMatchObject({
      name: "WorkThreadClientFailure",
      status: 401,
      message: "unauthorized",
    } satisfies Partial<WorkThreadClientFailure>);
  });
});

function validCommand(): WorkThreadCommand {
  return {
    kind: "create-work-thread",
    threadId,
    projectId,
    title: "Draft brief",
    providerInstanceId: "21000000-0000-4000-8000-000000000003" as never,
    modelId: "model-a" as never,
    hostId: "local" as never,
    bindingRevisionId: "72000000-0000-4000-8000-000000000008" as never,
  };
}

function thread() {
  return decodeWorkThread({
    id: threadId,
    projectId,
    title: "Draft brief",
    lifecycle: "active",
    providerInstanceId: "21000000-0000-4000-8000-000000000003",
    modelId: "model-a",
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
}

function successResult() {
  return decodeWorkThreadCommandResult({
    kind: "thread-created",
    thread: thread(),
  });
}
