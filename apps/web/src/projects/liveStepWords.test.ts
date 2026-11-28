import { describe, expect, it } from "vitest";
import { liveStepWords } from "./liveStepWords";

describe("a working row's activity in plain words", () => {
  it("says a shell command is running, by the command it runs", () => {
    expect(liveStepWords({ kind: "tool", tool: "Bash", argument: "bun bench.ts" })).toBe(
      "Running bun bench.ts",
    );
    expect(liveStepWords({ kind: "tool", tool: "exec_command", argument: "bench.ts" })).toBe(
      "Running bench.ts",
    );
    expect(liveStepWords({ kind: "tool", tool: "shell" })).toBe("Running a command");
  });

  it("names the file being edited or read by its own name, not its folder", () => {
    expect(
      liveStepWords({
        kind: "tool",
        tool: "Edit",
        argument: "apps/web/src/composer/composerThreadDraft.ts",
      }),
    ).toBe("Editing composerThreadDraft.ts");
    expect(liveStepWords({ kind: "tool", tool: "Read", argument: "…/notes.md" })).toBe(
      "Reading notes.md",
    );
    expect(liveStepWords({ kind: "tool", tool: "apply_patch", argument: "*** Begin Patch" })).toBe(
      "Editing files",
    );
  });

  it("says what a search looks for and what a listing lists", () => {
    expect(liveStepWords({ kind: "tool", tool: "Grep", argument: "useDraft" })).toBe(
      "Searching for useDraft",
    );
    expect(liveStepWords({ kind: "tool", tool: "ls", argument: "src/composer" })).toBe(
      "Listing composer",
    );
  });

  it("says a web read, a plan update and any other tool in words, and a parked turn by what it waits for", () => {
    expect(liveStepWords({ kind: "tool", tool: "WebFetch" })).toBe("Reading a web page");
    expect(liveStepWords({ kind: "tool", tool: "TodoWrite" })).toBe("Updating the plan");
    expect(liveStepWords({ kind: "tool", tool: "mcp__github__create_pull_request" })).toBe(
      "Using create pull request (github)",
    );
    expect(liveStepWords({ kind: "waiting", reason: "approval" })).toBe("Waiting for approval");
    expect(liveStepWords({ kind: "waiting", reason: "user-input" })).toBe(
      "Waiting for your answer",
    );
  });
});
