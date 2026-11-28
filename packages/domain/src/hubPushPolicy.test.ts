import { describe, expect, it } from "vitest";
import { decidePushRate } from "./hubPushPolicy";

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
