import { describe, expect, it } from "vitest";
import { decodeThreadDialogueMessageInput, decodeThreadDialogueResult } from "./threadDialogue";

const targetThreadId = "00000000-0000-4000-8000-000000000001";

describe("Thread dialogue contracts", () => {
  it("accepts a bounded message and completed target reply", () => {
    expect(
      decodeThreadDialogueMessageInput({
        targetThreadId,
        message: "Please inspect the failing test and report the cause.",
      }),
    ).toMatchObject({ targetThreadId, message: expect.any(String) });
    expect(
      decodeThreadDialogueResult({
        status: "completed",
        targetThreadId,
        targetTitle: "Test investigation",
        response: "The fixture uses a stale version.",
      }),
    ).toMatchObject({ status: "completed", targetThreadId });
  });

  it("rejects an unbounded or empty message", () => {
    expect(() => decodeThreadDialogueMessageInput({ targetThreadId, message: " " })).toThrow();
    expect(() =>
      decodeThreadDialogueMessageInput({ targetThreadId, message: "x".repeat(8_001) }),
    ).toThrow();
  });
});
