import { describe, expect, it } from "vitest";
import { codeThreadActivity } from "./shellModeRouting";

describe("codeThreadActivity", () => {
  it("gives follow-up and waiting threads attention, and unread threads an unread mark", () => {
    expect(codeThreadActivity({ lifecycle: "active", followUp: true })).toBe("attention");
    expect(codeThreadActivity({ lifecycle: "waiting" })).toBe("attention");
    expect(codeThreadActivity({ lifecycle: "interrupted" })).toBe("attention");
    expect(codeThreadActivity({ lifecycle: "active", unread: true })).toBe("unread");
    expect(codeThreadActivity({ lifecycle: "active" })).toBe("idle");
    expect(codeThreadActivity({ lifecycle: "archived" })).toBe("idle");
  });
});
