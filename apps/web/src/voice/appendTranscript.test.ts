import { describe, expect, it } from "vitest";
import { appendTranscript } from "./appendTranscript";

describe("appendTranscript", () => {
  it("adds spoken words to the draft as more of the same message", () => {
    expect(appendTranscript("chat:t", "", "  Hello there ")).toBe("Hello there");
    expect(appendTranscript("chat:t", "Please", "fix the tests")).toBe("Please fix the tests");
    expect(appendTranscript("chat:t", "Please ", "fix the tests")).toBe("Please fix the tests");
    expect(appendTranscript("chat:t", "Line one\n", "line two")).toBe("Line one\nline two");
    expect(appendTranscript("chat:t", "Keep me", "   ")).toBe("Keep me");
  });
});
