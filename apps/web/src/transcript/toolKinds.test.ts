import { describe, expect, it } from "vitest";
import {
  callDurationLabel,
  countToolKinds,
  thinkingDurationLabel,
  toolCallsAccessibleName,
  toolDisplayName,
  toolKind,
  toolPreview,
} from "./toolKinds";

describe("tool kinds", () => {
  it("reads the kind of work from the name a provider gave the call", () => {
    expect(toolKind("Bash")).toBe("command");
    expect(toolKind("command_execution")).toBe("command");
    expect(toolKind("Read")).toBe("read");
    expect(toolKind("Edit")).toBe("edit");
    expect(toolKind("apply_patch")).toBe("edit");
    expect(toolKind("Grep")).toBe("search");
    expect(toolKind("WebFetch")).toBe("web");
    expect(toolKind("mcp__github__create_issue")).toBe("mcp");
    expect(toolKind("provider-tool")).toBe("mcp");
    expect(toolKind("Task")).toBe("agent");
    expect(toolKind("Something new")).toBe("other");
  });

  it("speaks the host's internal kinds as words and leaves a tool's own name alone", () => {
    expect(toolDisplayName("provider-tool")).toBe("Provider tool");
    expect(toolDisplayName("mcp__github__create_issue")).toBe("create issue (github)");
    expect(toolDisplayName("Bash")).toBe("Bash");
  });

  it("says how long thinking ran, briefly when it was under a second", () => {
    expect(thinkingDurationLabel(undefined)).toBe("Thinking");
    expect(thinkingDurationLabel(400)).toBe("Thought briefly");
    expect(thinkingDurationLabel(12_300)).toBe("Thought for 12s");
    expect(thinkingDurationLabel(125_000)).toBe("Thought for 2m 5s");
  });
});

describe("tool list summaries", () => {
  const names = [
    "Bash",
    "Bash",
    "Bash",
    "Bash",
    "Read",
    "Read",
    "Read",
    "Read",
    "Read",
    "Edit",
    "Edit",
  ];

  it("counts what ran by kind, most frequent first", () => {
    expect(countToolKinds(names)).toEqual([
      { kind: "read", count: 5 },
      { kind: "command", count: 4 },
      { kind: "edit", count: 2 },
    ]);
  });

  it("puts the total and the breakdown in the group's accessible name", () => {
    expect(toolCallsAccessibleName(names)).toBe("11 tool calls: 5 reads, 4 commands, 2 edits");
    expect(toolCallsAccessibleName(["Bash"])).toBe("1 tool call: 1 command");
  });

  it("previews a call by its command's first line or its file's name", () => {
    expect(toolPreview("command", "git status\nsecond line")).toBe("git status");
    expect(toolPreview("read", "src/app/main.ts")).toBe("main.ts");
    expect(toolPreview("search", "needle in haystack")).toBe("needle in haystack");
    expect(toolPreview("command", undefined)).toBeUndefined();
  });

  it("writes a call's duration in meta-sized words", () => {
    expect(callDurationLabel(420)).toBe("420 ms");
    expect(callDurationLabel(3_200)).toBe("3.2 s");
    expect(callDurationLabel(65_000)).toBe("1 m 5 s");
  });
});
