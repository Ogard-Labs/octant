import { describe, expect, it, vi } from "vitest";
import { openMovedThreadThere } from "./threadMoveOpenThere";

const THREAD = { mode: "work", threadId: "77777777-7777-4777-8777-777777777777" } as const;
const ARRIVED = "11111111-1111-4111-8111-111111111111";

function departedStatus(destinationWebOrigin?: string) {
  return {
    status: "read",
    departed: {
      moveId: "44444444-4444-4444-8444-444444444444",
      thread: THREAD,
      destinationMemberId: "99999999-9999-4999-8999-999999999999",
      destinationThread: { mode: "work", threadId: ARRIVED },
      destinationName: "Studio",
      changesRemainInCheckout: false,
      movedAt: "2026-11-09T09:00:00.000Z",
      ...(destinationWebOrigin === undefined ? {} : { destinationWebOrigin }),
    },
  };
}

function host(answer: unknown, status = 200) {
  const fetch = vi.fn(async (_url: URL, _init?: RequestInit) => Response.json(answer, { status }));
  return {
    fetch,
    runtime: {
      serverUrl: "http://127.0.0.1:4317",
      desktopBridgeSecret: "bridge-secret",
      windowCapability: "A".repeat(43),
      fetch: fetch as unknown as typeof globalThis.fetch,
    },
  };
}

describe("opening a moved thread on the computer it moved to", () => {
  it("asks this host where the thread went and opens that member's own page for it", async () => {
    const { fetch, runtime } = host(departedStatus("https://studio.tail1234.ts.net:8443"));
    const openExternal = vi.fn(async (_url: string) => {});

    await expect(openMovedThreadThere({ runtime, thread: THREAD, openExternal })).resolves.toEqual({
      status: "opened",
    });
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:4317/api/desktop/hub/thread-moves/status",
    );
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ thread: THREAD }));
    expect(openExternal).toHaveBeenCalledWith(
      `https://studio.tail1234.ts.net:8443/?continueMode=work&continueThread=${ARRIVED}`,
    );
  });

  it("refuses a destination page that is not https on a Tailscale name, and opens nothing", async () => {
    for (const origin of [
      "http://studio.tail1234.ts.net",
      "https://studio.example.com",
      "https://100.64.0.1",
      "file:///etc/passwd",
    ]) {
      const { runtime } = host(departedStatus(origin));
      const openExternal = vi.fn(async (_url: string) => {});
      await expect(
        openMovedThreadThere({ runtime, thread: THREAD, openExternal }),
        origin,
      ).resolves.toEqual({ status: "refused" });
      expect(openExternal, origin).not.toHaveBeenCalled();
    }
  });

  it("refuses when the host names no web app, does not show the thread, or holds no departure", async () => {
    for (const [answer, status] of [
      [departedStatus(), 200],
      [{ category: "unauthorized", message: "no" }, 401],
      [{ status: "read" }, 200],
    ] as const) {
      const { runtime } = host(answer, status);
      const openExternal = vi.fn(async (_url: string) => {});
      await expect(
        openMovedThreadThere({ runtime, thread: THREAD, openExternal }),
      ).resolves.toEqual({ status: "refused" });
      expect(openExternal).not.toHaveBeenCalled();
    }
  });

  it("refuses a thread that is not a thread reference before asking the host", async () => {
    const { fetch, runtime } = host(departedStatus("https://studio.tail1234.ts.net"));
    const openExternal = vi.fn(async (_url: string) => {});
    await expect(
      openMovedThreadThere({ runtime, thread: "https://evil.example", openExternal }),
    ).resolves.toEqual({ status: "refused" });
    expect(fetch).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });
});
