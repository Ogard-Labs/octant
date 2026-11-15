import { describe, expect, it } from "vitest";
import { thinkingDurationLabel, toolDisplayName, toolKind } from "./toolKinds";

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
