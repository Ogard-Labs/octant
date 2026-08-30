import {
  decodeChatAttachmentId,
  decodeChatThreadId,
  decodeWindowId,
  type ChatEventFrame,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { WindowAuthorityStore } from "./windowAuthorityStore";
import { createChatRouteHandler } from "./chatRoutes";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("00000000-0000-4000-8000-000000000801");
const threadId = decodeChatThreadId("00000000-0000-4000-8000-000000000802");
const attachmentId = decodeChatAttachmentId("00000000-0000-4000-8000-000000000803");
const now = "2026-07-19T12:00:00.000Z";

const threadFixture = {
  id: threadId,
  title: "Replay",
  lifecycle: "active" as const,
  providerInstanceId: "10000000-0000-4000-8000-000000000001",
  modelId: "model-a",
  researchEnabled: false,
  researchRouting: "automatic" as const,
  personalityInstructions: "Be calm.",
  version: 2,
  createdAt: now,
  updatedAt: now,
};

const frame42 = {
  threadId,
  sequence: 42,
  event: {
    kind: "thread-updated" as const,
    thread: threadFixture,
  },
} as ChatEventFrame;
const frame43 = {
  threadId,
  sequence: 43,
  event: {
    kind: "thread-updated" as const,
    thread: { ...threadFixture, version: 3 },
  },
} as ChatEventFrame;

describe("Chat routes", () => {
  it("rejects missing window capability on bootstrap", async () => {
    const route = routeFixture();
    const response = await route(new Request("http://127.0.0.1/api/chat/bootstrap"));
    expect(response?.status).toBe(401);
  });

  it("returns the authenticated bounded navigation projection", async () => {
    const navigation = vi.fn(() => ({
      threads: [
        {
          id: threadId,
          title: "Replay",
          providerInstanceId: threadFixture.providerInstanceId,
          updatedAt: now,
          lastSequence: 7,
          followUpOpen: true,
        },
      ],
    }));
    const route = routeFixture({ navigation });
    const response = await route(request("/api/chat/navigation"));

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({
      threads: [
        {
          id: threadId,
          title: "Replay",
          providerInstanceId: threadFixture.providerInstanceId,
          updatedAt: now,
          lastSequence: 7,
          followUpOpen: true,
        },
      ],
    });
    expect(navigation).toHaveBeenCalledOnce();
  });

  it("rejects navigation queries instead of widening the read surface", async () => {
    const navigation = vi.fn(() => ({ threads: [] }));
    const route = routeFixture({ navigation });
    const response = await route(request("/api/chat/navigation?include=turns"));

    expect(response?.status).toBe(400);
    expect(navigation).not.toHaveBeenCalled();
  });

  it("returns authenticated transcript search hits", async () => {
    const payload = {
      query: "migration",
      hits: [
        {
          threadId,
          title: "Release notes",
          lifecycle: "archived" as const,
          turnId: "00000000-0000-4000-8000-000000000804",
          snippet: "explained that migration",
          matchRanges: [{ start: 14, end: 23 }],
        },
      ],
      truncated: false,
    };
    const searchTranscript = vi.fn(() => payload);
    const route = routeFixture({ searchTranscript });
    const response = await route(request("/api/chat/transcript-search?q=migration"));

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual(payload);
    expect(searchTranscript).toHaveBeenCalledWith("migration");
  });

  it("returns an empty transcript search when the service found nothing the caller may see", async () => {
    // Authority filtering is server-owned: a hidden or otherwise unlisted
    // thread never appears here even when its body would match the needle.
    const searchTranscript = vi.fn(() => ({
      query: "secret phrase",
      hits: [],
      truncated: false,
    }));
    const route = routeFixture({ searchTranscript });
    const response = await route(request("/api/chat/transcript-search?q=secret%20phrase"));

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({
      query: "secret phrase",
      hits: [],
      truncated: false,
    });
    expect(searchTranscript).toHaveBeenCalledWith("secret phrase");
  });

  it("rejects transcript search with unexpected query keys", async () => {
    const searchTranscript = vi.fn();
    const route = routeFixture({ searchTranscript });
    const response = await route(request("/api/chat/transcript-search?q=a&scope=all"));

    expect(response?.status).toBe(400);
    expect(searchTranscript).not.toHaveBeenCalled();
  });

  it("rejects oversized command bodies with 413", async () => {
    const route = routeFixture({}, 16);
    const response = await route(
      request("/api/chat/commands", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": "32",
        },
        body: "x".repeat(32),
      }),
    );
    expect(response?.status).toBe(413);
  });

  it("accepts browser Chat creation without a client-supplied host identity", async () => {
    const execute = vi.fn(async () => ({ kind: "thread-created", thread: threadFixture }));
    const route = routeFixture({ execute });
    const response = await route(
      request("/api/chat/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "create-chat-thread", title: "Browser thread" }),
      }),
    );

    expect(response?.status).toBe(200);
    expect(execute).toHaveBeenCalledWith(
      { kind: "create-chat-thread", title: "Browser thread" },
      { windowId },
    );
  });

  it("continues rejecting a client-supplied host identity", async () => {
    const execute = vi.fn();
    const route = routeFixture({ execute });
    const response = await route(
      request("/api/chat/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "create-chat-thread", title: "Forged host", hostId: "local" }),
      }),
    );

    expect(response?.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects unsupported attachment media types", async () => {
    const upload = vi.fn();
    const route = routeFixture({ uploadAttachment: upload });
    const response = await route(
      request("/api/chat/attachments", {
        method: "POST",
        headers: {
          "content-type": "application/x-executable",
          "x-octant-chat-thread-id": String(threadId),
          "x-octant-chat-attachment-id": String(attachmentId),
          "x-octant-chat-display-name": encodeURIComponent("run.bin"),
        },
        body: new Uint8Array([1, 2, 3]),
      }),
    );
    expect(response?.status).toBe(400);
    expect(upload).not.toHaveBeenCalled();
  });

  it("discards an unsent attachment through the authenticated thread boundary", async () => {
    const purged = {
      id: attachmentId,
      threadId,
      displayName: "draft.png",
      mediaType: "image/png",
      byteLength: 5,
      digest: "a".repeat(64),
      status: "purged" as const,
      createdAt: now,
    };
    const discardAttachment = vi.fn(async () => purged);
    const readAttachment = vi.fn();
    const route = routeFixture({ discardAttachment, readAttachment });

    const response = await route(
      request(`/api/chat/attachments/${attachmentId}`, {
        method: "DELETE",
        headers: { "x-octant-chat-thread-id": String(threadId) },
      }),
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual(purged);
    expect(discardAttachment).toHaveBeenCalledWith(threadId, attachmentId);
    expect(readAttachment).not.toHaveBeenCalled();
  });

  it("opens the event response before a future frame arrives", async () => {
    let releaseFrame!: () => void;
    const frameReady = new Promise<void>((resolve) => {
      releaseFrame = resolve;
    });
    const subscribe = vi.fn(async function* () {
      await frameReady;
      yield frame42;
    });
    const route = routeFixture({ subscribe });
    const responsePromise = route(request(`/api/chat/threads/${threadId}/events?afterSequence=41`));

    const openedBeforeFrame = await Promise.race([
      responsePromise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 25)),
    ]);
    releaseFrame();

    expect(openedBeforeFrame).toBe(true);
    await expect(collectFrames(responsePromise)).resolves.toEqual([frame42]);
  });

  it("returns bounded ordered replay frames after the cursor", async () => {
    const subscribe = vi.fn(async function* () {
      yield frame42;
      yield frame43;
    });
    const route = routeFixture({ subscribe });
    const frames = await collectFrames(
      route(request(`/api/chat/threads/${threadId}/events?afterSequence=41`)),
    );
    expect(frames).toEqual([frame42, frame43]);
    expect(subscribe).toHaveBeenCalledWith(threadId, 41, expect.any(AbortSignal));
  });

  it("fails a live replay stream whose NDJSON line exceeds the one MiB bound", async () => {
    const oversizedFrame = {
      threadId,
      sequence: 42,
      event: {
        kind: "thread-updated" as const,
        thread: {
          ...threadFixture,
          title: "x".repeat(1_100_000),
        },
      },
    } as ChatEventFrame;
    const subscribe = vi.fn(async function* () {
      yield oversizedFrame;
    });
    const route = routeFixture({ subscribe });
    const response = await route(request(`/api/chat/threads/${threadId}/events?afterSequence=41`));
    expect(response?.status).toBe(200);
    await expect(response?.text()).rejects.toThrow("Chat replay frame is too large.");
  });
});

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (!headers.has("x-octant-window-capability")) {
    headers.set("x-octant-window-capability", capability);
  }
  return new Request(`http://127.0.0.1${path}`, { ...init, headers });
}

async function collectFrames(
  responsePromise: Promise<Response | undefined>,
): Promise<ChatEventFrame[]> {
  const response = await responsePromise;
  const text = await response?.text();
  return (text ?? "")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ChatEventFrame);
}

function routeFixture(overrides: Record<string, unknown> = {}, maxJsonBodySize?: number) {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  const service = {
    bootstrap: vi.fn(async () => ({
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
    })),
    navigation: vi.fn(() => ({ threads: [] })),
    search: vi.fn(() => []),
    searchTranscript: vi.fn(() => ({ query: "", hits: [], truncated: false })),
    read: vi.fn(() => ({
      thread: threadFixture,
      turns: [],
      lastSequence: 0,
      contents: [],
      attachments: [],
      citations: [],
      workItems: [],
    })),
    execute: vi.fn(),
    uploadAttachment: vi.fn(),
    discardAttachment: vi.fn(),
    readAttachment: vi.fn(),
    subscribe: vi.fn(async function* () {}),
    ...overrides,
  };
  return createChatRouteHandler({
    service: service as never,
    windowAuthorityStore: store,
    now: () => 1,
    ...(maxJsonBodySize === undefined ? {} : { maxJsonBodySize }),
  });
}
