import { effectiveReplyDetail } from "@octant/domain/reply-detail-policy";
import { describe, expect, it } from "vitest";
import { mobileReplyDetailPresentation } from "./replyDetailPresentation";

const reasoning = "**Compare** the fixtures.\nThe second is stale.";

describe("a reply on the phone at each Reply detail level", () => {
  it("keeps reasoning shut and finished tool cards folded at low, as the phone always has", () => {
    expect(mobileReplyDetailPresentation("low", reasoning)).toEqual({
      reasoningExpanded: false,
      reasoningPreview: "",
      toolDetailOpen: false,
    });
  });

  it("keeps reasoning shut with its first line showing at medium", () => {
    expect(mobileReplyDetailPresentation("medium", reasoning)).toEqual({
      reasoningExpanded: false,
      reasoningPreview: "Compare the fixtures.",
      toolDetailOpen: false,
    });
  });

  it("opens reasoning and every tool card at high", () => {
    expect(mobileReplyDetailPresentation("high", reasoning)).toEqual({
      reasoningExpanded: true,
      reasoningPreview: "",
      toolDetailOpen: true,
    });
  });

  it("draws a thread at its own level, else at the default the host reports", () => {
    const reading = {
      defaultLevel: "medium" as const,
      threads: [{ mode: "code" as const, threadId: "thread-1", level: "high" as const }],
    };
    expect(effectiveReplyDetail(reading, { mode: "code", threadId: "thread-1" })).toBe("high");
    expect(effectiveReplyDetail(reading, { mode: "code", threadId: "thread-2" })).toBe("medium");
  });
});
