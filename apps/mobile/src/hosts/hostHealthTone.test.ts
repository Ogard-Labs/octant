import { describe, expect, it } from "vitest";
import { hostHealthTone } from "./hostHealthTone";

describe("Host health tone", () => {
  it("marks stale hosts as warnings and unavailable hosts as dangers", () => {
    expect(hostHealthTone("ready")).toBe("neutral");
    expect(hostHealthTone("idle")).toBe("neutral");
    expect(hostHealthTone("stale")).toBe("warning");
    expect(hostHealthTone("unavailable")).toBe("danger");
  });
});
