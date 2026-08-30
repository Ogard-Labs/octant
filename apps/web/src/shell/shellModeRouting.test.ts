import { describe, expect, it } from "vitest";
import { codeThreadActivity } from "./shellModeRouting";

describe("codeThreadActivity", () => {
  it("lights working while a turn executes, then returns to attention and unread when settled", () => {
    expect(codeThreadActivity({ lifecycle: "active", executing: true, followUp: true })).toBe(
      "working",
    );
    expect(codeThreadActivity({ lifecycle: "active", followUp: true })).toBe("attention");
    expect(codeThreadActivity({ lifecycle: "waiting" })).toBe("attention");
    expect(codeThreadActivity({ lifecycle: "interrupted" })).toBe("attention");
    expect(codeThreadActivity({ lifecycle: "active", unread: true })).toBe("unread");
    expect(codeThreadActivity({ lifecycle: "active" })).toBe("idle");
    expect(codeThreadActivity({ lifecycle: "archived" })).toBe("idle");
  });
});
