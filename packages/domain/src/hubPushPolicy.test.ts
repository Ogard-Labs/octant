import { describe, expect, it } from "vitest";
import { decidePushGateway, decidePushRate } from "./hubPushPolicy";

describe("which gateway a forward may reach", () => {
  it("sends a request that names none to the gateway the hub's person configured", () => {
    expect(
      decidePushGateway({ requested: undefined, configured: "https://push.example.test" }),
    ).toEqual({ status: "forward", gatewayUrl: "https://push.example.test" });
  });

  it("accepts the configured gateway named with or without a trailing slash", () => {
    expect(
      decidePushGateway({
        requested: "https://push.example.test/",
        configured: "https://push.example.test",
      }).status,
    ).toBe("forward");
  });

  it("refuses a gateway the hub's person did not configure, so a spoke cannot aim a forward", () => {
    for (const requested of [
      "https://other.example.test",
      "https://push.example.test:8443",
      "https://push.example.test/v2",
      "not a url",
    ]) {
      expect(decidePushGateway({ requested, configured: "https://push.example.test" })).toEqual({
        status: "refuse",
        kind: "gateway-mismatch",
      });
    }
  });
});

describe("how often one spoke may ask", () => {
  it("allows up to the maximum inside the window and refuses the next", () => {
    let recent: ReadonlyArray<number> = [];
    for (let at = 0; at < 3; at += 1) {
      const decision = decidePushRate({ recent, nowMs: at, windowMs: 1_000, max: 3 });
      expect(decision.status).toBe("allow");
      if (decision.status === "allow") recent = decision.recent;
    }
    expect(decidePushRate({ recent, nowMs: 3, windowMs: 1_000, max: 3 })).toEqual({
      status: "refuse",
      kind: "rate-limited",
    });
  });

  it("forgets requests that left the window", () => {
    const decision = decidePushRate({ recent: [0, 1, 2], nowMs: 1_500, windowMs: 1_000, max: 3 });
    expect(decision).toEqual({ status: "allow", recent: [1_500] });
  });
});
