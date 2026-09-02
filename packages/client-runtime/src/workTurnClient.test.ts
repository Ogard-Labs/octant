import { describe, expect, it, vi } from "vitest";
import {
  decodeWorkTurnAuthority,
  decodeWorkTurnId,
  decodeWorkTurnRequestId,
  decodeWorkThreadId,
  decodeProjectId,
  WORK_TURN_CAPABILITIES,
} from "@octant/contracts";
import { WorkTurnClientFailure, createWorkTurnClient } from "./workTurnClient";

const ids = {
  request: decodeWorkTurnRequestId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
  turn: decodeWorkTurnId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
  thread: decodeWorkThreadId("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
  project: decodeProjectId("dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
  binding: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  provider: "ffffffff-ffff-4fff-8fff-ffffffffffff",
} as const;

const authority = decodeWorkTurnAuthority({
  hostId: "local",
  projectId: ids.project,
  bindingRevisionId: ids.binding,
  workingDirectory: ".",
  confinementPosture: "project-root-confined",
  providerInstanceId: ids.provider,
  modelId: "gpt-5",
});

describe("createWorkTurnClient", () => {
  it("starts, looks up, cancels, and loads a durable transcript", async () => {
    const fetch = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/work/turns") && init?.method === "POST") {
        return Response.json({
          kind: "accepted",
          turn: {
            requestId: ids.request,
            threadId: ids.thread,
            turnId: ids.turn,
            projectId: ids.project,
            authority,
            status: "accepted",
            prompt: "Summarize the brief",
            transcript: [{ role: "user", text: "Summarize the brief" }],
            capabilities: WORK_TURN_CAPABILITIES,
            version: 1,
            acceptedAt: "2026-08-11T12:00:00.000Z",
            updatedAt: "2026-08-11T12:00:00.000Z",
          },
        });
      }
      if (url.endsWith(`/api/work/turns/${ids.request}`)) {
        return Response.json({
          kind: "accepted",
          turn: {
            requestId: ids.request,
            threadId: ids.thread,
            turnId: ids.turn,
            projectId: ids.project,
            authority,
            status: "completed",
            prompt: "Summarize the brief",
            response: "Done",
            transcript: [
              { role: "user", text: "Summarize the brief" },
              { role: "assistant", text: "Done", status: "completed" },
            ],
            capabilities: WORK_TURN_CAPABILITIES,
            version: 2,
            acceptedAt: "2026-08-11T12:00:00.000Z",
            updatedAt: "2026-08-11T12:00:01.000Z",
          },
        });
      }
      if (url.endsWith("/api/work/turns/cancel")) {
        return Response.json({
          kind: "turn-cancelled",
          requestId: ids.request,
          threadId: ids.thread,
          turnId: ids.turn,
          status: "cancelled",
        });
      }
      if (url.endsWith(`/api/work/turns/transcript/${ids.thread}`)) {
        return Response.json({ threadId: ids.thread, turns: [] });
      }
      if (url.endsWith("/api/work/attachments") && init?.method === "PUT") {
        return Response.json({
          attachmentId: "22222222-2222-4222-8222-222222222222",
          displayName: "mockup.png",
          mediaType: "image/png",
          byteLength: 3,
          digest: "a".repeat(64),
        });
      }
      if (url.includes("/api/work/attachments?") && init?.method === "DELETE") {
        return Response.json({ status: "discarded" });
      }
      return new Response("missing", { status: 404 });
    });
    const client = createWorkTurnClient({
      baseUrl: "http://127.0.0.1:8787",
      fetch: fetch as typeof globalThis.fetch,
      windowCapability: "cap",
    });

    await expect(
      client.startFirstTurn({
        kind: "start-work-thread-turn",
        requestId: ids.request,
        threadId: ids.thread,
        turnId: ids.turn,
        prompt: "Summarize the brief",
        authority,
      }),
    ).resolves.toMatchObject({ kind: "accepted" });
    await expect(client.lookupFirstTurn(ids.request)).resolves.toMatchObject({
      kind: "accepted",
      turn: { status: "completed" },
    });
    await expect(
      client.cancelFirstTurn({
        kind: "cancel-work-turn",
        requestId: ids.request,
        threadId: ids.thread,
        turnId: ids.turn,
      }),
    ).resolves.toMatchObject({ kind: "turn-cancelled" });
    await expect(client.transcript(ids.thread)).resolves.toEqual({
      threadId: ids.thread,
      turns: [],
      liveCursor: 0,
    });
    await expect(
      client.putAttachment({
        threadId: ids.thread,
        attachmentId: "22222222-2222-4222-8222-222222222222" as never,
        displayName: "mockup.png",
        mediaType: "image/png",
        bytes: new Uint8Array([137, 80, 78]),
      }),
    ).resolves.toMatchObject({ displayName: "mockup.png", mediaType: "image/png" });
    await expect(
      client.discardAttachment(ids.thread, "22222222-2222-4222-8222-222222222222" as never),
    ).resolves.toBeUndefined();
  });

  it("decodes the resumable Work response stream", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          `${JSON.stringify({
            kind: "response-delta",
            sequence: 5,
            threadId: ids.thread,
            requestId: ids.request,
            text: "Immediate text",
          })}\n`,
          { headers: { "content-type": "application/x-ndjson" } },
        ),
    );
    const client = createWorkTurnClient({
      baseUrl: "http://127.0.0.1:8787",
      fetch: fetch as typeof globalThis.fetch,
      windowCapability: "cap",
    });
    const controller = new AbortController();
    const stream = client.subscribe(ids.thread, 4, controller.signal);

    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: { kind: "response-delta", sequence: 5, text: "Immediate text" },
    });
    expect(fetch).toHaveBeenCalledWith(
      `http://127.0.0.1:8787/api/work/turns/stream/${ids.thread}?afterSequence=4`,
      expect.objectContaining({ method: "GET", signal: controller.signal }),
    );
  });

  it("accepts a restart snapshot marker below the previous process cursor", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          `${JSON.stringify({
            kind: "snapshot-required",
            sequence: 0,
            threadId: ids.thread,
          })}\n`,
          { headers: { "content-type": "application/x-ndjson" } },
        ),
    );
    const client = createWorkTurnClient({
      baseUrl: "http://127.0.0.1:8787",
      fetch: fetch as typeof globalThis.fetch,
      windowCapability: "cap",
    });

    const stream = client.subscribe(ids.thread, 4, new AbortController().signal);

    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: { kind: "snapshot-required", sequence: 0 },
    });
  });

  it("rejects non-loopback base URLs", () => {
    expect(() =>
      createWorkTurnClient({
        baseUrl: "https://example.com",
        fetch: globalThis.fetch,
        windowCapability: "cap",
      }),
    ).toThrow(WorkTurnClientFailure);
  });
});
