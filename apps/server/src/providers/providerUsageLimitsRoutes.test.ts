import {
  decodeWindowId,
  type ProviderUsageLimitsSnapshot,
  type UtcTimestamp,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { bindPrincipalRouteContext } from "../principalRouteContext";
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
    // A person pressed refresh: the one call that may ask a costly source.
    expect(service.refresh).toHaveBeenCalledExactlyOnceWith({ onDemand: true });
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

  it("accepts the packaged renderer's opaque Origin while retaining window auth", async () => {
    const route = fixture({
      snapshot: vi.fn(() => snapshot),
      refresh: vi.fn(async () => snapshot),
    });
    const response = await route(
      new Request("http://127.0.0.1/api/provider-usage-limits", {
        headers: { origin: "null", "x-octant-window-capability": capability },
      }),
    );
    expect(response?.status).toBe(200);
    expect(response?.headers.get("access-control-allow-origin")).toBe("null");
  });

  it("answers a device the host's own person paired, and refuses a hub-introduced device and an unproved pairing whatever the URL says", async () => {
    const refresh = vi.fn(async () => snapshot);
    const route = fixture({ snapshot: vi.fn(() => snapshot), refresh });
    // URL rewriting to loopback must not turn a bound remote principal into a
    // local-window principal: only the host's own approval record does.
    const fromDevice = (path: string, admittedBy?: "host-person" | "hub-roster") => {
      const loopback = new Request(`http://127.0.0.1${path}`, {
        method: path.endsWith("/refresh") ? "POST" : "GET",
        headers: { origin: "null", "x-octant-window-capability": capability },
      });
      bindPrincipalRouteContext(loopback, {
        principal: {
          kind: "remote-device",
          ...(admittedBy === undefined ? {} : { admittedBy }),
        } as never,
        scopeId: windowId,
      });
      return loopback;
    };
    for (const restricted of [undefined, "hub-roster"] as const) {
      expect((await route(fromDevice("/api/provider-usage-limits", restricted)))?.status).toBe(403);
      expect(
        (await route(fromDevice("/api/provider-usage-limits/refresh", restricted)))?.status,
      ).toBe(403);
    }
    expect(refresh).not.toHaveBeenCalled();

    expect((await route(fromDevice("/api/provider-usage-limits", "host-person")))?.status).toBe(
      200,
    );
    expect(
      (await route(fromDevice("/api/provider-usage-limits/refresh", "host-person")))?.status,
    ).toBe(200);
    expect(refresh).toHaveBeenCalledOnce();
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
