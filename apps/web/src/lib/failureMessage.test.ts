import { describe, expect, it } from "vitest";
import { failureMessage } from "./failureMessage";

describe("failureMessage", () => {
  it("reads a non-empty message from an Error", () => {
    expect(failureMessage(new Error("unavailable"), "fallback")).toBe("unavailable");
  });

  it("uses the fallback for an empty message", () => {
    expect(failureMessage({ message: "" }, "fallback")).toBe("fallback");
  });

  it("uses the fallback for a thrown string", () => {
    expect(failureMessage("unavailable", "fallback")).toBe("fallback");
  });
});
