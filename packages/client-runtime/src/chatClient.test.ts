import { describe, expect, it, vi } from "vitest";
import { ChatClientFailure, createChatClient, MAX_CHAT_NDJSON_LINE_BYTES } from "./chatClient";

const baseUrl = "http://127.0.0.1:4310";
const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const threadId = "00000000-0000-4000-8000-000000000802";
const now = "2026-07-19T12:00:00.000Z";

describe("chat client", () => {
  it("discards an unsent attachment through the authenticated attachment boundary", async () => {
    const attachmentId = "00000000-0000-4000-8000-000000000803";
    const purged = {
      id: attachmentId,
      threadId,
      displayName: "draft.png",
      mediaType: "image/png",
      byteLength: 5,
      digest: "a".repeat(64),
      status: "purged",
      createdAt: now,
    } as const;
    const fetch = vi.fn().mockResolvedValue(Response.json(purged));
    const client = createChatClient({ baseUrl, fetch, windowCapability: capability });

    await expect(
      client.discard({ threadId: threadId as never, attachmentId: attachmentId as never }),
    ).resolves.toEqual(purged);
    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/api/chat/attachments/${attachmentId}`,
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          "x-octant-window-capability": capability,
          "x-octant-chat-thread-id": threadId,
        }),
      }),
    );
  });

  it("preserves structured extension selections as typed command data", async () => {
    const extensionSelection = {
      kind: "plugin" as const,
      extensionId: "30000000-0000-4000-8000-000000000001" as never,
      packageId: "31000000-0000-4000-8000-000000000001" as never,
      componentId: "instructions" as never,
      packageVersion: "1.2.3" as never,
      packageDigest: `sha256:${"a".repeat(64)}` as never,
      catalogEpoch: `sha256:${"c".repeat(64)}` as never,
      origin: { kind: "draft" as const, reference: "draft-1" },
    };
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({
        kind: "turn-created",
        turn: {
          id: "00000000-0000-4000-8000-000000000803",
          threadId,
          sequence: 1,
          userMessageRef: {
            contentId: "00000000-0000-4000-8000-000000000804",
            digest: "a".repeat(64),
            byteLength: 5,
          },
          attachmentIds: [],
          extensionSelections: [
            {
              ...extensionSelection,
              origin: {
                kind: "turn",
                reference: "00000000-0000-4000-8000-000000000803",
              },
            },
          ],
          attempts: [],
          createdAt: now,
        },
      }),
    );
    const client = createChatClient({ baseUrl, fetch, windowCapability: capability });

    await client.execute({
      kind: "send-chat-turn",
      threadId: threadId as never,
      expectedVersion: 1 as never,
      prompt: "Build this",
      extensionSelections: [extensionSelection],
    });

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      kind: "send-chat-turn",
      extensionSelections: [extensionSelection],
    });
  });

  it("strictly decodes bootstrap success and failure payloads", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          settings: {
            defaultProviderInstanceId: "10000000-0000-4000-8000-000000000001",
            defaultModelId: "model-a",
            defaultResearchEnabled: false,
            defaultResearchRouting: "automatic",
            defaultPersonalityInstructions: "Be calm.",
            version: 1,
            updatedAt: now,
          },
          threads: [],
        }),
      )
      .mockResolvedValueOnce(
        Response.json(
          { category: "unauthorized", message: "Chat request is unauthorized." },
          { status: 401 },
        ),
      );
    const client = createChatClient({ baseUrl, fetch, windowCapability: capability });
    await expect(client.bootstrap()).resolves.toMatchObject({
      settings: { defaultModelId: "model-a" },
      threads: [],
    });
    await expect(client.thread(threadId as never)).rejects.toBeInstanceOf(ChatClientFailure);
  });

  it("reads bounded navigation metadata through one authenticated request", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        threads: [
          {
            id: threadId,
            title: "Replay",
            providerInstanceId: "10000000-0000-4000-8000-000000000001",
            updatedAt: now,
            lastSequence: 7,
            followUpOpen: true,
          },
        ],
      }),
    );
    const client = createChatClient({ baseUrl, fetch, windowCapability: capability });

    await expect(client.navigation()).resolves.toMatchObject({
      threads: [{ id: threadId, lastSequence: 7, followUpOpen: true }],
    });
    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/api/chat/navigation`,
      expect.objectContaining({
        method: "GET",
        headers: { "x-octant-window-capability": capability },
      }),
    );
  });

  it("rejects malformed oversized cross-thread and regressed NDJSON frames", async () => {
    const frames = [
      `${JSON.stringify({
        threadId,
        sequence: 42,
        event: {
          kind: "thread-updated",
          thread: {
            id: threadId,
            title: "Replay",
            lifecycle: "active",
            providerInstanceId: "10000000-0000-4000-8000-000000000001",
            modelId: "model-a",
            researchEnabled: false,
            researchRouting: "automatic",
            personalityInstructions: "Be calm.",
            version: 2,
            createdAt: now,
            updatedAt: now,
          },
        },
      })}\n`,
      `${JSON.stringify({
        threadId: "00000000-0000-4000-8000-000000000999",
        sequence: 43,
        event: {
          kind: "thread-updated",
          thread: {
            id: "00000000-0000-4000-8000-000000000999",
            title: "Other",
            lifecycle: "active",
            providerInstanceId: "10000000-0000-4000-8000-000000000001",
            modelId: "model-a",
            researchEnabled: false,
            researchRouting: "automatic",
            personalityInstructions: "Be calm.",
            version: 1,
            createdAt: now,
            updatedAt: now,
          },
        },
      })}\n`,
    ].join("");
    const fetch = vi.fn().mockResolvedValue(
      new Response(frames, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      }),
    );
    const client = createChatClient({ baseUrl, fetch, windowCapability: capability });
    const collected: number[] = [];
    await expect(async () => {
      for await (const frame of client.subscribe(
        threadId as never,
        41,
        new AbortController().signal,
      )) {
        collected.push(frame.sequence);
      }
    }).rejects.toBeInstanceOf(ChatClientFailure);
    expect(collected).toEqual([42]);

    const regressed = `${JSON.stringify({
      threadId,
      sequence: 41,
      event: {
        kind: "thread-updated",
        thread: {
          id: threadId,
          title: "Replay",
          lifecycle: "active",
          providerInstanceId: "10000000-0000-4000-8000-000000000001",
          modelId: "model-a",
          researchEnabled: false,
          researchRouting: "automatic",
          personalityInstructions: "Be calm.",
          version: 2,
          createdAt: now,
          updatedAt: now,
        },
      },
    })}\n`;
    const regressedFetch = vi.fn().mockResolvedValue(
      new Response(regressed, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      }),
    );
    const regressedClient = createChatClient({
      baseUrl,
      fetch: regressedFetch,
      windowCapability: capability,
    });
    await expect(async () => {
      for await (const frame of regressedClient.subscribe(
        threadId as never,
        41,
        new AbortController().signal,
      )) {
        void frame;
      }
    }).rejects.toBeInstanceOf(ChatClientFailure);

    const duplicateFetch = vi.fn().mockResolvedValue(
      new Response(
        `${frames}${JSON.stringify({
          threadId,
          sequence: 42,
          event: JSON.parse(frames.split("\n")[0]!).event,
        })}\n`,
        { status: 200, headers: { "content-type": "application/x-ndjson" } },
      ),
    );
    const duplicateClient = createChatClient({
      baseUrl,
      fetch: duplicateFetch,
      windowCapability: capability,
    });
    await expect(async () => {
      for await (const frame of duplicateClient.subscribe(
        threadId as never,
        41,
        new AbortController().signal,
      )) {
        void frame;
      }
    }).rejects.toBeInstanceOf(ChatClientFailure);

    const oversizedFetch = vi.fn().mockResolvedValue(
      new Response(`${"x".repeat(MAX_CHAT_NDJSON_LINE_BYTES + 1)}\n`, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      }),
    );
    const oversizedClient = createChatClient({
      baseUrl,
      fetch: oversizedFetch,
      windowCapability: capability,
    });
    await expect(async () => {
      for await (const frame of oversizedClient.subscribe(
        threadId as never,
        41,
        new AbortController().signal,
      )) {
        void frame;
      }
    }).rejects.toBeInstanceOf(ChatClientFailure);

    const multibyteChar = "\u00e9";
    const multibyteLine = `${multibyteChar.repeat(Math.floor(MAX_CHAT_NDJSON_LINE_BYTES / 2) + 1)}\n`;
    expect(multibyteLine.length).toBeLessThan(MAX_CHAT_NDJSON_LINE_BYTES);
    const multibyteFetch = vi.fn().mockResolvedValue(
      new Response(multibyteLine, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      }),
    );
    const multibyteClient = createChatClient({
      baseUrl,
      fetch: multibyteFetch,
      windowCapability: capability,
    });
    await expect(async () => {
      for await (const frame of multibyteClient.subscribe(
        threadId as never,
        41,
        new AbortController().signal,
      )) {
        void frame;
      }
    }).rejects.toBeInstanceOf(ChatClientFailure);
  });

  it("cancels the response reader on abort and early consumer return", async () => {
    let cancelCount = 0;
    const frameLine = `${JSON.stringify({
      threadId,
      sequence: 42,
      event: {
        kind: "thread-updated",
        thread: {
          id: threadId,
          title: "Replay",
          lifecycle: "active",
          providerInstanceId: "10000000-0000-4000-8000-000000000001",
          modelId: "model-a",
          researchEnabled: false,
          researchRouting: "automatic",
          personalityInstructions: "Be calm.",
          version: 2,
          createdAt: now,
          updatedAt: now,
        },
      },
    })}\n`;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frameLine));
      },
      cancel() {
        cancelCount += 1;
      },
    });
    const fetch = vi.fn().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      }),
    );
    const client = createChatClient({ baseUrl, fetch, windowCapability: capability });
    const controller = new AbortController();
    const sequences: number[] = [];
    const task = (async () => {
      for await (const frame of client.subscribe(threadId as never, 41, controller.signal)) {
        sequences.push(frame.sequence);
        break;
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await task.catch(() => undefined);
    expect(sequences).toEqual([42]);
    expect(cancelCount).toBeGreaterThan(0);
  });

  it("cancels a response reader when abort happens during a blocked read", async () => {
    let cancelCount = 0;
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
      pull() {
        return new Promise(() => undefined);
      },
      cancel() {
        cancelCount += 1;
      },
    });
    const fetch = vi.fn().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      }),
    );
    const client = createChatClient({ baseUrl, fetch, windowCapability: capability });
    const controller = new AbortController();
    const iterator = client
      .subscribe(threadId as never, 41, controller.signal)
      [Symbol.asyncIterator]();
    const pending = iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();

    const outcome = await Promise.race([
      pending.then(() => "cancelled"),
      new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 100)),
    ]);
    if (outcome === "blocked") streamController?.close();
    await pending;
    expect(outcome).toBe("cancelled");
    expect(cancelCount).toBeGreaterThan(0);
  });

  it("accepts sparse ascending global sequences from interleaved journal writes", async () => {
    const body = [
      JSON.stringify({
        threadId,
        sequence: 42,
        event: {
          kind: "thread-updated",
          thread: {
            id: threadId,
            title: "Replay",
            lifecycle: "active",
            providerInstanceId: "10000000-0000-4000-8000-000000000001",
            modelId: "model-a",
            researchEnabled: false,
            researchRouting: "automatic",
            personalityInstructions: "Be calm.",
            version: 2,
            createdAt: now,
            updatedAt: now,
          },
        },
      }),
      JSON.stringify({
        threadId,
        sequence: 44,
        event: {
          kind: "thread-updated",
          thread: {
            id: threadId,
            title: "Replay",
            lifecycle: "active",
            providerInstanceId: "10000000-0000-4000-8000-000000000001",
            modelId: "model-a",
            researchEnabled: false,
            researchRouting: "automatic",
            personalityInstructions: "Be calm.",
            version: 3,
            createdAt: now,
            updatedAt: now,
          },
        },
      }),
    ].join("\n");
    const fetch = vi.fn().mockResolvedValue(
      new Response(`${body}\n`, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      }),
    );
    const client = createChatClient({ baseUrl, fetch, windowCapability: capability });
    const sequences: number[] = [];
    for await (const frame of client.subscribe(
      threadId as never,
      41,
      new AbortController().signal,
    )) {
      sequences.push(frame.sequence);
    }
    expect(sequences).toEqual([42, 44]);
  });
});
