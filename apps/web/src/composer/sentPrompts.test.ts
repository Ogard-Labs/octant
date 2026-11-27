import { describe, expect, it } from "vitest";
import { promptsToRecall, sentPromptsNewestFirst } from "./sentPrompts";

describe("prompts ArrowUp recalls", () => {
  it("lists the person's prompts newest first, once each in a row", () => {
    expect(sentPromptsNewestFirst(["a", "b", "b", " ", "c"], (text) => ({ text }))).toEqual([
      { text: "c" },
      { text: "b" },
      { text: "a" },
    ]);
  });

  it("recalls nothing while attachments or receipts sit beside the prompt", () => {
    const sent = () => [{ text: "Last prompt" }];
    expect(promptsToRecall({ attachments: 0, receipts: 0 }, sent)).toEqual([
      { text: "Last prompt" },
    ]);
    expect(promptsToRecall({ attachments: 1, receipts: 0 }, sent)).toBeUndefined();
    expect(promptsToRecall({ attachments: 0, receipts: 2 }, sent)).toBeUndefined();
  });
});
