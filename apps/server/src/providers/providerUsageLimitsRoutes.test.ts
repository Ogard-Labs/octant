import {
  decodeWindowId,
  type ProviderUsageLimitsSnapshot,
  type UtcTimestamp,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { createProviderUsageLimitsRouteHandler } from "./providerUsageLimitsRoutes";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("80000000-0000-4000-8000-000000000020");
const snapshot: ProviderUsageLimitsSnapshot = {
  version: 1,
  refreshedAt: "2026-08-23T12:00:00.000Z" as UtcTimestamp,
  entries: [],
};

describe("provider usage limit routes", () => {
  it("authenticates list and explicit refresh without accepting query authority", async () => {
    const service = { snapshot: vi.fn(() => snapshot), refresh: vi.fn(async () => snapshot) };
    const route = fixture(service);
    const headers = { "x-octant-window-capability": capability };

    const listed = await route(
      new Request("http://127.0.0.1/api/provider-usage-limits", { headers }),
    );
    const refreshed = await route(
      new Request("http://127.0.0.1/api/provider-usage-limits/refresh", {
        method: "POST",
        headers,
      }),
    );

    expect(listed?.status).toBe(200);
    expect(refreshed?.status).toBe(200);
    expect(service.snapshot).toHaveBeenCalledOnce();
    expect(service.refresh).toHaveBeenCalledOnce();
    expect(await listed?.json()).toEqual(snapshot);
  });

  it("refuses non-loopback, missing capability, query strings, and unsupported methods", async () => {
    const route = fixture({
      snapshot: vi.fn(() => snapshot),
      refresh: vi.fn(async () => snapshot),
    });
    const headers = { "x-octant-window-capability": capability };
    const requests = [
      new Request("https://example.com/api/provider-usage-limits", { headers }),
      new Request("http://127.0.0.1/api/provider-usage-limits"),
      new Request("http://127.0.0.1/api/provider-usage-limits?window=x", { headers }),
      new Request("http://127.0.0.1/api/provider-usage-limits", { method: "POST", headers }),
      new Request("http://127.0.0.1/api/provider-usage-limits/refresh", { headers }),
    ];

    for (const request of requests) {
      expect((await route(request))?.status).toBeGreaterThanOrEqual(400);
    }
  });
});

function fixture(service: {
  readonly snapshot: () => ProviderUsageLimitsSnapshot;
  readonly refresh: () => Promise<ProviderUsageLimitsSnapshot>;
}) {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  return createProviderUsageLimitsRouteHandler({
    service,
    windowAuthorityStore: store,
    now: () => 1,
  });
}
