import { decodeWindowId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import type {
  ThreadSearchRows,
  ThreadSearchVisibleThread,
} from "./persistence/threadSearchProjection";
import { createThreadSearchRouteHandler, type ThreadSearchSources } from "./threadSearchRoutes";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("86000000-0000-4000-8000-000000000001");
const projectId = "86000000-0000-4000-8000-000000000002";
const chatThread = "86000000-0000-4000-8000-000000000003";
const workThread = "86000000-0000-4000-8000-000000000004";
const codeThread = "86000000-0000-4000-8000-000000000005";
const hiddenThread = "86000000-0000-4000-8000-000000000006";
const chatTurn = "86000000-0000-4000-8000-000000000007";
const operation = "86000000-0000-4000-8000-000000000008";
const now = "2026-11-14T10:00:00.000Z";

describe("search across modes", () => {
  it("searches only the threads each mode lists for the window and names each hit's mode, field, and turn", async () => {
    const search = vi.fn(
      (_query: string, visible: ReadonlyArray<ThreadSearchVisibleThread>): ThreadSearchRows => ({
        truncated: false,
        matches: [
          {
            mode: "chat",
            threadId: chatThread,
            anchorId: "",
            field: "title",
            snippet: "Release plan",
            matchRanges: [{ start: 0, end: 7 }],
          },
          {
            mode: "code",
            threadId: codeThread,
            anchorId: operation,
            field: "tool",
            snippet: "release.yml",
            matchRanges: [],
          },
          // The index answered a thread no mode listed; it must not leave the host.
          {
            mode: "work",
            threadId: hiddenThread,
            anchorId: "",
            field: "title",
            snippet: "x",
            matchRanges: [],
          },
          ...(visible.some((thread) => thread.threadId === workThread)
            ? [
                {
                  mode: "work" as const,
                  threadId: workThread,
                  anchorId: chatTurn,
                  field: "reply" as const,
                  snippet: "release",
                  matchRanges: [],
                },
              ]
            : []),
        ],
      }),
    );
    const route = fixture({
      search,
      chat: () => [
        { id: chatThread, title: "Release plan", lifecycle: "active", updatedAt: now },
        { id: hiddenThread, title: "Deleted", lifecycle: "deleted", updatedAt: now },
      ],
      work: () => [
        { id: workThread, title: "Brief", lifecycle: "archived", projectId, updatedAt: now },
      ],
      code: async () => [
        { id: codeThread, title: "CI", lifecycle: "waiting", projectId, updatedAt: now },
      ],
    });

    const response = await route(request("/api/search?q=%20release%20"));

    expect(response?.status).toBe(200);
    expect(search).toHaveBeenCalledWith(
      "release",
      [
        { mode: "chat", threadId: chatThread, updatedAt: now },
        { mode: "work", threadId: workThread, updatedAt: now },
        { mode: "code", threadId: codeThread, updatedAt: now },
      ],
      50,
    );
    expect(await response?.json()).toEqual({
      query: "release",
      scope: "all",
      truncated: false,
      unavailable: [],
      hits: [
        {
          mode: "chat",
          threadId: chatThread,
          field: "title",
          title: "Release plan",
          lifecycle: "active",
          updatedAt: now,
          snippet: "Release plan",
          matchRanges: [{ start: 0, end: 7 }],
        },
        {
          mode: "code",
          threadId: codeThread,
          operationId: operation,
          field: "tool",
          title: "CI",
          lifecycle: "active",
          projectId,
          updatedAt: now,
          snippet: "release.yml",
        },
        {
          mode: "work",
          threadId: workThread,
          turnId: chatTurn,
          field: "reply",
          title: "Brief",
          lifecycle: "archived",
          projectId,
          updatedAt: now,
          snippet: "release",
        },
      ],
    });
  });

  it("searches one mode when a scope names it, and reports a mode that cannot list as unavailable", async () => {
    const search = vi.fn((): ThreadSearchRows => ({ matches: [], truncated: false }));
    const chat = vi.fn(() => []);
    const route = fixture({
      search,
      chat,
      code: async () => {
        throw new Error("Code is not ready");
      },
    });

    const scoped = await route(request("/api/search?q=release&scope=work"));
    expect(await scoped?.json()).toMatchObject({ scope: "work", unavailable: ["work"] });
    expect(chat).not.toHaveBeenCalled();

    const all = await route(request("/api/search?q=release"));
    expect(await all?.json()).toMatchObject({ scope: "all", unavailable: ["work", "code"] });
  });

  it("answers an empty search with no hits and without reading any mode", async () => {
    const search = vi.fn((): ThreadSearchRows => ({ matches: [], truncated: false }));
    const chat = vi.fn(() => []);
    const response = await fixture({ search, chat })(request("/api/search?q=%20%20"));
    expect(await response?.json()).toEqual({
      query: "",
      scope: "all",
      hits: [],
      truncated: false,
      unavailable: [],
    });
    expect(chat).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it("refuses a missing capability, another method, another query key, an unknown scope, and an overlong query", async () => {
    const search = vi.fn((): ThreadSearchRows => ({ matches: [], truncated: false }));
    const route = fixture({ search });

    const status = async (path: string, init: RequestInit = {}) =>
      (await route(request(path, init)))?.status;
    expect(
      await status("/api/search?q=a", {
        headers: { "x-octant-window-capability": "B".repeat(43) },
      }),
    ).toBe(401);
    expect(await status("/api/search?q=a", { method: "POST" })).toBe(405);
    expect(await status("/api/search?q=a&windowId=x")).toBe(400);
    expect(await status("/api/search?q=a&q=b")).toBe(400);
    expect(await status("/api/search?q=a&scope=everything")).toBe(400);
    expect(await status(`/api/search?q=${"a".repeat(201)}`)).toBe(400);
    expect(await route(request("/api/searches?q=a"))).toBeUndefined();
    expect(search).not.toHaveBeenCalled();
  });
});

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (!headers.has("x-octant-window-capability")) {
    headers.set("x-octant-window-capability", capability);
  }
  return new Request(`http://127.0.0.1${path}`, { ...init, headers });
}

function fixture(sources: ThreadSearchSources) {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  return createThreadSearchRouteHandler({ sources, windowAuthorityStore: store, now: () => 1 });
}
