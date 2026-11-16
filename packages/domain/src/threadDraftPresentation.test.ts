import { describe, expect, it } from "vitest";
import { draftThreadModePresentation } from "./threadDraftPresentation";

describe("draftThreadModePresentation", () => {
  it.each([
    ["chat", "Octant Chat"],
    ["work", "Octant Work"],
    ["code", "Octant Code"],
  ] as const)("names the %s draft and gives its composer a hint", (mode, eyebrow) => {
    const presentation = draftThreadModePresentation(mode);
    expect(presentation.eyebrow).toBe(eyebrow);
    expect(presentation.composerPlaceholder).toBeTruthy();
  });
});
