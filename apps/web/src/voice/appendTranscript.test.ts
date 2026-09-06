import { describe, expect, it } from "vitest";
import { appendTranscript } from "./appendTranscript";

describe("appendTranscript", () => {
  it("adds spoken words to the draft as more of the same message", () => {
    expect(appendTranscript("", "  Hello there ")).toBe("Hello there");
    expect(appendTranscript("Please", "fix the tests")).toBe("Please fix the tests");
    expect(appendTranscript("Please ", "fix the tests")).toBe("Please fix the tests");
    expect(appendTranscript("Line one\n", "line two")).toBe("Line one\nline two");
    expect(appendTranscript("Keep me", "   ")).toBe("Keep me");
  });
});
