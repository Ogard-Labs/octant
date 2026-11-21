import { describe, expect, it } from "vitest";
import { agentFileMentions, completeAgentFileMention } from "./agentTuiMentions";

describe("terminal file mentions", () => {
  it("quotes completed paths with whitespace and keeps ordinary absolute paths unchanged", () => {
    expect(completeAgentFileMention("/repo/my image.png")).toBe('@"/repo/my image.png"');
    expect(completeAgentFileMention("/repo/image.png")).toBe("@/repo/image.png");
  });

  it("parses quoted paths with whitespace and existing unquoted absolute paths", () => {
    expect(agentFileMentions('Attach @"/repo/my image.png" and @/tmp/image.png')).toEqual([
      { start: 7, end: 28, path: "/repo/my image.png" },
      { start: 33, end: 48, path: "/tmp/image.png" },
    ]);
  });

  it("does not interpret an incomplete or invalid quoted token as an attachment", () => {
    expect(agentFileMentions('Attach @"/repo/my image.png')).toEqual([]);
    expect(agentFileMentions('Attach @"/repo/bad\\q.png"')).toEqual([]);
  });
});
