import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLaunchSession } from "./useLaunchSession";

const serverUrl = "http://127.0.0.1:13773";
const launchToken = `${"A".repeat(42)}A`;
const windowId = "00000000-0000-4000-8000-000000000601";
const capability = `${"C".repeat(42)}A`;
const clientContextId = "browser-tab-a";

function mockFetch(response: Response) {
  return vi.fn(async () => response) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  if (window.location.hash) {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  try {
    window.sessionStorage.clear();
  } catch {
    // ignore
  }
});

describe("useLaunchSession", () => {
  it.each([
    ["the canonical Machine URL", "http://127.0.0.1:13773/"],
    ["a Vite renderer", `http://127.0.0.1:5173/?serverUrl=${encodeURIComponent(serverUrl)}`],
  ])(
    "asks for a fresh launch, without asking the host for authority, when %s holds no session",
    async (_, href) => {
      const fetchMock = mockFetch(
        jsonResponse({ windowId, capability, authentication: "local-session" }),
      );
      const storage = createMemoryStorage();
      const { result } = renderHook(() =>
        useLaunchSession({ serverUrl, href, fetch: fetchMock, storage }),
      );
      await waitFor(() => expect(result.current.status).toBe("failed"));
      expect(result.current).toMatchObject({
        launchRequired: true,
        failureMessage: "Open Octant from the desktop app or run `octant web`.",
      });
      expect(result.current.capability).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("asks for a fresh launch after a host restart forgot the held session, and forgets it too", async () => {
    const storage = createMemoryStorage();
    storage.setItem(
      `octant:launch-session:${serverUrl}`,
      JSON.stringify({ capability, windowId, authentication: "launch-token", clientContextId }),
    );
    const fetchMock = mockFetch(
      jsonResponse(
        {
          category: "unauthorized",
          message: "Open Octant from the desktop app or run `octant web`.",
        },
        401,
      ),
    );

    const { result } = renderHook(() =>
      useLaunchSession({
        serverUrl,
        href: `http://127.0.0.1:5173/?serverUrl=${encodeURIComponent(serverUrl)}`,
        fetch: fetchMock,
        storage,
        clientContextId,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe("failed"));
    expect(result.current.launchRequired).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/api/shell/local-session", serverUrl),
      expect.objectContaining({
        body: JSON.stringify({ windowId, capability }),
        method: "POST",
      }),
    );
    expect(storage.getItem(`octant:launch-session:${serverUrl}`)).toBeNull();
  });

  it("shows the launch guidance when a mounted session is refused and renewal cannot restore it", async () => {
    const storage = createMemoryStorage();
    storage.setItem(
      `octant:launch-session:${serverUrl}`,
      JSON.stringify({ capability, windowId, authentication: "launch-token", clientContextId }),
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ windowId, capability, authentication: "local-session" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ category: "unauthorized", message: "refused" }, 401),
      ) as unknown as typeof fetch;
    const { result } = renderHook(() =>
      useLaunchSession({
        serverUrl,
        href: `${serverUrl}/`,
        fetch: fetchMock,
        storage,
        clientContextId,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await expect(result.current.renew?.()).rejects.toThrow(
        "Open Octant from the desktop app or run `octant web`.",
      );
    });

    expect(result.current).toMatchObject({ status: "failed", launchRequired: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects an invalid renewal response with the product error", async () => {
    const storage = createMemoryStorage();
    storage.setItem(
      `octant:launch-session:${serverUrl}`,
      JSON.stringify({ capability, windowId, authentication: "local-session", clientContextId }),
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ windowId, capability, authentication: "local-session" }),
      )
      .mockResolvedValueOnce(jsonResponse(null)) as unknown as typeof fetch;
    const { result } = renderHook(() =>
      useLaunchSession({
        serverUrl,
        href: `${serverUrl}/`,
        fetch: fetchMock,
        storage,
        clientContextId,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const renew = result.current.renew;
    if (renew === undefined) throw new Error("Expected session renewal.");

    await expect(renew()).rejects.toThrow("Local Machine response is invalid.");
  });

  it("keeps the same client context when the current host validates it", async () => {
    const storage = createMemoryStorage();
    storage.setItem(
      `octant:launch-session:${serverUrl}`,
      JSON.stringify({ capability, windowId, authentication: "local-session", clientContextId }),
    );
    const fetchMock = mockFetch(
      jsonResponse({ windowId, capability, authentication: "local-session" }),
    );

    const { result } = renderHook(() =>
      useLaunchSession({
        serverUrl,
        href: `http://127.0.0.1:5173/?serverUrl=${encodeURIComponent(serverUrl)}`,
        fetch: fetchMock,
        storage,
        clientContextId,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current).toMatchObject({
      authentication: "local-session",
      capability,
      windowId,
    });
  });

  it("does not reuse copied session context in a different browser tab", async () => {
    const storage = createMemoryStorage();
    storage.setItem(
      `octant:launch-session:${serverUrl}`,
      JSON.stringify({ capability, windowId, authentication: "launch-token", clientContextId }),
    );
    const fetchMock = mockFetch(
      jsonResponse({ windowId, capability, authentication: "local-session" }),
    );

    const { result } = renderHook(() =>
      useLaunchSession({
        serverUrl,
        href: `${serverUrl}/`,
        fetch: fetchMock,
        storage,
        clientContextId: "browser-tab-b",
      }),
    );

    await waitFor(() => expect(result.current.status).toBe("failed"));
    expect(result.current.launchRequired).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is idle when no server URL is available", () => {
    const { result } = renderHook(() =>
      useLaunchSession({ href: `http://127.0.0.1:13773/#launchToken=${launchToken}` }),
    );
    expect(result.current.status).toBe("idle");
  });

  it("exchanges a launch token for the window capability and reports ready", async () => {
    const fetchMock = mockFetch(jsonResponse({ windowId, capability }));
    const onLaunchTokenRead = vi.fn(() => {
      // The token leaves the address bar before the exchange is attempted.
      expect(fetchMock).not.toHaveBeenCalled();
    });
    const { result } = renderHook(() =>
      useLaunchSession({
        serverUrl,
        href: `http://127.0.0.1:13773/?serverUrl=${encodeURIComponent(serverUrl)}#launchToken=${launchToken}`,
        fetch: fetchMock,
        onLaunchTokenRead,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.capability).toBe(capability);
    expect(result.current.windowId).toBe(windowId);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/api/shell/launch-session", serverUrl),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "content-type": "application/json" }),
      }),
    );
    expect(onLaunchTokenRead).toHaveBeenCalledOnce();
  });

  it("refuses to follow a redirect during the launch exchange", async () => {
    const fetchMock = mockFetch(jsonResponse({ windowId, capability }));
    const { result } = renderHook(() =>
      useLaunchSession({
        serverUrl,
        href: `http://127.0.0.1:13773/#launchToken=${launchToken}`,
        fetch: fetchMock,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/api/shell/launch-session", serverUrl),
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("treats a redirect error as a failed launch exchange and stores no capability", async () => {
    const storage = createMemoryStorage();
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const { result } = renderHook(() =>
      useLaunchSession({
        serverUrl,
        href: `http://127.0.0.1:13773/#launchToken=${launchToken}`,
        fetch: fetchMock,
        storage,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("failed"));
    expect(result.current.capability).toBeUndefined();
    expect(storage.getItem(`octant:launch-session:${serverUrl}`)).toBeNull();
  });

  it("shares the one-shot launch exchange across StrictMode effect replay", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    ) as unknown as typeof fetch;
    const { result } = renderHook(
      () =>
        useLaunchSession({
          serverUrl,
          href: `http://127.0.0.1:13773/?serverUrl=${encodeURIComponent(serverUrl)}#launchToken=${launchToken}`,
          fetch: fetchMock,
        }),
      { wrapper: StrictMode },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    resolveFetch(jsonResponse({ windowId, capability }));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("builds the exchange endpoint with URL resolution even when serverUrl has a trailing slash", async () => {
    const fetchMock = mockFetch(jsonResponse({ windowId, capability }));
    const { result } = renderHook(() =>
      useLaunchSession({
        serverUrl: `${serverUrl}/`,
        href: `http://127.0.0.1:13773/#launchToken=${launchToken}`,
        fetch: fetchMock,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/api/shell/launch-session", `${serverUrl}/`),
      expect.objectContaining({ method: "POST" }),
    );
    expect((vi.mocked(fetchMock).mock.calls[0]![0] as URL).toString()).toBe(
      `${serverUrl}/api/shell/launch-session`,
    );
  });

  it("reports failed when the exchange rejects an expired or consumed token", async () => {
    const fetchMock = mockFetch(jsonResponse({ category: "invalid", message: "expired" }, 400));
    const { result } = renderHook(() =>
      useLaunchSession({
        serverUrl,
        href: `http://127.0.0.1:13773/#launchToken=${launchToken}`,
        fetch: fetchMock,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("failed"));
    expect(result.current.capability).toBeUndefined();
  });

  it("classifies a non-JSON rejection as an invalid launch session", async () => {
    const fetchMock = mockFetch(new Response("rejected", { status: 400 }));
    const { result } = renderHook(() =>
      useLaunchSession({
        serverUrl,
        href: `http://127.0.0.1:13773/#launchToken=${launchToken}`,
        fetch: fetchMock,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe("failed"));
    expect(result.current.failureMessage).toBe("Octant launch session is invalid or expired.");
  });

  it("reports failed when the host is unreachable", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    const { result } = renderHook(() =>
      useLaunchSession({
        serverUrl,
        href: `http://127.0.0.1:13773/#launchToken=${launchToken}`,
        fetch: fetchMock,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("failed"));
  });

  it("asks for a fresh launch when a launch-token fragment is malformed", async () => {
    const fetchMock = mockFetch(jsonResponse({ windowId, capability }));
    const storage = createMemoryStorage();
    const { result } = renderHook(() =>
      useLaunchSession({
        serverUrl,
        href: "http://127.0.0.1:13773/#launchToken=short",
        fetch: fetchMock,
        storage,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("failed"));
    expect(result.current.launchRequired).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("revalidates stored local client context on reload without a fragment", async () => {
    const storage = createMemoryStorage();
    storage.setItem(
      `octant:launch-session:${serverUrl}`,
      JSON.stringify({ capability, windowId, authentication: "local-session", clientContextId }),
    );
    const fetchMock = mockFetch(
      jsonResponse({ windowId, capability, authentication: "local-session" }),
    );
    const { result } = renderHook(() =>
      useLaunchSession({
        serverUrl,
        href: "http://127.0.0.1:13773/",
        fetch: fetchMock,
        storage,
        clientContextId,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.capability).toBe(capability);
    expect(result.current.windowId).toBe(windowId);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("persists the exchanged authority to sessionStorage for reloads", async () => {
    const storage = createMemoryStorage();
    const fetchMock = mockFetch(jsonResponse({ windowId, capability }));
    const { result } = renderHook(() =>
      useLaunchSession({
        serverUrl,
        href: `http://127.0.0.1:13773/#launchToken=${launchToken}`,
        fetch: fetchMock,
        storage,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const stored = storage.getItem(`octant:launch-session:${serverUrl}`);
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored ?? "{}");
    expect(parsed.capability).toBe(capability);
    expect(parsed.windowId).toBe(windowId);
  });

  it("keeps a session exchanged from a launch token across a reload by refreshing it", async () => {
    const storage = createMemoryStorage();
    const exchangeMock = mockFetch(jsonResponse({ windowId, capability }));
    const exchange = renderHook(() =>
      useLaunchSession({
        serverUrl,
        href: `http://127.0.0.1:13773/#launchToken=${launchToken}`,
        fetch: exchangeMock,
        storage,
        clientContextId,
      }),
    );
    await waitFor(() => expect(exchange.result.current.status).toBe("ready"));
    exchange.unmount();

    const refreshMock = mockFetch(
      jsonResponse({ windowId, capability, authentication: "local-session" }),
    );
    const { result } = renderHook(() =>
      useLaunchSession({
        serverUrl,
        href: "http://127.0.0.1:13773/",
        fetch: refreshMock,
        storage,
        clientContextId,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current).toMatchObject({ capability, windowId, authentication: "launch-token" });
    expect(refreshMock).toHaveBeenCalledWith(
      new URL("/api/shell/local-session", serverUrl),
      expect.objectContaining({ body: JSON.stringify({ windowId, capability }) }),
    );
  });
});

function createMemoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}
