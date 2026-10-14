import { describe, expect, it } from "vitest";
import {
  compareRemoteForwardListToClassifier,
  defaultRemoteAuthenticatedRouteCount,
} from "./remoteForwardListClassifierGate";
import { classifyProductAction } from "./authenticatedProductRoutes";
import { createRemoteRoutePolicy } from "./remoteRoutePolicy";

const origin = "https://octant.example:8443";

describe("remote forward list vs route classifier", () => {
  it("keeps the default forward list aligned with the product classifier", () => {
    expect(defaultRemoteAuthenticatedRouteCount()).toBeGreaterThan(0);
    expect(compareRemoteForwardListToClassifier()).toEqual([]);
  });

  it("does not forward host-wide usage purges, diagnostics export, or host export", () => {
    const policy = createRemoteRoutePolicy({ origin });
    for (const probe of [
      { path: "/api/usage/reset", method: "POST" },
      { path: "/api/usage/retain", method: "POST" },
      { path: "/api/diagnostics/export", method: "POST" },
      { path: "/api/host-control/export", method: "GET" },
    ]) {
      const decision = policy.inspect(
        new Request(`${origin}${probe.path}`, {
          method: probe.method,
          headers: {
            host: "octant.example:8443",
            origin,
            "sec-fetch-site": "same-origin",
            ...(probe.method === "GET" ? {} : { "content-type": "application/json" }),
          },
        }),
      );
      expect(decision.kind).toBe("reject");
    }
  });

  it("forwards the Work transcript window read as an overview read", () => {
    const policy = createRemoteRoutePolicy({ origin });
    const request = new Request(
      `${origin}/api/work/turns/window/00000000-0000-4000-8000-000000000001?limit=30`,
      {
        method: "GET",
        headers: { host: "octant.example:8443", origin, "sec-fetch-site": "same-origin" },
      },
    );
    expect(policy.inspect(request)).toMatchObject({
      kind: "allow",
      surface: "authenticated-product",
    });
    expect(classifyProductAction(request)).toBe("project.overview.read");
  });

  it("forwards the Chat thread window read as an overview read", () => {
    const policy = createRemoteRoutePolicy({ origin });
    const request = new Request(
      `${origin}/api/chat/threads/00000000-0000-4000-8000-000000000001/window?limit=30`,
      {
        method: "GET",
        headers: { host: "octant.example:8443", origin, "sec-fetch-site": "same-origin" },
      },
    );
    expect(policy.inspect(request)).toMatchObject({
      kind: "allow",
      surface: "authenticated-product",
    });
    expect(classifyProductAction(request)).toBe("project.overview.read");
  });

  it("forwards the Code conversation window read as an overview read", () => {
    const policy = createRemoteRoutePolicy({ origin });
    const request = new Request(
      `${origin}/api/code/threads/00000000-0000-4000-8000-000000000001/conversation/window?limit=20`,
      {
        method: "GET",
        headers: { host: "octant.example:8443", origin, "sec-fetch-site": "same-origin" },
      },
    );
    expect(policy.inspect(request)).toMatchObject({
      kind: "allow",
      surface: "authenticated-product",
    });
    expect(classifyProductAction(request)).toBe("project.overview.read");
  });
});
