import { describe, expect, it } from "vitest";
import { decodeSideChatDraftReturnReference } from "@octant/contracts";
import { prepareSideChatReturnedText } from "./sideChatReturn";

describe("selected reply draft framing", () => {
  it("states a legacy source snapshot is unrecorded and visibly bounds only the chosen answer", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const ref = decodeSideChatDraftReturnReference({
      sidecarThreadId: id,
      sourceThreadId: id,
      sourceMode: "work",
      turnId: id,
      attemptId: id,
      answerDigest: "a".repeat(64),
    });
    const result = prepareSideChatReturnedText(ref, "x".repeat(33_000), undefined);
    expect(result.text).toContain("Original source snapshot versions were not recorded");
    expect(result.text).toContain("not execution approval");
    expect(result.omissions).toContain("This reply is truncated to 32000 characters from 33000.");
    expect(result.text).not.toContain("x".repeat(32_001));
    expect(result.text.length).toBeLessThan(40_000);
  });
});
