import { describe, expect, it } from "vitest";
import {
  OCTANT_INSTRUCTIONS_LIMITS,
  PERSON_INSTRUCTIONS_PREAMBLE,
  octantInstructionsWithinLimit,
  personInstructionsBlockText,
} from "./octantInstructionsPolicy";
import { looksLikeSecret } from "./secretShapedTextPolicy";

describe("Octant instructions policy", () => {
  it("allows 8,000 characters for your instructions and 4,000 for a Project's and orchestration", () => {
    expect(OCTANT_INSTRUCTIONS_LIMITS).toEqual({
      person: 8_000,
      project: 4_000,
      orchestration: 4_000,
    });
    expect(octantInstructionsWithinLimit("person", "a".repeat(8_000))).toBe(true);
    expect(octantInstructionsWithinLimit("person", "a".repeat(8_001))).toBe(false);
    expect(octantInstructionsWithinLimit("orchestration", "a".repeat(4_001))).toBe(false);
  });

  it("sends nothing for an empty text and the person's words unchanged after the preamble otherwise", () => {
    expect(personInstructionsBlockText("")).toBeUndefined();
    expect(personInstructionsBlockText("  \n ")).toBeUndefined();
    expect(personInstructionsBlockText("Use Work for research.\n")).toBe(
      `${PERSON_INSTRUCTIONS_PREAMBLE}\n\nUse Work for research.\n`,
    );
  });

  it("says the text is for Octant, that a provider's own files come first, and that it grants nothing", () => {
    expect(PERSON_INSTRUCTIONS_PREAMBLE).toContain("inside Octant");
    expect(PERSON_INSTRUCTIONS_PREAMBLE).toContain("your own instruction files come first");
    expect(PERSON_INSTRUCTIONS_PREAMBLE).toContain("grant no permission");
  });

  it("flags a text that looks like it holds a key or a private key, and not ordinary rules", () => {
    expect(looksLikeSecret("api_key=abc123")).toBe(true);
    expect(looksLikeSecret("-----BEGIN RSA PRIVATE KEY-----\nMIIE")).toBe(true);
    expect(looksLikeSecret("Prefer Codex for refactors; ask before pushing.")).toBe(false);
  });
});
