import { describe, expect, it } from "vitest";
import {
  compareRemoteForwardListToClassifier,
  defaultRemoteAuthenticatedRouteCount,
} from "./remoteForwardListClassifierGate";
import { createRemoteRoutePolicy } from "./remoteRoutePolicy";

const origin = "https://octant.example:8443";

describe("remote forward list vs route classifier", () => {
  it("keeps the default forward list aligned with the product classifier", () => {
    expect(defaultRemoteAuthenticatedRouteCount()).toBeGreaterThan(0);
    expect(compareRemoteForwardListToClassifier()).toEqual([]);
  });

  it("does not forward host-wide usage purges or diagnostics export", () => {
    const policy = createRemoteRoutePolicy({ origin });
    for (const path of ["/api/usage/reset", "/api/usage/retain", "/api/diagnostics/export"]) {
      const decision = policy.inspect(
        new Request(`${origin}${path}`, {
          method: "POST",
          headers: {
            host: "octant.example:8443",
            origin,
            "sec-fetch-site": "same-origin",
            "content-type": "application/json",
          },
        }),
      );
      expect(decision.kind).toBe("reject");
    }
  });
});
