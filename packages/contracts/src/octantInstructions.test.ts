import { describe, expect, it } from "vitest";
import {
  PERSON_INSTRUCTIONS_MAX_CHARACTERS,
  PROJECT_INSTRUCTIONS_MAX_CHARACTERS,
  decodeOctantInstructionsCommand,
  decodePersonInstructionsChanged,
  decodeProjectInstructionsChanged,
} from "./octantInstructions";

const projectId = "00000000-0000-4000-8000-0000000000a1";

describe("Octant instructions contracts", () => {
  it("decodes a change to the person's instructions and to a Project's, with the whole text", () => {
    expect(decodePersonInstructionsChanged({ instructions: "Use Work for research." })).toEqual({
      instructions: "Use Work for research.",
    });
    expect(
      decodeProjectInstructionsChanged({ projectId, instructions: "Ship from main only." }),
    ).toEqual({ projectId, instructions: "Ship from main only." });
  });

  it("carries orchestration in the person's record, held to 4,000 characters", () => {
    expect(decodePersonInstructionsChanged({ instructions: "", orchestration: "Split." })).toEqual({
      instructions: "",
      orchestration: "Split.",
    });
    expect(() =>
      decodePersonInstructionsChanged({ instructions: "", orchestration: "a".repeat(4_001) }),
    ).toThrow();
  });

  it("accepts a cleared text, which turns it off", () => {
    expect(decodePersonInstructionsChanged({ instructions: "" }).instructions).toBe("");
  });

  it("holds the person's text to 8,000 characters and a Project's to 4,000", () => {
    expect(PERSON_INSTRUCTIONS_MAX_CHARACTERS).toBe(8_000);
    expect(PROJECT_INSTRUCTIONS_MAX_CHARACTERS).toBe(4_000);
    expect(() =>
      decodePersonInstructionsChanged({ instructions: "a".repeat(8_000) }),
    ).not.toThrow();
    expect(() => decodePersonInstructionsChanged({ instructions: "a".repeat(8_001) })).toThrow();
    expect(() =>
      decodeProjectInstructionsChanged({ projectId, instructions: "a".repeat(4_001) }),
    ).toThrow();
  });

  it("refuses a change that names no version it read, or carries anything else", () => {
    expect(() =>
      decodeOctantInstructionsCommand({ kind: "change-person-instructions", instructions: "x" }),
    ).toThrow();
    expect(() =>
      decodeOctantInstructionsCommand({
        kind: "change-person-instructions",
        expectedVersion: 0,
        instructions: "x",
        actor: "agent",
      }),
    ).toThrow();
  });
});
