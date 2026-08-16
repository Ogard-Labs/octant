import { describe, expect, it, vi } from "vitest";
import { startBrowserRuntimeBroker } from "./browserRuntimeBroker";

const contextId = "10000000-0000-4000-8000-000000000001";

function host() {
  return {
    available: () => true,
    act: vi.fn(async () => ({ url: "https://example.com/" })),
    closeAll: vi.fn(async () => undefined),
    closeContext: vi.fn(async () => undefined),
    createContext: vi.fn(async () => undefined),
    inspectTarget: vi.fn(async () => ({ sensitive: false })),
    onContextGone: vi.fn(() => () => undefined),
  };
}

describe("BrowserRuntimeBroker", () => {
  it("accepts only authenticated bounded interactive actions", async () => {
    const surface = host();
    const broker = await startBrowserRuntimeBroker(surface as never);
    try {
      const response = await broker.fetchForTest(
        request(broker.url, broker.token, {
          contextId,
          request: {
            kind: "click",
            point: { x: 0.5, y: 0.25 },
          },
        }),
      );

      expect(response.status).toBe(200);
      expect(surface.act).toHaveBeenCalledWith(contextId, {
        kind: "click",
        point: { x: 0.5, y: 0.25 },
      });

      const invalid = await broker.fetchForTest(
        request(broker.url, broker.token, {
          contextId,
          request: { kind: "scroll", deltaY: 2001 },
        }),
      );
      expect(invalid.status).toBe(400);
      expect(surface.act).toHaveBeenCalledOnce();
    } finally {
      await broker.close();
    }
  });

  it("rejects remote or unauthenticated callers", async () => {
    const broker = await startBrowserRuntimeBroker(host() as never);
    try {
      const unauthenticated = new Request(new URL("v1/available", broker.url), {
        method: "POST",
      });
      expect((await broker.fetchForTest(unauthenticated)).status).toBe(401);
      expect(
        (await broker.fetchForTest(request(broker.url, broker.token, {}), "192.0.2.1")).status,
      ).toBe(401);
    } finally {
      await broker.close();
    }
  });
});

function request(url: string, token: string, body: unknown): Request {
  return new Request(new URL("v1/contexts/act", url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-octant-browser-broker-token": token,
    },
    body: JSON.stringify(body),
  });
}
