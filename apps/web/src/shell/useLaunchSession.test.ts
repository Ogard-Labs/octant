import { renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLaunchSession } from "./useLaunchSession";

const serverUrl = "http://127.0.0.1:13773";
const launchToken = `${"A".repeat(42)}A`;
const windowId = "00000000-0000-4000-8000-000000000601";
const capability = `${"C".repeat(42)}A`;

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
  it("is idle when no launch token is present in the URL fragment", () => {
    const { result } = renderHook(() =>
      useLaunchSession({ serverUrl, href: "http://127.0.0.1:13773/?serverUrl=..." }),
    );
    expect(result.current.status).toBe("idle");
  });

  it("bootstraps a development authority without a token when explicitly allowed", async () => {
    const fetchMock = mockFetch(
      jsonResponse({ windowId, capability, authentication: "development-bypass" }),
    );
    const { result } = renderHook(() =>
      useLaunchSession({
        serverUrl,
        href: `http://127.0.0.1:5173/?serverUrl=${encodeURIComponent(serverUrl)}&developmentWebBootstrap=1`,
        allowDevelopmentBootstrap: true,
        fetch: fetchMock,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.authentication).toBe("development-bypass");
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/api/shell/development-session", serverUrl),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("shares development bootstrap across StrictMode effect replay", async () => {
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
          href: `http://127.0.0.1:5173/?serverUrl=${encodeURIComponent(serverUrl)}&developmentWebBootstrap=1`,
          allowDevelopmentBootstrap: true,
          fetch: fetchMock,
        }),
      { wrapper: StrictMode },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    resolveFetch(jsonResponse({ windowId, capability, authentication: "development-bypass" }));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("refreshes development authority after a host restart instead of restoring a stale session", async () => {
    const storage = createMemoryStorage();
    storage.setItem(
      `octant:launch-session:${serverUrl}`,
      JSON.stringify({
        capability,
        windowId,
        authentication: "development-bypass",
      }),
    );
    const nextWindowId = "00000000-0000-4000-8000-000000000602";
    const nextCapability = `${"D".repeat(42)}A`;
    const fetchMock = mockFetch(
      jsonResponse({
        windowId: nextWindowId,
        capability: nextCapability,
        authentication: "development-bypass",
      }),
    );

    const { result } = renderHook(() =>
      useLaunchSession({
        serverUrl,
        href: `http://127.0.0.1:5173/?serverUrl=${encodeURIComponent(serverUrl)}&developmentWebBootstrap=1`,
        allowDevelopmentBootstrap: true,
        fetch: fetchMock,
        storage,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.capability).toBe(nextCapability);
    expect(result.current.windowId).toBe(nextWindowId);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/api/shell/development-session", serverUrl),
      expect.objectContaining({
        body: JSON.stringify({ windowId, capability }),
        method: "POST",
      }),
    );
  });

  it("keeps the same development window when the current host validates it", async () => {
    const storage = createMemoryStorage();
    storage.setItem(
      `octant:launch-session:${serverUrl}`,
      JSON.stringify({ capability, windowId, authentication: "development-bypass" }),
    );
    const fetchMock = mockFetch(
      jsonResponse({ windowId, capability, authentication: "development-bypass" }),
    );

    const { result } = renderHook(() =>
      useLaunchSession({
        serverUrl,
        href: `http://127.0.0.1:5173/?serverUrl=${encodeURIComponent(serverUrl)}&developmentWebBootstrap=1`,
        allowDevelopmentBootstrap: true,
        fetch: fetchMock,
        storage,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current).toMatchObject({
      authentication: "development-bypass",
      capability,
      windowId,
    });
  });

  it("is idle when no server URL is available", () => {
    const { result } = renderHook(() =>
      useLaunchSession({ href: `http://127.0.0.1:13773/#launchToken=${launchToken}` }),
    );
    expect(result.current.status).toBe("idle");
  });

  it("exchanges a launch token for the window capability and reports ready", async () => {
    const fetchMock = mockFetch(jsonResponse({ windowId, capability }));
    const onExchanged = vi.fn();
    const { result } = renderHook(() =>
      useLaunchSession({
        serverUrl,
        href: `http://127.0.0.1:13773/?serverUrl=${encodeURIComponent(serverUrl)}#launchToken=${launchToken}`,
        fetch: fetchMock,
        onExchanged,
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
    expect(onExchanged).toHaveBeenCalledOnce();
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

  it("ignores a malformed launch token fragment", () => {
    const fetchMock = mockFetch(jsonResponse({ windowId, capability }));
    const { result } = renderHook(() =>
      useLaunchSession({
        serverUrl,
        href: "http://127.0.0.1:13773/#launchToken=short",
        fetch: fetchMock,
      }),
    );
    expect(result.current.status).toBe("idle");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("restores the exchanged authority from sessionStorage on reload without a fragment", () => {
    const storage = createMemoryStorage();
    storage.setItem(`octant:launch-session:${serverUrl}`, JSON.stringify({ capability, windowId }));
    const fetchMock = mockFetch(jsonResponse({ windowId, capability }));
    const { result } = renderHook(() =>
      useLaunchSession({
        serverUrl,
        href: "http://127.0.0.1:13773/",
        fetch: fetchMock,
        storage,
      }),
    );
    expect(result.current.status).toBe("ready");
    expect(result.current.capability).toBe(capability);
    expect(result.current.windowId).toBe(windowId);
    expect(fetchMock).not.toHaveBeenCalled();
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
    const parsed = JSON.parse(stored!);
    expect(parsed.capability).toBe(capability);
    expect(parsed.windowId).toBe(windowId);
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
