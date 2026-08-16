import { describe, expect, it, vi } from "vitest";
import { DesktopBrowserRuntime } from "./desktopBrowserRuntime";

const contextId = "60000000-0000-4000-8000-000000000001" as never;
const policy = {
  profileMode: "isolated" as const,
  allowedOrigins: ["https://example.com"],
  credentialFieldProtection: true,
  maxConcurrentTabs: 1,
  sessionTimeoutMs: 300_000,
};

describe("DesktopBrowserRuntime", () => {
  it("authenticates every loopback broker request and forwards the exact context owner", async () => {
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    const runtime = new DesktopBrowserRuntime({
      brokerUrl: "http://127.0.0.1:41234/",
      token: "broker-token",
      fetch,
    });

    await runtime.createContext(contextId, policy, new AbortController().signal, {
      windowId: "window-a" as never,
      threadId: "10000000-0000-4000-8000-000000000001" as never,
    });

    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:41234/v1/contexts/create",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
          "x-octant-browser-broker-token": "broker-token",
        }),
      }),
    );
    const request = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(request[1].body))).toMatchObject({
      contextId,
      owner: { windowId: "window-a" },
      policy,
    });
  });

  it("fails closed when the desktop broker is unavailable", async () => {
    const runtime = new DesktopBrowserRuntime({
      brokerUrl: "http://127.0.0.1:41234/",
      token: "broker-token",
      fetch: vi.fn(async () => new Response(null, { status: 503 })),
    });

    await expect(runtime.available()).resolves.toBe(false);
    await expect(
      runtime.createContext(contextId, policy, new AbortController().signal, {
        windowId: "window-a" as never,
        threadId: "10000000-0000-4000-8000-000000000001" as never,
      }),
    ).rejects.toThrow("desktop Browser broker");
  });

  it("reports only native contexts whose renderer process disappeared", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(async (input: string | URL | Request) =>
        Response.json(
          String(input).endsWith("/v1/contexts/gone") ? { contextIds: [contextId] } : { ok: true },
        ),
      );
      const runtime = new DesktopBrowserRuntime({
        brokerUrl: "http://127.0.0.1:41234/",
        token: "broker-token",
        fetch,
        eventPollIntervalMs: 10,
      });
      const exited = vi.fn();
      const remove = runtime.onProcessExit(exited);

      await vi.advanceTimersByTimeAsync(10);

      expect(exited).toHaveBeenCalledWith([contextId]);
      remove();
    } finally {
      vi.useRealTimers();
    }
  });
});
