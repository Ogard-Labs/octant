import { describe, expect, it } from "vitest";
import { enabledModes, resolveAvailableMode } from "./modePolicy";

describe("mode policy", () => {
  it("always retains Code and removes disabled optional surfaces", () => {
    expect(enabledModes({ chatEnabled: false, workEnabled: false })).toEqual(["code"]);
    expect(enabledModes({ chatEnabled: true, workEnabled: false })).toEqual(["chat", "code"]);
  });

  it("falls back to Code when a persisted optional mode is disabled", () => {
    expect(resolveAvailableMode("chat", { chatEnabled: false, workEnabled: true })).toBe("code");
    expect(resolveAvailableMode("work", { chatEnabled: true, workEnabled: true })).toBe("work");
  });
});
