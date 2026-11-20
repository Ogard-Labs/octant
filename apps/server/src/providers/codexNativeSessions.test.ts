import { describe, expect, it } from "vitest";
import { codexThreadMessages } from "./codexNativeSessions";

describe("Codex native session history", () => {
  it("imports each turn's request and replies, naming the tool items before each reply and after the last", () => {
    expect(
      codexThreadMessages([
        {
          items: [
            { type: "userMessage", id: "u1", content: [{ type: "text", text: "Bump the SDK" }] },
            { type: "reasoning", id: "r1", summary: [] },
            { type: "commandExecution", id: "c1", command: "npm install" },
            { type: "agentMessage", id: "a1", text: "Bumped." },
            { type: "fileChange", id: "f1", changes: [] },
          ],
        },
      ]),
    ).toEqual([
      { role: "person", text: "Bump the SDK" },
      { role: "agent", text: "Bumped.", tools: ["Ran npm install"] },
      { role: "agent", text: "", tools: ["Changed files"] },
    ]);
  });
});
